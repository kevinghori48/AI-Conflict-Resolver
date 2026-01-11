import express from "express";
import multer from "multer";
import {
  createDispute,
  joinDispute,
  startDispute,
  submitVoice,
  getDispute
} from "../controllers/smallDisputeController.js";
import auth from "../middleware/auth.js";

const router = express.Router();
const upload = multer({ dest: "uploads/" });

// Lobby
router.post("/create", auth, createDispute);
router.post("/join", auth, joinDispute);

// Game Flow
router.post("/start", auth, startDispute); // Triggers Socket Timer
router.post("/submit", auth, upload.single("audio"), submitVoice); // Triggers Verdict

// Info
router.get("/:id", auth, getDispute);

export default router;