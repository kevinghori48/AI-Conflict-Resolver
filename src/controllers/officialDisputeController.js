import { GoogleGenerativeAI } from "@google/generative-ai";
import OfficialDispute from "../models/OfficialDispute.js";
import SmallDispute from "../models/SmallDispute.js";
import Report from "../models/Report.js";
import DisputeMessage from "../models/DisputeMessage.js";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { transcribeAudio, analyzeMultimodalContent } from "../services/geminiService.js";
import MultimodalAnalysis from "../models/MultimodalAnalysis.js";

// Convert any audio file to MP3 using ffmpeg.
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const convertToMp3 = (inputPath, outputPath) =>
  new Promise((resolve, reject) => {
    execFile(FFMPEG_PATH, ["-y", "-i", inputPath, "-ac", "1", "-ar", "44100", "-b:a", "128k", outputPath], (err, stdout, stderr) => {
      if (err) {
        console.error("[ffmpeg] conversion failed:", err.message);
        console.error("[ffmpeg] stderr:", stderr);
        return reject(err);
      }
      try { fs.unlinkSync(inputPath); } catch (_) { }
      resolve(outputPath);
    });
  });

export const cleanAIResponse = (text) => {
  // 1. Try raw text first
  try { return JSON.parse(text); } catch (_) { }

  // 2. Strip markdown fences
  let cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try { return JSON.parse(cleaned); } catch (_) { }

  // 3. Try extracting JSON object
  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try { return JSON.parse(objectMatch[0]); } catch (_) { }
  }

  // 4. Try extracting JSON array
  const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try { return JSON.parse(arrayMatch[0]); } catch (_) { }
  }

  // 5. Last resort — strip control characters
  const sanitized = cleaned.replace(/[\u0000-\u001F\u007F]/g, " ");

  const sanitizedObject = sanitized.match(/\{[\s\S]*\}/);
  if (sanitizedObject) {
    try { return JSON.parse(sanitizedObject[0]); } catch (_) { }
  }

  // Log the raw response so you can see exactly what Gemini returned
  console.error("[cleanAIResponse] All parse attempts failed. Raw response:", text);
  throw new Error("AI returned invalid JSON format");
};

const AI_GENERATION_POLL_INTERVAL_MS = Number(process.env.AI_GENERATION_POLL_INTERVAL_MS || 500);
const AI_GENERATION_WAIT_TIMEOUT_MS = Number(process.env.AI_GENERATION_WAIT_TIMEOUT_MS || 15000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getMessageSenderName = (msg, creatorName, joinerName) =>
  msg.sender_role === "creator" ? creatorName : joinerName;

const escapeHtml = (value = "") =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const escapeRegex = (value = "") =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizeSensitiveTopics = (topics) =>
  Array.isArray(topics)
    ? [...new Set(
      topics
        .map((topic) => String(topic || "").trim())
        .filter(Boolean)
    )]
    : [];

const ensureString = (value) => String(value || "").trim();

const stripMarkdown = (value = "") =>
  String(value)
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/__(.*?)__/g, "$1")
    .replace(/_(.*?)_/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .trim();

const ensureStringArray = (value) => {
  if (Array.isArray(value)) {
    return value.map(ensureString).filter(Boolean);
  }
  const single = ensureString(value);
  return single ? [single] : [];
};

function normalizeCommitments(commitments) {
  if (!commitments || typeof commitments !== "object" || Array.isArray(commitments)) {
    const flattened = ensureString(commitments);
    return {
      creator: flattened ? [flattened] : [],
      joiner: []
    };
  }

  return {
    creator: ensureStringArray(commitments.creator),
    joiner: ensureStringArray(commitments.joiner)
  };
}

function normalizeActionSteps(actionSteps) {
  if (!Array.isArray(actionSteps)) return [];

  return actionSteps
    .map((step, index) => ({
      step: Number(step?.step) || index + 1,
      action: ensureString(step?.action),
      responsible: ensureString(step?.responsible),
      timeframe: ensureString(step?.timeframe)
    }))
    .filter((step) => step.action);
}

function normalizePlanOutput(plan) {
  return {
    ...plan,
    title: ensureString(plan?.title),
    summary: ensureString(plan?.summary),
    mediator_note: ensureString(plan?.mediator_note),
    ai_suggestions: ensureStringArray(plan?.ai_suggestions).slice(0, 3),
    sensitive_topics: normalizeSensitiveTopics(plan?.sensitive_topics),
    action_steps: normalizeActionSteps(plan?.action_steps),
    commitments: normalizeCommitments(plan?.commitments),
    success_criteria: ensureString(plan?.success_criteria)
  };
}

function highlightSensitiveText(text, sensitiveTopics) {
  const cleanText = stripMarkdown(text || "");
  if (!cleanText) return "";
  if (!sensitiveTopics.length) return escapeHtml(cleanText);

  const normalizedTopics = sensitiveTopics
    .map((topic) => stripMarkdown(topic))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

  if (!normalizedTopics.length) return escapeHtml(cleanText);

  const lowerText = cleanText.toLowerCase();
  const ranges = [];

  for (const topic of normalizedTopics) {
    const lowerTopic = topic.toLowerCase();
    const matchIndex = lowerText.indexOf(lowerTopic);
    if (matchIndex === -1) continue;

    let start = matchIndex;
    let end = matchIndex + topic.length;

    const leftBoundary = Math.max(
      cleanText.lastIndexOf(". ", matchIndex),
      cleanText.lastIndexOf("! ", matchIndex),
      cleanText.lastIndexOf("? ", matchIndex),
      cleanText.lastIndexOf(", ", matchIndex),
      cleanText.lastIndexOf("; ", matchIndex)
    );

    if (leftBoundary >= 0) {
      start = leftBoundary + 2;
    } else {
      start = Math.max(0, cleanText.lastIndexOf(" ", matchIndex - 1) + 1);
    }

    const rightCandidates = [
      cleanText.indexOf(". ", end),
      cleanText.indexOf("! ", end),
      cleanText.indexOf("? ", end),
      cleanText.indexOf(", ", end),
      cleanText.indexOf("; ", end)
    ].filter((idx) => idx >= 0);

    if (rightCandidates.length > 0) {
      end = Math.min(...rightCandidates);
    } else {
      const nextSpace = cleanText.indexOf(" ", end);
      end = nextSpace >= 0 ? nextSpace : cleanText.length;
    }

    ranges.push({ start, end });
  }

  if (!ranges.length) return escapeHtml(cleanText);

  ranges.sort((a, b) => a.start - b.start);
  const mergedRanges = [];
  for (const range of ranges) {
    const previous = mergedRanges[mergedRanges.length - 1];
    if (!previous || range.start > previous.end) {
      mergedRanges.push({ ...range });
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }

  let output = "";
  let cursor = 0;

  for (const range of mergedRanges) {
    output += escapeHtml(cleanText.slice(cursor, range.start));
    output += `<span class="highlighted-fragment">${escapeHtml(cleanText.slice(range.start, range.end).trim())}</span>`;
    cursor = range.end;
  }

  output += escapeHtml(cleanText.slice(cursor));
  return output;
}

function decoratePlanWithHighlights(plan) {
  const normalizedPlan = normalizePlanOutput(plan);
  const sensitiveTopics = normalizedPlan.sensitive_topics;
  const creatorCommitments = normalizedPlan.commitments.creator;
  const joinerCommitments = normalizedPlan.commitments.joiner;

  return {
    ...normalizedPlan,
    // We use the detected topics only for inline highlights so the frontend
    // doesn't render a separate "sensitive topics" section.
    sensitive_topics: [],
    summary_html: highlightSensitiveText(normalizedPlan.summary, sensitiveTopics),
    action_steps: normalizedPlan.action_steps.map((step) => ({
      ...step,
      action_html: highlightSensitiveText(step?.action || "", sensitiveTopics)
    })),
    commitments_html: {
      creator: creatorCommitments.map((item) => highlightSensitiveText(item, sensitiveTopics)),
      joiner: joinerCommitments.map((item) => highlightSensitiveText(item, sensitiveTopics))
    },
    success_criteria_html: highlightSensitiveText(normalizedPlan.success_criteria, sensitiveTopics)
  };
}

function getMessageContentForAI(msg) {
  if (msg.message_type === "text") {
    return (msg.text_content || "").trim();
  }

  return msg.audio_data?.transcript?.trim() || "";
}

export async function buildDisputeTranscriptForAI(messages, creatorName = "Person A", joinerName = "Person B") {
  const transcriptLines = [];

  for (const msg of messages) {
    const content = getMessageContentForAI(msg);
    if (!content) continue;

    transcriptLines.push(`${getMessageSenderName(msg, creatorName, joinerName)}: ${content}`);
  }

  return transcriptLines.join("\n");
}

async function waitForGeneratedDisputeContent(disputeId, isReady, options = {}) {
  const timeoutMs = options.timeoutMs ?? AI_GENERATION_WAIT_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? AI_GENERATION_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;

  let dispute = await OfficialDispute.findById(disputeId);

  while (
    dispute &&
    !isReady(dispute) &&
    dispute.status === "AI_SUMMARIZING" &&
    Date.now() < deadline
  ) {
    await sleep(intervalMs);
    dispute = await OfficialDispute.findById(disputeId);
  }

  return dispute;
}

// ─── Groq fallback (OpenAI-compatible API) ────────────────────────────────────
// Called automatically when Gemini returns 503. Requires GROQ_API_KEY in .env
// Get your free key at: https://console.groq.com
async function callGroq(prompt) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY not set — cannot use Groq fallback");
  }

  const strictPrompt = prompt + `\n\nCRITICAL: Your response MUST be valid JSON only. No markdown, no backticks, no explanation. Start with { and end with }. Nothing else.`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      temperature: 0,
      messages: [
        { role: "system", content: "You are a helpful assistant that responds only in valid JSON." },
        { role: "user", content: strictPrompt }
      ]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Groq API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Groq returned empty response");

  cleanAIResponse(text); // validate JSON before returning
  return text;
}

