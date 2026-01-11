<<<<<<< HEAD
import { GoogleGenerativeAI } from "@google/generative-ai";
import OfficialDispute from "../models/OfficialDispute.js";
import DisputeMessage from "../models/DisputeMessage.js";
import crypto from "crypto";
import fs from "fs";

// HELPER: Call Gemini AI
async function callGemini(prompt) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json" }
  });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

const cleanAIResponse = (text) => {
  try {
    return JSON.parse(text);
  } catch (err) {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    console.error("JSON Parse Failed:", text);
    throw new Error("AI returned invalid JSON format");
  }
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

// ENDPOINT 1: GET RELATIONSHIP QUESTIONS
export const getRelationshipQuestions = async (req, res) => {
  try {
    const { relationship_type } = req.params;
    const questions = RELATIONSHIP_QUESTIONS[relationship_type] || RELATIONSHIP_QUESTIONS.other;
    res.json({
      success: true,
      relationship_type,
      questions
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to get questions" });
  }
};

// ENDPOINT 2: CREATE DISPUTE
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
        parsedQuestions = typeof relationship_questions === 'string'
          ? JSON.parse(relationship_questions)
          : relationship_questions;
      } catch (e) {
        return res.status(400).json({ message: "Invalid relationship_questions format" });
      }
    }

    let code = generateCode();
    let exists = await OfficialDispute.findOne({ invite_code: code });
    while (exists) {
      code = generateCode();
      exists = await OfficialDispute.findOne({ invite_code: code });
    }

    const dispute = await OfficialDispute.create({
      dispute_name,
      creator_id: req.user._id,
      invite_code: code,
      intake_data: {
        relationship_type,
        custom_relationship: relationship_type === 'other' ? custom_relationship : undefined,
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
    console.error("❌ Create dispute error:", err);
    res.status(500).json({ message: "Failed to create dispute", error: err.message });
  }
};

// ENDPOINT 3: JOIN DISPUTE
export const joinDispute = async (req, res) => {
  try {
    const { invite_code } = req.body;

    if (!invite_code) {
      return res.status(400).json({ message: "Invite code required" });
    }

    const dispute = await OfficialDispute.findOne({
      invite_code: invite_code.toUpperCase(),
      status: "PRE_DISPUTE"
    }).populate('creator_id', 'firstName lastName email');

    if (!dispute) {
      return res.status(404).json({
        message: "Invalid invite code or dispute already started"
      });
    }

    if (dispute.creator_id._id.toString() === req.user._id.toString()) {
      return res.status(400).json({
        message: "You cannot join your own dispute"
      });
    }

    if (dispute.joiner_id) {
      return res.status(400).json({
        message: "This dispute already has two participants"
      });
    }

    dispute.joiner_id = req.user._id;
    dispute.status = "CONVERSATION";
    await dispute.save();

    await dispute.populate('joiner_id', 'firstName lastName email');

    // Emit socket event to creator
    if (req.io) {
      req.io.to(dispute._id.toString()).emit("joiner_connected", {
        joiner_id: req.user._id,
        joiner_name: `${req.user.firstName} ${req.user.lastName}`,
        status: "CONVERSATION",
        message: "Other party has joined. You can start the conversation.",
        timestamp: new Date()
      });
      console.log(`Joiner connected event sent to room ${dispute._id}`);
    }

    res.json({
      success: true,
      message: "Successfully joined dispute. You can now start chatting.",
      dispute_id: dispute._id,
      dispute
    });

  } catch (err) {
    console.error("❌ Join dispute error:", err);
    res.status(500).json({ message: "Failed to join dispute", error: err.message });
  }
};

export const sendAudioMessage = async (req, res) => {
  try {
    const { dispute_id, duration } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: "No audio file provided" });
    }

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) {
      fs.unlinkSync(file.path);
      return res.status(404).json({ message: "Dispute not found" });
    }

    if (dispute.status !== "CONVERSATION") {
      fs.unlinkSync(file.path);
      return res.status(400).json({
        message: "Dispute is not in conversation phase"
      });
    }

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isCreator && !isJoiner) {
      fs.unlinkSync(file.path);
      return res.status(403).json({
        message: "You are not a participant of this dispute"
      });
    }

    const senderRole = isCreator ? "creator" : "joiner";
    const currentCount = dispute.conversation.audio_count[senderRole] || 0;
    if (currentCount >= 5) {
      fs.unlinkSync(file.path);
      return res.status(400).json({
        message: `Maximum 5 audio messages allowed per person. You've reached the limit.`
      });
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

    await message.populate('sender_id', 'firstName lastName email');

    // EMIT SOCKET EVENT
    if (req.io) {
      req.io.to(dispute_id).emit("new_message", {
        message,
        sender_role: senderRole,
        audio_count: dispute.conversation.audio_count,
        remaining: 5 - dispute.conversation.audio_count[senderRole],
        timestamp: new Date()
      });
      console.log(`Audio message broadcast to room ${dispute_id}`);
    }

    res.json({
      success: true,
      message,
      remaining_audios: 5 - dispute.conversation.audio_count[senderRole],
      audio_count: dispute.conversation.audio_count
    });

  } catch (err) {
    console.error("Send audio error:", err);
    if (req.file && req.file.path) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ message: "Failed to send audio", error: err.message });
  }
};

