import { GoogleGenerativeAI } from "@google/generative-ai";
import OfficialDispute from "../models/OfficialDispute.js";
import DisputeMessage from "../models/DisputeMessage.js";
import crypto from "crypto";
import fs from "fs";

async function callGemini(prompt) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0
    }
  });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

const cleanAIResponse = (text) => {
  let cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim();

  // Try raw text first, then cleaned, then extract first {...} block
  for (const candidate of [text, cleaned]) {
    try { return JSON.parse(candidate); } catch (_) { /* try next */ }
  }

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (_) { /* fall through */ }
  }

  console.error("JSON Parse Failed:", text);
  throw new Error("AI returned invalid JSON format");
};

const generateCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();


const RELATIONSHIP_QUESTIONS = {
  couple: [
    "How long have you been together?",
    "What's the main issue affecting your relationship right now?",
    "Do you both want to continue the relationship?",
    "Have you tried resolving this before? What happened?"
  ],
  roommates: [
    "How long have you lived together?",
    "What are the main shared responsibilities causing conflict?",
    "Is anyone planning to move out soon?",
    "What house rules exist currently?"
  ],
  friends: [
    "How long have you known each other?",
    "What triggered this specific conflict?",
    "Do you want to maintain this friendship?",
    "Have you discussed this issue before?"
  ],
  family: [
    "What's your relationship to each other?",
    "Is this a recurring issue or new?",
    "Who else in the family is affected?",
    "What would an ideal resolution look like?"
  ],
  workplace: [
    "What are your roles in the organization?",
    "How long have you worked together?",
    "Has this been reported to HR or management?",
    "What's the impact on your work?"
  ],
  other: [
    "Please describe your relationship",
    "What's the nature of this conflict?",
    "How long has this been an issue?",
    "What do you hope to achieve?"
  ]
};

// SCREEN 1 & 2: DISPUTE CREATION

export const getRelationshipQuestions = async (req, res) => {
  try {
    const { relationship_type } = req.params;
    const questions = RELATIONSHIP_QUESTIONS[relationship_type] || RELATIONSHIP_QUESTIONS.other;
    res.json({ success: true, relationship_type, questions });
  } catch (err) {
    console.error("Get questions error:", err);
    res.status(500).json({ message: "Failed to get questions" });
  }
};

export const createDispute = async (req, res) => {
  try {
    const {
      dispute_name,
      relationship_type,
      custom_relationship,
      relationship_importance,
      goal,
      non_negotiables,
      avoid_topics,
      urgency,
      relationship_questions
    } = req.body;

    if (!dispute_name || !relationship_type || !relationship_importance || !goal || !urgency) {
      return res.status(400).json({
        message: "Missing required fields: dispute_name, relationship_type, relationship_importance, goal, urgency"
      });
    }

    let parsedQuestions = [];
    if (relationship_questions) {
      try {
        parsedQuestions = typeof relationship_questions === "string"
          ? JSON.parse(relationship_questions)
          : relationship_questions;
      } catch {
        return res.status(400).json({ message: "Invalid relationship_questions format" });
      }
    }

    // Unique invite code
    let code = generateCode();
    while (await OfficialDispute.findOne({ invite_code: code })) {
      code = generateCode();
    }

    const dispute = await OfficialDispute.create({
      dispute_name,
      creator_id: req.user._id,
      invite_code: code,
      intake_data: {
        relationship_type,
        custom_relationship: relationship_type === "other" ? custom_relationship : undefined,
        relationship_importance,
        goal,
        non_negotiables,
        avoid_topics,
        urgency,
        relationship_questions: parsedQuestions
      },
      status: "PRE_DISPUTE"
    });

    res.status(201).json({
      success: true,
      message: "Dispute created successfully. Share the invite code with the other party.",
      dispute_id: dispute._id,
      invite_code: code,
      dispute
    });
  } catch (err) {
    console.error("Create dispute error:", err);
    res.status(500).json({ message: "Failed to create dispute", error: err.message });
  }
};

// SCREEN 4: JOIN DISPUTE

export const joinDispute = async (req, res) => {
  try {
    const { invite_code } = req.body;

    if (!invite_code) {
      return res.status(400).json({ message: "Invite code required" });
    }

    const dispute = await OfficialDispute.findOne({
      invite_code: invite_code.toUpperCase(),
      status: "PRE_DISPUTE"
    }).populate("creator_id", "firstName lastName email");

    if (!dispute) {
      return res.status(404).json({ message: "Invalid invite code or dispute already started" });
    }

    if (dispute.creator_id._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: "You cannot join your own dispute" });
    }

    if (dispute.joiner_id) {
      return res.status(400).json({ message: "This dispute already has two participants" });
    }

    dispute.joiner_id = req.user._id;
    dispute.status = "CONVERSATION";
    await dispute.save();
    await dispute.populate("joiner_id", "firstName lastName email");

    // FIX: was using undefined 'dispute_id' variable — use dispute._id.toString()
    if (req.io) {
      req.io.to(dispute._id.toString()).emit("joiner_connected", {
        joiner_id: req.user._id,
        joiner_name: `${req.user.firstName} ${req.user.lastName}`,
        status: "CONVERSATION",
        dispute_name: dispute.dispute_name,
        message: "Other party has joined. You can start the conversation.",
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Successfully joined dispute. You can now start chatting.",
      dispute_id: dispute._id,
      dispute_name: dispute.dispute_name,
      dispute
    });
  } catch (err) {
    console.error("Join dispute error:", err);
    res.status(500).json({ message: "Failed to join dispute", error: err.message });
  }
};

// SCREEN 5: CONVERSATION — AUDIO