// ─── Main AI caller with Gemini → Groq fallback ───────────────────────────────
export async function callGemini(prompt, retries = 4) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  // Gemini model order: try 2.5-flash first, fall back to 1.5-flash
  const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-1.5-flash"];

  const strictPrompt = prompt + `\n\nCRITICAL: Your response MUST be valid JSON only. No markdown, no backticks, no explanation. Start with { and end with }. Nothing else.`;

  let lastError;
  let gemini503Count = 0;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const modelName = attempt <= 2 ? GEMINI_MODELS[0] : GEMINI_MODELS[1];
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: "application/json", temperature: 0 }
    });

    try {
      console.log(`[callGemini] attempt ${attempt}/${retries} | model: ${modelName}`);
      const result = await model.generateContent(strictPrompt);
      const text = result.response.text();
      cleanAIResponse(text);
      return text;
    } catch (err) {
      lastError = err;
      const is503 = err?.message?.includes("503") || err?.message?.includes("Service Unavailable") || err?.message?.includes("high demand");

      if (is503) {
        gemini503Count++;
        console.warn(`[callGemini] 503 overload | attempt ${attempt}/${retries} | model: ${modelName}`);

        // After 2 consecutive 503s, try Groq immediately before continuing Gemini retries
        if (gemini503Count >= 2 && process.env.GROQ_API_KEY) {
          try {
            console.log(`[callGemini] switching to Groq fallback after ${gemini503Count} Gemini 503s`);
            const groqResult = await callGroq(prompt);
            console.log(`[callGemini] Groq fallback succeeded`);
            return groqResult;
          } catch (groqErr) {
            console.warn(`[callGemini] Groq fallback also failed: ${groqErr.message} — continuing Gemini retries`);
          }
        }

        await new Promise(r => setTimeout(r, 4000 * attempt));
      } else {
        console.warn(`[callGemini] attempt ${attempt}/${retries} invalid JSON | model: ${modelName} — retrying in ${1000 * attempt}ms`);
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }

  // Last resort: try Groq if all Gemini attempts failed
  if (process.env.GROQ_API_KEY) {
    try {
      console.log(`[callGemini] all Gemini attempts exhausted — final Groq fallback`);
      const groqResult = await callGroq(prompt);
      console.log(`[callGemini] final Groq fallback succeeded`);
      return groqResult;
    } catch (groqErr) {
      console.error(`[callGemini] Groq final fallback failed: ${groqErr.message}`);
    }
  }

  throw new Error(`All AI providers failed. Last error: ${lastError?.message}`);
}

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
    // "Please describe your relationship",
    // "What's the nature of this conflict?",
    // "How long has this been an issue?",
    // "What do you hope to achieve?"
    "What have you already tried to resolve the situation?",
    "How long has this situation been affecting your relationship?",
    "How has this situation impacted your relationship?",
    "What outcome are you hoping to achieve?"
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
    }).populate("creator_id", "firstName lastName email avatarId gender");

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
    await dispute.populate("joiner_id", "firstName lastName email avatarId gender");

    // FIX: was using undefined 'dispute_id' variable — use dispute._id.toString()
    if (req.app.get('io')) {
      req.app.get('io').to(dispute._id.toString()).emit("joiner_connected", {
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


// SCREEN 5: CONVERSATION — AUDIO UPLOAD (step 1: upload file, get audio_id back)

export const uploadAudio = async (req, res) => {
  try {
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: "No audio file provided" });
    }

    // Convert to MP3 for universal playback
    const mp3Path = file.path.replace(/\.[^.]+$/, "") + ".mp3";
    try {
      await convertToMp3(file.path, mp3Path);
    } catch (convErr) {
      console.error("ffmpeg conversion failed, using raw file:", convErr);
      fs.renameSync(file.path, mp3Path);
    }

    const transcript = await transcribeAudio(mp3Path);

    // Saved as a temporary audio record (not tied to a dispute yet).
    // dispute_id and sender_role are intentionally omitted so Mongoose skips enum validation.
    // They are filled in when the send_audio socket event fires.
    const message = await DisputeMessage.create({
      sender_id: req.user._id,
      message_type: "audio",
      audio_data: {
        file_path: mp3Path,
        original_name: file.originalname.replace(/\.[^.]+$/, "") + ".mp3",
        mimetype: "audio/mpeg",
        size: fs.statSync(mp3Path).size,
        duration: 0,   // updated when send_audio socket event fires
        transcript
      },
      status: "sent"
    });

    const audioUrl = `${req.protocol}://${req.get("host")}/official-dispute/message/audio/${message._id}`;

    res.json({ success: true, audio_url: audioUrl, audio_id: message._id });
  } catch (err) {
    console.error("Upload audio error:", err);
    const rawPath = req.file?.path;
    const mp3PathOnErr = rawPath ? rawPath.replace(/\.[^.]+$/, "") + ".mp3" : null;
    for (const p of [rawPath, mp3PathOnErr]) {
      if (p && fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (e) { console.error("Failed to cleanup file:", e); }
      }
    }
    res.status(500).json({ message: "Failed to upload audio", error: err.message });
  }
};

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

    // Convert to MP3 for universal playback (iOS doesn't support webm).
    // multer already wrote the raw file to file.path — convert it in place.
    const mp3Path = file.path.replace(/\.[^.]+$/, "") + ".mp3";
    try {
      await convertToMp3(file.path, mp3Path);  // deletes file.path on success
    } catch (convErr) {
      console.error("ffmpeg conversion failed, using raw file:", convErr);
      fs.renameSync(file.path, mp3Path);        // fallback: rename without converting
    }

    const transcript = await transcribeAudio(mp3Path);

    const message = await DisputeMessage.create({
      dispute_id,
      sender_id: req.user._id,
      sender_role: senderRole,
      message_type: "audio",
      audio_data: {
        file_path: mp3Path,
        original_name: file.originalname.replace(/\.[^.]+$/, "") + ".mp3",
        mimetype: "audio/mpeg",
        size: fs.statSync(mp3Path).size,
        duration: duration ? parseFloat(duration) : 30,
        transcript
      },
      status: "sent"
    });

    dispute.conversation.messages.push(message._id);
    dispute.conversation.audio_count[senderRole] = currentCount + 1;
    await dispute.save();
    await message.populate("sender_id", "firstName lastName email avatarId gender");

    const audioUrl = `${req.protocol}://${req.get("host")}/official-dispute/message/audio/${message._id}`;

    if (req.app.get('io')) {
      req.app.get('io').to(dispute_id).emit("new_message", {
        message,
        audio_url: audioUrl,
        sender_role: senderRole,
        audio_count: dispute.conversation.audio_count,
        remaining: 5 - dispute.conversation.audio_count[senderRole],
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message,
      audio_url: audioUrl,
      remaining_audios: 5 - dispute.conversation.audio_count[senderRole],
      audio_count: dispute.conversation.audio_count
    });
  } catch (err) {
    console.error("Send audio error:", err);
    // Clean up whichever file exists (raw or converted)
    const rawPath = req.file?.path;
    const mp3PathOnErr = rawPath ? rawPath.replace(/\.[^.]+$/, "") + ".mp3" : null;
    for (const p of [rawPath, mp3PathOnErr]) {
      if (p && fs.existsSync(p)) {
        try { fs.unlinkSync(p); } catch (e) { console.error("Failed to cleanup file:", e); }
      }
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

    // Allow audio to be streamed directly (no auth required)
    // Message IDs are unguessable MongoDB ObjectIDs
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Accept-Ranges", "bytes");

    if (message.audio_data.data) {
      const buffer = Buffer.from(message.audio_data.data, "base64");
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("Content-Disposition", `inline; filename="audio_${message_id}.mp3"`);
      return res.send(buffer);
    }

    const filePath = message.audio_data.file_path;
    if (filePath && fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const range = req.headers.range;

      // Support range requests (required for iOS audio scrubbing)
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        const chunkSize = end - start + 1;

        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
        res.setHeader("Content-Length", chunkSize);
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Content-Disposition", `inline; filename="audio_${message_id}.mp3"`);
        return fs.createReadStream(filePath, { start, end }).pipe(res);
      }

      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Content-Length", stat.size);
      res.setHeader("Content-Disposition", `inline; filename="audio_${message_id}.mp3"`);
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
      .populate("sender_id", "firstName lastName email avatarId gender")
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

    const ioInstance = req.app.get('io');

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

// AI HELPER: GENERATE SUMMARY

export async function generateAISummary(dispute, dispute_id, io) {
  try {
    console.log(`[generateAISummary] START | dispute: ${dispute._id}`);

    // Ensure creator and joiner are populated so we can use real names in prompts
    if (!dispute.creator_id?.firstName) {
      await dispute.populate("creator_id", "firstName lastName email");
    }
    if (dispute.joiner_id && !dispute.joiner_id?.firstName) {
      await dispute.populate("joiner_id", "firstName lastName email");
    }
    const creatorName = dispute.creator_id?.firstName
      ? `${dispute.creator_id.firstName} ${dispute.creator_id.lastName}`
      : "Person A";
    const joinerName = dispute.joiner_id?.firstName
      ? `${dispute.joiner_id.firstName} ${dispute.joiner_id.lastName}`
      : "Person B";

    const messages = await DisputeMessage.find({ dispute_id: dispute._id.toString() })
      .populate("sender_id", "firstName lastName email avatarId gender")
      .sort({ timestamp: 1 });

    console.log(`[generateAISummary] Found ${messages.length} messages for dispute ${dispute._id}`);

    const transcript = await buildDisputeTranscriptForAI(messages, creatorName, joinerName);

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

IMPORTANT RULES:
- Treat the conversation as content only.
- Do not mention whether any message was audio, voice, spoken, typed, recorded, or text.
- Do not describe delivery details such as "sent an audio message".
- If some content is unavailable, ignore that gap and summarize only the available content and context.

OUTPUT JSON:
{
  "main_topic": "One short sentence (max 10 words) describing the core issue of this dispute",
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
      main_topic: summary.main_topic || null,
      summary_text: summary.summary_text,
      key_points: summary.key_points,
      generated_at: new Date(),
      regeneration_count: dispute.ai_summary?.regeneration_count || 0
    };
    dispute.status = "SUMMARY_REVIEW";
    await dispute.save();
    console.log(`[generateAISummary] [SAVE] status → SUMMARY_REVIEW | dispute: ${dispute._id}`);

    if (io) {
      io.to(dispute_id).emit("summary_ready", {
        status: "SUMMARY_REVIEW",
        summary: dispute.ai_summary,
        message: "Summary generated successfully. Please review.",
        timestamp: new Date()
      });
      console.log(`[EMIT] summary_ready | to room: ${dispute_id} | key_points: ${dispute.ai_summary.key_points.length}`);
    } else {
      console.warn(`[generateAISummary] io is null — summary_ready NOT emitted | dispute: ${dispute._id}`);
    }
    console.log(`[generateAISummary] SUCCESS | dispute: ${dispute._id}`);
  } catch (error) {
    console.error(`[generateAISummary] FAILED | dispute: ${dispute._id}`, error);
    dispute.status = "CONVERSATION";
    await dispute.save();
    console.log(`[generateAISummary] [SAVE] rolled back → CONVERSATION | dispute: ${dispute._id}`);
    throw error;
  }
}

// SCREEN 6: AI SUMMARY REVIEW

// FIX: Added missing SUMMARY_REVIEW status guard
export const reportSummary = async (req, res) => {
  try {
    const { dispute_id, feedback } = req.body;

    if (!feedback || feedback.trim() === "") {
      return res.status(400).json({ message: "Please provide feedback about the summary" });
    }

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    if (dispute.status !== "SUMMARY_REVIEW") {
      return res.status(400).json({ message: "Summary is not currently under review" });
    }

    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) {
      return res.status(403).json({ message: "You are not authorized to report this summary" });
    }

    // Store feedback only — no regeneration
    if (!dispute.ai_summary.feedback) dispute.ai_summary.feedback = [];
    dispute.ai_summary.feedback.push({
      reporter_id: req.user._id,
      reporter_role: dispute.creator_id.toString() === req.user._id.toString() ? "creator" : "joiner",
      feedback: feedback.trim(),
      reported_at: new Date()
    });
    await dispute.save();

    if (req.app.get("io")) {
      req.app.get("io").to(dispute_id).emit("summary_reported", {
        status: dispute.status,
        message: "Feedback recorded. Thank you.",
        timestamp: new Date(),
        reported_by: {
          user_id: req.user._id,
          name: `${req.user.firstName} ${req.user.lastName}`,
          role: dispute.creator_id.toString() === req.user._id.toString() ? "creator" : "joiner"
        }
      });
    }

    return res.json({
      success: true,
      message: "Feedback recorded. Thank you."
    });
  } catch (err) {
    console.error("Report summary error:", err);
    res.status(500).json({ message: "Failed to report summary", error: err.message });
  }
};

export const approveSummary = async (req, res) => {
  try {
    const { dispute_id } = req.body;

    // Pre-check: load for authorization only (not for state decisions)
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

    // Atomic update: only flip the approval flag if it is still false AND status is SUMMARY_REVIEW.
    // This eliminates the read-modify-write race where two simultaneous requests both read
    // approval=false, both pass the in-memory guard above, and both trigger generateSolutions.
    const approvalField = isCreator
      ? "summary_approval.creator_approved"
      : "summary_approval.joiner_approved";

    const updated = await OfficialDispute.findOneAndUpdate(
      { _id: dispute_id, status: "SUMMARY_REVIEW", [approvalField]: false },
      { $set: { [approvalField]: true } },
      { new: true }
    );

    if (!updated) {
      // Either already approved by this user, or status changed concurrently
      return res.status(400).json({
        message: "You have already approved the summary, or it is no longer under review"
      });
    }

    if (updated.summary_approval.creator_approved && updated.summary_approval.joiner_approved) {
      // Emit summary_approved (both_approved: true) to every socket individually
      // so each user gets their own your_approval value
      if (req.app.get('io')) {
        const approverRole = isCreator ? "creator" : "joiner";
        const ts = new Date();
        const allSockets = await req.app.get('io').in(dispute_id).fetchSockets();
        for (const s of allSockets) {
          s.emit("summary_approved", {
            approved_by: approverRole,
            creator_approved: true,
            joiner_approved: true,
            both_approved: true,
            your_approval: true, // both approved — true for everyone
            message: "Both parties approved the summary.",
            timestamp: ts
          });
        }
      }

      // Atomically claim the right to trigger generation by flipping status exactly once.
      const claimed = await OfficialDispute.findOneAndUpdate(
        { _id: dispute_id, status: "SUMMARY_REVIEW" },
        { $set: { status: "AI_SUMMARIZING" } },
        { new: true }
      );

      if (!claimed) {
        return res.json({
          success: true,
          message: "Both parties approved. Generating solution options...",
          status: "AI_SUMMARIZING"
        });
      }

      if (req.app.get('io')) {
        req.app.get('io').to(dispute_id).emit("generating_solutions", {
          status: "AI_SUMMARIZING",
          message: "Both parties approved. Generating solution options...",
          timestamp: new Date()
        });
      }

      const disputeIdString = dispute_id;
      const ioInstance = req.app.get('io');
      console.log(`[approveSummary] ioInstance resolved: ${ioInstance ? "OK" : "NULL — check io middleware"}`);

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

    if (req.app.get('io')) {
      const approverRole = isCreator ? "creator" : "joiner";
      const io = req.app.get('io');
      const ts = new Date();
      const basePayload = {
        approved_by: approverRole,
        creator_approved: updated.summary_approval.creator_approved,
        joiner_approved: updated.summary_approval.joiner_approved,
        both_approved: false,
        message: `${req.user.firstName} ${req.user.lastName} approved the summary. Waiting for the other party.`,
        timestamp: ts
      };

      // Emit individually so each socket gets its own your_approval value
      const allSockets = await io.in(dispute_id).fetchSockets();
      for (const s of allSockets) {
        s.emit("summary_approved", {
          ...basePayload,
          your_approval: s.userId === req.user._id.toString()
        });
      }
    }

    res.json({
      success: true,
      message: "Your approval recorded. Waiting for other party.",
      creator_approved: updated.summary_approval.creator_approved,
      joiner_approved: updated.summary_approval.joiner_approved
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

    let dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) {
      return res.status(403).json({ message: "You are not authorized to view this dispute" });
    }

    dispute = await waitForGeneratedDisputeContent(
      dispute_id,
      (d) => Boolean(d.ai_summary?.summary_text)
    );

    if (!dispute.ai_summary?.summary_text) {
      if (dispute.status === "AI_SUMMARIZING") {
        return res.status(202).json({
          success: false,
          status: dispute.status,
          message: "Summary is still being generated"
        });
      }
      return res.status(404).json({ message: "No summary available for this dispute" });
    }

    res.json({ success: true, data: dispute.ai_summary, timestamp: new Date() });
  } catch (err) {
    console.error("Get summary error:", err);
    res.status(500).json({ message: "Failed to retrieve summary", error: err.message });
  }
};

// AI HELPER: GENERATE SOLUTIONS

export async function generateSolutions(dispute, dispute_id, io) {
  try {
    console.log(`[generateSolutions] START | dispute: ${dispute._id}`);

    // Ensure creator and joiner are populated so we can use real names in prompts
    if (!dispute.creator_id?.firstName) {
      await dispute.populate("creator_id", "firstName lastName email");
    }
    if (dispute.joiner_id && !dispute.joiner_id?.firstName) {
      await dispute.populate("joiner_id", "firstName lastName email");
    }
    const creatorName = dispute.creator_id?.firstName
      ? `${dispute.creator_id.firstName} ${dispute.creator_id.lastName}`
      : "Person A";
    const joinerName = dispute.joiner_id?.firstName
      ? `${dispute.joiner_id.firstName} ${dispute.joiner_id.lastName}`
      : "Person B";

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
- Option A: Should favor ${creatorName} (creator) more
- Option B: Should favor ${joinerName} (joiner) more
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
        "creator": ["Specific benefit 1 for ${creatorName}", "Specific benefit 2 for ${creatorName}"],
        "joiner": ["Specific benefit 1 for ${joinerName}", "Specific benefit 2 for ${joinerName}"]
      },
      "cons": {
        "creator": ["Specific drawback 1 for ${creatorName}", "Specific drawback 2 for ${creatorName}"],
        "joiner": ["Specific drawback 1 for ${joinerName}", "Specific drawback 2 for ${joinerName}"]
      }
    }
  ]
}`;

    console.log(`[generateSolutions] Calling Gemini | dispute: ${dispute._id}`);
    const response = await callGemini(prompt);
    const result = cleanAIResponse(response);

    if (!result.solutions || !Array.isArray(result.solutions) || result.solutions.length < 3) {
      throw new Error("Invalid solutions structure from AI");
    }

    console.log(`[generateSolutions] Got ${result.solutions.length} solutions | dispute: ${dispute._id}`);
    dispute.solutions = result.solutions;
    dispute.status = "OPTIONS_SELECTION";
    await dispute.save();
    console.log(`[generateSolutions] [SAVE] status → OPTIONS_SELECTION | dispute: ${dispute._id}`);

    if (io) {
      io.to(dispute_id).emit("solutions_ready", {
        status: "OPTIONS_SELECTION",
        solutions: dispute.solutions,
        message: "Solution options generated. Please select your preferred options.",
        timestamp: new Date()
      });
      console.log(`[EMIT] solutions_ready | to room: ${dispute_id} | count: ${dispute.solutions.length}`);
    } else {
      console.warn(`[generateSolutions] io is null — solutions_ready NOT emitted | dispute: ${dispute._id}`);
    }
    console.log(`[generateSolutions] SUCCESS | dispute: ${dispute._id}`);
  } catch (error) {
    console.error(`[generateSolutions] FAILED | dispute: ${dispute._id}`, error);
    dispute.status = "SUMMARY_REVIEW";
    dispute.summary_approval.creator_approved = false;
    dispute.summary_approval.joiner_approved = false;
    await dispute.save();
    console.log(`[generateSolutions] [SAVE] rolled back → SUMMARY_REVIEW | dispute: ${dispute._id}`);
    throw error;
  }
}

// SCREEN 7: SOLUTIONS SELECTION

export const getSolutions = async (req, res) => {
  try {
    const { dispute_id } = req.params;

    let dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) return res.status(403).json({ message: "Not authorized" });

    dispute = await waitForGeneratedDisputeContent(
      dispute_id,
      (d) => Array.isArray(d.solutions) && d.solutions.length > 0
    );

    if (!dispute.solutions || dispute.solutions.length === 0) {
      if (dispute.status === "AI_SUMMARIZING") {
        return res.status(202).json({
          success: false,
          status: dispute.status,
          message: "Solutions are still being generated"
        });
      }
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

    const selectionField = isCreator
      ? "solution_selections.creator_selected"
      : "solution_selections.joiner_selected";
    const confirmedField = isCreator
      ? "solution_selections.creator_confirmed"
      : "solution_selections.joiner_confirmed";

    const updated = await OfficialDispute.findByIdAndUpdate(
      dispute_id,
      { $set: { [selectionField]: selected_solution_ids, [confirmedField]: true } },
      { new: true }
    );

    if (!updated) {
      return res.status(404).json({ message: "Dispute not found" });
    }

    const creatorVotes = updated.solution_selections.creator_selected;
    const joinerVotes = updated.solution_selections.joiner_selected;

    if (creatorVotes.length > 0 && joinerVotes.length > 0) {
      dispute.status = "AI_SUMMARIZING";
      await dispute.save();

      if (req.app.get('io')) {
        req.app.get('io').to(dispute_id).emit("generating_suggested_plan", {
          status: "AI_SUMMARIZING",
          creator_selections: creatorVotes,
          joiner_selections: joinerVotes,
          message: "Both parties have selected. AI is generating a suggested resolution plan...",
          timestamp: new Date()
        });
        console.log(`[EMIT] generating_suggested_plan | to room: ${dispute_id}`);
      }

      const disputeIdString = dispute._id.toString();
      const ioInstance = req.app.get('io');
      console.log(`[selectSolutions] ioInstance resolved: ${ioInstance ? "OK" : "NULL — check io middleware"}`);

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

    if (req.app.get('io')) {
      const io = req.app.get('io');
      const allSockets = await io.in(dispute_id).fetchSockets();
      for (const s of allSockets) {
        const isCreatorSocket = s.userRole === "creator";
        s.emit("selection_update", {
          selected_by: isCreator ? "creator" : "joiner",
          creator_confirmed: updated.solution_selections.creator_confirmed,
          joiner_confirmed: updated.solution_selections.joiner_confirmed,
          both_selected: false,
          you_confirmed: isCreatorSocket ? updated.solution_selections.creator_confirmed : updated.solution_selections.joiner_confirmed,
          other_confirmed: isCreatorSocket ? updated.solution_selections.joiner_confirmed : updated.solution_selections.creator_confirmed,
          message: "Selection confirmed. Waiting for other party.",
          timestamp: new Date()
        });
      }
    }

    res.json({
      success: true,
      message: "Selection confirmed. Waiting for other party.",
      your_selections: selected_solution_ids,
      creator_confirmed: updated.solution_selections.creator_confirmed,
      joiner_confirmed: updated.solution_selections.joiner_confirmed,
      waiting_for_other: true
    });
  } catch (err) {
    console.error("Select solutions error:", err);
    res.status(500).json({ message: "Failed to select solutions", error: err.message });
  }
};

// AI HELPER: GENERATE SUGGESTED PLAN

export async function generateSuggestedPlan(dispute, io) {
  try {
    console.log(`[generateSuggestedPlan] START | dispute: ${dispute._id}`);

    // Ensure creator and joiner are populated so we can use real names in prompts
    if (!dispute.creator_id?.firstName) {
      await dispute.populate("creator_id", "firstName lastName email");
    }
    if (dispute.joiner_id && !dispute.joiner_id?.firstName) {
      await dispute.populate("joiner_id", "firstName lastName email");
    }
    const creatorName = dispute.creator_id?.firstName
      ? `${dispute.creator_id.firstName} ${dispute.creator_id.lastName}`
      : "Person A";
    const joinerName = dispute.joiner_id?.firstName
      ? `${dispute.joiner_id.firstName} ${dispute.joiner_id.lastName}`
      : "Person B";

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

${creatorName} (Creator) selected these solutions:
${creatorSelectedSolutions.map(s => `- Option ${s.id}: ${s.title} — ${s.description}`).join("\n")}

${joinerName} (Joiner) selected these solutions:
${joinerSelectedSolutions.map(s => `- Option ${s.id}: ${s.title} — ${s.description}`).join("\n")}

TASK: Create a fair suggested resolution plan that balances both parties' selected solutions. This is a SUGGESTION — both parties will review it and can either accept it or negotiate further.

IMPORTANT:
- Make the AI's role visible and useful to the user.
- Add a short mediator note explaining why this plan could work in warm, human language.
- Add 3 concise AI suggestions that sound supportive and natural, like a thoughtful mediator coaching two real people.
- Use plain everyday language, not robotic advice or therapy jargon.
- Identify sensitive words or phrases only for inline highlighting in the summary/action plan. Do not make them look like a separate warning box.

OUTPUT JSON:
{
  "suggested_plan": {
    "title": "Suggested Resolution Plan Title (5-8 words)",
    "summary": "One paragraph summarizing the suggested resolution based on both parties selections",
    "mediator_note": "2-3 warm, human sentences from the AI mediator explaining the reasoning behind this suggested plan",
    "ai_suggestions": [
      "Human, supportive suggestion 1",
      "Human, supportive suggestion 2",
      "Human, supportive suggestion 3"
    ],
    "sensitive_topics": ["Topic or phrase 1", "Topic or phrase 2"],
    "action_steps": [
      {
        "step": 1,
        "action": "Clear specific action",
        "responsible": "creator" | "joiner" | "both",
        "timeframe": "Immediate / Within 1 week / Ongoing"
      }
    ],
    "commitments": {
      "creator": ["Specific commitment for ${creatorName}"],
      "joiner": ["Specific commitment for ${joinerName}"]
    },
    "success_criteria": "How both parties will know the resolution is working"
  }
}`;

    const response = await callGemini(prompt);
    const result = cleanAIResponse(response);

    if (!result.suggested_plan || !result.suggested_plan.title || !result.suggested_plan.action_steps) {
      throw new Error("Invalid suggested plan structure from AI");
    }

    dispute.suggested_plan = decoratePlanWithHighlights({
      ...result.suggested_plan,
      generated_at: new Date()
    });
    dispute.suggested_plan_approval = { creator_approved: false, joiner_approved: false };
    dispute.status = "SUGGESTED_PLAN_REVIEW";
    await dispute.save();
    console.log(`[generateSuggestedPlan] [SAVE] status → SUGGESTED_PLAN_REVIEW | dispute: ${dispute._id}`);

    if (io) {
      io.to(dispute._id.toString()).emit("suggested_plan_ready", {
        status: "SUGGESTED_PLAN_REVIEW",
        suggested_plan: dispute.suggested_plan,
        message: "Your AI mediator suggested a resolution plan with guidance and sensitive-topic highlights.",
        timestamp: new Date()
      });
      console.log(`[EMIT] suggested_plan_ready | to room: ${dispute._id} | title: ${dispute.suggested_plan.title}`);
    } else {
      console.warn(`[generateSuggestedPlan] io is null — suggested_plan_ready NOT emitted | dispute: ${dispute._id}`);
    }
    console.log(`[generateSuggestedPlan] SUCCESS | dispute: ${dispute._id}`);

  } catch (error) {
    console.error(`[generateSuggestedPlan] FAILED | dispute: ${dispute._id}`, error);
    dispute.status = "OPTIONS_SELECTION";
    await dispute.save();
    console.log(`[generateSuggestedPlan] [SAVE] rolled back → OPTIONS_SELECTION | dispute: ${dispute._id}`);
    throw error;
  }
}

