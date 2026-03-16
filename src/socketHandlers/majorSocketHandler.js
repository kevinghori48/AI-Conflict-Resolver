import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Room from "../models/Room.js";
import crypto from "crypto";

const generateCode = () => crypto.randomBytes(4).toString("hex").toUpperCase();

export const initMajorSocket = (io, app) => {
  console.log("Setting up Major Dispute WebSocket handlers...");

  // ─── AUTHENTICATION MIDDLEWARE ────────────────────────────────────────────
  // Same pattern as disputeSocketHandler — token from handshake
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded._id;
        socket.user = await User.findById(decoded._id).select("firstName lastName email");
        if (socket.user) {
          socket.authenticated = true;
          console.log(`[Major] Socket authenticated: ${socket.user.email}`);
          return next();
        }
      }
      socket.authenticated = false;
      console.log("[Major] Socket connected without auth");
      next();
    } catch (err) {
      socket.authenticated = false;
      console.log("[Major] Socket auth failed");
      next();
    }
  });

  // ─── CONNECTION EVENT ─────────────────────────────────────────────────────
  io.on("connection", (socket) => {
    console.log(`\n[Major] NEW CONNECTION: ${socket.id} (Auth: ${socket.authenticated})\n`);

    // Same requireAuth wrapper as disputeSocketHandler
    const requireAuth = (eventName, handler) => {
      socket.on(eventName, async (...args) => {
        console.log(`[Major][LISTEN] ${eventName} | user: ${socket.user?.email}`);
        if (!socket.authenticated) {
          socket.emit("error", { message: "Not authenticated", event: eventName });
          console.log(`[Major][EMIT] error | not authenticated | event: ${eventName}`);
          return;
        }
        try {
          await handler(...args);
        } catch (error) {
          console.error(`[Major] Error in ${eventName}:`, error);
          socket.emit("error", { message: `Error in ${eventName}`, error: error.message });
          console.log(`[Major][EMIT] error | handler exception | event: ${eventName}`);
        }
      });
    };

    // ─── JOIN REPORT ROOM ─────────────────────────────────────────────────────
    // Client emits this after connecting so they receive all room events
    // LISTEN : join_report_room  { report_id }
    // EMIT   : room_joined       → caller only
    requireAuth("join_report_room", async ({ report_id }, callback) => {
      if (!report_id) {
        socket.emit("error", { message: "report_id is required" });
        return;
      }

      socket.join(report_id.toString());
      socket.currentReport = report_id.toString();
      console.log(`[Major] ${socket.user.email} joined report room: ${report_id}`);

      socket.emit("room_joined", {
        report_id,
        user_id:   socket.userId,
        message:   "Successfully joined report room",
        timestamp: new Date()
      });
      console.log(`[Major][EMIT] room_joined | to: ${socket.user.email} | report: ${report_id}`);

      if (callback) callback({ success: true, report_id });
    });

    // ─── CREATE ROOM + INVITE CODE ────────────────────────────────────────────
    // User 1 creates the room and gets an invite code to share with User 2
    // LISTEN : create_room   { report_id }
    // EMIT   : room_created  → caller only
    requireAuth("create_room", async ({ report_id }, callback) => {
      if (!report_id) {
        socket.emit("error", { message: "report_id is required" });
        return;
      }

      // Prevent duplicate rooms for same report
      const existing = await Room.findOne({ report_id });
      if (existing) {
        socket.emit("error", { message: "Room already exists for this report" });
        if (callback) callback({ success: false, message: "Room already exists", room: existing });
        return;
      }

      const invite_code       = generateCode();
      const invite_expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

      const room = await Room.create({
        report_id,
        created_by:  socket.userId,
        members:     [{ user_id: socket.userId }],
        invite_code,
        invite_expires_at
      });

      // Put creator's socket into the report room
      socket.join(report_id.toString());
      socket.currentReport = report_id.toString();

      socket.emit("room_created", {
        room_id:    room._id,
        report_id,
        invite_code,
        expires_at: invite_expires_at,
        created_by: socket.userId,
        timestamp:  new Date()
      });
      console.log(`[Major][EMIT] room_created | to: ${socket.user.email} | code: ${invite_code}`);

      if (callback) callback({ success: true, room });
    });

    // ─── JOIN ROOM WITH INVITE CODE ───────────────────────────────────────────
    // User 2 joins using the invite code — User 1 is notified immediately
    // LISTEN : join_with_code  { invite_code }
    // EMIT   : user_joined     → entire room (User 1 sees this instantly)
    requireAuth("join_with_code", async ({ invite_code }, callback) => {
      if (!invite_code) {
        socket.emit("error", { message: "invite_code is required" });
        return;
      }

      const room = await Room.findOne({ invite_code: invite_code.toUpperCase() });

      if (!room) {
        socket.emit("error", { message: "Invalid invite code" });
        if (callback) callback({ success: false, message: "Invalid invite code" });
        return;
      }

      if (room.invite_expires_at < new Date()) {
        socket.emit("error", { message: "Invite code has expired" });
        if (callback) callback({ success: false, message: "Invite code has expired" });
        return;
      }

      // Already a member?
      const alreadyIn = room.members.some(
        m => m.user_id.toString() === socket.userId.toString()
      );
      if (alreadyIn) {
        socket.emit("error", { message: "You are already in this room" });
        if (callback) callback({ success: false, message: "Already in room" });
        return;
      }

      // Max 2 members
      if (room.members.length >= 2) {
        socket.emit("error", { message: "Room is full" });
        if (callback) callback({ success: false, message: "Room is full" });
        return;
      }

      room.members.push({ user_id: socket.userId });
      await room.save();

      // Put User 2's socket into the report room
      socket.join(room.report_id.toString());
      socket.currentReport = room.report_id.toString();

      // Notify ENTIRE room — User 1 sees this immediately
      io.to(room.report_id.toString()).emit("user_joined", {
        room_id:   room._id,
        report_id: room.report_id,
        joined_by: {
          _id:       socket.userId,
          firstName: socket.user.firstName,
          lastName:  socket.user.lastName,
          email:     socket.user.email
        },
        total_members: room.members.length,
        joined_at:     new Date()
      });
      console.log(`[Major][EMIT] user_joined | to room: ${room.report_id} | user: ${socket.user.email}`);

      if (callback) callback({ success: true, room });
    });

    // ─── APPROVE SUMMARY ──────────────────────────────────────────────────────
    // Either user approves — both see each approval event in real time
    // LISTEN : approve_summary          { report_id }
    // EMIT   : summary_approved_by_user → entire room (each individual approval)
    // EMIT   : summary_fully_approved   → entire room (when both have approved)
    requireAuth("approve_summary", async ({ report_id }, callback) => {
      if (!report_id) {
        socket.emit("error", { message: "report_id is required" });
        return;
      }

      const room = await Room.findOne({ report_id });
      if (!room) {
        socket.emit("error", { message: "Room not found for this report" });
        if (callback) callback({ success: false, message: "Room not found" });
        return;
      }

      // Must be a member
      const isMember = room.members.some(
        m => m.user_id.toString() === socket.userId.toString()
      );
      if (!isMember) {
        socket.emit("error", { message: "You are not a member of this room" });
        if (callback) callback({ success: false, message: "Not a member" });
        return;
      }

      // Already approved by this user?
      const alreadyApproved = room.summary_approvals.some(
        a => a.user_id.toString() === socket.userId.toString()
      );
      if (alreadyApproved) {
        socket.emit("error", { message: "You have already approved the summary" });
        if (callback) callback({ success: false, message: "Already approved" });
        return;
      }

      room.summary_approvals.push({ user_id: socket.userId });

      const approvedCount = room.summary_approvals.length;
      const totalMembers  = room.members.length;
      const fullyApproved = approvedCount >= totalMembers && totalMembers === 2;

      if (fullyApproved) room.summary_fully_approved = true;
      await room.save();

      // EVENT 1 — single approval, both users see it
      io.to(report_id.toString()).emit("summary_approved_by_user", {
        room_id:  room._id,
        report_id,
        approved_by: {
          _id:       socket.userId,
          firstName: socket.user.firstName,
          lastName:  socket.user.lastName,
          email:     socket.user.email
        },
        approvals_so_far: approvedCount,
        total_members:    totalMembers,
        approved_at:      new Date()
      });
      console.log(`[Major][EMIT] summary_approved_by_user | to room: ${report_id} | by: ${socket.user.email} | (${approvedCount}/${totalMembers})`);

      // EVENT 2 — both approved, summary is now locked
      if (fullyApproved) {
        io.to(report_id.toString()).emit("summary_fully_approved", {
          room_id:     room._id,
          report_id,
          message:     "Both users have approved the summary. It is now locked.",
          approved_at: new Date()
        });
        console.log(`[Major][EMIT] summary_fully_approved | to room: ${report_id} | locked`);
      }

      if (callback) {
        callback({
          success:          true,
          fully_approved:   fullyApproved,
          approvals_so_far: approvedCount
        });
      }
    });

    // ─── DISCONNECT ───────────────────────────────────────────────────────────
    socket.on("disconnect", (reason) => {
      console.log(`\n[Major] DISCONNECT: ${socket.id} - Reason: ${reason}\n`);
      if (socket.currentReport && socket.authenticated) {
        socket.to(socket.currentReport).emit("user_offline", {
          user_id:   socket.userId,
          user_name: socket.user ? `${socket.user.firstName} ${socket.user.lastName}` : "Unknown",
          reason,
          timestamp: new Date()
        });
        console.log(`[Major][EMIT] user_offline | to room: ${socket.currentReport} | user: ${socket.user?.email}`);
      }
    });

    socket.on("error", (error) => {
      console.error(`[Major] Socket error: ${socket.id}`, error);
    });
  });
};