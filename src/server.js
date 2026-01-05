import dotenv from "dotenv";
import http from "http";
import { Server } from "socket.io";
import app from "./app.js";
import { setupDisputeSocket } from "./socketHandlers/disputeSocketHandler.js";

dotenv.config();

console.log("Loaded MONGO_URI:", process.env.MONGO_URI);

const PORT = process.env.PORT || 5001;

// 1. CREATE HTTP SERVER
const server = http.createServer(app);

// 2. INITIALIZE SOCKET.IO
const io = new Server(server, {
  cors: {
    origin: "*", // Allow all origins for now
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling']
});

console.log("Socket.IO initialized");

// 3. ATTACH IO TO APP (Make accessible in controllers)
app.use((req, res, next) => {
  req.io = io;
  next();
});

console.log("Socket.IO attached to Express app");

// 4. SETUP DISPUTE SOCKET HANDLERS
setupDisputeSocket(io);

console.log("Dispute socket handlers registered");

// 5. GRACEFUL SHUTDOWN
process.on("SIGTERM", () => {
  console.log("SIGTERM signal received: closing HTTP server");
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  console.log("SIGINT signal received: closing HTTP server");
  server.close(() => {
    console.log("HTTP server closed");
    process.exit(0);
  });
});

// 6. START SERVER
server.listen(PORT, () => {
  console.log(`Server (HTTP + WebSocket) running on port ${PORT}`);
  console.log(`WebSocket ready at ws://localhost:${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});