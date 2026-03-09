import OfficialDispute from "../models/OfficialDispute.js";
import DisputeMessage from "../models/DisputeMessage.js";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


export const setupDisputeSocket = (io) => {
  console.log("Setting up FULL WebSocket dispute handlers...");

  // AUTHENTICATION MIDDLEWARE
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded._id;
        socket.user = await User.findById(decoded._id).select('firstName lastName email');
        if (socket.user) {
          socket.authenticated = true;
          console.log(`Socket authenticated: ${socket.user.email}`);
          return next();
        }
      }
      socket.authenticated = false;
      console.log("Socket connected without auth");
      next();
    } catch (err) {
      socket.authenticated = false;
      console.log("Socket auth failed");
      next();
    }
  });

  // CONNECTION EVENT
  io.on("connection", (socket) => {
    console.log(`\nNEW CONNECTION: ${socket.id} (Auth: ${socket.authenticated})\n`);

    // Helper to require authentication before handling any event
    const requireAuth = (eventName, handler) => {
      socket.on(eventName, async (...args) => {
        if (!socket.authenticated) {
          socket.emit("error", {
            message: "Not authenticated",
            event: eventName
          });
          return;
        }
        try {
          await handler(...args);
        } catch (error) {
          console.error(`Error in ${eventName}:`, error);
          socket.emit("error", {
            message: `Error in ${eventName}`,
            error: error.message
          });
        }
      });
    };

    // ============================================
    // JOIN DISPUTE ROOM
    // ============================================
    requireAuth("join_dispute", async ({ dispute_id }) => {
      console.log(`Join request: ${dispute_id} from ${socket.user.email}`);

      const dispute = await OfficialDispute.findById(dispute_id)
        .populate('creator_id', 'firstName lastName email')
        .populate('joiner_id', 'firstName lastName email');

      if (!dispute) {
        socket.emit("error", { message: "Dispute not found" });
        return;
      }

      const isCreator = dispute.creator_id._id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?._id.toString() === socket.userId;

      if (!isCreator && !isJoiner) {
        socket.emit("error", { message: "Not authorized to join this dispute" });
        return;
      }

      socket.join(dispute_id);
      socket.currentDispute = dispute_id;
      socket.userRole = isCreator ? "creator" : "joiner";

      console.log(`${socket.user.email} joined room ${dispute_id} as ${socket.userRole}`);

      // Send full dispute state to the user who just joined
      socket.emit("dispute_state", {
        dispute,
        user_role: socket.userRole,
        is_creator: isCreator,
        is_joiner: isJoiner,
        audio_count: dispute.conversation.audio_count,
        status: dispute.status,
        timestamp: new Date()
      });

      // Notify the other party
      socket.to(dispute_id).emit("user_online", {
        user_id: socket.userId,
        user_role: socket.userRole,
        user_name: `${socket.user.firstName} ${socket.user.lastName}`,
        timestamp: new Date()
      });
    });

    // ============================================
    // SEND TEXT MESSAGE
    // ============================================
    requireAuth("send_message", async ({ dispute_id, text_content }, callback) => {
      console.log(`Message from ${socket.user.email}: "${text_content?.substring(0, 30)}..."`);

      try {
        if (!text_content?.trim()) {
          const error = { success: false, message: "Message cannot be empty" };
          if (callback) callback(error);
          socket.emit("message_error", error);
          return;
        }

        const dispute = await OfficialDispute.findById(dispute_id);
        if (!dispute) {
          const error = { success: false, message: "Dispute not found" };
          if (callback) callback(error);
          socket.emit("message_error", error);
          return;
        }

        if (dispute.status !== "CONVERSATION") {
          const error = { success: false, message: "Not in conversation phase" };
          if (callback) callback(error);
          socket.emit("message_error", error);
          return;
        }

        const isCreator = dispute.creator_id.toString() === socket.userId;
        const isJoiner = dispute.joiner_id?.toString() === socket.userId;

        if (!isCreator && !isJoiner) {
          const error = { success: false, message: "Not a participant" };
          if (callback) callback(error);
          socket.emit("message_error", error);
          return;
        }

        const senderRole = isCreator ? "creator" : "joiner";

        const message = await DisputeMessage.create({
          dispute_id,
          sender_id: socket.userId,
          sender_role: senderRole,
          message_type: "text",
          text_content: text_content.trim(),
          status: "sent"
        });

        dispute.conversation.messages.push(message._id);
        await dispute.save();

        await message.populate('sender_id', 'firstName lastName email');

        console.log(`Message saved: ${message._id}`);

        if (callback) callback({ success: true, message, timestamp: new Date() });

        // Broadcast to entire room including sender for UI consistency
        io.to(dispute_id).emit("new_message", {
          message,
          sender_role: senderRole,
          timestamp: new Date()
        });

        console.log(`Message broadcast to room ${dispute_id}`);

      } catch (error) {
        console.error("Send message error:", error);
        const errorResponse = {
          success: false,
          message: "Failed to send message",
          error: error.message
        };
        if (callback) callback(errorResponse);
        socket.emit("message_error", errorResponse);
      }
    });

    // ============================================
    // SEND AUDIO MESSAGE
    // ============================================
    requireAuth("send_audio", async ({ dispute_id, audio_data, duration }, callback) => {
      console.log(`Audio from ${socket.user.email}: ${duration}s`);

      try {
        if (!audio_data) {
          const error = { success: false, message: "No audio data provided" };
          if (callback) callback(error);
          return;
        }

        const dispute = await OfficialDispute.findById(dispute_id);
        if (!dispute) {
          const error = { success: false, message: "Dispute not found" };
          if (callback) callback(error);
          return;
        }

        if (dispute.status !== "CONVERSATION") {
          const error = { success: false, message: "Not in conversation phase" };
          if (callback) callback(error);
          return;
        }

        const isCreator = dispute.creator_id.toString() === socket.userId;
        const isJoiner = dispute.joiner_id?.toString() === socket.userId;

        if (!isCreator && !isJoiner) {
          const error = { success: false, message: "Not a participant" };
          if (callback) callback(error);
          return;
        }

        const senderRole = isCreator ? "creator" : "joiner";
        const currentCount = dispute.conversation.audio_count[senderRole] || 0;

        if (currentCount >= 5) {
          const error = {
            success: false,
            message: "Maximum 5 audio messages allowed. You've reached the limit."
          };
          if (callback) callback(error);
          return;
        }

        // Save audio to disk
        const uploadsDir = path.join(__dirname, "../../uploads");
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const filename = `audio-${uniqueSuffix}.webm`;
        const filePath = path.join(uploadsDir, filename);

        let base64Data = audio_data;
        if (base64Data.includes("base64,")) base64Data = base64Data.split("base64,")[1];

        fs.writeFileSync(filePath, Buffer.from(base64Data, 'base64'));

        const message = await DisputeMessage.create({
          dispute_id,
          sender_id: socket.userId,
          sender_role: senderRole,
          message_type: "audio",
          audio_data: {
            file_path: filePath,
            original_name: "voice_message.webm",
            mimetype: "audio/webm",
            size: Buffer.from(base64Data, 'base64').length,
            duration: duration || 30
          },
          status: "sent"
        });

        dispute.conversation.messages.push(message._id);
        dispute.conversation.audio_count[senderRole] = currentCount + 1;
        await dispute.save();

        await message.populate('sender_id', 'firstName lastName email');

        if (callback) {
          callback({
            success: true,
            message,
            remaining_audios: 5 - dispute.conversation.audio_count[senderRole],
            timestamp: new Date()
          });
        }

        io.to(dispute_id).emit("new_message", {
          message,
          sender_role: senderRole,
          audio_count: dispute.conversation.audio_count,
          remaining: 5 - dispute.conversation.audio_count[senderRole],
          timestamp: new Date()
        });

        console.log(`Audio message broadcast to room ${dispute_id}`);

      } catch (error) {
        console.error("Send audio error:", error);
        if (callback) callback({ success: false, message: "Failed to send audio", error: error.message });
      }
    });

    // ============================================
    // TYPING INDICATORS
    // ============================================
    requireAuth("typing", ({ dispute_id }) => {
      socket.to(dispute_id).emit("user_typing", {
        user_id: socket.userId,
        user_role: socket.userRole,
        user_name: `${socket.user.firstName} ${socket.user.lastName}`,
        timestamp: new Date()
      });
    });

    requireAuth("stop_typing", ({ dispute_id }) => {
      socket.to(dispute_id).emit("user_stop_typing", {
        user_id: socket.userId,
        user_role: socket.userRole,
        timestamp: new Date()
      });
    });

    // ============================================
    // MESSAGE STATUS UPDATES (WhatsApp-like)
    // ============================================
    requireAuth("message_delivered", async ({ message_id, dispute_id }) => {
      await DisputeMessage.findByIdAndUpdate(message_id, {
        status: "delivered",
        delivered_at: new Date()
      });

      socket.to(dispute_id).emit("message_status_update", {
        message_id,
        status: "delivered",
        timestamp: new Date()
      });
    });

    requireAuth("message_read", async ({ message_id, dispute_id }) => {
      await DisputeMessage.findByIdAndUpdate(message_id, {
        status: "read",
        read_at: new Date()
      });

      socket.to(dispute_id).emit("message_status_update", {
        message_id,
        status: "read",
        timestamp: new Date()
      });
    });

    // ============================================
    // AUDIO RECORDING INDICATORS
    // ============================================
    requireAuth("audio_recording_start", ({ dispute_id }) => {
      socket.to(dispute_id).emit("user_recording_audio", {
        user_id: socket.userId,
        user_role: socket.userRole,
        user_name: `${socket.user.firstName} ${socket.user.lastName}`,
        timestamp: new Date()
      });
    });

    requireAuth("audio_recording_stop", ({ dispute_id }) => {
      socket.to(dispute_id).emit("user_stopped_recording", {
        user_id: socket.userId,
        user_role: socket.userRole,
        timestamp: new Date()
      });
    });

    // ============================================
    // LEAVE DISPUTE ROOM
    // ============================================
    requireAuth("leave_dispute", ({ dispute_id }) => {
      socket.leave(dispute_id);
      socket.to(dispute_id).emit("user_left", {
        user_id: socket.userId,
        user_role: socket.userRole,
        user_name: `${socket.user.firstName} ${socket.user.lastName}`,
        timestamp: new Date()
      });
      socket.currentDispute = null;
      socket.userRole = null;
      console.log(`${socket.user.email} left dispute`);
    });

    // ============================================
    // DISCONNECT
    // ============================================
    socket.on("disconnect", (reason) => {
      console.log(`\nDISCONNECT: ${socket.id} - Reason: ${reason}\n`);
      if (socket.currentDispute && socket.authenticated) {
        socket.to(socket.currentDispute).emit("user_offline", {
          user_id: socket.userId,
          user_role: socket.userRole,
          user_name: socket.user ? `${socket.user.firstName} ${socket.user.lastName}` : "Unknown",
          reason,
          timestamp: new Date()
        });
      }
    });

    socket.on("error", (error) => {
      console.error(`Socket error: ${socket.id}`, error);
    });
  });
};