export const sendAudioMessage = async (req, res) => {
  try {
    const { dispute_id, duration } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: "No audio file provided" });
    }

    const cleanupFile = () => {
      try { fs.unlinkSync(file.path); } catch (e) { console.error("Failed to cleanup file:", e); }
    };

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) { cleanupFile(); return res.status(404).json({ message: "Dispute not found" }); }

    if (dispute.status !== "CONVERSATION") {
      cleanupFile();
      return res.status(400).json({ message: "Dispute is not in conversation phase" });
    }

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isCreator && !isJoiner) {
      cleanupFile();
      return res.status(403).json({ message: "You are not a participant of this dispute" });
    }

    const senderRole = isCreator ? "creator" : "joiner";
    const currentCount = dispute.conversation.audio_count[senderRole] || 0;

    if (currentCount >= 5) {
      cleanupFile();
      return res.status(400).json({ message: "Maximum 5 audio messages allowed per person. You've reached the limit." });
    }

    const message = await DisputeMessage.create({
      dispute_id,
      sender_id: req.user._id,
      sender_role: senderRole,
      message_type: "audio",
      audio_data: {
        file_path: file.path,
        original_name: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        duration: duration ? parseFloat(duration) : 30
      },
      status: "sent"
    });

    dispute.conversation.messages.push(message._id);
    dispute.conversation.audio_count[senderRole] = currentCount + 1;
    await dispute.save();
    await message.populate("sender_id", "firstName lastName email");

    if (req.io) {
      req.io.to(dispute_id).emit("new_message", {
        message,
        sender_role: senderRole,
        audio_count: dispute.conversation.audio_count,
        remaining: 5 - dispute.conversation.audio_count[senderRole],
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message,
      remaining_audios: 5 - dispute.conversation.audio_count[senderRole],
      audio_count: dispute.conversation.audio_count
    });
  } catch (err) {
    console.error("Send audio error:", err);
    if (req.file?.path) {
      try { fs.unlinkSync(req.file.path); } catch (e) { console.error("Failed to cleanup file:", e); }
    }
    res.status(500).json({ message: "Failed to send audio", error: err.message });
  }
};

export const getAudioFile = async (req, res) => {
  try {
    const { message_id } = req.params;

    const message = await DisputeMessage.findById(message_id);
    if (!message || message.message_type !== "audio") {
      return res.status(404).json({ message: "Audio message not found" });
    }

    const dispute = await OfficialDispute.findById(message.dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) {
      return res.status(403).json({ message: "Not authorized to access this audio" });
    }

    if (message.audio_data.data) {
      const buffer = Buffer.from(message.audio_data.data, "base64");
      res.setHeader("Content-Type", message.audio_data.mimetype || "audio/webm");
      res.setHeader("Content-Length", buffer.length);
      return res.send(buffer);
    }

    const filePath = message.audio_data.file_path;
    if (filePath && fs.existsSync(filePath)) {
      res.setHeader("Content-Type", message.audio_data.mimetype);
      res.setHeader("Content-Length", message.audio_data.size);
      res.setHeader("Content-Disposition", `inline; filename="${message.audio_data.original_name}"`);
      return fs.createReadStream(filePath).pipe(res);
    }

    res.status(404).json({ message: "Audio file not found on server" });
  } catch (err) {
    console.error("Get audio error:", err);
    res.status(500).json({ message: "Failed to get audio file" });
  }
};

export const getConversationMessages = async (req, res) => {
  try {
    const { dispute_id } = req.params;
    const { limit = 50, before } = req.query;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) {
      return res.status(403).json({ message: "You are not authorized to view these messages" });
    }

    const query = { dispute_id };
    if (before) query.timestamp = { $lt: new Date(before) };

    // FIX: was calling .reverse() twice — that cancelled out the sort. Now only called once.
    const messages = await DisputeMessage.find(query)
      .populate("sender_id", "firstName lastName email")
      .sort({ timestamp: -1 })
      .limit(parseInt(limit));

    res.json({
      success: true,
      count: messages.length,
      audio_count: dispute.conversation.audio_count,
      messages: messages.reverse(),
      has_more: messages.length === parseInt(limit)
    });
  } catch (err) {
    console.error("Fetch messages error:", err);
    res.status(500).json({ message: "Failed to fetch messages", error: err.message });
  }
};

export const endConversation = async (req, res) => {
  try {
    const { dispute_id } = req.body;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    if (dispute.status !== "CONVERSATION") {
      return res.status(400).json({ message: "Conversation already ended or not started" });
    }

    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) {
      return res.status(403).json({ message: "You are not authorized to end this conversation" });
    }

    dispute.conversation.ended_by = req.user._id;
    dispute.conversation.ended_at = new Date();
    dispute.status = "AI_SUMMARIZING";
    await dispute.save();

    const ioInstance = req.io || req.app.get("io");

    if (ioInstance) {
      ioInstance.to(dispute_id).emit("conversation_ended", {
        ended_by: req.user._id,
        status: "AI_SUMMARIZING",
        message: "Conversation ended. AI is generating summary...",
        timestamp: new Date()
      });
    }

    const disputeIdString = dispute_id;

    setTimeout(async () => {
      try {
        const freshDispute = await OfficialDispute.findById(disputeIdString);
        if (!freshDispute) {
          console.error("Dispute not found during summary generation");
          return;
        }
        await generateAISummary(freshDispute, disputeIdString, ioInstance);
      } catch (error) {
        console.error("Summary generation failed:", error);
        // generateAISummary already reverts status to CONVERSATION on failure
        if (ioInstance) {
          ioInstance.to(disputeIdString).emit("summary_generation_failed", {
            message: "Failed to generate summary. Please try again.",
            error: error.message
          });
        }
      }
    }, 1000);

    res.json({
      success: true,
      message: "Conversation ended. Generating AI summary...",
      status: "AI_SUMMARIZING"
    });
  } catch (err) {
    console.error("End conversation error:", err);
    res.status(500).json({ message: "Failed to end conversation", error: err.message });
  }
};

// ─────────────────────────────────────────────
// AI HELPER: GENERATE SUMMARY
// ─────────────────────────────────────────────

