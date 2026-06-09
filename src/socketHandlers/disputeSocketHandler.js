import OfficialDispute from "../models/OfficialDispute.js";
import DisputeMessage from "../models/DisputeMessage.js";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import MultimodalAnalysis from "../models/MultimodalAnalysis.js";
import MultimodalChat from "../models/MultimodalChat.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import {
  buildDisputeTranscriptForAI,
  generateAISummary,
  generateFinalPlan,
  generateSuggestedPlan,
  generateSolutions
} from "../controllers/officialDisputeController.js";


export const setupDisputeSocket = (io) => {
  console.log("Setting up FULL WebSocket dispute handlers...");

  // AUTHENTICATION MIDDLEWARE
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded._id;
        socket.user = await User.findById(decoded._id).select('firstName lastName email avatarId gender');
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

    const requireAuth = (eventName, handler) => {
      socket.on(eventName, async (...args) => {
        console.log(`[LISTEN] ${eventName} | user: ${socket.user?.email}`);
        if (!socket.authenticated) {
          socket.emit("error", { message: "Not authenticated", event: eventName });
          console.log(`[EMIT] error | not authenticated | event: ${eventName}`);
          return;
        }
        try {
          await handler(...args);
        } catch (error) {
          console.error(`Error in ${eventName}:`, error);
          socket.emit("error", { message: `Error in ${eventName}`, error: error.message });
          console.log(`[EMIT] error | handler exception | event: ${eventName}`);
        }
      });
    };

    const getRoomDisputeId = (payload) => payload?.dispute_id || socket.currentDispute;

    // ─── JOIN DISPUTE ROOM ────────────────────────────────────────────────────
    requireAuth("join_dispute", async ({ dispute_id, invite_code }) => {
      const joinRef = dispute_id || invite_code;

      let disputeQuery;
      if (dispute_id) {
        disputeQuery = OfficialDispute.findById(dispute_id);
      } else if (invite_code) {
        disputeQuery = OfficialDispute.findOne({ invite_code: invite_code.toUpperCase() });
      } else {
        socket.emit("error", { message: "dispute_id or invite_code is required" });
        console.log(`[EMIT] error | missing dispute_id or invite_code`);
        return;
      }

      const dispute = await disputeQuery
        .populate("creator_id", "firstName lastName email avatarId gender")
        .populate("joiner_id", "firstName lastName email avatarId gender");

      if (!dispute) {
        socket.emit("error", { message: "Dispute not found" });
        console.log(`[EMIT] error | dispute not found | ref: ${joinRef}`);
        return;
      }

      const isCreator = dispute.creator_id._id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?._id.toString() === socket.userId;

      if (!isCreator && !isJoiner) {
        socket.emit("error", { message: "Not authorized to join this dispute" });
        console.log(`[EMIT] error | not authorized | dispute: ${dispute._id}`);
        return;
      }

      const roomId = dispute._id.toString();
      socket.join(roomId);
      socket.currentDispute = roomId;
      socket.userRole = isCreator ? "creator" : "joiner";

      const creatorUser = dispute.creator_id
        ? {
            _id: dispute.creator_id._id,
            firstName: dispute.creator_id.firstName,
            lastName: dispute.creator_id.lastName,
            email: dispute.creator_id.email,
            avatarId: dispute.creator_id.avatarId ?? null,
            gender: dispute.creator_id.gender ?? null
          }
        : null;

      const joinerUser = dispute.joiner_id
        ? {
            _id: dispute.joiner_id._id,
            firstName: dispute.joiner_id.firstName,
            lastName: dispute.joiner_id.lastName,
            email: dispute.joiner_id.email,
            avatarId: dispute.joiner_id.avatarId ?? null,
            gender: dispute.joiner_id.gender ?? null
          }
        : null;

      const currentUser = isCreator ? creatorUser : joinerUser;
      const otherUser = isCreator ? joinerUser : creatorUser;

      console.log(`${socket.user.email} joined room ${roomId} as ${socket.userRole}`);

      socket.emit("dispute_state", {
        dispute,
        creator_user: creatorUser,
        joiner_user: joinerUser,
        current_user: currentUser,
        other_user: otherUser,
        user_role: socket.userRole,
        is_creator: isCreator,
        is_joiner: isJoiner,
        audio_count: dispute.conversation.audio_count,
        status: dispute.status,
        timestamp: new Date()
      });
      console.log(`[EMIT] dispute_state | to: ${socket.user.email} | dispute: ${roomId}`);

      // Notify User 1 immediately when User 2 joins for the first time
      if (isJoiner && dispute.status === "CONVERSATION") {
        socket.to(roomId).emit("joiner_connected", {
          joiner_id: socket.userId,
          joiner_name: `${socket.user.firstName} ${socket.user.lastName}`,
          joiner_email: socket.user.email,
          joiner_user: {
            _id:       socket.userId,
            firstName: socket.user.firstName,
            lastName:  socket.user.lastName,
            email:     socket.user.email,
            avatarId:  socket.user.avatarId ?? null,
            gender:    socket.user.gender   ?? null
          },
          creator_user: {
            _id:       dispute.creator_id._id,
            firstName: dispute.creator_id.firstName,
            lastName:  dispute.creator_id.lastName,
            email:     dispute.creator_id.email,
            avatarId:  dispute.creator_id.avatarId ?? null,
            gender:    dispute.creator_id.gender   ?? null
          },
          status: dispute.status,
          dispute_name: dispute.dispute_name,
          message: `${socket.user.firstName} has joined the dispute. You can start the conversation.`,
          timestamp: new Date()
        });
        console.log(`[EMIT] joiner_connected | to room: ${roomId} | joiner: ${socket.user.email}`);
      }

      socket.to(roomId).emit("user_online", {
        user_id:   socket.userId,
        user_role: socket.userRole,
        user_name: `${socket.user.firstName} ${socket.user.lastName}`,
        user: {
          _id:       socket.userId,
          firstName: socket.user.firstName,
          lastName:  socket.user.lastName,
          email:     socket.user.email,
          avatarId:  socket.user.avatarId ?? null,
          gender:    socket.user.gender   ?? null
        },
        timestamp: new Date()
      });
      console.log(`[EMIT] user_online | to room: ${roomId} | user: ${socket.user.email}`);
    });

    // ─── END CONVERSATION ─────────────────────────────────────────────────────
    requireAuth("end_conversation", async ({ dispute_id }, callback) => {
      const dispute = await OfficialDispute.findById(dispute_id);
      if (!dispute) {
        if (callback) callback({ success: false, message: "Dispute not found" });
        return;
      }
      if (dispute.status !== "CONVERSATION") {
        if (callback) callback({ success: false, message: "Conversation already ended or not started" });
        return;
      }
      const isParticipant =
        dispute.creator_id.toString() === socket.userId ||
        dispute.joiner_id?.toString() === socket.userId;
      if (!isParticipant) {
        if (callback) callback({ success: false, message: "Not a participant" });
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
      console.log(`[EMIT] conversation_ended | to room: ${dispute_id}`);

      if (callback) callback({ success: true, status: "AI_SUMMARIZING" });

      const disputeIdString = dispute._id.toString();
      setTimeout(async () => {
        try {
          console.log(`[CALL] generateAISummary | dispute: ${disputeIdString}`);
          const freshDispute = await OfficialDispute.findById(disputeIdString);
          if (!freshDispute) return;
          await generateAISummary(freshDispute, disputeIdString, io);
        } catch (error) {
          console.error(`[ERROR] generateAISummary failed | dispute: ${disputeIdString}`, error);
          io.to(disputeIdString).emit("summary_generation_failed", {
            message: "Failed to generate summary. Please try again.",
            error: error.message
          });
          console.log(`[EMIT] summary_generation_failed | to room: ${disputeIdString}`);
        }
      }, 1000);
    });

    // ─── SEND TEXT MESSAGE ────────────────────────────────────────────────────
    requireAuth("send_message", async ({ dispute_id, text_content }, callback) => {
      try {
        if (!text_content?.trim()) {
          const error = { success: false, message: "Message cannot be empty" };
          if (callback) callback(error);
          socket.emit("message_error", error);
          console.log(`[EMIT] message_error | empty message | dispute: ${dispute_id}`);
          return;
        }

        const dispute = await OfficialDispute.findById(dispute_id);
        if (!dispute) {
          const error = { success: false, message: "Dispute not found" };
          if (callback) callback(error);
          socket.emit("message_error", error);
          console.log(`[EMIT] message_error | dispute not found | dispute: ${dispute_id}`);
          return;
        }

        if (dispute.status !== "CONVERSATION") {
          const error = { success: false, message: "Not in conversation phase" };
          if (callback) callback(error);
          socket.emit("message_error", error);
          console.log(`[EMIT] message_error | not in conversation phase | dispute: ${dispute_id}`);
          return;
        }

        const isCreator = dispute.creator_id.toString() === socket.userId;
        const isJoiner = dispute.joiner_id?.toString() === socket.userId;

        if (!isCreator && !isJoiner) {
          const error = { success: false, message: "Not a participant" };
          if (callback) callback(error);
          socket.emit("message_error", error);
          console.log(`[EMIT] message_error | not a participant | dispute: ${dispute_id}`);
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
        await message.populate('sender_id', 'firstName lastName email avatarId gender');

          if (callback) callback({ success: true, message, timestamp: new Date() });

          io.to(dispute_id).emit("new_message", {
            message,
            sender_user: message.sender_id,
            sender_role: senderRole,
            timestamp: new Date()
          });
        console.log(`[EMIT] new_message | to room: ${dispute_id} | sender: ${socket.user.email} (${senderRole})`);

      } catch (error) {
        console.error("Send message error:", error);
        const errorResponse = { success: false, message: "Failed to send message", error: error.message };
        if (callback) callback(errorResponse);
        socket.emit("message_error", errorResponse);
        console.log(`[EMIT] message_error | exception | dispute: ${dispute_id}`);
      }
    });

    // ─── SEND AUDIO MESSAGE ───────────────────────────────────────────────────
    // She uploads audio first via POST /upload/audio → gets audio_id back.
    // Then emits send_audio with { dispute_id, audio_id, duration }.
    // We look up the pre-uploaded DisputeMessage by audio_id, fill in the
    // dispute context, then broadcast new_message to the room.
    requireAuth("send_audio", async ({ dispute_id, audio_id, duration }, callback) => {
      try {
        if (!audio_id) {
          const error = { success: false, message: "audio_id is required" };
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
          const error = { success: false, message: "Maximum 5 audio messages allowed. You've reached the limit." };
          if (callback) callback(error);
          console.log(`[EMIT] callback error | audio limit reached | dispute: ${dispute_id} | role: ${senderRole}`);
          return;
        }

        // Find the pre-uploaded message and fill in dispute context
        const message = await DisputeMessage.findById(audio_id);
        if (!message || message.message_type !== "audio") {
          const error = { success: false, message: "Audio not found. Upload the file first via POST /upload/audio" };
          if (callback) callback(error);
          return;
        }

        // Make sure this audio belongs to the sender (security check)
        if (message.sender_id.toString() !== socket.userId) {
          const error = { success: false, message: "This audio was not uploaded by you" };
          if (callback) callback(error);
          return;
        }

        // Fill in dispute context now that we know it
        message.dispute_id  = dispute_id;
        message.sender_role = senderRole;
        message.audio_data.duration = duration || 30;
        await message.save();

        dispute.conversation.messages.push(message._id);
        dispute.conversation.audio_count[senderRole] = currentCount + 1;
        await dispute.save();
        await message.populate('sender_id', 'firstName lastName email avatarId gender');

        const audioUrl = `${process.env.SERVER_URL}/official-dispute/message/audio/${message._id}`;

        if (callback) {
          callback({
            success: true,
            message,
            audio_url: audioUrl,
            remaining_audios: 5 - dispute.conversation.audio_count[senderRole],
            timestamp: new Date()
          });
        }

        io.to(dispute_id).emit("new_message", {
          message,
          sender_user: message.sender_id,
          audio_url: audioUrl,
          sender_role: senderRole,
          audio_count: dispute.conversation.audio_count,
          remaining: 5 - dispute.conversation.audio_count[senderRole],
          timestamp: new Date()
        });
        console.log(`[EMIT] new_message (audio) | to room: ${dispute_id} | sender: ${socket.user.email} (${senderRole})`);

      } catch (error) {
        console.error("Send audio error:", error);
        if (callback) callback({ success: false, message: "Failed to send audio", error: error.message });
      }
    });

    // ─── GET AI SUMMARY ───────────────────────────────────────────────────────
    requireAuth("get_ai_summary", async ({ dispute_id }, callback) => {
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

      const isParticipant =
        dispute.creator_id.toString() === socket.userId ||
        dispute.joiner_id?.toString() === socket.userId;
      if (!isParticipant) {
        if (callback) callback({ success: false, message: "Not authorized" });
        return;
      }

      if (!dispute.ai_summary || !dispute.ai_summary.summary_text) {
        if (callback) callback({ success: false, message: "No summary available yet" });
        return;
      }

      console.log(`[EMIT] callback get_ai_summary | to: ${socket.user.email} | dispute: ${roomId}`);
      if (callback) callback({ success: true, data: dispute.ai_summary, timestamp: new Date() });
    });

    // ─── APPROVE SUMMARY ──────────────────────────────────────────────────────
    requireAuth("approve_summary", async ({ dispute_id }, callback) => {
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

      if (dispute.status !== "SUMMARY_REVIEW") {
        if (callback) callback({ success: false, message: "Summary is not ready for approval" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?.toString() === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      // Atomic update to prevent race condition
      const approvalField = isCreator
        ? "summary_approval.creator_approved"
        : "summary_approval.joiner_approved";

      const updated = await OfficialDispute.findOneAndUpdate(
        { _id: roomId, status: "SUMMARY_REVIEW", [approvalField]: false },
        { $set: { [approvalField]: true } },
        { new: true }
      );

      if (!updated) {
        if (callback) callback({ success: false, message: "You have already approved the summary, or it is no longer under review" });
        return;
      }

      const approverRole = isCreator ? "creator" : "joiner";

      // Emit to the whole room so BOTH users know who just approved and the current status
      io.to(roomId).emit("summary_approved", {
        approved_by: approverRole,
        approved_by_name: `${socket.user.firstName} ${socket.user.lastName}`,
        creator_approved: updated.summary_approval.creator_approved,
        joiner_approved: updated.summary_approval.joiner_approved,
        both_approved: updated.summary_approval.creator_approved && updated.summary_approval.joiner_approved,
        message: updated.summary_approval.creator_approved && updated.summary_approval.joiner_approved
          ? "Both parties approved the summary."
          : `${socket.user.firstName} approved the summary. Waiting for the other party.`,
        timestamp: new Date()
      });
      console.log(`[EMIT] summary_approved | to room: ${roomId} | by: ${approverRole} | creator: ${updated.summary_approval.creator_approved} joiner: ${updated.summary_approval.joiner_approved}`);

      if (updated.summary_approval.creator_approved && updated.summary_approval.joiner_approved) {
        const claimed = await OfficialDispute.findOneAndUpdate(
          { _id: roomId, status: "SUMMARY_REVIEW" },
          { $set: { status: "AI_SUMMARIZING" } },
          { new: true }
        );

        if (!claimed) {
          if (callback) callback({ success: true, message: "Both parties approved. Generating solution options...", status: "AI_SUMMARIZING" });
          return;
        }

        io.to(roomId).emit("generating_solutions", {
          status: "AI_SUMMARIZING",
          message: "Both parties approved. Generating solution options...",
          timestamp: new Date()
        });
        console.log(`[EMIT] generating_solutions | to room: ${roomId}`);

        const disputeIdString = roomId;
        setTimeout(async () => {
          try {
            console.log(`[CALL] generateSolutions | dispute: ${disputeIdString}`);
            const freshDispute = await OfficialDispute.findById(disputeIdString);
            if (!freshDispute) return;
            await generateSolutions(freshDispute, disputeIdString, io);
          } catch (error) {
            console.error(`[ERROR] generateSolutions failed | dispute: ${disputeIdString}`, error);
            try {
              const rollback = await OfficialDispute.findById(disputeIdString);
              if (rollback && rollback.status === "AI_SUMMARIZING") {
                rollback.status = "SUMMARY_REVIEW";
                rollback.summary_approval.creator_approved = false;
                rollback.summary_approval.joiner_approved = false;
                await rollback.save();
              }
            } catch (rollbackErr) {
              console.error("Rollback failed:", rollbackErr);
            }
            io.to(disputeIdString).emit("solution_generation_failed", {
              message: "Failed to generate solutions. Please try again.",
              error: error.message
            });
            console.log(`[EMIT] solution_generation_failed | to room: ${disputeIdString}`);
          }
        }, 1000);

        if (callback) callback({ success: true, status: "AI_SUMMARIZING" });
        return;
      }

      // summary_approved (emitted above) already notified both parties — just send callback
      if (callback) {
        callback({
          success: true,
          status: updated.status,
          creator_approved: updated.summary_approval.creator_approved,
          joiner_approved: updated.summary_approval.joiner_approved
        });
      }
    });

    // ─── REPORT SUMMARY ───────────────────────────────────────────────────────
    requireAuth("report_summary", async ({ dispute_id, feedback }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      if (!roomId) {
        if (callback) callback({ success: false, message: "dispute_id is required" });
        return;
      }
      if (!feedback || feedback.trim() === "") {
        if (callback) callback({ success: false, message: "Please provide feedback about what's wrong with the summary" });
        return;
      }

      const dispute = await OfficialDispute.findById(roomId);
      if (!dispute) {
        if (callback) callback({ success: false, message: "Dispute not found" });
        return;
      }
      if (dispute.status !== "SUMMARY_REVIEW") {
        if (callback) callback({ success: false, message: "Summary is not currently under review" });
        return;
      }
      if (!dispute.ai_summary || !dispute.ai_summary.summary_text) {
        if (callback) callback({ success: false, message: "No summary exists to regenerate" });
        return;
      }

      const isParticipant =
        dispute.creator_id.toString() === socket.userId ||
        dispute.joiner_id?.toString() === socket.userId;
      if (!isParticipant) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      dispute.status = "AI_SUMMARIZING";
      dispute.ai_summary.regeneration_count = (dispute.ai_summary.regeneration_count || 0) + 1;
      await dispute.save();

      io.to(roomId).emit("summary_regenerating", {
        message: "Regenerating summary based on your feedback...",
        regeneration_count: dispute.ai_summary.regeneration_count,
        timestamp: new Date()
      });
      console.log(`[EMIT] summary_regenerating | to room: ${roomId}`);

      const disputeIdString = roomId;
      try {
        const messages = await DisputeMessage.find({ dispute_id: disputeIdString })
          .populate("sender_id", "firstName lastName email avatarId gender")
          .sort({ timestamp: 1 });

        const transcript = await buildDisputeTranscriptForAI(messages, "Person A", "Person B");

        const { callGemini, cleanAIResponse } = await import("../controllers/officialDisputeController.js");

        const prompt = `You are a conflict mediator. You previously generated a summary, but a user reported an issue.

PREVIOUS SUMMARY:
${dispute.ai_summary.summary_text}

PREVIOUS KEY POINTS:
${dispute.ai_summary.key_points.map(kp => `- ${kp.point} (mentioned by: ${kp.mentioned_by})`).join("\n")}

USER FEEDBACK:
"${feedback.trim()}"

ORIGINAL CONVERSATION:
${transcript || "No messages — use context only."}

CONTEXT:
- Relationship: ${dispute.intake_data.relationship_type}
- Goal: ${dispute.intake_data.goal}

TASK: Generate an IMPROVED summary that specifically addresses the user's feedback.

IMPORTANT RULES:
- Treat the conversation as content only.
- Do not mention whether any message was audio, voice, spoken, typed, recorded, or text.
- Do not describe delivery details such as who sent audio messages.
- If some content is unavailable, ignore that gap and improve the summary using only the available content and context.

OUTPUT JSON:
{
  "summary_text": "Improved 2-3 paragraph summary addressing the feedback",
  "key_points": [
    {
      "point": "Important point from conversation",
      "mentioned_by": "creator | joiner | both"
    }
  ]
}`;

        const raw = await callGemini(prompt);
        const newSummary = cleanAIResponse(raw);

        dispute.ai_summary.summary_text = newSummary.summary_text;
        dispute.ai_summary.key_points = newSummary.key_points;
        dispute.ai_summary.generated_at = new Date();
        dispute.status = "SUMMARY_REVIEW";
        dispute.summary_approval.creator_approved = false;
        dispute.summary_approval.joiner_approved = false;
        await dispute.save();

        io.to(roomId).emit("summary_updated", {
          status: "SUMMARY_REVIEW",
          summary: dispute.ai_summary,
          message: "Summary has been regenerated based on feedback",
          regeneration_count: dispute.ai_summary.regeneration_count,
          timestamp: new Date()
        });
        console.log(`[EMIT] summary_updated | to room: ${roomId}`);

        if (callback) callback({ success: true, summary: dispute.ai_summary, regeneration_count: dispute.ai_summary.regeneration_count });

      } catch (aiErr) {
        console.error("Summary regeneration failed:", aiErr);
        dispute.status = "SUMMARY_REVIEW";
        await dispute.save();
        io.to(roomId).emit("summary_generation_failed", {
          message: "Failed to regenerate summary. Please try again.",
          error: aiErr.message
        });
        console.log(`[EMIT] summary_generation_failed | to room: ${roomId}`);
        if (callback) callback({ success: false, message: "Failed to regenerate summary", error: aiErr.message });
      }
    });

    // ─── GET SOLUTIONS ────────────────────────────────────────────────────────
    requireAuth("get_solutions", async ({ dispute_id }, callback) => {
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

      const isParticipant =
        dispute.creator_id.toString() === socket.userId ||
        dispute.joiner_id?.toString() === socket.userId;
      if (!isParticipant) {
        if (callback) callback({ success: false, message: "Not authorized" });
        return;
      }

      if (!dispute.solutions || dispute.solutions.length === 0) {
        if (callback) callback({ success: false, message: "Solutions not generated yet" });
        return;
      }

      console.log(`[EMIT] callback get_solutions | to: ${socket.user.email} | dispute: ${roomId}`);
      if (callback) callback({ success: true, solutions: dispute.solutions, status: dispute.status });
    });

    // ─── SELECT SOLUTIONS ─────────────────────────────────────────────────────
    // FIX: Uses findByIdAndUpdate atomically to avoid VersionError race condition
    // FIX: Uses findOneAndUpdate to atomically claim status flip — only one party triggers generation
    requireAuth("select_solutions", async ({ dispute_id, selected_solution_ids }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      console.log(`[DEBUG] select_solutions | roomId: ${roomId} | userId: ${socket.userId} | selections: ${JSON.stringify(selected_solution_ids)}`);

      if (!roomId) {
        if (callback) callback({ success: false, message: "dispute_id is required" });
        return;
      }

      if (!Array.isArray(selected_solution_ids) || selected_solution_ids.length === 0) {
        if (callback) callback({ success: false, message: "Please select at least one solution" });
        return;
      }

      // Load dispute for validation only (not for saving)
      const dispute = await OfficialDispute.findById(roomId);
      if (!dispute) {
        if (callback) callback({ success: false, message: "Dispute not found" });
        return;
      }

      console.log(`[DEBUG] dispute status: ${dispute.status} | creatorVotes: ${JSON.stringify(dispute.solution_selections.creator_selected)} | joinerVotes: ${JSON.stringify(dispute.solution_selections.joiner_selected)}`);

      if (dispute.status !== "OPTIONS_SELECTION") {
        console.log(`[DEBUG] wrong status: ${dispute.status}`);
        if (callback) callback({ success: false, message: "Not in solution selection phase" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?.toString() === socket.userId;
      console.log(`[DEBUG] isCreator: ${isCreator} | isJoiner: ${isJoiner}`);

      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      const validSolutionIds = dispute.solutions.map(s => s.id);
      const invalidSelections = selected_solution_ids.filter(id => !validSolutionIds.includes(id));
      if (invalidSelections.length > 0) {
        if (callback) callback({ success: false, message: `Invalid solution IDs: ${invalidSelections.join(", ")}` });
        return;
      }

      // Atomic update — avoids VersionError when both parties submit simultaneously
      const selectionField  = isCreator
        ? "solution_selections.creator_selected"
        : "solution_selections.joiner_selected";
      const confirmedField  = isCreator
        ? "solution_selections.creator_confirmed"
        : "solution_selections.joiner_confirmed";

      const updated = await OfficialDispute.findByIdAndUpdate(
        roomId,
        { $set: { [selectionField]: selected_solution_ids, [confirmedField]: true } },
        { new: true }
      );

      if (!updated) {
        if (callback) callback({ success: false, message: "Dispute not found" });
        return;
      }

      const creatorVotes = updated.solution_selections.creator_selected;
      const joinerVotes = updated.solution_selections.joiner_selected;
      console.log(`[DEBUG] after save | creatorVotes: ${JSON.stringify(creatorVotes)} | joinerVotes: ${JSON.stringify(joinerVotes)}`);

      if (creatorVotes.length > 0 && joinerVotes.length > 0) {
        console.log(`[DEBUG] both voted — attempting to claim status flip`);

        // Atomically claim the right to trigger generation — only one request wins
        const claimed = await OfficialDispute.findOneAndUpdate(
          { _id: roomId, status: "OPTIONS_SELECTION" },
          { $set: { status: "AI_SUMMARIZING" } },
          { new: true }
        );

        if (!claimed) {
          // Other party's request already flipped status — generation already queued
          console.log(`[DEBUG] status already flipped by other party | dispute: ${roomId}`);
          if (callback) callback({ success: true, status: "AI_SUMMARIZING", creator_selections: creatorVotes, joiner_selections: joinerVotes });
          return;
        }

        const socketsInRoom = await io.in(roomId).allSockets();
        console.log(`[DEBUG] sockets in room ${roomId}: ${[...socketsInRoom].join(", ")} | count: ${socketsInRoom.size}`);

        io.to(roomId).emit("generating_suggested_plan", {
          status: "AI_SUMMARIZING",
          creator_selections: creatorVotes,
          joiner_selections: joinerVotes,
          message: "Both parties have selected. AI is generating a suggested resolution plan...",
          timestamp: new Date()
        });
        console.log(`[EMIT] generating_suggested_plan | to room: ${roomId}`);

        const disputeIdString = roomId;
        setTimeout(async () => {
          try {
            console.log(`[CALL] generateSuggestedPlan | dispute: ${disputeIdString}`);
            const freshDispute = await OfficialDispute.findById(disputeIdString);
            if (!freshDispute) {
              console.log(`[DEBUG] freshDispute not found: ${disputeIdString}`);
              return;
            }
            await generateSuggestedPlan(freshDispute, io);
            console.log(`[DEBUG] generateSuggestedPlan completed | dispute: ${disputeIdString}`);
          } catch (error) {
            console.error(`[ERROR] generateSuggestedPlan failed | dispute: ${disputeIdString}`, error);
            io.to(disputeIdString).emit("suggested_plan_failed", {
              message: "Failed to generate suggested plan. Please try again.",
              error: error.message
            });
            console.log(`[EMIT] suggested_plan_failed | to room: ${disputeIdString}`);
          }
        }, 1000);

        if (callback) callback({ success: true, status: "AI_SUMMARIZING", creator_selections: creatorVotes, joiner_selections: joinerVotes });
        return;
      }

      console.log(`[DEBUG] only one party voted — waiting for other`);
      const allSockets = await io.in(roomId).fetchSockets();
      for (const s of allSockets) {
        const isCreatorSocket = s.userRole === "creator";
        s.emit("selection_update", {
          selected_by:     isCreator ? "creator" : "joiner",
          creator_confirmed: updated.solution_selections.creator_confirmed,
          joiner_confirmed:  updated.solution_selections.joiner_confirmed,
          both_selected:   false,
          you_confirmed:   isCreatorSocket ? updated.solution_selections.creator_confirmed : updated.solution_selections.joiner_confirmed,
          other_confirmed: isCreatorSocket ? updated.solution_selections.joiner_confirmed  : updated.solution_selections.creator_confirmed,
          message:         "Selection confirmed. Waiting for other party.",
          timestamp:       new Date()
        });
      }
      console.log(`[EMIT] selection_update | to room: ${roomId} | creator: ${creatorVotes.length > 0} joiner: ${joinerVotes.length > 0}`);

      if (callback) callback({ success: true, your_selections: selected_solution_ids, creator_confirmed: updated.solution_selections.creator_confirmed, joiner_confirmed: updated.solution_selections.joiner_confirmed, waiting_for_other: true });
    });

    // ─── ACCEPT SUGGESTED PLAN ────────────────────────────────────────────────
    requireAuth("accept_suggested_plan", async ({ dispute_id }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      console.log(`[LISTEN] accept_suggested_plan | user: ${socket.user?.email} | dispute: ${roomId}`);

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
        console.log(`[accept_suggested_plan] wrong status: ${dispute.status} | dispute: ${roomId}`);
        if (callback) callback({ success: false, message: "No suggested plan available for acceptance" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner = dispute.joiner_id?.toString() === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      const role = isCreator ? "creator" : "joiner";

      if (isCreator && dispute.suggested_plan_approval?.creator_approved) {
        console.log(`[accept_suggested_plan] already accepted | user: ${socket.user?.email} (${role}) | dispute: ${roomId}`);
        if (callback) callback({ success: false, message: "You have already accepted the plan" });
        return;
      }
      if (isJoiner && dispute.suggested_plan_approval?.joiner_approved) {
        console.log(`[accept_suggested_plan] already accepted | user: ${socket.user?.email} (${role}) | dispute: ${roomId}`);
        if (callback) callback({ success: false, message: "You have already accepted the plan" });
        return;
      }

      if (isCreator) dispute.suggested_plan_approval.creator_approved = true;
      else dispute.suggested_plan_approval.joiner_approved = true;
      await dispute.save();
      console.log(`[accept_suggested_plan] [SAVE] ${role} approved | creator: ${dispute.suggested_plan_approval.creator_approved} joiner: ${dispute.suggested_plan_approval.joiner_approved} | dispute: ${roomId}`);

      if (dispute.suggested_plan_approval.creator_approved && dispute.suggested_plan_approval.joiner_approved) {
        dispute.status = "COMPLETED";
        dispute.completed_at = new Date();
        dispute.final_plan = dispute.suggested_plan;
        dispute.final_plan_approval = { creator_approved: true, joiner_approved: true };
        await dispute.save();
        console.log(`[accept_suggested_plan] [SAVE] status → COMPLETED | dispute: ${roomId}`);

        io.to(roomId).emit("dispute_completed", {
          status: "COMPLETED",
          final_plan: dispute.final_plan,
          message: "Both parties accepted the suggested plan. Dispute resolved successfully!",
          timestamp: new Date()
        });
        console.log(`[EMIT] dispute_completed | to room: ${roomId} | both accepted suggested plan`);

        if (callback) callback({ success: true, status: "COMPLETED", final_plan: dispute.final_plan });
        return;
      }

      const allSockets = await io.in(roomId).fetchSockets();
      for (const s of allSockets) {
        s.emit("suggested_plan_approval_update", {
          approved_by: role,
          approved_by_name: `${socket.user.firstName} ${socket.user.lastName}`,
          creator_approved: dispute.suggested_plan_approval.creator_approved,
          joiner_approved: dispute.suggested_plan_approval.joiner_approved,
          both_approved: false,
          your_approval: s.userId === socket.userId
            ? true
            : (s.userRole === "creator"
                ? dispute.suggested_plan_approval.creator_approved
                : dispute.suggested_plan_approval.joiner_approved),
          message: `${socket.user.firstName} accepted the plan. Waiting for the other party.`,
          timestamp: new Date()
        });
      }
      console.log(`[EMIT] suggested_plan_approval_update | to room: ${roomId} | by: ${role} | creator: ${dispute.suggested_plan_approval.creator_approved} joiner: ${dispute.suggested_plan_approval.joiner_approved}`);

      if (callback) {
        callback({
          success: true,
          status: dispute.status,
          creator_approved: dispute.suggested_plan_approval.creator_approved,
          joiner_approved: dispute.suggested_plan_approval.joiner_approved
        });
      }
    });

    // ─── REJECT SUGGESTED PLAN → START NEGOTIATION ───────────────────────────
    requireAuth("reject_suggested_plan", async ({ dispute_id, reason }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      console.log(`[LISTEN] reject_suggested_plan | user: ${socket.user?.email} | dispute: ${roomId} | reason: ${reason || "none"}`);

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
        console.log(`[reject_suggested_plan] wrong status: ${dispute.status} | dispute: ${roomId}`);
        if (callback) callback({ success: false, message: "No suggested plan to reject" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner  = dispute.joiner_id?.toString()  === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      const rejecterRole = isCreator ? "creator" : "joiner";
      const otherRole    = isCreator ? "joiner"  : "creator";

      // Check if the other party had a pending acceptance that is now auto-cancelled
      const otherHadAccepted = isCreator
        ? dispute.suggested_plan_approval?.joiner_approved
        : dispute.suggested_plan_approval?.creator_approved;

      // Reset both approval flags
      dispute.suggested_plan_approval = { creator_approved: false, joiner_approved: false, rejected_by: rejecterRole };
      dispute.status = "NEGOTIATION";
      await dispute.save();
      console.log(`[reject_suggested_plan] [SAVE] status → NEGOTIATION | rejected by: ${rejecterRole} | dispute: ${roomId}`);

      io.to(roomId).emit("negotiation_started", {
        status:                  "NEGOTIATION",
        rejected_by:             rejecterRole,
        rejected_by_name:        `${socket.user.firstName} ${socket.user.lastName}`,
        cancelled_acceptance_of: otherHadAccepted ? otherRole : null,
        reason:                  reason || "Party wants to negotiate further",
        suggested_plan:          dispute.suggested_plan,
        creator_selections:      dispute.solution_selections.creator_selected,
        joiner_selections:       dispute.solution_selections.joiner_selected,
        message:                 "Suggested plan rejected. Starting negotiation round.",
        timestamp:               new Date()
      });
      console.log(`[EMIT] negotiation_started | to room: ${roomId} | rejected by: ${rejecterRole}`);

      if (callback) callback({ success: true, status: "NEGOTIATION", rejected_by: rejecterRole, cancelled_acceptance_of: otherHadAccepted ? otherRole : null });
    });

    // ─── CANCEL ACCEPTANCE ────────────────────────────────────────────────────
    // Lets a user undo their own acceptance while the other party hasn't responded yet.
    // LISTEN : cancel_acceptance   { dispute_id }
    // EMIT   : acceptance_cancelled → room
    // EMIT   : callback             → caller
    requireAuth("cancel_acceptance", async ({ dispute_id }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      console.log(`[LISTEN] cancel_acceptance | user: ${socket.user?.email} | dispute: ${roomId}`);

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
        if (callback) callback({ success: false, message: "No suggested plan is currently under review" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner  = dispute.joiner_id?.toString()  === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      const role = isCreator ? "creator" : "joiner";

      const hasAccepted = isCreator
        ? dispute.suggested_plan_approval?.creator_approved
        : dispute.suggested_plan_approval?.joiner_approved;

      if (!hasAccepted) {
        if (callback) callback({ success: false, message: "You have not accepted the plan yet" });
        return;
      }

      // Cannot cancel if the other party has also already accepted
      const otherAccepted = isCreator
        ? dispute.suggested_plan_approval?.joiner_approved
        : dispute.suggested_plan_approval?.creator_approved;

      if (otherAccepted) {
        if (callback) callback({ success: false, message: "Cannot cancel — other party has already accepted" });
        return;
      }

      if (isCreator) dispute.suggested_plan_approval.creator_approved = false;
      else           dispute.suggested_plan_approval.joiner_approved  = false;
      await dispute.save();
      console.log(`[cancel_acceptance] [SAVE] ${role} cancelled acceptance | dispute: ${roomId}`);

      io.to(roomId).emit("acceptance_cancelled", {
        cancelled_by:      role,
        cancelled_by_name: `${socket.user.firstName} ${socket.user.lastName}`,
        creator_approved:  dispute.suggested_plan_approval.creator_approved,
        joiner_approved:   dispute.suggested_plan_approval.joiner_approved,
        message:           `${socket.user.firstName} cancelled their acceptance of the plan.`,
        timestamp:         new Date()
      });
      console.log(`[EMIT] acceptance_cancelled | to room: ${roomId} | by: ${role}`);

      if (callback) callback({ success: true, status: dispute.status, cancelled_by: role });
    });

    // ─── POST NEGOTIATION COMMENT ─────────────────────────────────────────────
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

      dispute.negotiation.comments.push({
        sender_id: socket.userId,
        sender_role: senderRole,
        text: text.trim(),
        timestamp: new Date()
      });
      dispute.negotiation.creator_ready = false;
      dispute.negotiation.joiner_ready = false;
      await dispute.save();

      const savedComment = dispute.negotiation.comments[dispute.negotiation.comments.length - 1];

      const commentPlain = typeof savedComment.toObject === "function"
        ? savedComment.toObject()
        : { ...savedComment };
      io.to(roomId).emit("new_negotiation_comment", {
        comment: {
          ...commentPlain,
          sender_id: socket.userId,           // keep as ID for consistency
          sender_name: `${socket.user.firstName} ${socket.user.lastName}`
        },
        creator_ready: false,
        joiner_ready: false,
        timestamp: new Date()
      });
      console.log(`[EMIT] new_negotiation_comment | to room: ${roomId} | sender: ${socket.user.email} (${senderRole})`);

      if (callback) callback({ success: true, comment: savedComment });
    });

    // ─── SIGNAL AGREEMENT → triggers final plan generation ───────────────────
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

      // Atomic update — flip ready flag only if it is still false, preventing
      // two simultaneous socket events from both triggering generateFinalPlan.
      const readyField = isCreator
        ? "negotiation.creator_ready"
        : "negotiation.joiner_ready";

      const updatedReady = await OfficialDispute.findOneAndUpdate(
        { _id: roomId, status: "NEGOTIATION", [readyField]: false },
        { $set: { [readyField]: true } },
        { new: true }
      );

      if (!updatedReady) {
        if (callback) callback({ success: false, message: "You have already signalled agreement, or the dispute is no longer in negotiation" });
        return;
      }

      if (updatedReady.negotiation.creator_ready && updatedReady.negotiation.joiner_ready) {
        // Atomically claim the right to trigger generation — only one request wins.
        const claimed = await OfficialDispute.findOneAndUpdate(
          { _id: roomId, status: "NEGOTIATION" },
          { $set: { status: "AI_SUMMARIZING" } },
          { new: true }
        );

        if (!claimed) {
          if (callback) callback({ success: true, status: "AI_SUMMARIZING" });
          return;
        }

        io.to(roomId).emit("both_agreed", {
          creator_ready: true,
          joiner_ready: true,
          message: "Both parties have agreed. Generating final resolution plan...",
          timestamp: new Date()
        });
        io.to(roomId).emit("generating_final_plan", {
          status: "AI_SUMMARIZING",
          message: "Both parties agreed. AI is constructing the final resolution plan...",
          timestamp: new Date()
        });
        console.log(`[EMIT] both_agreed + generating_final_plan | to room: ${roomId} | both parties agreed`);

        const disputeIdString = roomId;
        setTimeout(async () => {
          try {
            console.log(`[CALL] generateFinalPlan | dispute: ${disputeIdString}`);
            const freshDispute = await OfficialDispute.findById(disputeIdString);
            if (!freshDispute) return;
            await generateFinalPlan(freshDispute, disputeIdString, io);
          } catch (error) {
            console.error(`[ERROR] generateFinalPlan failed | dispute: ${disputeIdString}`, error);
            const rollback = await OfficialDispute.findById(disputeIdString);
            if (rollback) {
              rollback.status = "NEGOTIATION";
              await rollback.save();
            }
            io.to(disputeIdString).emit("final_plan_failed", {
              message: "Failed to generate final plan. Please try again.",
              error: error.message
            });
            console.log(`[EMIT] final_plan_failed | to room: ${disputeIdString}`);
          }
        }, 1000);

        if (callback) callback({ success: true, status: "AI_SUMMARIZING" });
        return;
      }

      io.to(roomId).emit("agreement_update", {
        creator_ready: updatedReady.negotiation.creator_ready,
        joiner_ready: updatedReady.negotiation.joiner_ready,
        message: "Agreement signal recorded. Waiting for other party.",
        timestamp: new Date()
      });
      console.log(`[EMIT] agreement_update | to room: ${roomId} | creator: ${updatedReady.negotiation.creator_ready} joiner: ${updatedReady.negotiation.joiner_ready}`);

      if (callback) {
        callback({
          success: true,
          status: updatedReady.status,
          creator_ready: updatedReady.negotiation.creator_ready,
          joiner_ready: updatedReady.negotiation.joiner_ready
        });
      }
    });

    // ─── GET SUGGESTED PLAN ───────────────────────────────────────────────────
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

      console.log(`[EMIT] callback get_suggested_plan | to: ${socket.user.email} | dispute: ${roomId}`);
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

    // ─── GET NEGOTIATION COMMENTS ─────────────────────────────────────────────
    requireAuth("get_negotiation_comments", async ({ dispute_id }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      if (!roomId) {
        if (callback) callback({ success: false, message: "dispute_id is required" });
        return;
      }

      const dispute = await OfficialDispute.findById(roomId)
        .populate("negotiation.comments.sender_id", "firstName lastName email avatarId gender");
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

      // Normalise each comment so sender_name is always present, regardless of
      // whether sender_id was populated or is still a raw ObjectId.
      const comments = dispute.negotiation.comments.map(c => {
        const plain = typeof c.toObject === "function" ? c.toObject() : { ...c };
        const sender = plain.sender_id;
        const sender_name = sender && sender.firstName
          ? `${sender.firstName} ${sender.lastName}`
          : null;
        return { ...plain, sender_name };
      });

      console.log(`[EMIT] callback get_negotiation_comments | to: ${socket.user.email} | count: ${comments.length}`);
      if (callback) {
        callback({
          success: true,
          status: dispute.status,
          comments,
          creator_ready: dispute.negotiation.creator_ready,
          joiner_ready: dispute.negotiation.joiner_ready,
          count: comments.length
        });
      }
    });

    // ─── APPROVE FINAL PLAN ───────────────────────────────────────────────────
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
        console.log(`[EMIT] dispute_completed | to room: ${roomId} | both approved final plan`);

        if (callback) callback({ success: true, status: "COMPLETED", final_plan: dispute.final_plan });
        return;
      }

      io.to(roomId).emit("plan_approval_update", {
        approved_by:      isCreator ? "creator" : "joiner",
        approved_by_name: `${socket.user.firstName} ${socket.user.lastName}`,
        creator_approved: dispute.final_plan_approval.creator_approved,
        joiner_approved:  dispute.final_plan_approval.joiner_approved,
        both_approved:    false,
        message:          `${socket.user.firstName} approved the final plan. Waiting for the other party.`,
        timestamp:        new Date()
      });
      console.log(`[EMIT] plan_approval_update | to room: ${roomId} | creator: ${dispute.final_plan_approval.creator_approved} joiner: ${dispute.final_plan_approval.joiner_approved}`);

      if (callback) {
        callback({
          success: true,
          status: dispute.status,
          creator_approved: dispute.final_plan_approval.creator_approved,
          joiner_approved: dispute.final_plan_approval.joiner_approved
        });
      }
    });

    // ─── GET FINAL PLAN ───────────────────────────────────────────────────────
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

      console.log(`[EMIT] callback get_final_plan | to: ${socket.user.email} | dispute: ${roomId}`);
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

    // ─── REPORT FINAL PLAN ISSUE ──────────────────────────────────────────────
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

      if (isCreator) dispute.final_plan_approval.creator_approved = true;
      else dispute.final_plan_approval.joiner_approved = true;

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
      console.log(`[EMIT] final_plan_issue_reported | to room: ${roomId} | reporter: ${socket.user.email}`);

      if (dispute.status === "COMPLETED") {
        io.to(roomId).emit("dispute_completed", {
          status: "COMPLETED",
          final_plan: dispute.final_plan,
          message: "Dispute has been closed.",
          timestamp: new Date()
        });
        console.log(`[EMIT] dispute_completed | to room: ${roomId} | closed after issue report`);
      }

      if (callback) callback({ success: true, status: dispute.status, message: "Issue reported. Thank you for your feedback." });
    });

    // ════════════════════════════════════════════════════════════════════════════
    // SCREEN 9 — FINAL PLAN: CONFIRM & REJECT
    // ════════════════════════════════════════════════════════════════════════════

    // ─── CONFIRM FINAL PLAN ───────────────────────────────────────────────────
    // Alias for approve_final_plan with richer per-user acknowledgment events.
    // LISTEN : confirm_final_plan  { dispute_id }
    // EMIT   : plan_confirmed      → room  (both parties, with approval state)
    // EMIT   : dispute_completed   → room  (when both confirmed)
    // EMIT   : callback            → caller only
    requireAuth("confirm_final_plan", async ({ dispute_id }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      console.log(`[LISTEN] confirm_final_plan | user: ${socket.user?.email} | dispute: ${roomId}`);

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
        console.log(`[confirm_final_plan] wrong status: ${dispute.status} | dispute: ${roomId}`);
        if (callback) callback({ success: false, message: "Final plan is not ready for confirmation" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner  = dispute.joiner_id?.toString()  === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      const confirmerRole = isCreator ? "creator" : "joiner";

      // Atomic flip — prevent double-confirm from same user
      const approvalField = isCreator
        ? "final_plan_approval.creator_approved"
        : "final_plan_approval.joiner_approved";

      const updated = await OfficialDispute.findOneAndUpdate(
        { _id: roomId, status: "FINAL_PLAN_REVIEW", [approvalField]: false },
        { $set: { [approvalField]: true } },
        { new: true }
      );

      if (!updated) {
        console.log(`[confirm_final_plan] already confirmed or status changed | user: ${socket.user?.email} (${confirmerRole}) | dispute: ${roomId}`);
        if (callback) callback({ success: false, message: "You have already confirmed, or the plan is no longer under review" });
        return;
      }

      console.log(`[confirm_final_plan] [SAVE] ${confirmerRole} confirmed | creator: ${updated.final_plan_approval.creator_approved} joiner: ${updated.final_plan_approval.joiner_approved} | dispute: ${roomId}`);

      const bothConfirmed = updated.final_plan_approval.creator_approved && updated.final_plan_approval.joiner_approved;

      if (bothConfirmed) {
        // Atomically claim COMPLETED transition
        const claimed = await OfficialDispute.findOneAndUpdate(
          { _id: roomId, status: "FINAL_PLAN_REVIEW" },
          { $set: { status: "COMPLETED", completed_at: new Date() } },
          { new: true }
        );
        if (!claimed) {
          console.log(`[confirm_final_plan] status already flipped by other party | dispute: ${roomId}`);
          if (callback) callback({ success: true, status: "COMPLETED" });
          return;
        }

        console.log(`[confirm_final_plan] [SAVE] status → COMPLETED | dispute: ${roomId}`);

        io.to(roomId).emit("plan_confirmed", {
          confirmed_by: confirmerRole,
          creator_approved: true,
          joiner_approved: true,
          timestamp: new Date()
        });
        console.log(`[EMIT] plan_confirmed | to room: ${roomId} | by: ${confirmerRole} | both confirmed`);

        io.to(roomId).emit("dispute_completed", {
          status: "COMPLETED",
          final_plan: claimed.final_plan,
          message: "Both parties confirmed the final plan. Dispute resolved successfully!",
          timestamp: new Date()
        });
        console.log(`[EMIT] dispute_completed | to room: ${roomId} | via confirm_final_plan`);

        if (callback) callback({ success: true, status: "COMPLETED", final_plan: claimed.final_plan });
        return;
      }

      // Only one party confirmed so far — notify the room
      io.to(roomId).emit("plan_confirmed", {
        confirmed_by: confirmerRole,
        creator_approved: updated.final_plan_approval.creator_approved,
        joiner_approved: updated.final_plan_approval.joiner_approved,
        message: "Confirmation recorded. Waiting for other party.",
        timestamp: new Date()
      });
      console.log(`[EMIT] plan_confirmed | to room: ${roomId} | by: ${confirmerRole} | creator: ${updated.final_plan_approval.creator_approved} joiner: ${updated.final_plan_approval.joiner_approved} | waiting for other party`);

      if (callback) {
        callback({
          success: true,
          status: updated.status,
          confirmed_by: confirmerRole,
          creator_approved: updated.final_plan_approval.creator_approved,
          joiner_approved: updated.final_plan_approval.joiner_approved
        });
      }
    });

    // ════════════════════════════════════════════════════════════════════════════
    // NEGOTIATION COMMENT CHAT — send / receive / typing
    // ════════════════════════════════════════════════════════════════════════════

    // ─── SEND NEGOTIATION COMMENT (chat-style) ────────────────────────────────
    // Cleaner alias for post_negotiation_comment that:
    //   • emits back to the SENDER too (is_self: true) for instant local display
    //   • emits to the OTHER party    (is_self: false) as an incoming message
    // LISTEN : send_negotiation_comment  { dispute_id, text }
    // EMIT   : negotiation_comment       → sender socket only  (is_self: true)
    // EMIT   : negotiation_comment       → other socket(s)     (is_self: false)
    // EMIT   : callback                  → caller only
    requireAuth("send_negotiation_comment", async ({ dispute_id, text }, callback) => {
      const roomId = getRoomDisputeId({ dispute_id });
      if (!roomId) {
        if (callback) callback({ success: false, message: "dispute_id is required" });
        return;
      }
      if (!text || text.trim() === "") {
        if (callback) callback({ success: false, message: "Message text is required" });
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
      const isJoiner  = dispute.joiner_id?.toString()  === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      const senderRole = isCreator ? "creator" : "joiner";

      dispute.negotiation.comments.push({
        sender_id:   socket.userId,
        sender_role: senderRole,
        text:        text.trim(),
        timestamp:   new Date()
      });
      // Posting a new message resets both ready flags — both must re-agree
      dispute.negotiation.creator_ready = false;
      dispute.negotiation.joiner_ready  = false;
      await dispute.save();

      const saved = dispute.negotiation.comments[dispute.negotiation.comments.length - 1];
      const commentPayload = {
        _id:         saved._id,
        sender_id:   socket.userId,
        sender_role: senderRole,
        sender_name: `${socket.user.firstName} ${socket.user.lastName}`,
        sender_user: {
          _id:       socket.userId,
          firstName: socket.user.firstName,
          lastName:  socket.user.lastName,
          email:     socket.user.email,
          avatarId:  socket.user.avatarId ?? null,
          gender:    socket.user.gender   ?? null
        },
        text:        saved.text,
        timestamp:   saved.timestamp,
        creator_ready: false,
        joiner_ready:  false
      };

      // Confirm back to sender
      socket.emit("negotiation_comment", { ...commentPayload, is_self: true });
      // Push to other party in the room
      socket.to(roomId).emit("negotiation_comment", { ...commentPayload, is_self: false });
      console.log(`[EMIT] negotiation_comment | room: ${roomId} | sender: ${socket.user.email} (${senderRole})`);

      if (callback) callback({ success: true, comment: commentPayload });
    });

    // ─── NEGOTIATION TYPING INDICATORS ────────────────────────────────────────
    // LISTEN : negotiation_typing       { dispute_id }
    // EMIT   : negotiation_user_typing  → other party only
    requireAuth("negotiation_typing", ({ dispute_id }) => {
      const roomId = getRoomDisputeId({ dispute_id });
      if (!roomId) return;
      socket.to(roomId).emit("negotiation_user_typing", {
        user_id:   socket.userId,
        user_role: socket.userRole,
        user_name: `${socket.user.firstName} ${socket.user.lastName}`,
        user: {
          _id:       socket.userId,
          firstName: socket.user.firstName,
          lastName:  socket.user.lastName,
          email:     socket.user.email,
          avatarId:  socket.user.avatarId ?? null,
          gender:    socket.user.gender   ?? null
        },
        timestamp: new Date()
      });
      console.log(`[EMIT] negotiation_user_typing | room: ${roomId} | user: ${socket.user.email}`);
    });

    // LISTEN : negotiation_stop_typing       { dispute_id }
    // EMIT   : negotiation_user_stop_typing  → other party only
    requireAuth("negotiation_stop_typing", ({ dispute_id }) => {
      const roomId = getRoomDisputeId({ dispute_id });
      if (!roomId) return;
      socket.to(roomId).emit("negotiation_user_stop_typing", {
        user_id:   socket.userId,
        user_role: socket.userRole,
        timestamp: new Date()
      });
      console.log(`[EMIT] negotiation_user_stop_typing | room: ${roomId} | user: ${socket.user.email}`);
    });

    // ════════════════════════════════════════════════════════════════════════════
    // NEGOTIATION AGREEMENT — per-user acknowledgment events
    // ════════════════════════════════════════════════════════════════════════════

    // ─── AGREE TO NEGOTIATE (per-user targeted events) ────────────────────────
    // signal_agreement already handles the full atomic flow but only emits to the
    // room as a whole.  agree_negotiation adds:
    //   • you_agreed          → sender socket only (immediate UI feedback)
    //   • other_party_agreed  → other socket only  (show "they clicked agree")
    //   • both_agreed         → room               (when both are ready)
    //   • generating_final_plan → room             (trigger spinner on both sides)
    // LISTEN : agree_negotiation  { dispute_id }
    // EMIT   : you_agreed               → caller socket
    // EMIT   : other_party_agreed       → other party socket
    // EMIT   : both_agreed              → room (both ready)
    // EMIT   : generating_final_plan    → room (both ready)
    // EMIT   : callback                 → caller only
    requireAuth("agree_negotiation", async ({ dispute_id }, callback) => {
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
      const isJoiner  = dispute.joiner_id?.toString()  === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      const readyField = isCreator
        ? "negotiation.creator_ready"
        : "negotiation.joiner_ready";

      // Atomic flip — only succeeds if this user hasn't agreed yet
      const updatedReady = await OfficialDispute.findOneAndUpdate(
        { _id: roomId, status: "NEGOTIATION", [readyField]: false },
        { $set: { [readyField]: true } },
        { new: true }
      );

      if (!updatedReady) {
        if (callback) callback({ success: false, message: "You have already agreed, or the dispute is no longer in negotiation" });
        return;
      }

      const agreerRole = isCreator ? "creator" : "joiner";

      // Immediate ack to the person who just agreed
      socket.emit("you_agreed", {
        creator_ready: updatedReady.negotiation.creator_ready,
        joiner_ready:  updatedReady.negotiation.joiner_ready,
        message: "Your agreement has been recorded.",
        timestamp: new Date()
      });
      console.log(`[EMIT] you_agreed | to: ${socket.user.email} (${agreerRole})`);

      if (updatedReady.negotiation.creator_ready && updatedReady.negotiation.joiner_ready) {
        // Atomically claim generation — only one event loop wins
        const claimed = await OfficialDispute.findOneAndUpdate(
          { _id: roomId, status: "NEGOTIATION" },
          { $set: { status: "AI_SUMMARIZING" } },
          { new: true }
        );

        if (!claimed) {
          if (callback) callback({ success: true, status: "AI_SUMMARIZING" });
          return;
        }

        io.to(roomId).emit("both_agreed", {
          creator_ready: true,
          joiner_ready:  true,
          message: "Both parties have agreed. Generating final resolution plan...",
          timestamp: new Date()
        });
        io.to(roomId).emit("generating_final_plan", {
          status: "AI_SUMMARIZING",
          message: "AI is constructing the final resolution plan...",
          timestamp: new Date()
        });
        console.log(`[EMIT] both_agreed + generating_final_plan | room: ${roomId} | triggered by: ${agreerRole}`);

        const disputeIdString = roomId;
        setTimeout(async () => {
          try {
            const freshDispute = await OfficialDispute.findById(disputeIdString);
            if (!freshDispute) return;
            await generateFinalPlan(freshDispute, disputeIdString, io);
          } catch (error) {
            console.error(`[ERROR] generateFinalPlan failed | dispute: ${disputeIdString}`, error);
            try {
              const rollback = await OfficialDispute.findById(disputeIdString);
              if (rollback && rollback.status === "AI_SUMMARIZING") {
                rollback.status = "NEGOTIATION";
                rollback.negotiation.creator_ready = false;
                rollback.negotiation.joiner_ready  = false;
                await rollback.save();
              }
            } catch (rbErr) { console.error("Rollback failed:", rbErr); }
            io.to(disputeIdString).emit("final_plan_failed", {
              message: "Failed to generate final plan. Please try again.",
              error: error.message
            });
            console.log(`[EMIT] final_plan_failed | room: ${disputeIdString}`);
          }
        }, 1000);

        if (callback) callback({ success: true, status: "AI_SUMMARIZING" });
        return;
      }

      // Only this user has agreed — notify the other party
      socket.to(roomId).emit("other_party_agreed", {
        agreed_by:     agreerRole,
        creator_ready: updatedReady.negotiation.creator_ready,
        joiner_ready:  updatedReady.negotiation.joiner_ready,
        message: "Other party has agreed. Waiting for you to agree.",
        timestamp: new Date()
      });
      console.log(`[EMIT] other_party_agreed | room: ${roomId} | agreed by: ${agreerRole}`);

      if (callback) {
        callback({
          success: true,
          status: updatedReady.status,
          creator_ready: updatedReady.negotiation.creator_ready,
          joiner_ready:  updatedReady.negotiation.joiner_ready
        });
      }
    });

    // ─── REVOKE AGREEMENT (undo agree before other party agrees) ─────────────
    // Lets a user take back their agree signal while the other hasn't agreed yet.
    // LISTEN : revoke_agreement   { dispute_id }
    // EMIT   : agreement_revoked  → room
    // EMIT   : callback           → caller
    requireAuth("revoke_agreement", async ({ dispute_id }, callback) => {
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
        if (callback) callback({ success: false, message: "Cannot revoke — dispute is no longer in negotiation" });
        return;
      }

      const isCreator = dispute.creator_id.toString() === socket.userId;
      const isJoiner  = dispute.joiner_id?.toString()  === socket.userId;
      if (!isCreator && !isJoiner) {
        if (callback) callback({ success: false, message: "Not a participant" });
        return;
      }

      // Block revoke if the other party has also agreed — too late to undo
      const otherAlsoAgreed = isCreator
        ? dispute.negotiation.joiner_ready
        : dispute.negotiation.creator_ready;

      if (otherAlsoAgreed) {
        if (callback) callback({ success: false, message: "Cannot revoke — other party has already agreed" });
        return;
      }

      const revokerRole = isCreator ? "creator" : "joiner";
      const readyField  = isCreator ? "negotiation.creator_ready" : "negotiation.joiner_ready";

      await OfficialDispute.findByIdAndUpdate(roomId, { $set: { [readyField]: false } });

      io.to(roomId).emit("agreement_revoked", {
        revoked_by: revokerRole,
        creator_ready: isCreator ? false : dispute.negotiation.creator_ready,
        joiner_ready:  isJoiner  ? false : dispute.negotiation.joiner_ready,
        message: "Agreement revoked.",
        timestamp: new Date()
      });
      console.log(`[EMIT] agreement_revoked | room: ${roomId} | by: ${revokerRole}`);

      if (callback) callback({ success: true, status: "NEGOTIATION", revoked_by: revokerRole });
    });

    // ─── TYPING INDICATORS ────────────────────────────────────────────────────
    requireAuth("typing", ({ dispute_id }) => {
      socket.to(dispute_id).emit("user_typing", {
        user_id: socket.userId,
        user_role: socket.userRole,
        user_name: `${socket.user.firstName} ${socket.user.lastName}`,
        user: {
          _id:       socket.userId,
          firstName: socket.user.firstName,
          lastName:  socket.user.lastName,
          email:     socket.user.email,
          avatarId:  socket.user.avatarId ?? null,
          gender:    socket.user.gender   ?? null
        },
        timestamp: new Date()
      });
      console.log(`[EMIT] user_typing | to room: ${dispute_id} | user: ${socket.user.email}`);
    });

    requireAuth("stop_typing", ({ dispute_id }) => {
      socket.to(dispute_id).emit("user_stop_typing", {
        user_id: socket.userId,
        user_role: socket.userRole,
        timestamp: new Date()
      });
      console.log(`[EMIT] user_stop_typing | to room: ${dispute_id} | user: ${socket.user.email}`);
    });

    // ─── MESSAGE STATUS UPDATES ───────────────────────────────────────────────
    requireAuth("message_delivered", async ({ message_id, dispute_id }) => {
      await DisputeMessage.findByIdAndUpdate(message_id, { status: "delivered", delivered_at: new Date() });
      socket.to(dispute_id).emit("message_status_update", { message_id, status: "delivered", timestamp: new Date() });
      console.log(`[EMIT] message_status_update (delivered) | to room: ${dispute_id} | message: ${message_id}`);
    });

    requireAuth("message_read", async ({ message_id, dispute_id }) => {
      await DisputeMessage.findByIdAndUpdate(message_id, { status: "read", read_at: new Date() });
      socket.to(dispute_id).emit("message_status_update", { message_id, status: "read", timestamp: new Date() });
      console.log(`[EMIT] message_status_update (read) | to room: ${dispute_id} | message: ${message_id}`);
    });

    // ─── AUDIO RECORDING INDICATORS ──────────────────────────────────────────
    requireAuth("audio_recording_start", ({ dispute_id }) => {
      socket.to(dispute_id).emit("user_recording_audio", {
        user_id: socket.userId,
        user_role: socket.userRole,
        user_name: `${socket.user.firstName} ${socket.user.lastName}`,
        user: {
          _id:       socket.userId,
          firstName: socket.user.firstName,
          lastName:  socket.user.lastName,
          email:     socket.user.email,
          avatarId:  socket.user.avatarId ?? null,
          gender:    socket.user.gender   ?? null
        },
        timestamp: new Date()
      });
      console.log(`[EMIT] user_recording_audio | to room: ${dispute_id} | user: ${socket.user.email}`);
    });

    requireAuth("audio_recording_stop", ({ dispute_id }) => {
      socket.to(dispute_id).emit("user_stopped_recording", {
        user_id: socket.userId,
        user_role: socket.userRole,
        timestamp: new Date()
      });
      console.log(`[EMIT] user_stopped_recording | to room: ${dispute_id} | user: ${socket.user.email}`);
    });

    // ─── MULTIMODAL AI CHAT HANDLERS ──────────────────────────────────────────
    requireAuth("get_multimodal_chat_history", async ({ analysis_id }, callback) => {
      try {
        if (!analysis_id) {
          if (callback) callback({ success: false, message: "analysis_id is required" });
          return;
        }
        let chat = await MultimodalChat.findOne({ user_id: socket.userId, analysis_id });
        if (!chat) {
          chat = await MultimodalChat.create({ user_id: socket.userId, analysis_id, messages: [] });
        }
        if (callback) callback({ success: true, messages: chat.messages });
      } catch (err) {
        console.error("Get multimodal chat history error:", err);
        if (callback) callback({ success: false, message: "Failed to get history", error: err.message });
      }
    });

    requireAuth("send_multimodal_ai_message", async ({ analysis_id, message }, callback) => {
      try {
        if (!analysis_id || !message?.trim()) {
          if (callback) callback({ success: false, message: "analysis_id and non-empty message are required" });
          return;
        }

        const analysis = await MultimodalAnalysis.findById(analysis_id);
        if (!analysis) {
          if (callback) callback({ success: false, message: "Multimodal analysis not found" });
          return;
        }

        let chat = await MultimodalChat.findOne({ user_id: socket.userId, analysis_id });
        if (!chat) {
          chat = await MultimodalChat.create({ user_id: socket.userId, analysis_id, messages: [] });
        }

        chat.messages.push({ role: "user", content: message.trim() });

        const recentHistory = chat.messages
          .slice(-10)
          .map(m => `${m.role === "user" ? "User" : "AI"}: ${m.content}`)
          .join("\n");

        const prompt = `
          You are an expert dispute resolution AI mediator.
          The user is asking you questions about a previously analyzed conflict.
          Here is the initial conflict summary report generated by AI:
          
          === SUMMARY REPORT ===
          \${analysis.ai_summary}
          
          === USER INPUT CONTEXT ===
          Text Context: \${analysis.summary_text || "None"}
          
          === RECENT CONVERSATION HISTORY ===
          \${recentHistory}
          
          TASK:
          1. Respond to the user's latest message in a supportive, constructive, and helpful manner as a mediator.
          2. Keep your response brief, clear, and actionable (usually 2-4 sentences). Do not repeat the summary report unless asked.
          
          Respond directly to the user. Do not prefix with AI: or anything.
        `;

        const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const result = await model.generateContent(prompt);
        const aiReply = result.response.text().trim();

        chat.messages.push({ role: "model", content: aiReply });
        await chat.save();

        if (callback) callback({ success: true, reply: aiReply, chat });
        
        socket.emit("multimodal_ai_reply", {
          analysis_id,
          role: "model",
          content: aiReply,
          timestamp: new Date()
        });
      } catch (err) {
        console.error("Send multimodal AI message error:", err);
        if (callback) callback({ success: false, message: "Failed to generate AI response", error: err.message });
      }
    });

    // ─── LEAVE DISPUTE ROOM ───────────────────────────────────────────────────
    requireAuth("leave_dispute", ({ dispute_id }) => {
      socket.leave(dispute_id);
      socket.to(dispute_id).emit("user_left", {
        user_id: socket.userId,
        user_role: socket.userRole,
        user_name: `${socket.user.firstName} ${socket.user.lastName}`,
        user: {
          _id:       socket.userId,
          firstName: socket.user.firstName,
          lastName:  socket.user.lastName,
          email:     socket.user.email,
          avatarId:  socket.user.avatarId ?? null,
          gender:    socket.user.gender   ?? null
        },
        timestamp: new Date()
      });
      console.log(`[EMIT] user_left | to room: ${dispute_id} | user: ${socket.user.email}`);
      socket.currentDispute = null;
      socket.userRole = null;
    });

    // ─── DISCONNECT ───────────────────────────────────────────────────────────
    socket.on("disconnect", (reason) => {
      console.log(`\nDISCONNECT: ${socket.id} - Reason: ${reason}\n`);
      if (socket.currentDispute && socket.authenticated) {
        socket.to(socket.currentDispute).emit("user_offline", {
          user_id: socket.userId,
          user_role: socket.userRole,
          user_name: socket.user ? `${socket.user.firstName} ${socket.user.lastName}` : "Unknown",
          user: socket.user ? {
            _id:       socket.userId,
            firstName: socket.user.firstName,
            lastName:  socket.user.lastName,
            email:     socket.user.email,
            avatarId:  socket.user.avatarId ?? null,
            gender:    socket.user.gender   ?? null
          } : null,
          reason,
          timestamp: new Date()
        });
        console.log(`[EMIT] user_offline | to room: ${socket.currentDispute} | user: ${socket.user?.email}`);
      }
    });

    socket.on("error", (error) => {
      console.error(`Socket error: ${socket.id}`, error);
    });
  });
};
