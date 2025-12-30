import express from "express";
import multer from "multer";
import {
  createDispute,
  joinDispute,
  signFairness,
  submitRound1,
  confirmRound1,
  modifyRound1,
  submitRound2Selection,
  modifyRound3,
  getDispute,
  signPlan
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
router.post("/round1/modify", auth, modifyRound1); // Feedback Endpoint

// Screen 5: Round 2 (Options)
router.post("/round2/select", auth, submitRound2Selection);

// Screen 5: Round 3 (Plan)
router.post("/round3/modify", auth, modifyRound3); // Feedback Endpoint

router.get("/:id", auth, getDispute);
router.post("/round3/sign", auth, signPlan);

export default router;