// ENDPOINT 4: GET AUDIO FILE (KEEP - For playback)
export const getAudioFile = async (req, res) => {
  try {
    const { message_id } = req.params;

    const message = await DisputeMessage.findById(message_id);
    if (!message || message.message_type !== "audio") {
      return res.status(404).json({ message: "Audio message not found" });
    }

    const dispute = await OfficialDispute.findById(message.dispute_id);
    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) {
      return res.status(403).json({
        message: "Not authorized to access this audio"
      });
    }

    // If audio is stored as base64/buffer in DB
    if (message.audio_data.data) {
      const buffer = Buffer.from(message.audio_data.data, 'base64');
      res.setHeader('Content-Type', message.audio_data.mimetype || 'audio/webm');
      res.setHeader('Content-Length', buffer.length);
      return res.send(buffer);
    }

    // If audio is stored as file path
    const filePath = message.audio_data.file_path;
    if (filePath && fs.existsSync(filePath)) {
      res.setHeader('Content-Type', message.audio_data.mimetype);
      res.setHeader('Content-Length', message.audio_data.size);
      res.setHeader('Content-Disposition', `inline; filename="${message.audio_data.original_name}"`);
      const fileStream = fs.createReadStream(filePath);
      return fileStream.pipe(res);
    }

    res.status(404).json({ message: "Audio file not found on server" });

  } catch (err) {
    console.error("❌ Get audio error:", err);
    res.status(500).json({ message: "Failed to get audio file" });
  }
};

// ENDPOINT 5: GET CONVERSATION MESSAGES (KEEP - For history)
export const getConversationMessages = async (req, res) => {
  try {
    const { dispute_id } = req.params;
    const { limit = 50, before } = req.query;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) {
      return res.status(403).json({ 
        message: "You are not authorized to view these messages" 
      });
    }

    // Build query with pagination
    const query = { dispute_id };
    if (before) {
      query.timestamp = { $lt: new Date(before) };
    }

    const messages = await DisputeMessage.find(query)
      .populate('sender_id', 'firstName lastName email')
      .sort({ timestamp: -1 })
      .limit(parseInt(limit));

    res.json({
      success: true,
      count: messages.length,
      audio_count: dispute.conversation.audio_count,
      messages: messages.reverse(), // Return in chronological order
      has_more: messages.length === parseInt(limit)
    });

  } catch (err) {
    console.error("❌ Fetch messages error:", err);
    res.status(500).json({ message: "Failed to fetch messages", error: err.message });
  }
};