// SUGGESTED PLAN REVIEW

export const getSuggestedPlan = async (req, res) => {
  try {
    const { dispute_id } = req.params;

    let dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    const isParticipant =
      dispute.creator_id.toString() === req.user._id.toString() ||
      dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isParticipant) return res.status(403).json({ message: "Not authorized" });

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();

    dispute = await waitForGeneratedDisputeContent(
      dispute_id,
      (d) => Boolean(d.suggested_plan?.title)
    );

    if (!dispute.suggested_plan?.title) {
      if (dispute.status === "AI_SUMMARIZING") {
        return res.status(202).json({
          success: false,
          status: dispute.status,
          message: "Suggested plan is still being generated"
        });
      }
      return res.status(404).json({ message: "Suggested plan not generated yet" });
    }

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

      if (req.app.get('io')) {
        req.app.get('io').to(dispute_id).emit("dispute_completed", {
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

    if (req.app.get('io')) {
      const io = req.app.get('io');
      const allSockets = await io.in(dispute_id).fetchSockets();
      for (const s of allSockets) {
        s.emit("suggested_plan_approval_update", {
          approved_by: isCreator ? "creator" : "joiner",
          approved_by_name: `${req.user.firstName} ${req.user.lastName}`,
          creator_approved: dispute.suggested_plan_approval.creator_approved,
          joiner_approved: dispute.suggested_plan_approval.joiner_approved,
          both_approved: false,
          your_approval: s.userId === req.user._id.toString()
            ? true
            : (s.userRole === "creator"
              ? dispute.suggested_plan_approval.creator_approved
              : dispute.suggested_plan_approval.joiner_approved),
          message: `${req.user.firstName} accepted the plan. Waiting for the other party.`,
          timestamp: new Date()
        });
      }
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
    const rejecterRole = isCreator ? "creator" : "joiner";
    const otherRole = isCreator ? "joiner" : "creator";

    // Determine if the other party had a pending acceptance that must be auto-cancelled
    const otherHadAccepted = isCreator
      ? dispute.suggested_plan_approval?.joiner_approved
      : dispute.suggested_plan_approval?.creator_approved;

    // Reset both acceptance flags and record who rejected
    dispute.suggested_plan_approval = {
      creator_approved: false,
      joiner_approved: false,
      rejected_by: rejecterRole
    };
    dispute.status = "NEGOTIATION";
    await dispute.save();

    if (req.app.get("io")) {
      req.app.get("io").to(dispute_id).emit("negotiation_started", {
        status: "NEGOTIATION",
        rejected_by: rejecterRole,
        rejected_by_name: `${req.user.firstName} ${req.user.lastName}`,
        cancelled_acceptance_of: otherHadAccepted ? otherRole : null,
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
      rejected_by: rejecterRole,
      cancelled_acceptance_of: otherHadAccepted ? otherRole : null
    });
  } catch (err) {
    console.error("Reject suggested plan error:", err);
    res.status(500).json({ message: "Failed to reject plan", error: err.message });
  }
};

// CANCEL ACCEPTANCE — undo a previously accepted suggested plan while the other party hasn't responded yet
export const cancelAcceptance = async (req, res) => {
  try {
    const { dispute_id } = req.body;

    const dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    if (dispute.status !== "SUGGESTED_PLAN_REVIEW") {
      return res.status(400).json({ message: "No suggested plan is currently under review" });
    }

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isCreator && !isJoiner) {
      return res.status(403).json({ message: "Not a participant" });
    }

    const role = isCreator ? "creator" : "joiner";

    // Check this user actually had a pending acceptance to cancel
    const hasAccepted = isCreator
      ? dispute.suggested_plan_approval?.creator_approved
      : dispute.suggested_plan_approval?.joiner_approved;

    if (!hasAccepted) {
      return res.status(400).json({ message: "You have not accepted the plan yet" });
    }

    // Cannot cancel if the other party has also already accepted (dispute would already be COMPLETED)
    const otherAccepted = isCreator
      ? dispute.suggested_plan_approval?.joiner_approved
      : dispute.suggested_plan_approval?.creator_approved;

    if (otherAccepted) {
      return res.status(400).json({ message: "Cannot cancel — other party has already accepted" });
    }

    // Reset only this user's acceptance flag
    if (isCreator) dispute.suggested_plan_approval.creator_approved = false;
    else dispute.suggested_plan_approval.joiner_approved = false;

    await dispute.save();

    if (req.app.get("io")) {
      req.app.get("io").to(dispute_id).emit("acceptance_cancelled", {
        cancelled_by: role,
        cancelled_by_name: `${req.user.firstName} ${req.user.lastName}`,
        creator_approved: dispute.suggested_plan_approval.creator_approved,
        joiner_approved: dispute.suggested_plan_approval.joiner_approved,
        message: `${req.user.firstName} cancelled their acceptance of the plan.`,
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Acceptance cancelled.",
      creator_approved: dispute.suggested_plan_approval.creator_approved,
      joiner_approved: dispute.suggested_plan_approval.joiner_approved
    });
  } catch (err) {
    console.error("Cancel acceptance error:", err);
    res.status(500).json({ message: "Failed to cancel acceptance", error: err.message });
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

    if (req.app.get('io')) {
      const commentPlain = typeof savedComment.toObject === "function"
        ? savedComment.toObject()
        : { ...savedComment };
      req.app.get('io').to(dispute_id).emit("new_negotiation_comment", {
        comment: {
          ...commentPlain,
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
      .populate("negotiation.comments.sender_id", "firstName lastName email avatarId gender");

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

    // Atomic update — flip this user's ready flag only if it is still false.
    // This prevents two simultaneous HTTP calls from both reading ready=false,
    // both passing the in-memory guard, and both calling generateFinalPlan.
    const readyField = isCreator
      ? "negotiation.creator_ready"
      : "negotiation.joiner_ready";

    const updatedReady = await OfficialDispute.findOneAndUpdate(
      { _id: dispute_id, status: "NEGOTIATION", [readyField]: false },
      { $set: { [readyField]: true } },
      { new: true }
    );

    if (!updatedReady) {
      return res.status(400).json({
        message: "You have already signalled agreement, or the dispute is no longer in negotiation"
      });
    }

    if (updatedReady.negotiation.creator_ready && updatedReady.negotiation.joiner_ready) {
      // Atomically claim the right to trigger final plan generation — only one request wins.
      const claimed = await OfficialDispute.findOneAndUpdate(
        { _id: dispute_id, status: "NEGOTIATION" },
        { $set: { status: "AI_SUMMARIZING" } },
        { new: true }
      );

      if (!claimed) {
        // Another concurrent request already flipped status — generation already queued.
        return res.json({
          success: true,
          message: "Both parties agreed. Generating final resolution plan...",
          status: "AI_SUMMARIZING"
        });
      }

      const ioInstance = req.app.get('io');
      console.log(`[signalAgreement] ioInstance resolved: ${ioInstance ? "OK" : "NULL — check io middleware"}`);

      if (ioInstance) {
        ioInstance.to(dispute_id).emit("both_agreed", {
          creator_ready: true,
          joiner_ready: true,
          message: "Both parties have agreed. Generating final resolution plan...",
          timestamp: new Date()
        });
        ioInstance.to(dispute_id).emit("generating_final_plan", {
          status: "AI_SUMMARIZING",
          message: "Both parties agreed. AI is constructing the final resolution plan...",
          timestamp: new Date()
        });
      }

      const disputeIdString = dispute_id;

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

    if (req.app.get('io')) {
      req.app.get('io').to(dispute_id).emit("agreement_update", {
        creator_ready: updatedReady.negotiation.creator_ready,
        joiner_ready: updatedReady.negotiation.joiner_ready,
        message: "Agreement signal recorded. Waiting for other party.",
        timestamp: new Date()
      });
    }

    res.json({
      success: true,
      message: "Agreement signal recorded. Waiting for other party.",
      creator_ready: updatedReady.negotiation.creator_ready,
      joiner_ready: updatedReady.negotiation.joiner_ready
    });
  } catch (err) {
    console.error("Signal agreement error:", err);
    res.status(500).json({ message: "Failed to signal agreement", error: err.message });
  }
};

// AI HELPER: GENERATE FINAL PLAN (FIX: now exported)

export async function generateFinalPlan(dispute, dispute_id, io) {
  try {
    console.log(`[generateFinalPlan] START | dispute: ${dispute._id}`);

    // Ensure creator and joiner are populated so we can use real names in prompts
    if (!dispute.creator_id?.firstName) {
      await dispute.populate("creator_id", "firstName lastName email");
    }
    if (dispute.joiner_id && !dispute.joiner_id?.firstName) {
      await dispute.populate("joiner_id", "firstName lastName email");
    }
    const creatorName = dispute.creator_id?.firstName
      ? `${dispute.creator_id.firstName} ${dispute.creator_id.lastName}`
      : "Person A";
    const joinerName = dispute.joiner_id?.firstName
      ? `${dispute.joiner_id.firstName} ${dispute.joiner_id.lastName}`
      : "Person B";

    const creatorSelectedSolutions = dispute.solutions.filter(s =>
      dispute.solution_selections.creator_selected.includes(s.id)
    );
    const joinerSelectedSolutions = dispute.solutions.filter(s =>
      dispute.solution_selections.joiner_selected.includes(s.id)
    );

    const negotiationThread = dispute.negotiation.comments
      .map(c => `${c.sender_role === "creator" ? creatorName : joinerName}: ${c.text}`)
      .join("\n");

    // Build a section for the previously rejected suggested plan, if one exists
    const rejectedPlanSection = dispute.suggested_plan && dispute.suggested_plan.title
      ? `PREVIOUSLY REJECTED PLAN (do NOT reproduce this — use it only to understand what was already tried and rejected):
Title: ${dispute.suggested_plan.title}
Summary: ${dispute.suggested_plan.summary}
Action Steps:
${(dispute.suggested_plan.action_steps || []).map(s => `  ${s.step}. [${s.responsible}] ${s.action} (${s.timeframe})`).join("\n")}
Commitments:
  ${creatorName}: ${(dispute.suggested_plan.commitments?.creator || []).join("; ")}
  ${joinerName}: ${(dispute.suggested_plan.commitments?.joiner || []).join("; ")}

The parties reviewed this plan and rejected it. The negotiation comments below explain what they want changed. Your new plan MUST meaningfully differ from the above based on that feedback.`
      : "";

    const prompt = `You are a professional conflict resolution expert constructing a final binding resolution plan.

CONTEXT:
- Relationship: ${dispute.intake_data.relationship_type}${dispute.intake_data.custom_relationship ? ` (${dispute.intake_data.custom_relationship})` : ""}
- Relationship Importance: ${dispute.intake_data.relationship_importance}
- Goal: ${dispute.intake_data.goal}
- Non-negotiables: ${dispute.intake_data.non_negotiables || "None"}

ORIGINAL DISPUTE SUMMARY:
${dispute.ai_summary.summary_text}

${creatorName} (Creator) preferred these solutions:
${creatorSelectedSolutions.map(s => `- Option ${s.id}: ${s.title} — ${s.description}`).join("\n")}

${joinerName} (Joiner) preferred these solutions:
${joinerSelectedSolutions.map(s => `- Option ${s.id}: ${s.title} — ${s.description}`).join("\n")}

${rejectedPlanSection}

NEGOTIATION DISCUSSION (what the parties want changed):
${negotiationThread || "No additional comments were made — both parties agreed directly."}

TASK: Based on everything above — especially the negotiation feedback and what was already rejected — construct a revised, fair, and actionable final resolution plan that addresses the parties' concerns.

IMPORTANT:
- Make the AI's role visible and useful to the user.
- Add a short mediator note explaining why this final plan is likely to work in warm, human language.
- Add 3 concise AI suggestions that sound supportive and natural, like a thoughtful mediator coaching two real people.
- Use plain everyday language, not robotic advice or therapy jargon.
- The final summary and action steps must feel noticeably updated if negotiation happened.
- If the earlier plan was rejected or cancelled, explicitly reflect the requested changes and highlight those changed points inline.
- Do not reuse the previous summary or action steps with only light rewording.
- Identify sensitive words or phrases only for inline highlighting in the summary/action plan. Do not make them look like a separate warning box.

OUTPUT JSON:
{
  "final_plan": {
    "title": "Resolution Plan Title (5-8 words)",
    "summary": "One paragraph summarizing what both parties have agreed to",
    "mediator_note": "2-3 warm, human sentences from the AI mediator explaining why this final plan fits the conversation and negotiation",
    "ai_suggestions": [
      "Human, supportive suggestion 1",
      "Human, supportive suggestion 2",
      "Human, supportive suggestion 3"
    ],
    "sensitive_topics": ["Topic or phrase 1", "Topic or phrase 2"],
    "action_steps": [
      {
        "step": 1,
        "action": "Clear, specific action to take",
        "responsible": "creator" | "joiner" | "both",
        "timeframe": "Immediate / Within 1 week / Ongoing / etc."
      }
    ],
    "commitments": {
      "creator": ["Specific commitment ${creatorName} is making"],
      "joiner": ["Specific commitment ${joinerName} is making"]
    },
    "success_criteria": "How both parties will know the resolution is working"
  }
}`;

    const response = await callGemini(prompt);
    const result = cleanAIResponse(response);

    if (!result.final_plan || !result.final_plan.title || !result.final_plan.action_steps) {
      throw new Error("Invalid final plan structure from AI");
    }

    dispute.final_plan = decoratePlanWithHighlights(result.final_plan);
    dispute.status = "FINAL_PLAN_REVIEW";
    await dispute.save();
    console.log(`[generateFinalPlan] [SAVE] status → FINAL_PLAN_REVIEW | dispute: ${dispute._id}`);

    if (io) {
      io.to(dispute_id).emit("final_plan_ready", {
        status: "FINAL_PLAN_REVIEW",
        final_plan: dispute.final_plan,
        message: "Your AI mediator prepared the final plan with follow-through suggestions and sensitive-topic highlights.",
        timestamp: new Date()
      });
      console.log(`[EMIT] final_plan_ready | to room: ${dispute_id} | title: ${dispute.final_plan.title}`);
    } else {
      console.warn(`[generateFinalPlan] io is null — final_plan_ready NOT emitted | dispute: ${dispute._id}`);
    }
    console.log(`[generateFinalPlan] SUCCESS | dispute: ${dispute._id}`);
  } catch (error) {
    console.error(`[generateFinalPlan] FAILED | dispute: ${dispute._id}`, error);
    dispute.status = "NEGOTIATION";
    await dispute.save();
    console.log(`[generateFinalPlan] [SAVE] rolled back → NEGOTIATION | dispute: ${dispute._id}`);
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

      if (req.app.get('io')) {
        req.app.get('io').to(dispute_id).emit("dispute_completed", {
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

    if (req.app.get('io')) {
      req.app.get('io').to(dispute_id).emit("plan_approval_update", {
        approved_by: isCreator ? "creator" : "joiner",
        approved_by_name: `${req.user.firstName} ${req.user.lastName}`,
        creator_approved: dispute.final_plan_approval.creator_approved,
        joiner_approved: dispute.final_plan_approval.joiner_approved,
        both_approved: false,
        message: `${req.user.firstName} approved the final plan. Waiting for the other party.`,
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

    if (req.app.get('io')) {
      req.app.get('io').to(dispute_id).emit("plan_reported", {
        status: dispute.status,
        message: "Plan issue reported. Thank you.",
        timestamp: new Date(),
        reported_by: {
          user_id: req.user._id,
          name: `${req.user.firstName} ${req.user.lastName}`,
          role: isCreator ? "creator" : "joiner"
        }
      });
    }

    if (dispute.status === "COMPLETED" && req.app.get('io')) {
      req.app.get('io').to(dispute_id).emit("dispute_completed", {
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

    let dispute = await OfficialDispute.findById(dispute_id);
    if (!dispute) return res.status(404).json({ message: "Dispute not found" });

    const isCreator = dispute.creator_id.toString() === req.user._id.toString();
    const isJoiner = dispute.joiner_id?.toString() === req.user._id.toString();

    if (!isCreator && !isJoiner) {
      return res.status(403).json({ message: "You are not authorized to view this plan" });
    }

    dispute = await waitForGeneratedDisputeContent(
      dispute_id,
      (d) => Boolean(d.final_plan?.title)
    );

    if (!dispute.final_plan?.title) {
      if (dispute.status === "AI_SUMMARIZING") {
        return res.status(202).json({
          success: false,
          status: dispute.status,
          message: "Final plan is still being generated"
        });
      }
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
      .populate("creator_id", "firstName lastName email avatarId gender")
      .populate("joiner_id", "firstName lastName email avatarId gender")
      .populate({
        path: "conversation.messages",
        populate: { path: "sender_id", select: "firstName lastName email avatarId gender" }
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
    const {
      type,
      status,
      startDate,
      page = 1,
      limit = 10
    } = req.query;

    // If type is provided, validate it
    if (type && !["major", "minor", "call"].includes(type)) {
      return res.status(400).json({ message: "Invalid type. Must be one of: major, minor, call" });
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    // No type provided — return all disputes from all 3 collections combined
    if (!type) {
      const majorQuery = { $or: [{ creator_id: req.user._id }, { joiner_id: req.user._id }] };
      const minorQuery = { $or: [{ creator_id: req.user._id }, { joiner_id: req.user._id }] };
      const callQuery = { user_id: req.user._id };

      if (startDate) {
        const from = new Date(startDate);
        if (!isNaN(from)) {
          majorQuery.createdAt = { $gte: from };
          minorQuery.createdAt = { $gte: from };
          callQuery.createdAt = { $gte: from };
        }
      }

      const [majorDisputes, minorDisputes, callReports] = await Promise.all([
        OfficialDispute.find(majorQuery)
          .populate("creator_id", "firstName lastName email avatarId gender")
          .populate("joiner_id", "firstName lastName email avatarId gender")
          .select("_id dispute_name status invite_code intake_data.relationship_type ai_summary.main_topic creator_id joiner_id createdAt updatedAt")
          .sort({ updatedAt: -1 }),
        SmallDispute.find(minorQuery)
          .populate("creator_id", "firstName lastName email avatarId gender")
          .populate("joiner_id", "firstName lastName email avatarId gender")
          .sort({ createdAt: -1 }),
        Report.find(callQuery)
          .sort({ createdAt: -1 })
      ]);

      const allDisputes = [
        ...majorDisputes.map(d => ({
          _id: d._id,
          type: "major",
          dispute_name: d.dispute_name,
          status: d.status,
          invite_code: d.invite_code,
          relationship_type: d.intake_data?.relationship_type,
          main_topic: d.ai_summary?.main_topic || null,
          creator: d.creator_id,
          joiner: d.joiner_id,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt
        })),
        ...minorDisputes.map(d => ({
          _id: d._id,
          type: "minor",
          status: d.status,
          invite_code: d.invite_code,
          creator: d.creator_id,
          joiner: d.joiner_id,
          result: d.result || null,
          createdAt: d.createdAt
        })),
        ...callReports.map(r => ({
          _id: r._id,
          type: "call",
          title: r.title,
          conversation_type: r.conversation_type,
          conflict_score: r.conflict_score,
          objective: r.objective,
          createdAt: r.createdAt
        }))
      ].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

      // Apply pagination on combined results
      const total = allDisputes.length;
      const totalPages = Math.ceil(total / limitNum);
      const paginated = allDisputes.slice(skip, skip + limitNum);

      return res.json({
        success: true,
        type: "all",
        count: paginated.length,
        total,
        page: pageNum,
        total_pages: totalPages,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1,
        disputes: paginated
      });
    }

    // ── MAJOR (OfficialDispute) ───────────────────────────────────────────────
    if (type === "major") {
      const query = {
        $or: [{ creator_id: req.user._id }, { joiner_id: req.user._id }]
      };

      if (status) query.status = status;

      if (startDate) {
        const from = new Date(startDate);
        if (!isNaN(from)) query.createdAt = { $gte: from };
      }

      const [disputes, total] = await Promise.all([
        OfficialDispute.find(query)
          .populate("creator_id", "firstName lastName email avatarId gender")
          .populate("joiner_id", "firstName lastName email avatarId gender")
          .select("_id dispute_name status invite_code intake_data.relationship_type ai_summary.main_topic creator_id joiner_id createdAt updatedAt")
          .sort({ updatedAt: -1 })
          .skip(skip)
          .limit(limitNum),
        OfficialDispute.countDocuments(query)
      ]);

      const totalPages = Math.ceil(total / limitNum);

      return res.json({
        success: true,
        type: "major",
        count: disputes.length,
        total,
        page: pageNum,
        total_pages: totalPages,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1,
        disputes: disputes.map(d => ({
          _id: d._id,
          type: "major",
          dispute_name: d.dispute_name,
          status: d.status,
          invite_code: d.invite_code,
          relationship_type: d.intake_data?.relationship_type,
          main_topic: d.ai_summary?.main_topic || null,
          creator: d.creator_id,
          joiner: d.joiner_id,
          createdAt: d.createdAt,
          updatedAt: d.updatedAt
        }))
      });
    }

    // ── MINOR (SmallDispute) ──────────────────────────────────────────────────
    if (type === "minor") {
      const query = {
        $or: [{ creator_id: req.user._id }, { joiner_id: req.user._id }]
      };

      if (startDate) {
        const from = new Date(startDate);
        if (!isNaN(from)) query.createdAt = { $gte: from };
      }

      const [disputes, total] = await Promise.all([
        SmallDispute.find(query)
          .populate("creator_id", "firstName lastName email avatarId gender")
          .populate("joiner_id", "firstName lastName email avatarId gender")
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum),
        SmallDispute.countDocuments(query)
      ]);

      const totalPages = Math.ceil(total / limitNum);

      return res.json({
        success: true,
        type: "minor",
        count: disputes.length,
        total,
        page: pageNum,
        total_pages: totalPages,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1,
        disputes: disputes.map(d => ({
          _id: d._id,
          type: "minor",
          status: d.status,
          invite_code: d.invite_code,
          creator: d.creator_id,
          joiner: d.joiner_id,
          result: d.result || null,
          createdAt: d.createdAt
        }))
      });
    }

    // ── CALL (Report) ─────────────────────────────────────────────────────────
    if (type === "call") {
      const query = { user_id: req.user._id };

      if (startDate) {
        const from = new Date(startDate);
        if (!isNaN(from)) query.createdAt = { $gte: from };
      }

      const [reports, total] = await Promise.all([
        Report.find(query)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limitNum),
        Report.countDocuments(query)
      ]);

      const totalPages = Math.ceil(total / limitNum);

      return res.json({
        success: true,
        type: "call",
        count: reports.length,
        total,
        page: pageNum,
        total_pages: totalPages,
        has_next: pageNum < totalPages,
        has_prev: pageNum > 1,
        disputes: reports.map(r => ({
          _id: r._id,
          type: "call",
          title: r.title,
          conversation_type: r.conversation_type,
          conflict_score: r.conflict_score,
          objective: r.objective,
          createdAt: r.createdAt
        }))
      });
    }

  } catch (err) {
    console.error("Get user disputes error:", err);
    res.status(500).json({ message: "Failed to fetch disputes", error: err.message });
  }
};

// DETAIL PAGE: Full dispute info for a single dispute
// Checks all 3 collections — major (OfficialDispute), minor (SmallDispute), call (Report)
export const getMyDisputeDetails = async (req, res) => {
  try {
    const { dispute_id } = req.params;

    // ── MAJOR (OfficialDispute) ───────────────────────────────────────────────
    const major = await OfficialDispute.findById(dispute_id)
      .populate("creator_id", "firstName lastName email avatarId gender")
      .populate("joiner_id", "firstName lastName email avatarId gender");

    if (major) {
      const isCreator = major.creator_id._id.toString() === req.user._id.toString();
      const isJoiner = major.joiner_id?._id.toString() === req.user._id.toString();

      if (!isCreator && !isJoiner) {
        return res.status(403).json({ message: "You are not authorized to view this dispute" });
      }

      const disputeObj = major.toObject();
      delete disputeObj.conversation.messages;

      return res.json({
        success: true,
        type: "major",
        user_role: isCreator ? "creator" : "joiner",
        is_creator: isCreator,
        dispute: disputeObj
      });
    }

    // ── MINOR (SmallDispute) ──────────────────────────────────────────────────
    const minor = await SmallDispute.findById(dispute_id)
      .populate("creator_id", "firstName lastName email avatarId gender")
      .populate("joiner_id", "firstName lastName email avatarId gender");

    if (minor) {
      const isCreator = minor.creator_id._id.toString() === req.user._id.toString();
      const isJoiner = minor.joiner_id?._id.toString() === req.user._id.toString();

      if (!isCreator && !isJoiner) {
        return res.status(403).json({ message: "You are not authorized to view this dispute" });
      }

      return res.json({
        success: true,
        type: "minor",
        user_role: isCreator ? "creator" : "joiner",
        is_creator: isCreator,
        dispute: minor
      });
    }

    // ── CALL (Report) ─────────────────────────────────────────────────────────
    const report = await Report.findById(dispute_id);

    if (report) {
      if (report.user_id.toString() !== req.user._id.toString()) {
        return res.status(403).json({ message: "You are not authorized to view this report" });
      }

      return res.json({
        success: true,
        type: "call",
        dispute: report
      });
    }

    return res.status(404).json({ message: "Dispute not found" });

  } catch (err) {
    console.error("Get dispute details error:", err);
    res.status(500).json({ message: "Failed to fetch dispute details", error: err.message });
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

    if (req.app.get('io')) {
      req.app.get('io').to(dispute_id).emit("dispute_deleted", {
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

export const analyzeMultimodalDispute = async (req, res) => {
  try {
    const summaryText = req.body.summary_text || req.body.summaryText || "";
    const summaryAudioFile = req.files?.["summary_audio"]?.[0];
    const mediaFiles = [
      ...(req.files?.["image"] || []),
      ...(req.files?.["audio"] || [])
    ];

    if (!summaryText && !summaryAudioFile && mediaFiles.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one input (summary text, summary audio, or uploaded media) is required."
      });
    }

    const aiSummary = await analyzeMultimodalContent(summaryText, summaryAudioFile, mediaFiles);
    const shortSummary = aiSummary?.short_summary || "";
    if (aiSummary && aiSummary.short_summary) {
      delete aiSummary.short_summary;
    }

    const uploadedMedia = mediaFiles.map(file => ({
      file_path: file.path,
      mime_type: file.mimetype
    }));

    const analysis = await MultimodalAnalysis.create({
      user_id: req.user._id,
      summary_text: summaryText || undefined,
      summary_audio_url: summaryAudioFile ? summaryAudioFile.path : undefined,
      uploaded_media: uploadedMedia,
      ai_summary: aiSummary
    });

    return res.json({
      success: true,
      message: "Multimodal dispute analyzed successfully.",
      ai_summary: aiSummary,
      short_summary: shortSummary,
      analysis_id: analysis._id
    });
  } catch (err) {
    console.error("Multimodal analysis error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to analyze multimodal dispute.",
      error: err.message
    });
  }
};

