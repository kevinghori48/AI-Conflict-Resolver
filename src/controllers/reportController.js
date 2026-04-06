import { GoogleGenerativeAI } from "@google/generative-ai";
import Report from "../models/Report.js";
import AudioFile from "../models/AudioFile.js";
import fs from "fs";
import path from "path";

// CONFIG & HELPERS
const getGeminiModel = () => {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: {
      responseMimeType: "application/json",
      maxOutputTokens: 8192,
      temperature: 0
    }
  });
};

const getMimeType = (filename) => {
  if (filename.endsWith(".mp3")) return "audio/mp3";
  if (filename.endsWith(".wav")) return "audio/wav";
  if (filename.endsWith(".m4a")) return "audio/m4a";
  return "audio/mp3";
};

// CORE LOGIC: THE MASTER PROMPT
// We extract this into a function so both Create and Append can use it.
const generateAnalysis = async (audioFiles, conversationType, objective) => {
  const model = getGeminiModel();
  const parts = [];

  // 1. Attach ALL Audio Files
  for (const file of audioFiles) {
    if (fs.existsSync(file.file_path)) {
      const base64Data = (await fs.promises.readFile(file.file_path)).toString("base64");
      parts.push({
        inlineData: {
          mimeType: getMimeType(file.original_name),
          data: base64Data
        }
      });
    }
  }

  // 2. The Prompt (Strict Constraints)
  const prompt = `
    ROLE: You are an expert Conflict Resolution Specialist.
    CONTEXT: Analyze the attached audio recordings of a ${conversationType} dispute.
    USER GOAL: "${objective || "Resolve the conflict and find harmony."}"

    TASK: Generate a structured JSON report.
    STRICT CONSTRAINTS:
    1. OUTPUT MUST BE PURE JSON.
    2. "emotional_intensity": Identify speakers (Speaker 1, Speaker 2, etc.) and give a score (0-100).
    3. "advice": Must have 3 specific categories (Quick Fixes, Better Communication, Long Term Harmony).
    4. "formatting":
       - Use bullet points for summary.
       - FOR ADVICE: Provide 2-3 actionable points per category.
       - CRITICAL: Maximum 20-25 words per point. Be concise and expert.

    JSON STRUCTURE:
    {
      "conflict_score": 7,
      "emotional_intensity": [
        { "speaker_label": "Main Speaker (Aggressive)", "score": 85 },
        { "speaker_label": "Secondary Speaker (Passive)", "score": 40 }
      ],
      "summary_points": ["Point 1", "Point 2"],
      "advice": {
        "quick_fixes": ["Detailed point 1 (Max 25 words)", "Detailed point 2"],
        "better_communication": ["Tip 1", "Tip 2"],
        "long_term_harmony": ["Strategy 1", "Strategy 2"]
      },
      "suggested_replies": ["Suggestion 1", "Suggestion 2"]
    }
  `;

  parts.push({ text: prompt });

  // 3. Call Gemini
  const result = await model.generateContent({
    contents: [{ role: "user", parts: parts }]
  });

  // 4. Clean response and parse JSON
  // Gemini sometimes wraps response in ```json ... ``` markdown fences
  const raw = result.response.text();
  const cleaned = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(cleaned);
};