// ENDPOINT 6: END CONVERSATION (KEEP - Can use HTTP or WebSocket)
export const endConversation = async (req, res) => {
  try {
    const { dispute_id } = req.body;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    if (dispute.status !== "CONVERSATION") {
      return res.status(400).json({ 
        message: "Conversation already ended or not started" 
      });
    }

    const isParticipant = 
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) {
      return res.status(403).json({ 
        message: "You are not authorized to end this conversation" 
      });
    }

    dispute.conversation.ended_by = req.user._id;
    dispute.conversation.ended_at = new Date();
    dispute.status = "AI_SUMMARIZING";
    await dispute.save();

    // Emit socket event
    if (req.io) {
      req.io.to(dispute_id).emit("conversation_ended", {
        ended_by: req.user._id,
        status: "AI_SUMMARIZING",
        message: "Conversation ended. AI is generating summary...",
        timestamp: new Date()
      });
      console.log(`Conversation ended event sent to room ${dispute_id}`);
    }

    // Trigger AI summary generation
    setTimeout(async () => {
      try {
        await generateAISummary(dispute, req.io);
      } catch (error) {
        console.error("Summary generation failed:", error);
        if (req.io) {
          req.io.to(dispute_id).emit("summary_generation_failed", {
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
    console.error("❌ End conversation error:", err);
    res.status(500).json({ message: "Failed to end conversation", error: err.message });
  }
};

// HELPER: GENERATE AI SUMMARY
async function generateAISummary(dispute, io) {
  try {
    console.log("🤖 Generating AI summary for dispute:", dispute._id);

    const messages = await DisputeMessage.find({ 
      dispute_id: dispute._id 
    })
      .populate('sender_id', 'firstName lastName email')
      .sort({ timestamp: 1 });

    if (messages.length === 0) {
      throw new Error("No messages to summarize");
    }

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
- Relationship: ${dispute.intake_data.relationship_type}${dispute.intake_data.custom_relationship ? ` (${dispute.intake_data.custom_relationship})` : ''}
- Importance: ${dispute.intake_data.relationship_importance}
- Goal: ${dispute.intake_data.goal}
- Non-negotiables: ${dispute.intake_data.non_negotiables || "None specified"}
- Topics to avoid: ${dispute.intake_data.avoid_topics || "None specified"}
- Urgency: ${dispute.intake_data.urgency}

CONVERSATION TRANSCRIPT:
${transcript}

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
      io.to(dispute._id.toString()).emit("summary_ready", {
        status: "SUMMARY_REVIEW",
        summary: dispute.ai_summary,
        message: "Summary generated successfully. Please review.",
        timestamp: new Date()
      });
    }

    console.log("✅ Summary generated for dispute:", dispute._id);

  } catch (error) {
    console.error("❌ Summary generation failed:", error);
    dispute.status = "CONVERSATION";
    await dispute.save();
    throw error;
  }
}

// ENDPOINT 9: REPORT SUMMARY (Regenerate)
export const reportSummary = async (req, res) => {
  try {
    const { dispute_id, feedback } = req.body;

    if (!feedback || feedback.trim() === "") {
      return res.status(400).json({ 
        message: "Please provide feedback about what's wrong with the summary" 
      });
    }

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    if (!dispute.ai_summary || !dispute.ai_summary.summary_text) {
      return res.status(400).json({ 
        message: "No summary exists to regenerate" 
      });
    }

    const isParticipant = 
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) {
      return res.status(403).json({ 
        message: "You are not authorized to report this summary" 
      });
    }

    dispute.status = "AI_SUMMARIZING";
    dispute.ai_summary.regeneration_count++;
    await dispute.save();

    if (req.io) {
       req.io.to(dispute_id).emit("summary_regenerating", {
        message: "Regenerating summary based on your feedback...",
        regeneration_count: dispute.ai_summary.regeneration_count,
        timestamp: new Date()
      });
    }

    const messages = await DisputeMessage.find({ dispute_id })
      .populate('sender_id', 'firstName lastName email')
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
${dispute.ai_summary.key_points.map(kp => `- ${kp.point} (mentioned by: ${kp.mentioned_by})`).join('\n')}

USER FEEDBACK:
"${feedback.trim()}"

ORIGINAL CONVERSATION:
${transcript}

CONTEXT:
- Relationship: ${dispute.intake_data.relationship_type}
- Goal: ${dispute.intake_data.goal}

TASK: Generate an IMPROVED summary that specifically addresses the user's feedback while maintaining accuracy.

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

    res.json({
      success: true,
      message: "Summary regenerated successfully",
      summary: dispute.ai_summary,
      regeneration_count: dispute.ai_summary.regeneration_count
    });

  } catch (err) {
    console.error("  Report summary error:", err);
    res.status(500).json({ message: "Failed to regenerate summary", error: err.message });
  }
};

// ENDPOINT 10: APPROVE SUMMARY
export const approveSummary = async (req, res) => {
  try {
    const { dispute_id } = req.body;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    if (dispute.status !== "SUMMARY_REVIEW") {
      return res.status(400).json({ 
        message: "Summary is not ready for approval" 
      });
    }

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?.toString() === req.user._id.toString();
    if (!isCreator && !isJoiner) {
      return res.status(403).json({ 
        message: "You are not authorized to approve this summary" 
      });
    }
    if (isCreator) {
      dispute.summary_approval.creator_approved = true;
    } else {
      dispute.summary_approval.joiner_approved = true;
    }

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

      setTimeout(async () => {
        try {
          await generateSolutions(dispute,  req.io);
        } catch (error) {
          console.error("  Solution generation failed:", error);
          if (req.io) {
             req.io.to(dispute_id).emit("solution_generation_failed", {
              message: "Failed to generate solutions. Please try again.",
              error: error.message
            });
          }
        }
      }, 1000);

      return res.json({
        success: true,
        message: "Both parties approved. Generating solution options...",
        status: "Generating solutions"
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
    console.error("  Approve summary error:", err);
    res.status(500).json({ message: "Failed to approve summary", error: err.message });
  }
};

// HELPER: GENERATE SOLUTIONS (Screen 7)
async function generateSolutions(dispute, io) {
  try {
    console.log("Generating solutions for dispute:", dispute._id);

    const prompt = `You are a conflict resolution expert generating solution options.

CONTEXT:
- Relationship: ${dispute.intake_data.relationship_type}${dispute.intake_data.custom_relationship ? ` (${dispute.intake_data.custom_relationship})` : ''}
- Relationship Importance: ${dispute.intake_data.relationship_importance}
- Goal: ${dispute.intake_data.goal}
- Non-negotiables: ${dispute.intake_data.non_negotiables || "None"}
- Topics to avoid: ${dispute.intake_data.avoid_topics || "None"}

CONVERSATION SUMMARY:
${dispute.ai_summary.summary_text}

KEY POINTS FROM DISCUSSION:
${dispute.ai_summary.key_points.map(kp => `- ${kp.point} (${kp.mentioned_by})`).join('\n')}

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
      io.to(dispute._id.toString()).emit("solutions_ready", {
        status: "OPTIONS_SELECTION",
        solutions: dispute.solutions,
        message: "Solution options generated. Please select your preferred options.",
        timestamp: new Date()
      });
    }

    console.log("  Solutions generated successfully for dispute:", dispute._id);

  } catch (error) {
    console.error("  Solution generation failed:", error);
    dispute.status = "SUMMARY_REVIEW";
    await dispute.save();
    throw error;
  }
}

// ENDPOINT 11: SELECT SOLUTIONS (Screen 7)
export const selectSolutions = async (req, res) => {
  try {
    const { dispute_id, selected_solution_ids } = req.body;

    if (!Array.isArray(selected_solution_ids) || selected_solution_ids.length === 0) {
      return res.status(400).json({ 
        message: "Please select at least one solution" 
      });
    }

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    if (dispute.status !== "OPTIONS_SELECTION") {
      return res.status(400).json({ 
        message: "Not in solution selection phase" 
      });
    }

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isCreator && !isJoiner) {
      return res.status(403).json({ 
        message: "You are not authorized to select solutions" 
      });
    }

    const validSolutionIds = dispute.solutions.map(s => s.id);
    const invalidSelections = selected_solution_ids.filter(id => !validSolutionIds.includes(id));
    if (invalidSelections.length > 0) {
      return res.status(400).json({ 
        message: `Invalid solution IDs: ${invalidSelections.join(', ')}` 
      });
    }

    if (isCreator) {
      dispute.solution_selections.creator_selected = selected_solution_ids;
    } else {
      dispute.solution_selections.joiner_selected = selected_solution_ids;
    }

    await dispute.save();

    if (dispute.solution_selections.creator_selected.length > 0 && 
        dispute.solution_selections.joiner_selected.length > 0) {
      const commonSolutions = dispute.solution_selections.creator_selected.filter(
        id => dispute.solution_selections.joiner_selected.includes(id)
      );

      dispute.status = "COMPLETED";
      await dispute.save();

      if (req.io) {
         req.io.to(dispute_id).emit("dispute_completed", {
          status: "COMPLETED",
          creator_selections: dispute.solution_selections.creator_selected,
          joiner_selections: dispute.solution_selections.joiner_selected,
          common_solutions: commonSolutions,
          message: commonSolutions.length > 0 
            ? `Both parties have selected solutions. You agreed on ${commonSolutions.length} option(s): ${commonSolutions.join(', ')}!` 
            : "Both parties have selected solutions. Review each other's preferences.",
          timestamp: new Date()
        });
      }

      return res.json({
        success: true,
        message: "Dispute completed successfully!",
        status: "COMPLETED",
        creator_selections: dispute.solution_selections.creator_selected,
        joiner_selections: dispute.solution_selections.joiner_selected,
        common_solutions: commonSolutions,
        has_agreement: commonSolutions.length > 0
      });
    }

    if (req.io) {
       req.io.to(dispute_id).emit("selection_update", {
        message: "Selection recorded. Waiting for other party.",
        has_creator_selected: dispute.solution_selections.creator_selected.length > 0,
        has_joiner_selected: dispute.solution_selections.joiner_selected.length > 0,
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
    console.error("  Select solutions error:", err);
    res.status(500).json({ message: "Failed to select solutions", error: err.message });
  }
};

// ENDPOINT 12: GET DISPUTE STATUS
export const getDisputeStatus = async (req, res) => {
  try {
    const { dispute_id } = req.params;

    const dispute = await OfficialDispute.findById(dispute_id)
      .populate('creator_id', 'firstName lastName email')
      .populate('joiner_id', 'firstName lastName email')
      .populate({
        path: 'conversation.messages',
        populate: { path: 'sender_id', select: 'firstName lastName email' }
      });

    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    // Check if user is participant
    const isCreator = dispute.creator_id._id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?._id.toString() === req.user._id.toString();
    const isParticipant = isCreator || isJoiner;

    if (!isParticipant) {
      return res.status(403).json({ 
        message: "You are not authorized to view this dispute" 
      });
    }

    // Determine user's role
    const userRole = isCreator ? "creator" : "joiner";

    res.json({
      success: true,
      dispute,
      user_role: userRole,
      is_creator: isCreator,
      is_joiner: isJoiner
    });

  } catch (err) {
    console.error("  Get dispute status error:", err);
    res.status(500).json({ message: "Failed to fetch dispute", error: err.message });
  }
};

// ENDPOINT 13: GET USER'S DISPUTES
export const getUserDisputes = async (req, res) => {
  try {
    const { status, limit = 50 } = req.query;

    const query = {
      $or: [
        { creator_id: req.user._id },
        { joiner_id: req.user._id }
      ]
    };

    // Filter by status if provided
    if (status) {
      query.status = status;
    }

    const disputes = await OfficialDispute.find(query)
      .populate('creator_id', 'firstName lastName email')
      .populate('joiner_id', 'firstName lastName email')
      .sort({ updatedAt: -1 })
      .limit(parseInt(limit));

    res.json({
      success: true,
      count: disputes.length,
      disputes
    });

  } catch (err) {
    console.error("  Get user disputes error:", err);
    res.status(500).json({ message: "Failed to fetch disputes", error: err.message });
  }
};

// ENDPOINT 14: DELETE DISPUTE
export const deleteDispute = async (req, res) => {
  try {
    const { dispute_id } = req.params;

    const dispute = await OfficialDispute.findById(dispute_id);
    
    if (!dispute) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    // Only creator can delete, and only if not completed
    if (dispute.creator_id.toString() !== req.user._id.toString()) {
      return res.status(403).json({ 
        message: "Only the dispute creator can delete it" 
      });
    }

    if (dispute.status === "COMPLETED") {
      return res.status(400).json({ 
        message: "Cannot delete completed disputes" 
      });
    }

    // Delete all audio files first
    const messages = await DisputeMessage.find({ 
      dispute_id, 
      message_type: "audio" 
    });
    
    for (const msg of messages) {
      if (msg.audio_data?.file_path && fs.existsSync(msg.audio_data.file_path)) {
        try {
          fs.unlinkSync(msg.audio_data.file_path);
          console.log(`🗑️ Deleted audio file: ${msg.audio_data.file_path}`);
        } catch (err) {
          console.error(`  Failed to delete audio file: ${msg.audio_data.file_path}`, err);
        }
      }
    }

    // Delete all messages
    await DisputeMessage.deleteMany({ dispute_id });

    // Delete dispute
    await OfficialDispute.findByIdAndDelete(dispute_id);

    // Emit socket event
    if (req.io) {
       req.io.to(dispute_id).emit("dispute_deleted", {
        message: "This dispute has been deleted by the creator",
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Dispute deleted successfully"
    });

  } catch (err) {
    console.error("  Delete dispute error:", err);
    res.status(500).json({ message: "Failed to delete dispute", error: err.message });
  }
};
=======
import OfficialDispute from "../models/OfficialDispute.js";
import AudioFile from "../models/AudioFile.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import crypto from "crypto";
import fs from "fs";

// CONFIG: Relationship Presets
const PRESETS = {
  couple: {
    system_role: "Relationship Therapist",
    objective: "Prioritize emotional validation, mutual understanding, and a long-term plan that protects the relationship."
  },
  roommate: {
    system_role: "Housing Mediator",
    objective: "Focus on practical rules, fairness in shared responsibilities, and preventing future conflict in the shared space."
  },
  workplace: {
    system_role: "HR Specialist",
    objective: "Focus on professionalism, psychological safety, and a clear, documented agreement that fits workplace norms."
  },
  money: {
    system_role: "Financial Counselor",
    objective: "Clarify expectations and responsibilities around money while reducing blame and protecting the relationship."
  },
  custom: {
    system_role: "Conflict Resolution Expert",
    objective: "Understand the unique context and propose balanced options that respect both sides."
  }
};

const generateCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();

const getGeminiModel = () => {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({ 
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json" }
  });
};

// HELPER: Clean AI Response
const cleanAIResponse = (text) => {
  try {
    // 1. Remove Markdown code blocks
    let cleanText = text.replace(/```json/g, "").replace(/```/g, "").trim();
    
    // 2. Parse the main JSON
    let json = JSON.parse(cleanText);

    // 3. SPECIAL FIX: If 'options' or 'tasks' are stringified inside, parse them
    if (json.options && typeof json.options === "string") {
        json.options = JSON.parse(json.options);
    }
    if (json.tasks && typeof json.tasks === "string") {
        json.tasks = JSON.parse(json.tasks);
    }

    return json;
  } catch (err) {
    console.error("JSON Parse Failed for text:", text);
    throw new Error("AI returned invalid JSON format. Check terminal for details.");
  }
};

// 1. CREATE DISPUTE
export const createDispute = async (req, res) => {
  try {
    const { relationship_type, intake_data } = req.body;
    const code = generateCode();
    
    let audioId = null;
    if (req.file) {
      const audio = await AudioFile.create({
        user_id: req.user._id,
        file_path: req.file.path,
        original_name: "intake.mp3",
        mimetype: req.file.mimetype,
        size: req.file.size
      });
      audioId = audio._id;
    }

    const dispute = await OfficialDispute.create({
      creator_id: req.user._id,
      invite_code: code,
      relationship_type,
      intake_data: typeof intake_data === 'string' ? JSON.parse(intake_data) : intake_data,
      intake_audio: audioId,
      status: "PRE_DISPUTE"
    });

    res.status(201).json({ 
      message: "Official Dispute Started", 
      invite_code: code, 
      dispute_id: dispute._id 
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Creation failed" });
  }
};

// 2. JOIN DISPUTE
export const joinDispute = async (req, res) => {
  try {
    const { invite_code } = req.body;
    const dispute = await OfficialDispute.findOne({ invite_code, status: "PRE_DISPUTE" });

    if (!dispute) return res.status(404).json({ message: "Invalid code" });
    if (dispute.creator_id.toString() === req.user._id.toString()) return res.status(400).json({ message: "Cannot join own room" });

    dispute.joiner_id = req.user._id;
    dispute.status = "FAIRNESS_CHECK"; 
    await dispute.save();

    if (req.io) req.io.to(dispute._id.toString()).emit("status_update", { status: "FAIRNESS_CHECK" });

    res.json({ message: "Joined", dispute_id: dispute._id });
  } catch (err) {
    res.status(500).json({ message: "Join failed" });
  }
};

// 3. SIGN FAIRNESS AGREEMENT
export const signFairness = async (req, res) => {
  try {
    const { dispute_id } = req.body;
    const dispute = await OfficialDispute.findById(dispute_id);

    if (req.user._id.toString() === dispute.creator_id.toString()) {
      dispute.fairness_signatures.creator_signed = true;
    } else {
      dispute.fairness_signatures.joiner_signed = true;
    }

    if (dispute.fairness_signatures.creator_signed && dispute.fairness_signatures.joiner_signed) {
      dispute.status = "ROUND_1_INPUT"; 
      if (req.io) req.io.to(dispute_id).emit("status_update", { status: "ROUND_1_INPUT", message: "Fairness Signed. Starting Round 1." });
    }

    await dispute.save();
    res.json({ message: "Signed", status: dispute.status });

  } catch (err) {
    res.status(500).json({ message: "Signing failed" });
  }
};

// 4. SUBMIT ROUND 1 INPUT
export const submitRound1 = async (req, res) => {
  try {
    const { dispute_id, text_input } = req.body;
    const dispute = await OfficialDispute.findById(dispute_id);
    const file = req.file;

    let audioId = null;
    if (file) {
      const audio = await AudioFile.create({
        user_id: req.user._id,
        file_path: file.path,
        original_name: "round1.mp3",
        mimetype: file.mimetype,
        size: file.size
      });
      audioId = audio._id;
    }

    if (req.user._id.toString() === dispute.creator_id.toString()) {
      if (audioId) dispute.round_1_inputs.creator_audio = audioId;
      if (text_input) dispute.round_1_inputs.creator_text = text_input;
    } else {
      if (audioId) dispute.round_1_inputs.joiner_audio = audioId;
      if (text_input) dispute.round_1_inputs.joiner_text = text_input;
    }

    await dispute.save();

    const creatorReady = dispute.round_1_inputs.creator_audio || dispute.round_1_inputs.creator_text;
    const joinerReady = dispute.round_1_inputs.joiner_audio || dispute.round_1_inputs.joiner_text;

    if (creatorReady && joinerReady) {
      
      dispute.status = "ROUND_1_ANALYSIS";
      await dispute.save();
      
      if (req.io) req.io.to(dispute_id).emit("processing_start", { message: "Analyzing perspectives..." });

      const analysis = await runRound1AI(dispute);
      
      dispute.round_1_result = analysis;
      dispute.status = "ROUND_1_CONFIRMATION"; 
      await dispute.save();

      if (req.io) req.io.to(dispute_id).emit("round_1_complete", { result: analysis, status: "ROUND_1_CONFIRMATION" });

      return res.json({ 
          message: "Round 1 Analysis Complete", 
          result: analysis, 
          status: "ROUND_1_CONFIRMATION" 
      });
    }

    res.json({ message: "Input received. Waiting for opponent." });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Submission failed" });
  }
};

// 5. CONFIRM ROUND 1
export const confirmRound1 = async (req, res) => {
  try {
    const { dispute_id } = req.body;
    console.log(`Attempting confirm for Dispute ID: ${dispute_id}`);

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    if (req.user._id.toString() === dispute.creator_id.toString()) {
      dispute.round_1_confirmation.creator_agreed = true;
      console.log("Creator Agreed");
    } else {
      dispute.round_1_confirmation.joiner_agreed = true;
      console.log("Joiner Agreed");
    }

    if (dispute.round_1_confirmation.creator_agreed && dispute.round_1_confirmation.joiner_agreed) {
        console.log("Both confirmed. Starting Round 2 AI...");
        
        if (!dispute.round_1_result || !dispute.round_1_result.summaries) {
             console.error("CRITICAL: Round 1 Result missing!");
             return res.status(500).json({ message: "Round 1 data missing. Cannot generate Round 2." });
        }

        if (req.io) req.io.to(dispute_id).emit("processing_start", { message: "Generating options..." });
        
        try {
            const options = await runRound2AI(dispute);
            console.log("Round 2 AI Success");
            
            dispute.round_2_options = options.options;
            dispute.status = "ROUND_2_OPTIONS";
            
            await dispute.save();
            
            if (req.io) req.io.to(dispute_id).emit("status_update", { 
                status: "ROUND_2_OPTIONS", 
                data: options.options 
            });

        } catch (aiError) {
            console.error("AI GENERATION FAILED:", aiError);
            throw new Error("Gemini API Error during Round 2");
        }
    } else {
        await dispute.save();
        console.log("Waiting for other user...");
    }

    res.json({ message: "Confirmation received" });
  } catch (err) {
    console.error("ERROR IN CONFIRM ROUND 1:", err);
    res.status(500).json({ message: "Confirmation failed", error: err.message });
  }
};

// 5.5 MODIFY ROUND 1
export const modifyRound1 = async (req, res) => {
  try {
    const { dispute_id, feedback } = req.body;
    const dispute = await OfficialDispute.findById(dispute_id);

    dispute.round_1_confirmation.creator_agreed = false;
    dispute.round_1_confirmation.joiner_agreed = false;
    
    if (req.io) req.io.to(dispute_id).emit("processing_start", { message: "Updating analysis..." });

    const newAnalysis = await runRound1AI_Correction(dispute, feedback);
    
    dispute.round_1_result = newAnalysis;
    await dispute.save();

    if (req.io) req.io.to(dispute_id).emit("round_1_complete", { 
        result: newAnalysis, 
        message: "Analysis updated." 
    });

    res.json({ message: "Correction processed", result: newAnalysis });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Correction failed" });
  }
};


// 6. SUBMIT ROUND 2 (Selection)
export const submitRound2Selection = async (req, res) => {
  try {
    const { dispute_id, selected_ids } = req.body;
    const dispute = await OfficialDispute.findById(dispute_id);

    if (req.user._id.toString() === dispute.creator_id.toString()) {
        dispute.round_2_selections.creator_selected_ids = selected_ids;
    } else {
        dispute.round_2_selections.joiner_selected_ids = selected_ids;
    }

    await dispute.save();

    const c_ids = dispute.round_2_selections.creator_selected_ids;
    const j_ids = dispute.round_2_selections.joiner_selected_ids;

    if (c_ids.length > 0 && j_ids.length > 0) {
        let final_ids = c_ids.filter(id => j_ids.includes(id));
        if (final_ids.length === 0) final_ids = [...new Set([...c_ids, ...j_ids])];

        dispute.final_selected_option_ids = final_ids;

        if (req.io) req.io.to(dispute_id).emit("processing_start", { message: "Drafting Action Plan..." });
        
        const plan = await runRound3AI(dispute);
        
        dispute.round_3_plan.tasks = plan.tasks;
        dispute.round_3_plan.suggestions = plan.suggestions;
        dispute.status = "ROUND_3_PLAN";
        
        await dispute.save();

        if (req.io) req.io.to(dispute_id).emit("status_update", { 
            status: "ROUND_3_PLAN", 
            data: dispute.round_3_plan
        });
    }

    res.json({ message: "Selection received" });
  } catch (err) {
    res.status(500).json({ message: "Selection failed" });
  }
};

// 6.5 MODIFY ROUND 3
export const modifyRound3 = async (req, res) => {
  try {
    const { dispute_id, feedback } = req.body; 
    const dispute = await OfficialDispute.findById(dispute_id);

    dispute.round_3_plan.final_signatures.creator = false;
    dispute.round_3_plan.final_signatures.joiner = false;

    if (req.io) req.io.to(dispute_id).emit("processing_start", { message: "Refining Action Plan..." });

    const newPlan = await runRound3AI_Correction(dispute, feedback);

    dispute.round_3_plan.tasks = newPlan.tasks;
    await dispute.save();

    if (req.io) req.io.to(dispute_id).emit("status_update", { 
        status: "ROUND_3_PLAN", 
        data: dispute.round_3_plan,
        message: "Plan updated based on feedback."
    });

    res.json({ message: "Plan refined", plan: newPlan });

  } catch (err) {
    res.status(500).json({ message: "Modification failed" });
  }
};

// AI FUNCTIONS
async function runRound1AI(dispute) {
  const model = getGeminiModel();
  const preset = PRESETS[dispute.relationship_type];
  
  const prompt = `
    ROLE: You are a ${preset.system_role}.
    OBJECTIVE: ${preset.objective}
    
    INPUT: Two user arguments (Creator vs Joiner).
    creator: "${dispute.round_1_inputs.creator_text || 'Audio Input'}"
    joiner: "${dispute.round_1_inputs.joiner_text || 'Audio Input'}"
    
    TASK: Round 1 - Understanding.
    1. Summarize "What User A is really saying" (their core need).
    2. Summarize "What User B is really saying".
    3. Find "Common Ground" (3 bullet points).
    
    OUTPUT JSON:
    {
      "summaries": { "creator": "...", "joiner": "..." },
      "common_ground": ["...", "...", "..."]
    }
  `;
  const result = await model.generateContent(prompt); 
  return cleanAIResponse(result.response.text());
}

async function runRound1AI_Correction(dispute, feedback) {
  const model = getGeminiModel();
  const prompt = `
    ROLE: Conflict Mediator.
    PREVIOUS ANALYSIS: ${JSON.stringify(dispute.round_1_result)}
    USER FEEDBACK: "${feedback}"
    
    TASK: Update summaries/common ground based on feedback.
    OUTPUT JSON (Same structure):
    {
      "summaries": { "creator": "...", "joiner": "..." },
      "common_ground": ["...", "...", "..."]
    }
  `;
  const result = await model.generateContent(prompt);
  return cleanAIResponse(result.response.text());
}

async function runRound2AI(dispute) {
  const model = getGeminiModel();
  const summary = dispute.round_1_result;

  const prompt = `
    CONTEXT:
    Creator needs: ${summary.summaries.creator}
    Joiner needs: ${summary.summaries.joiner}
    Common Ground: ${summary.common_ground.join(", ")}

    TASK: Generate 3 solutions (A=Creator Focus, B=Joiner Focus, C=Balanced).
    IMPORTANT: Return "options" as a valid JSON Array.

    OUTPUT JSON:
    {
      "options": [
        { 
          "id": "A", "title": "...", "description": "...", "type": "Creator Focused",
          "pros": { "creator": "...", "joiner": "..." },
          "cons": { "creator": "...", "joiner": "..." }
        },
        { 
          "id": "B", "title": "...", "description": "...", "type": "Joiner Focused",
          "pros": { "creator": "...", "joiner": "..." },
          "cons": { "creator": "...", "joiner": "..." }
        },
        { 
          "id": "C", "title": "...", "description": "...", "type": "Balanced Compromise",
          "pros": { "creator": "...", "joiner": "..." },
          "cons": { "creator": "...", "joiner": "..." }
        }
      ]
    }
  `;
  const result = await model.generateContent(prompt);
  return cleanAIResponse(result.response.text());
}

async function runRound3AI(dispute) {
  const model = getGeminiModel();
  const selectedOptions = dispute.round_2_options
    .filter(o => dispute.final_selected_option_ids.includes(o.id))
    .map(o => `${o.title}: ${o.description}`)
    .join("\n");

  const prompt = `
    DECISION: Users agreed on:
    ${selectedOptions}

    TASK: Create an Action Plan.
    1. Tasks (Who, What, By When).
    2. Suggestions (Short/Medium/Long term).

    OUTPUT JSON:
    {
      "tasks": [
        { "who": "Creator", "what": "...", "by_when": "..." }
      ],
      "suggestions": {
        "short_term": ["..."],
        "medium_term": ["..."],
        "long_term": ["..."]
      }
    }
  `;
  const result = await model.generateContent(prompt);
  return cleanAIResponse(result.response.text());
}

async function runRound3AI_Correction(dispute, feedback) {
  const model = getGeminiModel();
  const currentPlan = JSON.stringify(dispute.round_3_plan.tasks);

  const prompt = `
    CURRENT PLAN: ${currentPlan}
    USER REQUEST: "${feedback}"
    
    TASK: Modify the tasks list.
    OUTPUT JSON:
    {
      "tasks": [
        { "who": "...", "what": "...", "by_when": "..." }
      ],
      "suggestions": { "short_term": [], "medium_term": [], "long_term": [] }
    }
  `;
  const result = await model.generateContent(prompt);
  return cleanAIResponse(result.response.text());
}

// 7. GET DISPUTE STATUS (Polling)
export const getDispute = async (req, res) => {
  try {
    const dispute = await OfficialDispute.findById(req.params.id)
      .populate("creator_id joiner_id"); // Get names if needed
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });
    res.json(dispute);
  } catch (err) {
    res.status(500).json({ message: "Error fetching dispute" });
  }
};

// 8. SIGN FINAL PLAN (Completion)
export const signPlan = async (req, res) => {
  try {
    const { dispute_id } = req.body;
    const dispute = await OfficialDispute.findById(dispute_id);

    if (req.user._id.toString() === dispute.creator_id.toString()) {
      dispute.round_3_plan.final_signatures.creator = true;
    } else {
      dispute.round_3_plan.final_signatures.joiner = true;
    }

    await dispute.save();

    // Check if BOTH signed
    if (dispute.round_3_plan.final_signatures.creator && dispute.round_3_plan.final_signatures.joiner) {
      dispute.status = "COMPLETED";
      await dispute.save();
      if (req.io) req.io.to(dispute_id).emit("status_update", {
        status: "COMPLETED",
        message: "Dispute Resolved!"
      });
    }

    res.json({ message: "Plan signed", status: dispute.status });

  } catch (err) {
    res.status(500).json({ message: "Signing failed" });
  }
};
>>>>>>> 568ac423124b3a8823867993fb73fe19d7899ddc
