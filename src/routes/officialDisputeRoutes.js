import express from "express";
import auth from "../middleware/auth.js";
import upload from "../utils/multerUpload.js";
import * as controller from "../controllers/officialDisputeController.js";

const router = express.Router();

// SCREEN 1 & 2: Dispute Creation
router.get("/questions/:relationship_type", auth, controller.getRelationshipQuestions);
router.post("/create", auth, controller.createDispute);

// SCREEN 4: Join Dispute
router.post("/join", auth, controller.joinDispute);

// SCREEN 5: Conversation
router.post("/message/audio", auth, upload.single("audio"), controller.sendAudioMessage);
router.get("/message/audio/:message_id", auth, controller.getAudioFile);
router.get("/messages/:dispute_id", auth, controller.getConversationMessages);
router.post("/end-conversation", auth, controller.endConversation);

// SCREEN 6: AI Summary Review
router.post("/summary/report", auth, controller.reportSummary);
router.post("/summary/approve", auth, controller.approveSummary);

// SCREEN 7: Solutions Selection
router.get("/solutions/:dispute_id", auth, controller.getSolutions);  // new endpoint to fetch generated solutions
router.post("/solutions/select", auth, controller.selectSolutions);

// Suggested plan (after both select solutions): get, accept, or reject → negotiation
router.get("/plan/suggested/:dispute_id", auth, controller.getSuggestedPlan);
router.post("/plan/accept", auth, controller.acceptSuggestedPlan);
router.post("/plan/reject", auth, controller.rejectSuggestedPlan);

// SCREEN 8: Negotiation Phase
// Post a comment in the negotiation thread
router.post("/negotiation/comment", auth, controller.postNegotiationComment);

// Get all negotiation comments + ready status
router.get("/negotiation/comments/:dispute_id", auth, controller.getNegotiationComments);

// Signal "I agree" — when both signal, AI generates the final plan
router.post("/negotiation/agree", auth, controller.signalAgreement);

// SCREEN 9: Final Plan Review
// Get the AI-generated final plan
router.get("/final-plan/:dispute_id", auth, controller.getFinalPlan);

// Approve the AI-generated final plan
router.post("/final-plan/approve", auth, controller.approveFinalPlan);

// Report an issue with the final plan (saved for dev; dispute still closes)
router.post("/final-plan/report", auth, controller.reportFinalPlanIssue);

// GENERAL ENDPOINTS
router.get("/status/:dispute_id", auth, controller.getDisputeStatus);
router.get("/my-disputes", auth, controller.getUserDisputes);
router.delete("/delete/:dispute_id", auth, controller.deleteDispute);

// AI SUMMARY ENDPOINT
router.post("/summary/get", auth, controller.getAISummary);

export default router;