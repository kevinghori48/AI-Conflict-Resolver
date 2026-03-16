import crypto from "crypto";
import Room from "../models/Room.js";
import User from "../models/User.js";

// ================================
// HELPER: generate a short code
// ================================
const generateCode = () => crypto.randomBytes(4).toString("hex").toUpperCase(); // e.g. "A3F9B21C"

// ================================
// 1. CREATE ROOM + INVITE CODE
//    POST /api/room/create
//    Body: { report_id }
// ================================
export const createRoom = async (req, res) => {
  try {
    const { report_id } = req.body;
    const user_id = req.user._id;

    if (!report_id) return res.status(400).json({ message: "report_id is required" });

    // Prevent duplicate rooms for the same report
    const existing = await Room.findOne({ report_id });
    if (existing) return res.status(400).json({ message: "Room already exists for this report", room: existing });

    const invite_code      = generateCode();
    const invite_expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 h

    const room = await Room.create({
      report_id,
      created_by: user_id,
      members: [{ user_id }],           // creator is already in the room
      invite_code,
      invite_expires_at
    });

    // ── WebSocket: notify creator's own socket that the room is ready ──
    const io = req.app.get("io");
    if (io) {
      // Creator joins the socket room keyed by report_id
      const creatorSocketId = req.app.get("userSockets")?.[user_id.toString()];
      if (creatorSocketId) {
        const creatorSocket = io.sockets.sockets.get(creatorSocketId);
        creatorSocket?.join(report_id.toString());
      }

      io.to(report_id.toString()).emit("room_created", {
        room_id:    room._id,
        report_id,
        invite_code,
        expires_at: invite_expires_at,
        created_by: user_id
      });
    }

    return res.status(201).json({ message: "Room created", room });
  } catch (err) {
    console.error("createRoom error:", err);
    res.status(500).json({ message: "Failed to create room" });
  }
};

// ================================
// 2. JOIN ROOM WITH INVITE CODE
//    POST /api/room/join
//    Body: { invite_code }
// ================================
export const joinRoom = async (req, res) => {
  try {
    const { invite_code } = req.body;
    const user_id = req.user._id;

    if (!invite_code) return res.status(400).json({ message: "invite_code is required" });

    const room = await Room.findOne({ invite_code });
    if (!room)                                   return res.status(404).json({ message: "Invalid invite code" });
    if (room.invite_expires_at < new Date())     return res.status(410).json({ message: "Invite code has expired" });

    // Already a member?
    const alreadyIn = room.members.some(m => m.user_id.toString() === user_id.toString());
    if (alreadyIn) return res.status(400).json({ message: "You are already in this room" });

    // Max 2 members
    if (room.members.length >= 2) return res.status(400).json({ message: "Room is full" });

    room.members.push({ user_id });
    await room.save();

    const joiner = await User.findById(user_id).select("firstName lastName email");

    // ── WebSocket: notify User 1 (creator) that User 2 has joined ──
    const io         = req.app.get("io");
    const userSockets = req.app.get("userSockets") || {};

    if (io) {
      // Put User 2's socket into the room as well
      const joinerSocketId = userSockets[user_id.toString()];
      if (joinerSocketId) {
        const joinerSocket = io.sockets.sockets.get(joinerSocketId);
        joinerSocket?.join(room.report_id.toString());
      }

      // Broadcast to the whole room (User 1 will see this)
      io.to(room.report_id.toString()).emit("user_joined", {
        room_id:   room._id,
        report_id: room.report_id,
        joined_by: {
          _id:       joiner._id,
          firstName: joiner.firstName,
          lastName:  joiner.lastName,
          email:     joiner.email
        },
        total_members: room.members.length,
        joined_at:     new Date()
      });
    }

    return res.json({ message: "Joined room successfully", room });
  } catch (err) {
    console.error("joinRoom error:", err);
    res.status(500).json({ message: "Failed to join room" });
  }
};

// ================================
// 3. APPROVE SUMMARY
//    POST /api/room/approve-summary
//    Body: { report_id }
// ================================
export const approveSummary = async (req, res) => {
  try {
    const { report_id } = req.body;
    const user_id = req.user._id;

    if (!report_id) return res.status(400).json({ message: "report_id is required" });

    const room = await Room.findOne({ report_id });
    if (!room) return res.status(404).json({ message: "Room not found for this report" });

    // Check user is a member
    const isMember = room.members.some(m => m.user_id.toString() === user_id.toString());
    if (!isMember) return res.status(403).json({ message: "You are not a member of this room" });

    // Already approved by this user?
    const alreadyApproved = room.summary_approvals.some(
      a => a.user_id.toString() === user_id.toString()
    );
    if (alreadyApproved) return res.status(400).json({ message: "You have already approved the summary" });

    // Record approval
    room.summary_approvals.push({ user_id });

    const approvedCount  = room.summary_approvals.length;
    const totalMembers   = room.members.length;
    const fullyApproved  = approvedCount >= totalMembers && totalMembers === 2;

    if (fullyApproved) room.summary_fully_approved = true;

    await room.save();

    const approver = await User.findById(user_id).select("firstName lastName email");

    // ── WebSocket: broadcast approval event to the whole room ──
    const io = req.app.get("io");
    if (io) {
      // EVENT 1 – single user approved
      io.to(report_id.toString()).emit("summary_approved_by_user", {
        room_id:        room._id,
        report_id,
        approved_by: {
          _id:       approver._id,
          firstName: approver.firstName,
          lastName:  approver.lastName,
          email:     approver.email
        },
        approvals_so_far: approvedCount,
        total_members:    totalMembers,
        approved_at:      new Date()
      });

      // EVENT 2 – both users approved → summary is locked
      if (fullyApproved) {
        io.to(report_id.toString()).emit("summary_fully_approved", {
          room_id:      room._id,
          report_id,
          message:      "Both users have approved the summary. It is now locked.",
          approved_at:  new Date()
        });
      }
    }

    return res.json({
      message: fullyApproved
        ? "Summary fully approved by all members"
        : `Approval recorded (${approvedCount}/${totalMembers})`,
      fully_approved: fullyApproved,
      approvals_so_far: approvedCount
    });
  } catch (err) {
    console.error("approveSummary error:", err);
    res.status(500).json({ message: "Failed to approve summary" });
  }
};

// ================================
// 4. GET ROOM DETAILS
//    GET /api/room/:report_id
// ================================
export const getRoom = async (req, res) => {
  try {
    const { report_id } = req.params;
    const room = await Room.findOne({ report_id })
      .populate("members.user_id", "firstName lastName email")
      .populate("summary_approvals.user_id", "firstName lastName email");

    if (!room) return res.status(404).json({ message: "Room not found" });

    return res.json({ room });
  } catch (err) {
    console.error("getRoom error:", err);
    res.status(500).json({ message: "Failed to fetch room" });
  }
};