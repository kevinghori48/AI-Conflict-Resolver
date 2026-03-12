import OfficialDispute from "../models/OfficialDispute.js";
import DisputeMessage from "../models/DisputeMessage.js";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { generateAISummary, generateFinalPlan } from "../controllers/officialDisputeController.js";

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

    // JOIN DISPUTE ROOM
    requireAuth("join_dispute", async ({ dispute_id, invite_code }) => {
      const joinRef = dispute_id || invite_code;
      console.log(`Join request: ${joinRef} from ${socket.user.email}`);

      let disputeQuery;
      if (dispute_id) {
        disputeQuery = OfficialDispute.findById(dispute_id);
      } else if (invite_code) {
        disputeQuery = OfficialDispute.findOne({ invite_code: invite_code.toUpperCase() });
      } else {
        socket.emit("error", { message: "dispute_id or invite_code is required" });
        return;
      }

      const dispute = await disputeQuery
        .populate("creator_id", "firstName lastName email")
        .populate("joiner_id", "firstName lastName email");

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

      const roomId = dispute._id.toString();
      socket.join(roomId);
      socket.currentDispute = roomId;
      socket.userRole = isCreator ? "creator" : "joiner";

      console.log(`${socket.user.email} joined room ${roomId} as ${socket.userRole}`);

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
      socket.to(roomId).emit("user_online", {
        user_id: socket.userId,
        user_role: socket.userRole,
        user_name: `${socket.user.firstName} ${socket.user.lastName}`,
        timestamp: new Date()
      });
    });

    // END CONVERSATION
    requireAuth("end_conversation", async ({ dispute_id }, callback) => {
      console.log(`Conversation ended for dispute ${dispute_id} by ${socket.user.email}`);
      console.log(`Socket ID: ${socket.id}`);
      console.log(`Timestamp: ${new Date().toISOString()}`);
      const dispute = await OfficialDispute.findById(dispute_id);
      if (!dispute) {
        console.log(`[Error] Dispute not found: ${dispute_id}`);
        if (callback) callback({ success: false, message: "Dispute not found" });
        return;
      }
      if (dispute.status !== "CONVERSATION") {
        console.log(`[Error] Wrong status: ${dispute.status} (expected CONVERSATION)`);
        if (callback) callback({ success: false, message: "Conversation already ended or not started" });
        return;
      }
      const isParticipant =
        dispute.creator_id.toString() === socket.userId ||
        dispute.joiner_id?.toString() === socket.userId;
      if (!isParticipant) {
        console.log(`[Error] Not a participant: ${socket.userId}`);
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }
      dispute.conversation.ended_by = socket.userId;
      dispute.conversation.ended_at = new Date();
      dispute.status = "AI_SUMMARIZING";
      await dispute.save();
      console.log(`[Success] Status updated to AI_SUMMARIZING`);
      console.log(`[Success] Emitting conversation_ended to room: ${dispute_id}`);
      io.to(dispute_id).emit("conversation_ended", {
        ended_by: socket.userId,
        ended_by_role: socket.userRole,
        status: "AI_SUMMARIZING",
        message: "Conversation ended. AI is generating summary...",
        timestamp: new Date()
      });
      if (callback) callback({ success: true, status: "AI_SUMMARIZING" });
      const disputeIdString = dispute._id.toString();
      console.log(`[Wait] Starting summary generation in 1s for dispute: ${disputeIdString}`);
      setTimeout(async () => {
        try {
          console.log(`[AI] Calling generateAISummary for dispute: ${disputeIdString}`);
          const freshDispute = await OfficialDispute.findById(disputeIdString);
          if (!freshDispute) {
            console.error(`[Error] Fresh dispute not found: ${disputeIdString}`);
            return;
          }

          await generateAISummary(freshDispute, disputeIdString, io); 
          console.log(`[Success] Summary generation completed for dispute: ${disputeIdString}`);
        } catch (error) {
          console.error(`[Error] Summary generation failed for dispute ${disputeIdString}:`, error);
          io.to(disputeIdString).emit("summary_generation_failed", {
            message: "Failed to generate summary. Please try again.",
            error: error.message
          });
        }
      }, 1000);
    });

    // SEND TEXT MESSAGE
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

    // SEND AUDIO MESSAGE
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

    const getRoomDisputeId = (payload) => payload?.dispute_id || socket.currentDispute;

    // ACCEPT SUGGESTED PLAN (Socket version)
    requireAuth("accept_suggested_plan", async ({ dispute_id }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      if (!roomId) {
        if (callback) callback({ success: false, message: "dispute_id is required" });
        return;
      }

      const dispute = await OfficialDispute.findById(roomId);
      if (!dispute) {
        if (callback) callback({ success: false, message: "Dispute not found" });
        return;
      }

      if (dispute.status !== "SUGGESTED_PLAN_REVIEW") {
        if (callback) callback({ success: false, message: "No suggested plan available for acceptance" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?.toString() === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      if (isCreator && dispute.suggested_plan_approval?.creator_approved) {
        if (callback) callback({ success: false, message: "You have already accepted the plan" });
        return;
      }
      if (isJoiner && dispute.suggested_plan_approval?.joiner_approved) {
        if (callback) callback({ success: false, message: "You have already accepted the plan" });
        return;
      }

      if (isCreator) dispute.suggested_plan_approval.creator_approved = true;
      else dispute.suggested_plan_approval.joiner_approved = true;

      await dispute.save();

      if (dispute.suggested_plan_approval.creator_approved && dispute.suggested_plan_approval.joiner_approved) {
        dispute.status = "COMPLETED";
        dispute.completed_at = new Date();
        dispute.final_plan = dispute.suggested_plan;
        dispute.final_plan_approval = { creator_approved: true, joiner_approved: true };
        await dispute.save();

        io.to(roomId).emit("dispute_completed", {
          status: "COMPLETED",
          final_plan: dispute.final_plan,
          message: "Both parties accepted the suggested plan. Dispute resolved successfully!",
          timestamp: new Date()
        });

        if (callback) {
          callback({ success: true, status: "COMPLETED", final_plan: dispute.final_plan });
        }
        return;
      }

      io.to(roomId).emit("suggested_plan_approval_update", {
        creator_approved: dispute.suggested_plan_approval.creator_approved,
        joiner_approved: dispute.suggested_plan_approval.joiner_approved,
        message: "Acceptance recorded. Waiting for other party.",
        timestamp: new Date()
      });

      if (callback) {
        callback({
          success: true,
          status: dispute.status,
          creator_approved: dispute.suggested_plan_approval.creator_approved,
          joiner_approved: dispute.suggested_plan_approval.joiner_approved
        });
      }
    });

    // REJECT SUGGESTED PLAN → START NEGOTIATION (Socket version)
    requireAuth("reject_suggested_plan", async ({ dispute_id, reason }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      if (!roomId) {
        if (callback) callback({ success: false, message: "dispute_id is required" });
        return;
      }

      const dispute = await OfficialDispute.findById(roomId);
      if (!dispute) {
        if (callback) callback({ success: false, message: "Dispute not found" });
        return;
      }

      if (dispute.status !== "SUGGESTED_PLAN_REVIEW") {
        if (callback) callback({ success: false, message: "No suggested plan to reject" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?.toString() === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      dispute.suggested_plan_approval = { creator_approved: false, joiner_approved: false };
      dispute.status = "NEGOTIATION";
      await dispute.save();

      io.to(roomId).emit("negotiation_started", {
        status: "NEGOTIATION",
        rejected_by: isCreator ? "creator" : "joiner",
        reason: reason || "Party wants to negotiate further",
        suggested_plan: dispute.suggested_plan,
        creator_selections: dispute.solution_selections.creator_selected,
        joiner_selections: dispute.solution_selections.joiner_selected,
        message: "Suggested plan rejected. Starting negotiation round.",
        timestamp: new Date()
      });

      if (callback) callback({ success: true, status: "NEGOTIATION" });
    });

    // POST NEGOTIATION COMMENT (Socket version)
    requireAuth("post_negotiation_comment", async ({ dispute_id, text }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      if (!roomId) {
        if (callback) callback({ success: false, message: "dispute_id is required" });
        return;
      }
      if (!text || text.trim() === "") {
        if (callback) callback({ success: false, message: "Comment text is required" });
        return;
      }

      const dispute = await OfficialDispute.findById(roomId);
      if (!dispute) {
        if (callback) callback({ success: false, message: "Dispute not found" });
        return;
      }
      if (dispute.status !== "NEGOTIATION") {
        if (callback) callback({ success: false, message: "Dispute is not in negotiation phase" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?.toString() === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      const senderRole = isCreator ? "creator" : "joiner";
      const comment = {
        sender_id: socket.userId,
        sender_role: senderRole,
        text: text.trim(),
        timestamp: new Date()
      };

      dispute.negotiation.comments.push(comment);
      dispute.negotiation.creator_ready = false;
      dispute.negotiation.joiner_ready = false;
      await dispute.save();

      const savedComment = dispute.negotiation.comments[dispute.negotiation.comments.length - 1];

      io.to(roomId).emit("new_negotiation_comment", {
        comment: {
          ...savedComment.toObject?.(),
          ...(!savedComment.toObject ? savedComment : {}),
          sender_name: `${socket.user.firstName} ${socket.user.lastName}`
        },
        creator_ready: false,
        joiner_ready: false,
        timestamp: new Date()
      });

      if (callback) callback({ success: true, comment: savedComment });
    });

    // SIGNAL AGREEMENT (Socket version) → triggers final plan generation
    requireAuth("signal_agreement", async ({ dispute_id }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      if (!roomId) {
        if (callback) callback({ success: false, message: "dispute_id is required" });
        return;
      }

      const dispute = await OfficialDispute.findById(roomId);
      if (!dispute) {
        if (callback) callback({ success: false, message: "Dispute not found" });
        return;
      }
      if (dispute.status !== "NEGOTIATION") {
        if (callback) callback({ success: false, message: "Dispute is not in negotiation phase" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?.toString() === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      if (isCreator) dispute.negotiation.creator_ready = true;
      else dispute.negotiation.joiner_ready = true;
      await dispute.save();

      if (dispute.negotiation.creator_ready && dispute.negotiation.joiner_ready) {
        dispute.status = "AI_SUMMARIZING";
        await dispute.save();

        io.to(roomId).emit("generating_final_plan", {
          status: "AI_SUMMARIZING",
          message: "Both parties agreed. AI is constructing the final resolution plan...",
          timestamp: new Date()
        });

        const disputeIdString = dispute._id.toString();
        setTimeout(async () => {
          try {
            const freshDispute = await OfficialDispute.findById(disputeIdString);
            if (!freshDispute) return;
            await generateFinalPlan(freshDispute, disputeIdString, io);
          } catch (error) {
            console.error("Final plan generation failed:", error);
            const rollback = await OfficialDispute.findById(disputeIdString);
            if (rollback) {
              rollback.status = "NEGOTIATION";
              await rollback.save();
            }
            io.to(disputeIdString).emit("final_plan_failed", {
              message: "Failed to generate final plan. Please try again.",
              error: error.message
            });
          }
        }, 1000);

        if (callback) callback({ success: true, status: "AI_SUMMARIZING" });
        return;
      }

      io.to(roomId).emit("agreement_update", {
        creator_ready: dispute.negotiation.creator_ready,
        joiner_ready: dispute.negotiation.joiner_ready,
        message: "Agreement signal recorded. Waiting for other party.",
        timestamp: new Date()
      });

      if (callback) {
        callback({
          success: true,
          status: dispute.status,
          creator_ready: dispute.negotiation.creator_ready,
          joiner_ready: dispute.negotiation.joiner_ready
        });
      }
    });

    // GET SUGGESTED PLAN (Socket version)
    requireAuth("get_suggested_plan", async ({ dispute_id }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      if (!roomId) {
        if (callback) callback({ success: false, message: "dispute_id is required" });
        return;
      }

      const dispute = await OfficialDispute.findById(roomId);
      if (!dispute) {
        if (callback) callback({ success: false, message: "Dispute not found" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?.toString() === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not authorized" });
        return;
      }

      if (!dispute.suggested_plan || !dispute.suggested_plan.title) {
        if (callback) callback({ success: false, message: "Suggested plan not generated yet" });
        return;
      }

      if (callback) {
        callback({
          success: true,
          status: dispute.status,
          suggested_plan: dispute.suggested_plan,
          approval: {
            creator_approved: dispute.suggested_plan_approval?.creator_approved || false,
            joiner_approved: dispute.suggested_plan_approval?.joiner_approved || false,
            your_approval: isCreator
              ? dispute.suggested_plan_approval?.creator_approved
              : dispute.suggested_plan_approval?.joiner_approved
          }
        });
      }
    });

    // GET NEGOTIATION COMMENTS (Socket version)
    requireAuth("get_negotiation_comments", async ({ dispute_id }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      if (!roomId) {
        if (callback) callback({ success: false, message: "dispute_id is required" });
        return;
      }

      const dispute = await OfficialDispute.findById(roomId)
        .populate("negotiation.comments.sender_id", "firstName lastName email");
      if (!dispute) {
        if (callback) callback({ success: false, message: "Dispute not found" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?.toString() === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not authorized" });
        return;
      }

      if (callback) {
        callback({
          success: true,
          status: dispute.status,
          comments: dispute.negotiation.comments,
          creator_ready: dispute.negotiation.creator_ready,
          joiner_ready: dispute.negotiation.joiner_ready,
          count: dispute.negotiation.comments.length
        });
      }
    });

    // APPROVE FINAL PLAN (Socket version)
    requireAuth("approve_final_plan", async ({ dispute_id }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      if (!roomId) {
        if (callback) callback({ success: false, message: "dispute_id is required" });
        return;
      }

      const dispute = await OfficialDispute.findById(roomId);
      if (!dispute) {
        if (callback) callback({ success: false, message: "Dispute not found" });
        return;
      }

      if (dispute.status !== "FINAL_PLAN_REVIEW") {
        if (callback) callback({ success: false, message: "Final plan is not ready for approval" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?.toString() === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not authorized to approve this plan" });
        return;
      }

      if (isCreator && dispute.final_plan_approval.creator_approved) {
        if (callback) callback({ success: false, message: "You have already approved the plan" });
        return;
      }
      if (isJoiner && dispute.final_plan_approval.joiner_approved) {
        if (callback) callback({ success: false, message: "You have already approved the plan" });
        return;
      }

      if (isCreator) dispute.final_plan_approval.creator_approved = true;
      else dispute.final_plan_approval.joiner_approved = true;

      await dispute.save();

      if (dispute.final_plan_approval.creator_approved && dispute.final_plan_approval.joiner_approved) {
        dispute.status = "COMPLETED";
        dispute.completed_at = new Date();
        await dispute.save();

        io.to(roomId).emit("dispute_completed", {
          status: "COMPLETED",
          final_plan: dispute.final_plan,
          message: "Both parties approved the plan. Dispute resolved successfully!",
          timestamp: new Date()
        });

        if (callback) callback({ success: true, status: "COMPLETED", final_plan: dispute.final_plan });
        return;
      }

      io.to(roomId).emit("plan_approval_update", {
        creator_approved: dispute.final_plan_approval.creator_approved,
        joiner_approved: dispute.final_plan_approval.joiner_approved,
        message: "Approval recorded. Waiting for other party.",
        timestamp: new Date()
      });

      if (callback) {
        callback({
          success: true,
          status: dispute.status,
          creator_approved: dispute.final_plan_approval.creator_approved,
          joiner_approved: dispute.final_plan_approval.joiner_approved
        });
      }
    });

    // GET FINAL PLAN (Socket version)
    requireAuth("get_final_plan", async ({ dispute_id }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      if (!roomId) {
        if (callback) callback({ success: false, message: "dispute_id is required" });
        return;
      }

      const dispute = await OfficialDispute.findById(roomId);
      if (!dispute) {
        if (callback) callback({ success: false, message: "Dispute not found" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?.toString() === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not authorized" });
        return;
      }

      if (!dispute.final_plan || !dispute.final_plan.title) {
        if (callback) callback({ success: false, message: "Final plan not generated yet" });
        return;
      }

      if (callback) {
        callback({
          success: true,
          status: dispute.status,
          final_plan: dispute.final_plan,
          approval: {
            creator_approved: dispute.final_plan_approval?.creator_approved || false,
            joiner_approved: dispute.final_plan_approval?.joiner_approved || false,
            your_approval: isCreator
              ? dispute.final_plan_approval?.creator_approved
              : dispute.final_plan_approval?.joiner_approved
          }
        });
      }
    });

    // REPORT FINAL PLAN ISSUE (Socket version)
    // Matches HTTP behavior: stores feedback; counts as implicit approval so dispute can complete.
    requireAuth("report_final_plan_issue", async ({ dispute_id, feedback }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      if (!roomId) {
        if (callback) callback({ success: false, message: "dispute_id is required" });
        return;
      }
      if (!feedback || feedback.trim() === "") {
        if (callback) callback({ success: false, message: "Please provide feedback about the issue" });
        return;
      }

      const dispute = await OfficialDispute.findById(roomId);
      if (!dispute) {
        if (callback) callback({ success: false, message: "Dispute not found" });
        return;
      }

      if (dispute.status !== "FINAL_PLAN_REVIEW" && dispute.status !== "COMPLETED") {
        if (callback) callback({ success: false, message: "No final plan to report on" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?.toString() === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      dispute.final_plan_reports.push({
        reporter_id: socket.userId,
        reporter_role: isCreator ? "creator" : "joiner",
        feedback: feedback.trim(),
        reported_at: new Date()
      });

      // Reporting also approves on behalf of this user
      if (isCreator) dispute.final_plan_approval.creator_approved = true;
      else dispute.final_plan_approval.joiner_approved = true;

      // Complete if both approved/reported
      if (dispute.final_plan_approval.creator_approved && dispute.final_plan_approval.joiner_approved) {
        dispute.status = "COMPLETED";
        dispute.completed_at = dispute.completed_at || new Date();
      }

      await dispute.save();

      io.to(roomId).emit("final_plan_issue_reported", {
        status: dispute.status,
        reporter_role: isCreator ? "creator" : "joiner",
        feedback: feedback.trim(),
        timestamp: new Date()
      });

      if (dispute.status === "COMPLETED") {
        io.to(roomId).emit("dispute_completed", {
          status: "COMPLETED",
          final_plan: dispute.final_plan,
          message: "Dispute has been closed.",
          timestamp: new Date()
        });
      }

      if (callback) {
        callback({
          success: true,
          status: dispute.status,
          message: "Issue reported. Thank you for your feedback."
        });
      }
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

    // LEAVE DISPUTE ROOM
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

    // DISCONNECT
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