export async function generateAISummary(dispute, dispute_id, io) {
  try {
    const messages = await DisputeMessage.find({ dispute_id: dispute._id.toString() })
      .populate("sender_id", "firstName lastName email")
      .sort({ timestamp: 1 });

    console.log(`[generateAISummary] Found ${messages.length} messages for dispute ${dispute._id}`);

    let transcript = "";
    for (const msg of messages) {
      const senderName = msg.sender_role === "creator" ? "Person A" : "Person B";
      if (msg.message_type === "text") {
        transcript += `${senderName}: ${msg.text_content}\n`;
      } else {
        transcript += `${senderName}: [Sent ${msg.audio_data?.duration || 30} second audio message]\n`;
      }
    }

    const prompt = `You are an expert conflict mediator analyzing a conversation between two people.

CONTEXT:
- Relationship: ${dispute.intake_data.relationship_type}${dispute.intake_data.custom_relationship ? ` (${dispute.intake_data.custom_relationship})` : ""}
- Importance: ${dispute.intake_data.relationship_importance}
- Goal: ${dispute.intake_data.goal}
- Non-negotiables: ${dispute.intake_data.non_negotiables || "None specified"}
- Topics to avoid: ${dispute.intake_data.avoid_topics || "None specified"}
- Urgency: ${dispute.intake_data.urgency}

CONVERSATION TRANSCRIPT:
${transcript || "No messages exchanged — summarize based on context only."}

TASK: Create a comprehensive, balanced summary of this conversation.

OUTPUT JSON:
{
  "summary_text": "A detailed 2-3 paragraph overview",
  "key_points": [
    {
      "point": "Specific key issue",
      "mentioned_by": "creator" | "joiner" | "both"
    }
  ]
}`;

    const response = await callGemini(prompt);
    const summary = cleanAIResponse(response);

    if (!summary.summary_text || !summary.key_points || !Array.isArray(summary.key_points)) {
      throw new Error("Invalid summary structure from AI");
    }

    dispute.ai_summary = {
      summary_text: summary.summary_text,
      key_points: summary.key_points,
      generated_at: new Date(),
      regeneration_count: dispute.ai_summary?.regeneration_count || 0
    };
    dispute.status = "SUMMARY_REVIEW";
    await dispute.save();

    if (io) {
      io.to(dispute_id).emit("summary_ready", {
        status: "SUMMARY_REVIEW",
        summary: dispute.ai_summary,
        message: "Summary generated successfully. Please review.",
        timestamp: new Date()
      });
    }
  } catch (error) {
    console.error("generateAISummary failed:", error);
    dispute.status = "CONVERSATION";
    await dispute.save();
    throw error;
  }
}

// ─────────────────────────────────────────────
// SCREEN 6: AI SUMMARY REVIEW
// ─────────────────────────────────────────────

// FIX: Added missing SUMMARY_REVIEW status guard
export const reportSummary = async (req, res) => {
  try {
    const { dispute_id, feedback } = req.body;

    if (!feedback || feedback.trim() === "") {
      return res.status(400).json({ message: "Please provide feedback about what's wrong with the summary" });
    }

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    // FIX: status guard was missing in original
    if (dispute.status !== "SUMMARY_REVIEW") {
      return res.status(400).json({ message: "Summary is not currently under review" });
    }

    if (!dispute.ai_summary || !dispute.ai_summary.summary_text) {
      return res.status(400).json({ message: "No summary exists to regenerate" });
    }

    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) {
      return res.status(403).json({ message: "You are not authorized to report this summary" });
    }

    dispute.status = "AI_SUMMARIZING";
    dispute.ai_summary.regeneration_count = (dispute.ai_summary.regeneration_count || 0) + 1;
    await dispute.save();

    if (req.io) {
      req.io.to(dispute_id).emit("summary_regenerating", {
        message: "Regenerating summary based on your feedback...",
        regeneration_count: dispute.ai_summary.regeneration_count,
        timestamp: new Date()
      });
    }

    try {
      const messages = await DisputeMessage.find({ dispute_id })
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
      "mentioned_by": "creator" | "joiner" | "both"
    }
  ]
}`;

      const response = await callGemini(prompt);
      const newSummary = cleanAIResponse(response);

      dispute.ai_summary.summary_text = newSummary.summary_text;
      dispute.ai_summary.key_points = newSummary.key_points;
      dispute.ai_summary.generated_at = new Date();
      dispute.status = "SUMMARY_REVIEW";
      dispute.summary_approval.creator_approved = false;
      dispute.summary_approval.joiner_approved = false;
      await dispute.save();

      if (req.io) {
        req.io.to(dispute_id).emit("summary_updated", {
          status: "SUMMARY_REVIEW",
          summary: dispute.ai_summary,
          message: "Summary has been regenerated based on feedback",
          regeneration_count: dispute.ai_summary.regeneration_count,
          timestamp: new Date()
        });
      }

      return res.json({
        success: true,
        message: "Summary regenerated successfully",
        summary: dispute.ai_summary,
        regeneration_count: dispute.ai_summary.regeneration_count
      });
    } catch (aiErr) {
      dispute.status = "SUMMARY_REVIEW";
      await dispute.save();
      if (req.io) {
        req.io.to(dispute_id).emit("summary_generation_failed", {
          message: "Failed to regenerate summary. Please try again.",
          error: aiErr.message
        });
      }
      return res.status(500).json({ message: "Failed to regenerate summary", error: aiErr.message });
    }
  } catch (err) {
    console.error("Report summary error:", err);
    res.status(500).json({ message: "Failed to regenerate summary", error: err.message });
  }
};

export const approveSummary = async (req, res) => {
  try {
    const { dispute_id } = req.body;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    if (dispute.status !== "SUMMARY_REVIEW") {
      return res.status(400).json({ message: "Summary is not ready for approval" });
    }

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isCreator && !isJoiner) {
      return res.status(403).json({ message: "You are not authorized to approve this summary" });
    }

    if (isCreator && dispute.summary_approval.creator_approved) {
      return res.status(400).json({ message: "You have already approved the summary" });
    }
    if (isJoiner && dispute.summary_approval.joiner_approved) {
      return res.status(400).json({ message: "You have already approved the summary" });
    }

    if (isCreator) dispute.summary_approval.creator_approved = true;
    else dispute.summary_approval.joiner_approved = true;

    await dispute.save();

    if (dispute.summary_approval.creator_approved && dispute.summary_approval.joiner_approved) {
      dispute.status = "AI_SUMMARIZING";
      await dispute.save();

      if (req.io) {
        req.io.to(dispute_id).emit("generating_solutions", {
          status: "AI_SUMMARIZING",
          message: "Both parties approved. Generating solution options...",
          timestamp: new Date()
        });
      }

      const disputeIdString = dispute_id;
      const ioInstance = req.io;

      setTimeout(async () => {
        try {
          const freshDispute = await OfficialDispute.findById(disputeIdString);
          if (!freshDispute) {
            console.error("Dispute not found during solution generation");
            return;
          }
          await generateSolutions(freshDispute, disputeIdString, ioInstance);
        } catch (error) {
          console.error("Solution generation failed:", error);
          // generateSolutions already reverts status & approvals internally.
          // One extra defensive rollback in case the internal save also failed:
          try {
            const rollback = await OfficialDispute.findById(disputeIdString);
            if (rollback && rollback.status === "AI_SUMMARIZING") {
              rollback.status = "SUMMARY_REVIEW";
              rollback.summary_approval.creator_approved = false;
              rollback.summary_approval.joiner_approved = false;
              await rollback.save();
            }
          } catch (rollbackErr) {
            console.error("Failed to rollback after solution generation failure:", rollbackErr);
          }
          if (ioInstance) {
            ioInstance.to(disputeIdString).emit("solution_generation_failed", {
              message: "Failed to generate solutions. Please try again.",
              error: error.message
            });
          }
        }
      }, 1000);

      return res.json({
        success: true,
        message: "Both parties approved. Generating solution options...",
        status: "AI_SUMMARIZING"
      });
    }

    if (req.io) {
      req.io.to(dispute_id).emit("approval_update", {
        creator_approved: dispute.summary_approval.creator_approved,
        joiner_approved: dispute.summary_approval.joiner_approved,
        message: "Approval recorded. Waiting for other party.",
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Your approval recorded. Waiting for other party.",
      creator_approved: dispute.summary_approval.creator_approved,
      joiner_approved: dispute.summary_approval.joiner_approved
    });
  } catch (err) {
    console.error("Approve summary error:", err);
    res.status(500).json({ message: "Failed to approve summary", error: err.message });
  }
};

export const getAISummary = async (req, res) => {
  try {
    const { dispute_id } = req.body;

    if (!dispute_id) {
      return res.status(400).json({ message: "dispute_id is required" });
    }

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) {
      return res.status(403).json({ message: "You are not authorized to view this dispute" });
    }

    if (!dispute.ai_summary || !dispute.ai_summary.summary_text) {
      return res.status(404).json({ message: "No summary available for this dispute" });
    }

    res.json({ success: true, data: dispute.ai_summary, timestamp: new Date() });
  } catch (err) {
    console.error("Get summary error:", err);
    res.status(500).json({ message: "Failed to retrieve summary", error: err.message });
  }
};

// ─────────────────────────────────────────────
// AI HELPER: GENERATE SOLUTIONS
// ─────────────────────────────────────────────

async function generateSolutions(dispute, dispute_id, io) {
  try {
    const prompt = `You are a conflict resolution expert generating solution options.

