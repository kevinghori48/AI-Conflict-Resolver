<<<<<<< HEAD
import express from "express";
import auth from "../middleware/auth.js";
import upload from "../utils/multerUpload.js";
import * as controller from "../controllers/officialDisputeController.js";

const router = express.Router();

// SCREEN 1 & 2: Dispute Creation
// Get relationship-specific questions
router.get("/questions/:relationship_type", auth, controller.getRelationshipQuestions);

// Create new dispute (after Screen 1 & 2)
router.post("/create", auth, controller.createDispute);

// SCREEN 4: Join Dispute
// Join dispute via invite code
router.post("/join", auth, controller.joinDispute);

// SCREEN 5: Conversation (WebSocket-based Chat)
router.post("/message/audio", auth, upload.single("audio"), controller.sendAudioMessage);

// Get audio file (for playback)
router.get("/message/audio/:message_id", auth, controller.getAudioFile);

// Get all messages for a dispute (for loading history)
router.get("/messages/:dispute_id", auth, controller.getConversationMessages);

// End conversation (Can use HTTP or WebSocket)
router.post("/end-conversation", auth, controller.endConversation);

// SCREEN 6: AI Summary Review
// Report and regenerate summary
router.post("/summary/report", auth, controller.reportSummary);

// Approve summary
router.post("/summary/approve", auth, controller.approveSummary);

// SCREEN 7: Solutions Selection
// Select preferred solutions
router.post("/solutions/select", auth, controller.selectSolutions);

// GENERAL ENDPOINTS
// Get specific dispute details
router.get("/status/:dispute_id", auth, controller.getDisputeStatus);

// Get all user's disputes
router.get("/my-disputes", auth, controller.getUserDisputes);

// Delete dispute (optional)
router.delete("/delete/:dispute_id", auth, controller.deleteDispute);

export default router;
=======
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
>>>>>>> 568ac423124b3a8823867993fb73fe19d7899ddc