// 1. CREATE NEW REPORT (Multiple Audios)
export const createReport = async (req, res) => {
  try {
    const { conversation_type, objective } = req.body;
    const files = req.files; // Array of files

    if (!files || files.length === 0) {
      return res.status(400).json({ message: "Upload at least one audio file." });
    }
    if (!conversation_type) {
      return res.status(400).json({ message: "Conversation type is required." });
    }

    const validTypes = ["Relationship", "Work", "Family", "Friendship", "Other"];
    const normalizedType = validTypes.find(
      t => t.toLowerCase() === conversation_type.toLowerCase()
    );
    if (!normalizedType) {
      return res.status(400).json({
        message: `Invalid conversation_type. Must be one of: ${validTypes.join(", ")}`
      });
    }

    // A. Save Audios to DB
    const audioDocs = [];
    for (const file of files) {
      const audio = await AudioFile.create({
        user_id: req.user._id,
        file_path: file.path,
        original_name: file.originalname,
        mimetype: file.mimetype,
        size: file.size
      });
      audioDocs.push(audio);
    }

    // B. Generate Analysis
    console.log(`Analyzing ${files.length} files...`);
    const analysis = await generateAnalysis(audioDocs, normalizedType, objective);

    // C. Save Report
    const report = await Report.create({
      user_id: req.user._id,
      audio_ids: audioDocs.map(a => a._id),
      conversation_type: normalizedType,
      objective,
      title: `${normalizedType} Analysis`,
      conflict_score: analysis.conflict_score,
      emotional_intensity: analysis.emotional_intensity,
      summary_points: analysis.summary_points,
      advice: analysis.advice,
      suggested_replies: analysis.suggested_replies
    });

    res.status(201).json({ message: "Report generated successfully", report });

  } catch (err) {
    console.error("Create Report Error:", err);
    res.status(500).json({ message: "Failed to analyze audio" });
  }
};

// 2. APPEND AUDIO (Re-Analyze) — accepts multiple new files
export const appendAudio = async (req, res) => {
  try {
    const { report_id } = req.body;
    const files = req.files; // Array of new files

    if (!report_id || !files || files.length === 0) {
      return res.status(400).json({ message: "Report ID and at least one Audio File required." });
    }

    // A. Find Report (populate so we can read file_path for Gemini)
    const report = await Report.findById(report_id).populate("audio_ids");
    if (!report) return res.status(404).json({ message: "Report not found" });

    // B. Save ALL NEW Audios to DB
    const newAudioDocs = [];
    for (const file of files) {
      const newAudio = await AudioFile.create({
        user_id: req.user._id,
        file_path: file.path,
        original_name: file.originalname,
        mimetype: file.mimetype,
        size: file.size
      });
      newAudioDocs.push(newAudio);
    }

    // C. Combine Old Audios + New Audios for Gemini
    // report.audio_ids is an array of full objects because of .populate()
    const allAudioDocs = [...report.audio_ids, ...newAudioDocs];

    // D. Re-Analyze EVERYTHING
    console.log(`Re-Analyzing ${allAudioDocs.length} files...`);
    const analysis = await generateAnalysis(allAudioDocs, report.conversation_type, report.objective);

    // E. Update Report with NEW Analysis
    // FIX: .populate() replaced audio_ids with full objects, so we must
    // re-map them back to plain ObjectIds before saving, otherwise
    // Mongoose won't store the new IDs correctly and the append is lost.
    const oldIds = report.audio_ids.map(a => a._id);
    report.audio_ids = [...oldIds, ...newAudioDocs.map(a => a._id)];

    report.conflict_score      = analysis.conflict_score;
    report.emotional_intensity = analysis.emotional_intensity;
    report.summary_points      = analysis.summary_points;
    report.advice              = analysis.advice;
    report.suggested_replies   = analysis.suggested_replies;
    await report.save();

    // Re-fetch the saved report fully populated so the response is clean and complete
    const updatedReport = await Report.findById(report._id).populate("audio_ids");
    res.json({ message: "Report updated with new context", report: updatedReport });

  } catch (err) {
    console.error("Append Error:", err);
    res.status(500).json({ message: "Failed to update report" });
  }
};

export const getReports = async (req, res) => {
  try {
    const reports = await Report.find({ user_id: req.user._id }).sort({ createdAt: -1 });
    res.json(reports);
  } catch (err) {
    res.status(500).json({ message: "Error fetching reports" });
  }
};

export const getReport = async (req, res) => {
  try {
    const report = await Report.findById(req.params.id).populate("audio_ids");
    if (!report) return res.status(404).json({ message: "Report not found" });
    res.json(report);
  } catch (err) {
    res.status(500).json({ message: "Error fetching report" });
  }
};