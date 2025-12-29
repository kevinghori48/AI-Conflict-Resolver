import express from "express";
import multer from "multer";
import {
  createDispute,
  joinDispute,
  signFairness,
  submitRound1,
  confirmRound1,
  submitRound2Selection
} from "../controllers/officialDisputeController.js";
import auth from "../middleware/auth.js";

const router = express.Router();
const upload = multer({ dest: "uploads/" });

// Screen 1 & 2: Intake
router.post("/create", auth, upload.single("intake_audio"), createDispute);

// Screen 4: Invite
router.post("/join", auth, joinDispute);

// Screen 3: Fairness
router.post("/sign-fairness", auth, signFairness);

// Screen 5: Round 1 (Understanding)
router.post("/round1/submit", auth, upload.single("audio"), submitRound1);
router.post("/round1/confirm", auth, confirmRound1);

// Screen 5: Round 2 (Options)
router.post("/round2/select", auth, submitRound2Selection);

export default router;