import express from "express";
import cors from "cors";
import connectDB from "./config/db.js";
import dotenv from "dotenv";

// Import Routes
import authRoutes from "./routes/authRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import smallDisputeRoutes from "./routes/smallDisputeRoutes.js";
import officialDisputeRoutes from "./routes/officialDisputeRoutes.js";
import roomRoutes from "./routes/roomRoutes.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

connectDB();

// Mount Routes
app.use("/auth", authRoutes);
app.use("/report", reportRoutes);
app.use("/chat", chatRoutes);
app.use("/small-dispute", smallDisputeRoutes);
app.use("/official-dispute", officialDisputeRoutes);
app.use("/room", roomRoutes);

// Simple root route to check if server is alive
app.get("/", (req, res) => {
  res.send("API is working");
});

export default app;