CONTEXT:
- Relationship: ${dispute.intake_data.relationship_type}${dispute.intake_data.custom_relationship ? ` (${dispute.intake_data.custom_relationship})` : ""}
- Relationship Importance: ${dispute.intake_data.relationship_importance}
- Goal: ${dispute.intake_data.goal}
- Non-negotiables: ${dispute.intake_data.non_negotiables || "None"}
- Topics to avoid: ${dispute.intake_data.avoid_topics || "None"}

CONVERSATION SUMMARY:
${dispute.ai_summary.summary_text}

KEY POINTS FROM DISCUSSION:
${dispute.ai_summary.key_points.map(kp => `- ${kp.point} (${kp.mentioned_by})`).join("\n")}

TASK: Generate 3-5 possible solution options labeled A, B, C, D, E.

REQUIREMENTS:
- Option A: Should favor Person A (creator) more
- Option B: Should favor Person B (joiner) more
- Option C: Balanced compromise between both parties
- Options D & E: Creative alternative solutions (if applicable)
- Each option MUST have specific pros and cons for BOTH sides
- Solutions should be practical, actionable, and respectful

OUTPUT JSON:
{
  "solutions": [
    {
      "id": "A",
      "label": "A",
      "title": "Concise title (5-7 words)",
      "description": "Detailed description of the solution (2-3 sentences)",
      "pros": {
        "creator": ["Specific benefit 1 for Person A", "Specific benefit 2 for Person A"],
        "joiner": ["Specific benefit 1 for Person B", "Specific benefit 2 for Person B"]
      },
      "cons": {
        "creator": ["Specific drawback 1 for Person A", "Specific drawback 2 for Person A"],
        "joiner": ["Specific drawback 1 for Person B", "Specific drawback 2 for Person B"]
      }
    }
  ]
}`;

    const response = await callGemini(prompt);
    const result = cleanAIResponse(response);

    if (!result.solutions || !Array.isArray(result.solutions) || result.solutions.length < 3) {
      throw new Error("Invalid solutions structure from AI");
    }

    dispute.solutions = result.solutions;
    dispute.status = "OPTIONS_SELECTION";
    await dispute.save();

    if (io) {
      io.to(dispute_id).emit("solutions_ready", {
        status: "OPTIONS_SELECTION",
        solutions: dispute.solutions,
        message: "Solution options generated. Please select your preferred options.",
        timestamp: new Date()
      });
    }
  } catch (error) {
    console.error("generateSolutions failed:", error);
    dispute.status = "SUMMARY_REVIEW";
    dispute.summary_approval.creator_approved = false;
    dispute.summary_approval.joiner_approved = false;
    await dispute.save();
    throw error;
  }
}

// SCREEN 7: SOLUTIONS SELECTION

export const getSolutions = async (req, res) => {
  try {
    const { dispute_id } = req.params;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) return res.status(403).json({ message: "Not authorized" });

    if (!dispute.solutions || dispute.solutions.length === 0) {
      return res.status(404).json({ message: "Solutions not generated yet" });
    }

    res.json({ success: true, solutions: dispute.solutions, status: dispute.status });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch solutions", error: err.message });
  }
};

export const selectSolutions = async (req, res) => {
  try {
    const { dispute_id, selected_solution_ids } = req.body;

    if (!Array.isArray(selected_solution_ids) || selected_solution_ids.length === 0) {
      return res.status(400).json({ message: "Please select at least one solution" });
    }

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    if (dispute.status !== "OPTIONS_SELECTION") {
      return res.status(400).json({ message: "Not in solution selection phase" });
    }

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isCreator && !isJoiner) {
      return res.status(403).json({ message: "You are not authorized to select solutions" });
    }

    const validSolutionIds = dispute.solutions.map(s => s.id);
    const invalidSelections = selected_solution_ids.filter(id => !validSolutionIds.includes(id));
    if (invalidSelections.length > 0) {
      return res.status(400).json({ message: `Invalid solution IDs: ${invalidSelections.join(", ")}` });
    }

    if (isCreator) dispute.solution_selections.creator_selected = selected_solution_ids;
    else dispute.solution_selections.joiner_selected = selected_solution_ids;

    await dispute.save();

    const creatorVotes = dispute.solution_selections.creator_selected;
    const joinerVotes = dispute.solution_selections.joiner_selected;

    if (creatorVotes.length > 0 && joinerVotes.length > 0) {
      dispute.status = "AI_SUMMARIZING";
      await dispute.save();

      if (req.io) {
        req.io.to(dispute_id).emit("generating_suggested_plan", {
          status: "AI_SUMMARIZING",
          creator_selections: creatorVotes,
          joiner_selections: joinerVotes,
          message: "Both parties have selected. AI is generating a suggested resolution plan...",
          timestamp: new Date()
        });
      }

      const disputeIdString = dispute._id.toString();
      const ioInstance = req.io;

      setTimeout(async () => {
        try {
          const freshDispute = await OfficialDispute.findById(disputeIdString);
          if (!freshDispute) return;
          await generateSuggestedPlan(freshDispute, ioInstance);
        } catch (error) {
          console.error("Suggested plan generation failed:", error);
          if (ioInstance) {
            ioInstance.to(disputeIdString).emit("suggested_plan_failed", {
              message: "Failed to generate suggested plan. Please try again.",
              error: error.message
            });
          }
        }
      }, 1000);

      return res.json({
        success: true,
        message: "Both parties have selected. Generating suggested plan...",
        status: "AI_SUMMARIZING",
        creator_selections: creatorVotes,
        joiner_selections: joinerVotes
      });
    }

    if (req.io) {
      req.io.to(dispute_id).emit("selection_update", {
        message: "Selection recorded. Waiting for other party.",
        has_creator_selected: creatorVotes.length > 0,
        has_joiner_selected: joinerVotes.length > 0,
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Selection recorded. Waiting for other party.",
      your_selections: selected_solution_ids,
      waiting_for_other: true
    });
  } catch (err) {
    console.error("Select solutions error:", err);
    res.status(500).json({ message: "Failed to select solutions", error: err.message });
  }
};

// AI HELPER: GENERATE SUGGESTED PLAN

async function generateSuggestedPlan(dispute, io) {
  try {
    const creatorSelectedSolutions = dispute.solutions.filter(s =>
      dispute.solution_selections.creator_selected.includes(s.id)
    );
    const joinerSelectedSolutions = dispute.solutions.filter(s =>
      dispute.solution_selections.joiner_selected.includes(s.id)
    );

    const prompt = `You are a professional conflict resolution expert. Based on the solutions both parties selected, generate a suggested resolution plan.

