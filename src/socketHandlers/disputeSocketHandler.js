import OfficialDispute from "../models/OfficialDispute.js";
import DisputeMessage from "../models/DisputeMessage.js";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { generateAISummary, generateFinalPlan, generateSuggestedPlan, generateSolutions } from "../controllers/officialDisputeController.js";

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
        .populate("creator_id", "firstName lastName email")
        .populate("joiner_id", "firstName lastName email");

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

      console.log(`${socket.user.email} joined room ${roomId} as ${socket.userRole}`);

      socket.emit("dispute_state", {
        dispute,
        user_role: socket.userRole,
        is_creator: isCreator,
        is_joiner: isJoiner,
        audio_count: dispute.conversation.audio_count,
        status: dispute.status,
        timestamp: new Date()
      });
      console.log(`[EMIT] dispute_state | to: ${socket.user.email} | dispute: ${roomId}`);

      socket.to(roomId).emit("user_online", {
        user_id: socket.userId,
        user_role: socket.userRole,
        user_name: `${socket.user.firstName} ${socket.user.lastName}`,
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
        await message.populate('sender_id', 'firstName lastName email');

        if (callback) callback({ success: true, message, timestamp: new Date() });

        io.to(dispute_id).emit("new_message", {
          message,
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
    requireAuth("send_audio", async ({ dispute_id, audio_data, duration }, callback) => {
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
          const error = { success: false, message: "Maximum 5 audio messages allowed. You've reached the limit." };
          if (callback) callback(error);
          console.log(`[EMIT] callback error | audio limit reached | dispute: ${dispute_id} | role: ${senderRole}`);
          return;
        }

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

      io.to(roomId).emit("approval_update", {
        creator_approved: updated.summary_approval.creator_approved,
        joiner_approved: updated.summary_approval.joiner_approved,
        message: "Approval recorded. Waiting for other party.",
        timestamp: new Date()
      });
      console.log(`[EMIT] approval_update | to room: ${roomId} | creator: ${updated.summary_approval.creator_approved} joiner: ${updated.summary_approval.joiner_approved}`);

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
          .populate("sender_id", "firstName lastName email")
          .sort({ timestamp: 1 });

        let transcript = "";
        for (const msg of messages) {
          const senderName = msg.sender_role === "creator" ? "Person A" : "Person B";
          if (msg.message_type === "text") {
            transcript += `${senderName}: ${msg.text_content}\n`;
          } else {
            transcript += `${senderName}: [Audio message - ${msg.audio_data?.duration || 30}s]\n`;
          }
        }

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
      const selectionField = isCreator
        ? "solution_selections.creator_selected"
        : "solution_selections.joiner_selected";

      const updated = await OfficialDispute.findByIdAndUpdate(
        roomId,
        { $set: { [selectionField]: selected_solution_ids } },
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
      io.to(roomId).emit("selection_update", {
        message: "Selection recorded. Waiting for other party.",
        has_creator_selected: creatorVotes.length > 0,
        has_joiner_selected: joinerVotes.length > 0,
        timestamp: new Date()
      });
      console.log(`[EMIT] selection_update | to room: ${roomId} | creator: ${creatorVotes.length > 0} joiner: ${joinerVotes.length > 0}`);

      if (callback) callback({ success: true, your_selections: selected_solution_ids, waiting_for_other: true });
    });

    // ─── ACCEPT SUGGESTED PLAN ────────────────────────────────────────────────
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
        console.log(`[EMIT] dispute_completed | to room: ${roomId} | both accepted suggested plan`);

        if (callback) callback({ success: true, status: "COMPLETED", final_plan: dispute.final_plan });
        return;
      }

      io.to(roomId).emit("suggested_plan_approval_update", {
        creator_approved: dispute.suggested_plan_approval.creator_approved,
        joiner_approved: dispute.suggested_plan_approval.joiner_approved,
        message: "Acceptance recorded. Waiting for other party.",
        timestamp: new Date()
      });
      console.log(`[EMIT] suggested_plan_approval_update | to room: ${roomId} | creator: ${dispute.suggested_plan_approval.creator_approved} joiner: ${dispute.suggested_plan_approval.joiner_approved}`);

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
      console.log(`[EMIT] negotiation_started | to room: ${roomId} | rejected by: ${isCreator ? "creator" : "joiner"}`);

      if (callback) callback({ success: true, status: "NEGOTIATION" });
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
        creator_approved: dispute.final_plan_approval.creator_approved,
        joiner_approved: dispute.final_plan_approval.joiner_approved,
        message: "Approval recorded. Waiting for other party.",
        timestamp: new Date()
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

    // ─── TYPING INDICATORS ────────────────────────────────────────────────────
    requireAuth("typing", ({ dispute_id }) => {
      socket.to(dispute_id).emit("user_typing", {
        user_id: socket.userId,
        user_role: socket.userRole,
        user_name: `${socket.user.firstName} ${socket.user.lastName}`,
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

    // ─── LEAVE DISPUTE ROOM ───────────────────────────────────────────────────
    requireAuth("leave_dispute", ({ dispute_id }) => {
      socket.leave(dispute_id);
      socket.to(dispute_id).emit("user_left", {
        user_id: socket.userId,
        user_role: socket.userRole,
        user_name: `${socket.user.firstName} ${socket.user.lastName}`,
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