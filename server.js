/**
 * 2624 Server
 * Node.js + Express + Socket.io synchronized video rooms
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e9 // 2GB for large video uploads
});

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// For logins
function logEvent(event, data) {
  console.log("📌", event, data);
}

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors()); 
app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'ux.html'));
});

// ─── Multer Storage (local; swap for S3/Firebase in production) ───────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 4 * 1024 * 1024 * 1024 }, // 4GB
  fileFilter: (req, file, cb) => {
    const allowed = /mp4|mkv|webm|mov|avi|m4v/i;
    cb(null, allowed.test(path.extname(file.originalname)));
  }
});

// ─── In-memory Room Store ─────────────────────────────────────────────────────
// rooms[roomId] = { host, guests[], videoFile, videoName, state: { playing, currentTime, lastSyncAt } }
const rooms = {};

// ─── HTTP Routes ──────────────────────────────────────────────────────────────

// Serve video files with range support (for proper seeking)
app.get('/video/:filename', (req, res) => {
  const filePath = path.join(UPLOADS_DIR, req.params.filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;
    const fileStream = fs.createReadStream(filePath, { start, end });

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4'
    });
    fileStream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// Upload video and create room
app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded' });

  const roomId = uuidv4().slice(0, 8).toUpperCase();

  rooms[roomId] = {
    host: null,
    guests: [],
    videoFile: req.file.filename,
    videoName: req.file.originalname,
    videoSize: req.file.size,
    state: { playing: false, currentTime: 0, lastSyncAt: Date.now() },
    createdAt: Date.now()
  };

  console.log("━━━━━━━━━━━━━━━━━━━━━━");
  console.log("🎬 VIDEO UPLOADED");
  console.log("Room ID:", roomId);
  console.log("Original Name:", req.file.originalname);
  console.log("Stored File:", req.file.filename);
  console.log("Video URL:", `https://two624.onrender.com/video/${req.file.filename}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━");

  res.json({
    roomId,
    videoFile: req.file.filename,
    videoName: req.file.originalname
  });
});
  // 🔥 UPLOAD LOG (ADD THIS)
  console.log("\n🎬 NEW VIDEO UPLOAD");
  console.log("━━━━━━━━━━━━━━━━━━━━━━");
  console.log("Room ID      :", roomId);
  console.log("File Name    :", req.file.originalname);
  console.log("Stored File  :", req.file.filename);
  console.log("File Size    :", (req.file.size / (1024 * 1024)).toFixed(2) + " MB");
  console.log("Time         :", new Date().toISOString());
  console.log("━━━━━━━━━━━━━━━━━━━━━━\n");

  res.json({ roomId, videoFile: req.file.filename, videoName: req.file.originalname });
});

// Get room info
app.get('/api/room/:roomId', (req, res) => {
  const room = rooms[req.params.roomId.toUpperCase()];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({
    roomId: req.params.roomId.toUpperCase(),
    videoName: room.videoName,
    videoFile: room.videoFile,
    guestCount: room.guests.length,
    hasHost: !!room.host,
    state: room.state
  });
});

// ─── Socket.io Real-time Sync ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`🔌 Socket connected: ${socket.id}`);

  // Join a room
  socket.on('join-room', ({ roomId, username }) => {
     logEvent("USER_JOINED", { roomId, username });
    const room = rooms[roomId?.toUpperCase()];
    if (!room) {
      socket.emit('error', { message: 'Room not found. Check your room code.' });
      return;
    }

    const upperRoomId = roomId.toUpperCase();
    socket.join(upperRoomId);
    socket.roomId = upperRoomId;
    socket.username = username || `Guest_${socket.id.slice(0, 4)}`;

    // First joiner = host
    let isHost = false;

if (!room.host) {
  room.host = socket.id;
  isHost = true;
  socket.isHost = true;
} else {
  socket.isHost = room.host === socket.id;
  if (!socket.isHost) {
    room.guests.push(socket.id);
  }
}

    console.log(`👤 ${socket.username} joined room ${upperRoomId} as ${isHost ? 'HOST' : 'GUEST'}`);

    // Send room data to joiner
    socket.emit('room-joined', {
    roomId: upperRoomId,
  isHost,
  videoFile: room.videoFile,
  videoName: room.videoName,
  state: room.state,
  username: socket.username
});

//  ADD THIS (IMPORTANT FIX)
io.to(upperRoomId).emit('sync-state', {
  playing: room.state.playing,
  currentTime: room.state.currentTime
});

    // Notify others
    socket.to(upperRoomId).emit('user-joined', {
      username: socket.username,
      isHost,
      totalUsers: 1 + room.guests.length
    });

    // Update user count for everyone
    io.to(upperRoomId).emit('user-count', { count: 1 + room.guests.length });
  });


  // Host plays video
  socket.on('video-play', ({ currentTime }) => {
    const room = rooms[socket.roomId];
    if (!room || !socket.isHost) return;

    room.state = { playing: true, currentTime, lastSyncAt: Date.now() };
    socket.to(socket.roomId).emit('video-play', { currentTime, username: socket.username });
    console.log(`▶ PLAY | Room: ${socket.roomId} | By: ${socket.username} | Time: ${currentTime?.toFixed(2)}s`);
  });

  // Host pauses video
  socket.on('video-pause', ({ currentTime }) => {
    const room = rooms[socket.roomId];
    if (!room || !socket.isHost) return;

    room.state = { playing: false, currentTime, lastSyncAt: Date.now() };
    socket.to(socket.roomId).emit('video-pause', { currentTime, username: socket.username });
    console.log(`⏸ PAUSE | Room: ${socket.roomId} | By: ${socket.username} | Time: ${currentTime?.toFixed(2)}s`);
  });

  // Host seeks
  socket.on('video-seek', ({ currentTime }) => {
    const room = rooms[socket.roomId];
    if (!room || !socket.isHost) return;

    room.state.currentTime = currentTime;
    room.state.lastSyncAt = Date.now();
    socket.to(socket.roomId).emit('video-seek', { currentTime, username: socket.username });
    console.log(`⏩ Room ${socket.roomId}: SEEK to ${currentTime?.toFixed(2)}s`);
  });

  // Guest requests sync (if they joined late / buffered)

 socket.on('request-sync', () => {
  const room = rooms[socket.roomId];
  if (!room) return;

  let time = room.state.currentTime;

  if (room.state.playing) {
    const elapsed = (Date.now() - room.state.lastSyncAt) / 1000;
    time += elapsed;
  }

  socket.emit('sync-state', {
    playing: room.state.playing,
    currentTime: time
  });
});



  // Chat message
  socket.on('chat-message', ({ message }) => {
    if (!socket.roomId || !message?.trim()) return;
    io.to(socket.roomId).emit('chat-message', {
      username: socket.username,
      message: message.trim().slice(0, 300),
      isHost: socket.isHost,
      timestamp: Date.now()
    });
  });

  // Disconnect
  socket.on('disconnect', () => {
    const room = rooms[socket.roomId];
    if (!room) return;

    if (socket.isHost) {
      // Host left — promote first guest or close room
      const nextHostId = room.guests.shift();
      if (nextHostId) {
        room.host = nextHostId;
        const nextHostSocket = io.sockets.sockets.get(nextHostId);
        if (nextHostSocket) {
          nextHostSocket.isHost = true;
          nextHostSocket.emit('promoted-to-host', {});
          io.to(socket.roomId).emit('host-changed', { username: nextHostSocket.username });
        }
      } else {
        // No guests, delete room after delay
        setTimeout(() => {
          if (rooms[socket.roomId] && rooms[socket.roomId].guests.length === 0) {
            const file = rooms[socket.roomId]?.videoFile;
            if (file) {
              const fp = path.join(UPLOADS_DIR, file);
              if (fs.existsSync(fp)) fs.unlinkSync(fp);
            }
            delete rooms[socket.roomId];
            console.log(`🗑️  Room ${socket.roomId} deleted`);
          }
        }, 30000); // 30s grace period
      }
    } else {
      room.guests = room.guests.filter(id => id !== socket.id);
    }

    io.to(socket.roomId).emit('user-left', { username: socket.username });
    io.to(socket.roomId).emit('user-count', { count: 1 + room.guests.length });
    console.log(`❌ ${socket.username} left room ${socket.roomId}`);
  });
});


// ─── Cleanup expired rooms every hour ────────────────────────────────────────
setInterval(() => {
  for (const roomId of Object.keys(rooms)) {
    const room = rooms[roomId];
    if (!room.state.playing) continue;

    const elapsed = (Date.now() - room.state.lastSyncAt) / 1000;
    room.state.currentTime += elapsed;
    room.state.lastSyncAt = Date.now();

    io.to(roomId).emit('sync-state', {
      playing: true,
      currentTime: room.state.currentTime
    });
  }
}, 15000);

// ─── Start Server ─────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n 2624 Server running at http://localhost:${PORT}`);
  console.log(`📁 Uploads: ${UPLOADS_DIR}\n`);
})
