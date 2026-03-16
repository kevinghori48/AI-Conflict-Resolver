import express from "express";
import auth from "../middleware/auth.js";
import { createRoom, joinRoom, approveSummary, getRoom } from "../controllers/roomController.js";

const router = express.Router();

// POST /api/room/create         → User 1 creates room + invite code
router.post("/create", auth, createRoom);

// POST /api/room/join            → User 2 joins via invite code
router.post("/join", auth, joinRoom);

// POST /api/room/approve-summary → Either user approves the summary
router.post("/approve-summary", auth, approveSummary);

// GET  /api/room/:report_id      → Fetch room details
router.get("/:report_id", auth, getRoom);

export default router;