const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json());

const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    transports: ["polling", "websocket"]
});

// ---------------- STORAGE ----------------
const meetings = {};        // meetingId -> [socketId]
const hostMap = {};         // meetingId -> hostSocketId
const users = {};           // socketId -> user info
const userMeeting = {};     // socketId -> meetingId
const waitingRoom = {};     // meetingId -> [{ id, username }]

// ---------------- UTILS ----------------
function generateMeetingId() {
    return "MEET-" + Math.floor(1000 + Math.random() * 9000);
}

function emitParticipants(meetingId) {
    io.to(meetingId).emit("participants-update", {
        participants: meetings[meetingId].map(id => ({
            id,
            username: users[id]?.username || "Guest",
            micOn: users[id]?.micOn ?? false,
            camOn: users[id]?.camOn ?? false,
            handRaised: users[id]?.handRaised ?? false,
            isHost: hostMap[meetingId] === id
        }))
    });
}

// ---------------- REST ----------------
app.post("/create-meeting", (req, res) => {
    const meetingId = generateMeetingId();
    meetings[meetingId] = [];
    waitingRoom[meetingId] = [];
    res.json({ meetingId });
});

// ---------------- SOCKET ----------------
io.on("connection", socket => {

    // -------- JOIN MEETING (WITH WAITING ROOM) --------
    socket.on("join-meeting", ({ meetingId, isHost, username }) => {
        if (!meetings[meetingId]) return;

        // HOST → join directly
        if (isHost) {
            socket.join(meetingId);

            users[socket.id] = {
                username,
                micOn: true,
                camOn: true,
                handRaised: false
            };

            userMeeting[socket.id] = meetingId;
            hostMap[meetingId] = socket.id;

            socket.emit("existing-users", meetings[meetingId]);
            meetings[meetingId].push(socket.id);

            io.to(meetingId).emit("host-info", socket.id);
            emitParticipants(meetingId);

            io.to(meetingId).emit("system-message", {
                message: `${username} joined as host`
            });

            return;
        }

        // PARTICIPANT → WAITING ROOM
        waitingRoom[meetingId] = waitingRoom[meetingId] || [];
        waitingRoom[meetingId].push({ id: socket.id, username });

        socket.emit("waiting-room");

        const hostId = hostMap[meetingId];
        if (hostId) {
            io.to(hostId).emit("waiting-room-update", waitingRoom[meetingId]);
        }
    });

    // -------- ADMIT USER --------
    socket.on("admit-user", ({ meetingId, userId }) => {
        const user = waitingRoom[meetingId]?.find(u => u.id === userId);
        if (!user) return;

        waitingRoom[meetingId] =
            waitingRoom[meetingId].filter(u => u.id !== userId);

        users[userId] = {
            username: user.username,
            micOn: true,
            camOn: true,
            handRaised: false
        };

        userMeeting[userId] = meetingId;
        io.sockets.sockets.get(userId)?.join(meetingId);

        io.to(userId).emit("existing-users", meetings[meetingId]);
        meetings[meetingId].push(userId);

        emitParticipants(meetingId);

        io.to(userId).emit("admitted");
        io.to(hostMap[meetingId]).emit(
            "waiting-room-update",
            waitingRoom[meetingId]
        );

        io.to(meetingId).emit("system-message", {
            message: `${user.username} joined the meeting`
        });
    });

    // -------- REJECT USER --------
    socket.on("reject-user", ({ meetingId, userId }) => {
        waitingRoom[meetingId] =
            waitingRoom[meetingId]?.filter(u => u.id !== userId);

        io.to(userId).emit("rejected");

        io.to(hostMap[meetingId]).emit(
            "waiting-room-update",
            waitingRoom[meetingId]
        );
    });

    // -------- TYPING --------
    socket.on("typing", ({ meetingId, username }) => {
        socket.to(meetingId).emit("user-typing", { username });
    });

    // -------- RAISE HAND --------
    socket.on("toggle-hand", () => {
        const meetingId = userMeeting[socket.id];
        if (!meetingId || !users[socket.id]) return;

        users[socket.id].handRaised = !users[socket.id].handRaised;
        emitParticipants(meetingId);
    });

    // -------- REACTIONS --------
    socket.on("reaction", ({ meetingId, emoji }) => {
        io.to(meetingId).emit("reaction", {
            emoji,
            from: socket.id
        });
    });

    // -------- MIC / CAM --------
    socket.on("toggle-media", ({ micOn, camOn }) => {
        if (!users[socket.id]) return;

        users[socket.id].micOn = micOn;
        users[socket.id].camOn = camOn;

        const meetingId = userMeeting[socket.id];
        if (meetingId) emitParticipants(meetingId);
    });

    // -------- WEBRTC --------
    socket.on("webrtc-offer", ({ to, offer }) => {
        socket.to(to).emit("webrtc-offer", { from: socket.id, offer });
    });

    socket.on("webrtc-answer", ({ to, answer }) => {
        socket.to(to).emit("webrtc-answer", { from: socket.id, answer });
    });

    socket.on("webrtc-ice-candidate", ({ to, candidate }) => {
        socket.to(to).emit("webrtc-ice-candidate", { from: socket.id, candidate });
    });

    // -------- CHAT --------
    socket.on("chat-message", ({ meetingId, message }) => {
        io.to(meetingId).emit("chat-message", {
            sender: socket.id,
            username: users[socket.id]?.username || "Guest",
            message,
            time: new Date().toLocaleTimeString()
        });
    });

    // -------- END MEETING --------
    socket.on("end-meeting", ({ meetingId }) => {
        if (hostMap[meetingId] === socket.id) {
            io.to(meetingId).emit("meeting-ended");
            delete meetings[meetingId];
            delete hostMap[meetingId];
            delete waitingRoom[meetingId];
        }
    });

    // -------- DISCONNECT --------
    socket.on("disconnect", () => {
        const meetingId = userMeeting[socket.id];

        // remove from waiting room if present
        if (meetingId && waitingRoom[meetingId]) {
            waitingRoom[meetingId] =
                waitingRoom[meetingId].filter(u => u.id !== socket.id);

            io.to(hostMap[meetingId]).emit(
                "waiting-room-update",
                waitingRoom[meetingId]
            );
        }

        if (!meetingId || !meetings[meetingId]) return;

        const username = users[socket.id]?.username;

        io.to(meetingId).emit("user-left", socket.id);

        meetings[meetingId] =
            meetings[meetingId].filter(id => id !== socket.id);

        delete users[socket.id];
        delete userMeeting[socket.id];

        emitParticipants(meetingId);

        io.to(meetingId).emit("system-message", {
            message: `${username} left the meeting`
        });

        if (hostMap[meetingId] === socket.id) {
            io.to(meetingId).emit("meeting-ended");
            delete meetings[meetingId];
            delete hostMap[meetingId];
            delete waitingRoom[meetingId];
        }
    });
});

// ---------------- START ----------------
server.listen(3000, "0.0.0.0", () => {
    console.log("✅ Backend running on http://0.0.0.0:3000");
});