CONTEXT:
- Relationship: ${dispute.intake_data.relationship_type}${dispute.intake_data.custom_relationship ? ` (${dispute.intake_data.custom_relationship})` : ""}
- Relationship Importance: ${dispute.intake_data.relationship_importance}
- Goal: ${dispute.intake_data.goal}
- Non-negotiables: ${dispute.intake_data.non_negotiables || "None"}

ORIGINAL DISPUTE SUMMARY:
${dispute.ai_summary.summary_text}

PERSON A (Creator) selected these solutions:
${creatorSelectedSolutions.map(s => `- Option ${s.id}: ${s.title} — ${s.description}`).join("\n")}

PERSON B (Joiner) selected these solutions:
${joinerSelectedSolutions.map(s => `- Option ${s.id}: ${s.title} — ${s.description}`).join("\n")}

TASK: Create a fair suggested resolution plan that balances both parties' selected solutions. This is a SUGGESTION — both parties will review it and can either accept it or negotiate further.

OUTPUT JSON:
{
  "suggested_plan": {
    "title": "Suggested Resolution Plan Title (5-8 words)",
    "summary": "One paragraph summarizing the suggested resolution based on both parties selections",
    "action_steps": [
      {
        "step": 1,
        "action": "Clear specific action",
        "responsible": "creator" | "joiner" | "both",
        "timeframe": "Immediate / Within 1 week / Ongoing"
      }
    ],
    "commitments": {
      "creator": ["Specific commitment for Person A"],
      "joiner": ["Specific commitment for Person B"]
    },
    "success_criteria": "How both parties will know the resolution is working"
  }
}`;

    const response = await callGemini(prompt);
    const result = cleanAIResponse(response);

    if (!result.suggested_plan || !result.suggested_plan.title || !result.suggested_plan.action_steps) {
      throw new Error("Invalid suggested plan structure from AI");
    }

    dispute.suggested_plan = { ...result.suggested_plan, generated_at: new Date() };
    dispute.suggested_plan_approval = { creator_approved: false, joiner_approved: false };
    dispute.status = "SUGGESTED_PLAN_REVIEW";
    await dispute.save();

    if (io) {
      io.to(dispute._id.toString()).emit("suggested_plan_ready", {
        status: "SUGGESTED_PLAN_REVIEW",
        suggested_plan: dispute.suggested_plan,
        message: "AI has suggested a resolution plan. Review and accept or start negotiation.",
        timestamp: new Date()
      });
    }

    console.log("Suggested plan generated for dispute:", dispute._id);
  } catch (error) {
    console.error("generateSuggestedPlan failed:", error);
    dispute.status = "OPTIONS_SELECTION";
    await dispute.save();
    throw error;
  }
}

// SUGGESTED PLAN REVIEW

export const getSuggestedPlan = async (req, res) => {
  try {
    const { dispute_id } = req.params;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) return res.status(403).json({ message: "Not authorized" });

    if (!dispute.suggested_plan || !dispute.suggested_plan.title) {
      return res.status(404).json({ message: "Suggested plan not generated yet" });
    }

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();

    res.json({
      success: true,
      suggested_plan: dispute.suggested_plan,
      status: dispute.status,
      approval: {
        creator_approved: dispute.suggested_plan_approval?.creator_approved || false,
        joiner_approved: dispute.suggested_plan_approval?.joiner_approved || false,
        your_approval: isCreator
          ? dispute.suggested_plan_approval?.creator_approved
          : dispute.suggested_plan_approval?.joiner_approved
      }
    });
  } catch (err) {
    console.error("Get suggested plan error:", err);
    res.status(500).json({ message: "Failed to fetch suggested plan", error: err.message });
  }
};

export const acceptSuggestedPlan = async (req, res) => {
  try {
    const { dispute_id } = req.body;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    if (dispute.status !== "SUGGESTED_PLAN_REVIEW") {
      return res.status(400).json({ message: "No suggested plan available for acceptance" });
    }

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isCreator && !isJoiner) {
      return res.status(403).json({ message: "Not a participant" });
    }

    if (isCreator && dispute.suggested_plan_approval?.creator_approved) {
      return res.status(400).json({ message: "You have already accepted the plan" });
    }
    if (isJoiner && dispute.suggested_plan_approval?.joiner_approved) {
      return res.status(400).json({ message: "You have already accepted the plan" });
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

      if (req.io) {
        req.io.to(dispute_id).emit("dispute_completed", {
          status: "COMPLETED",
          final_plan: dispute.final_plan,
          message: "Both parties accepted the suggested plan. Dispute resolved successfully!",
          timestamp: new Date()
        });
      }

      return res.json({
        success: true,
        message: "Both parties accepted. Dispute resolved successfully!",
        status: "COMPLETED",
        final_plan: dispute.final_plan
      });
    }

    if (req.io) {
      req.io.to(dispute_id).emit("suggested_plan_approval_update", {
        creator_approved: dispute.suggested_plan_approval.creator_approved,
        joiner_approved: dispute.suggested_plan_approval.joiner_approved,
        message: "Acceptance recorded. Waiting for other party.",
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Acceptance recorded. Waiting for other party.",
      creator_approved: dispute.suggested_plan_approval.creator_approved,
      joiner_approved: dispute.suggested_plan_approval.joiner_approved
    });
  } catch (err) {
    console.error("Accept suggested plan error:", err);
    res.status(500).json({ message: "Failed to accept plan", error: err.message });
  }
};

export const rejectSuggestedPlan = async (req, res) => {
  try {
    const { dispute_id, reason } = req.body;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    if (dispute.status !== "SUGGESTED_PLAN_REVIEW") {
      return res.status(400).json({ message: "No suggested plan to reject" });
    }

    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) return res.status(403).json({ message: "Not a participant" });

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();

    dispute.suggested_plan_approval = { creator_approved: false, joiner_approved: false };
    dispute.status = "NEGOTIATION";
    await dispute.save();

    if (req.io) {
      req.io.to(dispute_id).emit("negotiation_started", {
        status: "NEGOTIATION",
        rejected_by: isCreator ? "creator" : "joiner",
        reason: reason || "Party wants to negotiate further",
        suggested_plan: dispute.suggested_plan,
        creator_selections: dispute.solution_selections.creator_selected,
        joiner_selections: dispute.solution_selections.joiner_selected,
        message: "Suggested plan rejected. Starting negotiation round.",
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Suggested plan rejected. Negotiation phase started.",
      status: "NEGOTIATION",
      rejected_by: isCreator ? "creator" : "joiner"
    });
  } catch (err) {
    console.error("Reject suggested plan error:", err);
    res.status(500).json({ message: "Failed to reject plan", error: err.message });
  }
};

// SCREEN 8: NEGOTIATION

export const postNegotiationComment = async (req, res) => {
  try {
    const { dispute_id, text } = req.body;

    if (!text || text.trim() === "") {
      return res.status(400).json({ message: "Comment text is required" });
    }

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    if (dispute.status !== "NEGOTIATION") {
      return res.status(400).json({ message: "Dispute is not in negotiation phase" });
    }

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isCreator && !isJoiner) {
      return res.status(403).json({ message: "You are not a participant of this dispute" });
    }

    const senderRole = isCreator ? "creator" : "joiner";

    dispute.negotiation.comments.push({
      sender_id: req.user._id,
      sender_role: senderRole,
      text: text.trim(),
      timestamp: new Date()
    });

    // Reset ready flags — both must re-confirm after each new message
    dispute.negotiation.creator_ready = false;
    dispute.negotiation.joiner_ready = false;

    await dispute.save();

    const savedComment = dispute.negotiation.comments[dispute.negotiation.comments.length - 1];

    if (req.io) {
      req.io.to(dispute_id).emit("new_negotiation_comment", {
        comment: {
          ...savedComment.toObject(),
          sender_name: `${req.user.firstName} ${req.user.lastName}`
        },
        creator_ready: false,
        joiner_ready: false,
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Comment posted",
      comment: savedComment,
      creator_ready: dispute.negotiation.creator_ready,
      joiner_ready: dispute.negotiation.joiner_ready
    });
  } catch (err) {
    console.error("Post negotiation comment error:", err);
    res.status(500).json({ message: "Failed to post comment", error: err.message });
  }
};

export const getNegotiationComments = async (req, res) => {
  try {
    const { dispute_id } = req.params;

    const dispute = await OfficialDispute.findById(dispute_id)
      .populate("negotiation.comments.sender_id", "firstName lastName email");

    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) {
      return res.status(403).json({ message: "You are not authorized to view these comments" });
    }

    res.json({
      success: true,
      comments: dispute.negotiation.comments,
      creator_ready: dispute.negotiation.creator_ready,
      joiner_ready: dispute.negotiation.joiner_ready,
      count: dispute.negotiation.comments.length
    });
  } catch (err) {
    console.error("Get negotiation comments error:", err);
    res.status(500).json({ message: "Failed to fetch comments", error: err.message });
  }
};

export const signalAgreement = async (req, res) => {
  try {
    const { dispute_id } = req.body;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    if (dispute.status !== "NEGOTIATION") {
      return res.status(400).json({ message: "Dispute is not in negotiation phase" });
    }

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isCreator && !isJoiner) {
      return res.status(403).json({ message: "You are not a participant of this dispute" });
    }

    if (isCreator) dispute.negotiation.creator_ready = true;
    else dispute.negotiation.joiner_ready = true;

    await dispute.save();

    if (dispute.negotiation.creator_ready && dispute.negotiation.joiner_ready) {
      dispute.status = "AI_SUMMARIZING";
      await dispute.save();

      if (req.io) {
        req.io.to(dispute_id).emit("generating_final_plan", {
          status: "AI_SUMMARIZING",
          message: "Both parties agreed. AI is constructing the final resolution plan...",
          timestamp: new Date()
        });
      }

      const disputeIdString = dispute_id;
      const ioInstance = req.io;

      setTimeout(async () => {
        try {
          const freshDispute = await OfficialDispute.findById(disputeIdString);
          if (!freshDispute) {
            console.error("Dispute not found during final plan generation");
            return;
          }
          await generateFinalPlan(freshDispute, disputeIdString, ioInstance);
        } catch (error) {
          console.error("Final plan generation failed:", error);
          // generateFinalPlan reverts status to NEGOTIATION internally
          if (ioInstance) {
            ioInstance.to(disputeIdString).emit("final_plan_failed", {
              message: "Failed to generate final plan. Please try again.",
              error: error.message
            });
          }
        }
      }, 1000);

      return res.json({
        success: true,
        message: "Both parties agreed. Generating final resolution plan...",
        status: "AI_SUMMARIZING"
      });
    }

    if (req.io) {
      req.io.to(dispute_id).emit("agreement_update", {
        creator_ready: dispute.negotiation.creator_ready,
        joiner_ready: dispute.negotiation.joiner_ready,
        message: "Agreement signal recorded. Waiting for other party.",
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Agreement signal recorded. Waiting for other party.",
      creator_ready: dispute.negotiation.creator_ready,
      joiner_ready: dispute.negotiation.joiner_ready
    });
  } catch (err) {
    console.error("Signal agreement error:", err);
    res.status(500).json({ message: "Failed to signal agreement", error: err.message });
  }
};

// AI HELPER: GENERATE FINAL PLAN (FIX: now exported)

export async function generateFinalPlan(dispute, dispute_id, io) {
  try {
    const creatorSelectedSolutions = dispute.solutions.filter(s =>
      dispute.solution_selections.creator_selected.includes(s.id)
    );
    const joinerSelectedSolutions = dispute.solutions.filter(s =>
      dispute.solution_selections.joiner_selected.includes(s.id)
    );

    const negotiationThread = dispute.negotiation.comments
      .map(c => `${c.sender_role === "creator" ? "Person A" : "Person B"}: ${c.text}`)
      .join("\n");

    const prompt = `You are a professional conflict resolution expert constructing a final binding resolution plan.

