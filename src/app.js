import express from "express";
import cors from "cors";
import connectDB from "./config/db.js";
import dotenv from "dotenv";
dotenv.config();

import authRoutes from "./routes/authRoutes.js";
import reportRoutes from "./routes/reportRoutes.js";
import chatRoutes from "./routes/chatRoutes.js";
import disputeRoutes from "./routes/smallDisputeRoutes.js";
import officialDisputeRoutes from "./routes/officialDisputeRoutes.js";

const app = express();
app.use(cors());
app.use(express.json());

connectDB();

app.use("/auth", authRoutes);
app.use("/report", reportRoutes);
app.use("/chat", chatRoutes);
app.use("/small-dispute", disputeRoutes);
app.use("/api/official-dispute", officialDisputeRoutes);

app.get("/", (req, res) => {
  res.send("API is working");
});

export default app;

// import express from "express";
// import cors from "cors";
// import connectDB from "./config/db.js";
// import dotenv from "dotenv";
// import path from "path";
// import { fileURLToPath } from "url";

// // Import Routes
// import authRoutes from "./routes/authRoutes.js";
// import reportRoutes from "./routes/reportRoutes.js";
// import chatRoutes from "./routes/chatRoutes.js";
// import disputeRoutes from "./routes/disputeRoutes.js";

// dotenv.config();

// // FIX: Define __dirname for ES Modules
// const __filename = fileURLToPath(import.meta.url);
// const __dirname = path.dirname(__filename);

// const app = express();

// app.use(cors());
// app.use(express.json());

// // FIX: Serve the 'public' folder as static files
// // This makes http://localhost:5000 load your index.html automatically
// app.use(express.static(path.join(__dirname, "../public")));

// connectDB();

// // API Routes
// app.use("/auth", authRoutes);
// app.use("/report", reportRoutes);
// app.use("/chat", chatRoutes);
// app.use("/dispute", disputeRoutes);

// // (Optional) Explicit fallback to index.html if needed
// app.get("/", (req, res) => {
//   res.sendFile(path.join(__dirname, "../public/index.html"));
// });

// export default app;