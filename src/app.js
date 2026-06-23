import express from "express";
import cors from "cors";

// Import Routes
import authRoutes from "./routes/authRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import smallDisputeRoutes from "./routes/smallDisputeRoutes.js";
import officialDisputeRoutes from "./routes/officialDisputeRoutes.js";

const app = express();

app.use(cors());
app.use(express.json());

// Mount Routes
app.use("/auth", authRoutes);
app.use("/report", reportRoutes);
app.use("/chat", chatRoutes);
app.use("/small-dispute", smallDisputeRoutes);
app.use("/official-dispute", officialDisputeRoutes);

// Simple root route to check if server is alive
app.get("/", (req, res) => {
  res.send("API is working");
});

export default app;