CONTEXT:
- Relationship: ${dispute.intake_data.relationship_type}${dispute.intake_data.custom_relationship ? ` (${dispute.intake_data.custom_relationship})` : ""}
- Relationship Importance: ${dispute.intake_data.relationship_importance}
- Goal: ${dispute.intake_data.goal}
- Non-negotiables: ${dispute.intake_data.non_negotiables || "None"}

ORIGINAL DISPUTE SUMMARY:
${dispute.ai_summary.summary_text}

PERSON A (Creator) preferred these solutions:
${creatorSelectedSolutions.map(s => `- Option ${s.id}: ${s.title} — ${s.description}`).join("\n")}

PERSON B (Joiner) preferred these solutions:
${joinerSelectedSolutions.map(s => `- Option ${s.id}: ${s.title} — ${s.description}`).join("\n")}

NEGOTIATION DISCUSSION:
${negotiationThread || "No additional comments were made — both parties agreed directly."}

TASK: Based on everything above, construct a clear, fair, and actionable final resolution plan that both parties have agreed to.

OUTPUT JSON:
{
  "final_plan": {
    "title": "Resolution Plan Title (5-8 words)",
    "summary": "One paragraph summarizing what both parties have agreed to",
    "action_steps": [
      {
        "step": 1,
        "action": "Clear, specific action to take",
        "responsible": "creator" | "joiner" | "both",
        "timeframe": "Immediate / Within 1 week / Ongoing / etc."
      }
    ],
    "commitments": {
      "creator": ["Specific commitment Person A is making"],
      "joiner": ["Specific commitment Person B is making"]
    },
    "success_criteria": "How both parties will know the resolution is working"
  }
}`;

    const response = await callGemini(prompt);
    const result = cleanAIResponse(response);

    if (!result.final_plan || !result.final_plan.title || !result.final_plan.action_steps) {
      throw new Error("Invalid final plan structure from AI");
    }

    dispute.final_plan = result.final_plan;
    dispute.status = "FINAL_PLAN_REVIEW";
    await dispute.save();

    if (io) {
      io.to(dispute_id).emit("final_plan_ready", {
        status: "FINAL_PLAN_REVIEW",
        final_plan: dispute.final_plan,
        message: "Final resolution plan is ready. Please review and approve.",
        timestamp: new Date()
      });
    }

    console.log("Final plan generated for dispute:", dispute._id);
  } catch (error) {
    console.error("generateFinalPlan failed:", error);
    dispute.status = "NEGOTIATION";
    await dispute.save();
    throw error;
  }
}

// SCREEN 9: FINAL PLAN REVIEW

export const approveFinalPlan = async (req, res) => {
  try {
    const { dispute_id } = req.body;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    if (dispute.status !== "FINAL_PLAN_REVIEW") {
      return res.status(400).json({ message: "Final plan is not ready for approval" });
    }

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isCreator && !isJoiner) {
      return res.status(403).json({ message: "You are not authorized to approve this plan" });
    }

    if (isCreator && dispute.final_plan_approval.creator_approved) {
      return res.status(400).json({ message: "You have already approved the final plan" });
    }
    if (isJoiner && dispute.final_plan_approval.joiner_approved) {
      return res.status(400).json({ message: "You have already approved the final plan" });
    }

    if (isCreator) dispute.final_plan_approval.creator_approved = true;
    else dispute.final_plan_approval.joiner_approved = true;

    await dispute.save();

    if (dispute.final_plan_approval.creator_approved && dispute.final_plan_approval.joiner_approved) {
      dispute.status = "COMPLETED";
      dispute.completed_at = new Date();
      await dispute.save();

      if (req.io) {
        req.io.to(dispute_id).emit("dispute_completed", {
          status: "COMPLETED",
          final_plan: dispute.final_plan,
          message: "Both parties approved the plan. Dispute resolved successfully!",
          timestamp: new Date()
        });
      }

      return res.json({
        success: true,
        message: "Dispute resolved successfully! Both parties approved the final plan.",
        status: "COMPLETED",
        final_plan: dispute.final_plan
      });
    }

    if (req.io) {
      req.io.to(dispute_id).emit("plan_approval_update", {
        creator_approved: dispute.final_plan_approval.creator_approved,
        joiner_approved: dispute.final_plan_approval.joiner_approved,
        message: "Approval recorded. Waiting for other party.",
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Approval recorded. Waiting for other party.",
      creator_approved: dispute.final_plan_approval.creator_approved,
      joiner_approved: dispute.final_plan_approval.joiner_approved
    });
  } catch (err) {
    console.error("Approve final plan error:", err);
    res.status(500).json({ message: "Failed to approve final plan", error: err.message });
  }
};

export const reportFinalPlanIssue = async (req, res) => {
  try {
    const { dispute_id, feedback } = req.body;

    if (!feedback || feedback.trim() === "") {
      return res.status(400).json({ message: "Please provide feedback about the issue" });
    }

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    if (dispute.status !== "FINAL_PLAN_REVIEW" && dispute.status !== "COMPLETED") {
      return res.status(400).json({ message: "No final plan to report on" });
    }

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isCreator && !isJoiner) {
      return res.status(403).json({ message: "You are not a participant of this dispute" });
    }

    dispute.final_plan_reports.push({
      reporter_id: req.user._id,
      reporter_role: isCreator ? "creator" : "joiner",
      feedback: feedback.trim(),
      reported_at: new Date()
    });

    // Counts as implicit approval so the dispute can still complete
    if (isCreator) dispute.final_plan_approval.creator_approved = true;
    else dispute.final_plan_approval.joiner_approved = true;

    if (dispute.final_plan_approval.creator_approved && dispute.final_plan_approval.joiner_approved) {
      dispute.status = "COMPLETED";
      dispute.completed_at = new Date();
    }

    await dispute.save();

    if (dispute.status === "COMPLETED" && req.io) {
      req.io.to(dispute_id).emit("dispute_completed", {
        status: "COMPLETED",
        final_plan: dispute.final_plan,
        message: "Dispute has been closed.",
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Issue reported. Thank you for your feedback. The dispute has been marked as resolved.",
      status: dispute.status
    });
  } catch (err) {
    console.error("Report final plan issue error:", err);
    res.status(500).json({ message: "Failed to report issue", error: err.message });
  }
};

export const getFinalPlan = async (req, res) => {
  try {
    const { dispute_id } = req.params;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isCreator && !isJoiner) {
      return res.status(403).json({ message: "You are not authorized to view this plan" });
    }

    if (!dispute.final_plan || !dispute.final_plan.title) {
      return res.status(404).json({ message: "Final plan not generated yet" });
    }

    res.json({
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
  } catch (err) {
    console.error("Get final plan error:", err);
    res.status(500).json({ message: "Failed to fetch final plan", error: err.message });
  }
};

// GENERAL ENDPOINTS

export const getDisputeStatus = async (req, res) => {
  try {
    const { dispute_id } = req.params;

    const dispute = await OfficialDispute.findById(dispute_id)
      .populate("creator_id", "firstName lastName email")
      .populate("joiner_id", "firstName lastName email")
      .populate({
        path: "conversation.messages",
        populate: { path: "sender_id", select: "firstName lastName email" }
      });

    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    const isCreator = dispute.creator_id._id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?._id.toString() === req.user._id.toString();

    if (!isCreator && !isJoiner) {
      return res.status(403).json({ message: "You are not authorized to view this dispute" });
    }

    res.json({
      success: true,
      dispute,
      user_role: isCreator ? "creator" : "joiner",
      is_creator: isCreator,
      is_joiner: isJoiner
    });
  } catch (err) {
    console.error("Get dispute status error:", err);
    res.status(500).json({ message: "Failed to fetch dispute", error: err.message });
  }
};

export const getUserDisputes = async (req, res) => {
  try {
    const { status, limit = 50 } = req.query;

    const query = {
      $or: [{ creator_id: req.user._id }, { joiner_id: req.user._id }]
    };

    if (status) query.status = status;

    const disputes = await OfficialDispute.find(query)
      .populate("creator_id", "firstName lastName email")
      .populate("joiner_id", "firstName lastName email")
      .sort({ updatedAt: -1 })
      .limit(parseInt(limit));

    res.json({ success: true, count: disputes.length, disputes });
  } catch (err) {
    console.error("Get user disputes error:", err);
    res.status(500).json({ message: "Failed to fetch disputes", error: err.message });
  }
};

export const deleteDispute = async (req, res) => {
  try {
    const { dispute_id } = req.params;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    if (dispute.creator_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: "Only the dispute creator can delete it" });
    }

    if (dispute.status === "COMPLETED") {
      return res.status(400).json({ message: "Cannot delete completed disputes" });
    }

    const audioMessages = await DisputeMessage.find({ dispute_id, message_type: "audio" });
    for (const msg of audioMessages) {
      if (msg.audio_data?.file_path && fs.existsSync(msg.audio_data.file_path)) {
        try { fs.unlinkSync(msg.audio_data.file_path); }
        catch (e) { console.error(`Failed to delete audio file: ${msg.audio_data.file_path}`, e); }
      }
    }

    await DisputeMessage.deleteMany({ dispute_id });
    await OfficialDispute.findByIdAndDelete(dispute_id);

    if (req.io) {
      req.io.to(dispute_id).emit("dispute_deleted", {
        message: "This dispute has been deleted by the creator",
        timestamp: new Date()
      });
    }

    res.json({ success: true, message: "Dispute deleted successfully" });
  } catch (err) {
    console.error("Delete dispute error:", err);
    res.status(500).json({ message: "Failed to delete dispute", error: err.message });
  }
};