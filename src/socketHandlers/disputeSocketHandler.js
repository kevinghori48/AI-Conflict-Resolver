import OfficialDispute from "../models/OfficialDispute.js";
import DisputeMessage from "../models/DisputeMessage.js";
import jwt from "jsonwebtoken";
import User from "../models/User.js";

export const setupDisputeSocket = (io) => {
  console.log("Setting up dispute socket handlers...");

  // OPTIONAL AUTHENTICATION MIDDLEWARE (for clients that support handshake auth)
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded._id;
        socket.user = await User.findById(decoded._id).select('firstName lastName email');
        if (socket.user) {
          socket.authenticated = true;
          console.log(`Socket pre-authenticated: ${socket.user.email}`);
          return next();
        }
      }
      // Allow connection without auth, but require auth before other events
      socket.authenticated = false;
      console.log("Socket connected without auth (will require authenticate event)");
      next();
    } catch (err) {
      // Allow connection but not authenticated
      socket.authenticated = false;
      console.log("Socket auth failed, allowing unauthenticated connection");
      next();
    }
  });

  // CONNECTION EVENT
  io.on("connection", (socket) => {
    console.log(`\n🔌 NEW CONNECTION: ${socket.id} (Auth: ${socket.authenticated})\n`);

    // AUTHENTICATE EVENT (For Postman/Testing)
    socket.on("authenticate", async ({ token }) => {
      try {
        if (!token) {
          socket.emit("error", { message: "No token provided" });
          return;
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded._id;
        socket.user = await User.findById(decoded._id).select('firstName lastName email');

        if (!socket.user) {
          socket.emit("error", { message: "User not found" });
          return;
        }

        socket.authenticated = true;
        socket.emit("authenticated", {
          success: true,
          user: {
            id: socket.user._id,
            email: socket.user.email,
            name: `${socket.user.firstName} ${socket.user.lastName}`
          },
          message: "Authentication successful"
        });

        console.log(`Socket authenticated: ${socket.user.email} (${socket.id})`);

      } catch (error) {
        socket.emit("error", {
          message: "Authentication failed",
          error: error.message
        });
        console.error("Auth error:", error.message);
      }
    });

    // ============================================
    // MIDDLEWARE: Check authentication before other events
    // ============================================
    const requireAuth = (eventName, handler) => {
      socket.on(eventName, async (...args) => {
        if (!socket.authenticated) {
          socket.emit("error", {
            message: "Not authenticated. Please send 'authenticate' event first with your token.",
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

    // PING/PONG (Connection Test)
    socket.on("ping", () => {
      socket.emit("pong", {
        message: "Connection is alive",
        timestamp: new Date(),
        authenticated: socket.authenticated,
        user: socket.user ? socket.user.email : null
      });
    });

    // JOIN DISPUTE ROOM
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

      socket.emit("dispute_state", {
        dispute,
        user_role: socket.userRole,
        is_creator: isCreator,
        is_joiner: isJoiner,
        audio_count: dispute.conversation.audio_count,
        status: dispute.status,
        timestamp: new Date()
      });

      socket.to(dispute_id).emit("user_online", {
        user_id: socket.userId,
        user_role: socket.userRole,
        user_name: `${socket.user.firstName} ${socket.user.lastName}`,
        timestamp: new Date()
      });
    });

    // SEND TEXT MESSAGE (REAL-TIME)
    requireAuth("send_message", async ({ dispute_id, text_content }) => {
      console.log(`Message from ${socket.user.email}: "${text_content.substring(0, 30)}..."`);

      if (!text_content?.trim()) {
        socket.emit("error", { message: "Message cannot be empty" });
        return;
      }

      const dispute = await OfficialDispute.findById(dispute_id);
      if (!dispute) {
        socket.emit("error", { message: "Dispute not found" });
        return;
      }

      if (dispute.status !== "CONVERSATION") {
        socket.emit("error", { message: "Not in conversation phase" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?.toString() === socket.userId;

      if (!isCreator && !isJoiner) {
        socket.emit("error", { message: "Not a participant" });
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

      // Broadcast to entire room (including sender)
      io.to(dispute_id).emit("new_message", {
        message,
        sender_role: senderRole,
        timestamp: new Date()
      });

      console.log(`Message saved & broadcast: ${message._id}`);
    });

    // TYPING INDICATORS
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

    // MESSAGE STATUS UPDATES
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

    // AUDIO RECORDING INDICATORS
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

    // REQUEST MESSAGE HISTORY
    requireAuth("request_messages", async ({ dispute_id, limit = 50, before }) => {
      const query = { dispute_id };
      if (before) {
        query.timestamp = { $lt: new Date(before) };
      }

      const messages = await DisputeMessage.find(query)
        .populate('sender_id', 'firstName lastName email')
        .sort({ timestamp: -1 })
        .limit(limit);

      socket.emit("messages_loaded", {
        messages: messages.reverse(),
        count: messages.length,
        has_more: messages.length === limit,
        timestamp: new Date()
      });

      console.log(`Sent ${messages.length} messages to ${socket.user.email}`);
    });

    // END CONVERSATION
    requireAuth("end_conversation", async ({ dispute_id }) => {
      const dispute = await OfficialDispute.findById(dispute_id);
      if (!dispute) {
        socket.emit("error", { message: "Dispute not found" });
        return;
      }

      if (dispute.status !== "CONVERSATION") {
        socket.emit("error", { message: "Conversation already ended" });
        return;
      }

      dispute.conversation.ended_by = socket.userId;
      dispute.conversation.ended_at = new Date();
      dispute.status = "AI_SUMMARIZING";
      await dispute.save();

      io.to(dispute_id).emit("conversation_ended", {
        ended_by: socket.userId,
        ended_by_role: socket.userRole,
        status: "AI_SUMMARIZING",
        message: "Conversation ended. AI is generating summary...",
        timestamp: new Date()
      });

      console.log(`Conversation ended by ${socket.userRole}`);
    });

    // ============================================
    // LEAVE DISPUTE
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
          reason: reason,
          timestamp: new Date()
        });
      }
    });

    socket.on("error", (error) => {
      console.error(`Socket error: ${socket.id}`, error);
    });
  });

  io.on("connect_error", (error) => {
    console.error("Connection error:", error);
  });

  console.log("Dispute socket handlers ready\n");
};