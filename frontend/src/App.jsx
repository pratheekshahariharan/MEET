import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const BACKEND_URL = "http://10.20.101.117:3000";
const SOCKET_URL = "http://10.20.101.117:3000";

const socket = io(SOCKET_URL, {
  transports: ["polling", "websocket"],
  reconnection: true
});

const rtcConfig = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
};

export default function App() {
  const previewVideoRef = useRef(null);
  const roomVideoRef = useRef(null);
  const peers = useRef({});

  const cameraTrackRef = useRef(null);
  const screenTrackRef = useRef(null);

  const [page, setPage] = useState("home");
  const [meetingId, setMeetingId] = useState("");
  const [localStream, setLocalStream] = useState(null);
  const [remoteStreams, setRemoteStreams] = useState({});
  const [isHost, setIsHost] = useState(false);
  const [hostId, setHostId] = useState(null);

  const [micOn, setMicOn] = useState(true);
  const [camOn, setCamOn] = useState(true);
  const [isSharing, setIsSharing] = useState(false);

  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [showChat, setShowChat] = useState(true);

  const [participants, setParticipants] = useState([]);
  const [showParticipants, setShowParticipants] = useState(false);
  const [typingUser, setTypingUser] = useState("");
  const [reactions, setReactions] = useState([]);

  const [username, setUsername] = useState("");
  const [waiting, setWaiting] = useState(false);
  const [waitingUsers, setWaitingUsers] = useState([]);
  const [showWaitingRoom, setShowWaitingRoom] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const idFromLink = params.get("meetingId");
    if (idFromLink) {
      setMeetingId(idFromLink);
    }
  }, []);


  useEffect(() => {
    let name = prompt("Enter your name");
    if (!name || !name.trim()) {
      name = "Guest-" + Math.floor(Math.random() * 1000);
    }
    setUsername(name.trim());
  }, []);


  async function startMedia() {
    if (localStream) return localStream;

    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true
    });

    cameraTrackRef.current = stream.getVideoTracks()[0];
    setLocalStream(stream);
    return stream;
  }

  useEffect(() => {
    if (page === "preview" && previewVideoRef.current && localStream) {
      previewVideoRef.current.srcObject = localStream;
    }
    if (page === "room" && roomVideoRef.current && localStream) {
      roomVideoRef.current.srcObject = localStream;
    }
  }, [page, localStream]);


  function createPeer(id, offerer) {
    if (peers.current[id]) return;

    const pc = new RTCPeerConnection(rtcConfig);
    peers.current[id] = pc;

    localStream.getTracks().forEach(track =>
      pc.addTrack(track, localStream)
    );

    pc.ontrack = e => {
      setRemoteStreams(prev => ({
        ...prev,
        [id]: e.streams[0]
      }));
    };

    pc.onicecandidate = e => {
      if (e.candidate) {
        socket.emit("webrtc-ice-candidate", {
          to: id,
          candidate: e.candidate
        });
      }
    };

    if (offerer) {
      pc.createOffer().then(offer => {
        pc.setLocalDescription(offer);
        socket.emit("webrtc-offer", { to: id, offer });
      });
    }
  }


  useEffect(() => {
    if (!localStream) return;

    socket.on("existing-users", users =>
      users.forEach(id => createPeer(id, true))
    );

    socket.on("new-user", id => createPeer(id, false));
    socket.on("host-info", id => setHostId(id));

    socket.on("participants-update", data => {
      setParticipants(data.participants);
    });

    socket.on("webrtc-offer", async ({ from, offer }) => {
      createPeer(from, false);
      const pc = peers.current[from];
      await pc.setRemoteDescription(offer);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.emit("webrtc-answer", { to: from, answer: ans });
    });
    socket.on("user-left", (id) => {

      if (peers.current[id]) {
        peers.current[id].close();
        delete peers.current[id];
      }


      setRemoteStreams(prev => {
        const updated = { ...prev };
        delete updated[id];
        return updated;
      });
    });
    socket.on("user-typing", ({ username }) => {
      setTypingUser(username);

      setTimeout(() => {
        setTypingUser("");
      }, 1500);
    });
    socket.on("reaction", ({ emoji, from }) => {
      const id = Date.now() + Math.random();

      setReactions(prev => [...prev, { id, emoji }]);

      setTimeout(() => {
        setReactions(prev => prev.filter(r => r.id !== id));
      }, 2000);
    });


    socket.on("webrtc-answer", ({ from, answer }) => {
      peers.current[from].setRemoteDescription(answer);
    });

    socket.on("webrtc-ice-candidate", ({ from, candidate }) => {
      peers.current[from].addIceCandidate(candidate);
    });

    socket.on("chat-message", msg => {
      setMessages(prev => [...prev, msg]);
    });

    socket.on("system-message", msg => {
      setMessages(prev => [
        ...prev,
        { system: true, message: msg.message }
      ]);
    });
    socket.on("waiting-room", () => {
      setWaiting(true);
    });

    socket.on("waiting-room-update", users => {
      setWaitingUsers(users);
    });

    socket.on("admitted", () => {
      setWaiting(false);
      setPage("room");
    });

    socket.on("rejected", () => {
      alert("Host rejected your request");
      window.location.reload();
    });

    socket.on("meeting-ended", () => {
      alert("Meeting ended by host");
      window.location.reload();
    });

    return () => socket.removeAllListeners();
  }, [localStream]);

  async function toggleScreenShare() {
    if (!isSharing) {
      const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      const track = screenStream.getVideoTracks()[0];
      screenTrackRef.current = track;

      Object.values(peers.current).forEach(pc => {
        pc.getSenders().find(s => s.track.kind === "video").replaceTrack(track);
      });

      roomVideoRef.current.srcObject = screenStream;
      setIsSharing(true);
      track.onended = stopScreenShare;
    } else {
      stopScreenShare();
    }
  }

  function stopScreenShare() {
    Object.values(peers.current).forEach(pc => {
      pc.getSenders().find(s => s.track.kind === "video").replaceTrack(cameraTrackRef.current);
    });

    roomVideoRef.current.srcObject = localStream;
    setIsSharing(false);
  }


  async function hostMeeting() {
    const res = await fetch(`${BACKEND_URL}/create-meeting`, { method: "POST" });
    const data = await res.json();
    setMeetingId(data.meetingId);
    setIsHost(true);
    await startMedia();
    setPage("preview");
  }

  async function joinMeeting() {
    setIsHost(false);
    await startMedia();
    setPage("preview");
  }

  function enterRoom() {
    socket.emit("join-meeting", { meetingId, isHost, username });
    if (!isHost) setWaiting(true);
    else setPage("room");
  }


  function toggleMic() {
    const t = localStream.getAudioTracks()[0];
    t.enabled = !t.enabled;
    setMicOn(t.enabled);
    socket.emit("toggle-media", { micOn: t.enabled, camOn });
  }

  function toggleCam() {

    cameraTrackRef.current.enabled = !cameraTrackRef.current.enabled;
    setCamOn(cameraTrackRef.current.enabled);
    socket.emit("toggle-media", {
      micOn,
      camOn: cameraTrackRef.current.enabled
    });
  }
  function toggleHand() {
    socket.emit("toggle-hand");
  }
  function sendReaction(emoji) {
    socket.emit("reaction", { meetingId, emoji });
  }




  function endCall() {
    if (isHost) socket.emit("end-meeting", { meetingId });
    window.location.reload();
  }

  function sendMessage() {
    if (!chatInput.trim()) return;
    socket.emit("chat-message", { meetingId, message: chatInput });
    setChatInput("");
  }
  function copyInviteLink() {
    const link = `${window.location.origin}/?meetingId=${meetingId}`;
    navigator.clipboard.writeText(link);
    alert("Invite link copied");
  }



  if (page === "home") {
    return (
      <div className="preview">
        <h2>Local Meet</h2>
        <button className="join-btn" onClick={hostMeeting}>New meeting</button>
        <input placeholder="Meeting ID" onChange={e => setMeetingId(e.target.value)} />
        <button className="join-btn" onClick={joinMeeting}>Join</button>
      </div>
    );
  }

  if (page === "preview") {
    return (
      <div className="preview">
        <video ref={previewVideoRef} autoPlay muted />
        <button onClick={toggleMic}>{micOn ? "🎤 Mic On" : "🔇 Mic Off"}</button>
        <button onClick={toggleCam}>{camOn ? "📷 Cam On" : "🚫 Cam Off"}</button>
        <button className="join-btn" onClick={enterRoom}>Join now</button>
      </div>
    );
  }
  if (waiting) {
    return (
      <div className="preview">
        <h2>Waiting for host to admit you…</h2>
      </div>
    );
  }

  return (
    <div className="room">

      {/* ---------- HEADER ---------- */}
      <div className="room-header">
        <span>
          Meeting ID: <b>{meetingId}</b>
        </span>

        <button
          onClick={copyInviteLink}
          style={{
            marginLeft: "16px",
            padding: "6px 12px",
            borderRadius: "8px",
            border: "1px solid #e5e7eb",
            background: "#f1f5f9",
            cursor: "pointer"
          }}
        >
          🔗 Copy invite
        </button>
      </div>

      {/* ---------- REACTIONS OVERLAY ---------- */}
      <div className="reactions-layer">
        {reactions.map(r => (
          <div
            key={r.id}
            className="reaction"
            style={{
              left: `${Math.random() * 90}%`,
              top: `${60 + Math.random() * 20}%`
            }}
          >
            {r.emoji}
          </div>
        ))}
      </div>

      {/* ---------- MAIN CONTENT ---------- */}
      <div className="main-content">

        {/* ----- VIDEO GRID ----- */}
        <div className="grid">
          <div className="video-box">
            <video ref={roomVideoRef} autoPlay muted />
            <div className="name-tag">
              {username} {socket.id === hostId ? "(Host)" : ""} {!micOn && " 🔇"}
            </div>
          </div>

          {Object.entries(remoteStreams).map(([id, stream]) => (
            <div key={id} className="video-box">
              <video autoPlay ref={el => el && (el.srcObject = stream)} />
            </div>
          ))}
        </div>

        {/* ----- WAITING ROOM (HOST ONLY) ----- */}
        {isHost && showWaitingRoom && waitingUsers.length > 0 && (
          <div className="participants-panel">
            <h4>Waiting Room</h4>

            {waitingUsers.map(u => (
              <div key={u.id} className="participant">
                <span>{u.username}</span>

                <span>
                  <button
                    onClick={() =>
                      socket.emit("admit-user", {
                        meetingId,
                        userId: u.id
                      })
                    }
                  >
                    ✅
                  </button>

                  <button
                    onClick={() =>
                      socket.emit("reject-user", {
                        meetingId,
                        userId: u.id
                      })
                    }
                  >
                    ❌
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        {/* ----- CHAT PANEL ----- */}
        {showChat && (
          <div className="chat-panel">
            <h4>Chat</h4>

            <div className="chat-messages">
              {messages.map((m, i) => {
                if (m.system) {
                  return (
                    <div
                      key={i}
                      style={{
                        textAlign: "center",
                        color: "#6b7280",
                        fontSize: "13px"
                      }}
                    >
                      {m.message}
                    </div>
                  );
                }

                return (
                  <div
                    key={i}
                    className={`chat-msg ${m.sender === socket.id ? "me" : "other"
                      }`}
                  >
                    <b>{m.username}</b>: {m.message}
                  </div>
                );
              })}
            </div>

            {typingUser && typingUser !== username && (
              <div
                style={{
                  fontSize: "12px",
                  color: "#6b7280",
                  marginBottom: "6px"
                }}
              >
                {typingUser} is typing...
              </div>
            )}

            <div className="chat-input">
              <input
                value={chatInput}
                onChange={e => {
                  setChatInput(e.target.value);
                  socket.emit("typing", { meetingId, username });
                }}
                placeholder="Type a message..."
              />
              <button onClick={sendMessage}>➤</button>
            </div>
          </div>
        )}

        {/* ----- PARTICIPANTS PANEL ----- */}
        {showParticipants && (
          <div className="participants-panel">
            <h4>Participants</h4>

            {participants.map(p => (
              <div key={p.id} className="participant">
                <span>
                  {p.username || "Guest"} {p.isHost && "👑"}{" "}
                  {p.handRaised && "✋"}
                </span>

                <span>
                  {p.micOn ? "🎤" : "🔇"} {p.camOn ? "📷" : "🚫📷"}
                </span>
              </div>
            ))}
          </div>
        )}

      </div>

      {/* ---------- CONTROLS ---------- */}
      <div className="controls">
        <button onClick={toggleMic}>{micOn ? "🎤" : "🔇"}</button>
        <button onClick={toggleCam}>{camOn ? "📷" : "🚫📷"}</button>
        <button onClick={toggleScreenShare}>🖥️</button>
        <button onClick={() => setShowChat(v => !v)}>💬</button>
        <button onClick={() => setShowParticipants(v => !v)}>👥</button>
        <button onClick={toggleHand}>✋</button>
        <button onClick={() => sendReaction("👍")}>👍</button>
        <button onClick={() => sendReaction("😂")}>😂</button>
        <button onClick={() => sendReaction("❤️")}>❤️</button>
        <button onClick={endCall}>📞</button>
        {isHost && (
          <button onClick={() => setShowWaitingRoom(v => !v)}>
            ⏳
          </button>
        )}


      </div>

    </div>
  );
}