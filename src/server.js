import dotenv from "dotenv";
import http from "http";
import { Server } from "socket.io";
import app from "./app.js";
import { setupDisputeSocket } from "./socketHandlers/disputeSocketHandler.js";
import connectDB from "./config/db.js";

dotenv.config();

console.log("Loaded MONGO_URI:", process.env.MONGO_URI);

// Connect to MongoDB (after dotenv has loaded env vars)
connectDB();

const PORT = process.env.PORT || 5001;

// 1. CREATE HTTP SERVER
const server = http.createServer(app);

// 2. INITIALIZE SOCKET.IO
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(",")
  : "*";

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: allowedOrigins !== "*"
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ['websocket', 'polling'],
  allowEIO3: true
});

console.log("Socket.IO initialized");

// 3. ATTACH IO TO APP (Make accessible in controllers)
app.use((req, res, next) => {
  req.io = io;
  next();
});

// also store on app locals so controllers can fetch even if req.io is missing
app.set('io', io);

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