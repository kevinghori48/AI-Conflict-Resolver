import dotenv from "dotenv";
import http from "http";
import { Server } from "socket.io";
import app from "./app.js";

dotenv.config();

console.log("Loaded MONGO_URI:", process.env.MONGO_URI);

const PORT = process.env.PORT || 5000;

// 1. CREATE DUAL SERVER (HTTP + SOCKET)
// We wrap the Express 'app' in a standard HTTP server
const server = http.createServer(app);

// Initialize Socket.io
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all connections (Change to frontend URL in production)
    methods: ["GET", "POST"]
  }
});

// 2. ATTACH IO TO REQUESTS (Global Access)
// This makes 'req.io' available in ALL your controllers
// independently of middleware order.
app.request.io = io;

// 3. SOCKET LOGIC (The Real-Time Brain)
io.on("connection", (socket) => {
  console.log(`New Client Connected: ${socket.id}`);

  // A. Join a Dispute Room (Lobby)
  socket.on("join_room", (room_id) => {
    socket.join(room_id);
    console.log(`User ${socket.id} joined room: ${room_id}`);
    
    // Notify others in the room
    socket.to(room_id).emit("user_joined", { message: "Opponent has entered the arena." });
  });

  // B. Start the Timer (Synchronized)
  socket.on("start_timer", (room_id) => {
    console.log(`Timer started for room: ${room_id}`);
    // Broadcast to EVERYONE in the room (including sender) to start counting
    io.in(room_id).emit("timer_start", { duration: 30 }); 
  });

  socket.on("disconnect", () => {
    console.log("User disconnected", socket.id);
  });
});

// 4. START SERVER
server.listen(PORT, () => {
  console.log(`Server (HTTP + Socket) running on port ${PORT}`);
});
