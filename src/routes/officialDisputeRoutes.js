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

// SCREEN 5: Conversation (WhatsApp-like Chat)
// Send text message
router.post("/message/text", auth, controller.sendTextMessage);

// Send audio message (max 30 sec, 5 per user)
router.post("/message/audio", auth, upload.single("audio"), controller.sendAudioMessage);

// Get audio file (streaming)
router.get("/message/audio/:message_id", auth, controller.getAudioFile);

// Get all messages for a dispute
router.get("/messages/:dispute_id", auth, controller.getConversationMessages);

// End conversation (Stop button)
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