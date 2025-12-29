import OfficialDispute from "../models/OfficialDispute.js";
import AudioFile from "../models/AudioFile.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import crypto from "crypto";
import fs from "fs";

// ==========================================
// CONFIG: Relationship Presets
// ==========================================
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

// ==========================================
// 1. CREATE DISPUTE (Screen 1 & 2)
// ==========================================
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

// ==========================================
// 2. JOIN DISPUTE (Screen 4)
// ==========================================
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

// ==========================================
// 3. SIGN FAIRNESS AGREEMENT (Screen 3)
// ==========================================
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

// ==========================================
// 4. SUBMIT ROUND 1 INPUT (Screen 5 - Round 1)
// ==========================================
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

    // CHECK: Are both inputs ready? (Logic: checks if both have sent audio)
    if (dispute.round_1_inputs.creator_audio && dispute.round_1_inputs.joiner_audio) {
      dispute.status = "ROUND_1_ANALYSIS";
      await dispute.save();
      if (req.io) req.io.to(dispute_id).emit("processing_start", { message: "Analyzing perspectives..." });

      // === RUN AI ROUND 1 ===
      const analysis = await runRound1AI(dispute);
      dispute.round_1_result = analysis;
      dispute.status = "ROUND_1_CONFIRMATION"; // Wait for user approval
      await dispute.save();

      if (req.io) req.io.to(dispute_id).emit("round_1_complete", { result: analysis, status: "ROUND_1_CONFIRMATION" });
    }

    res.json({ message: "Input received" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Submission failed" });
  }
};

// ==========================================
// 5. CONFIRM ROUND 1 (User Agreement)
// ==========================================
export const confirmRound1 = async (req, res) => {
  try {
    const { dispute_id } = req.body;
    const dispute = await OfficialDispute.findById(dispute_id);

    if (req.user._id.toString() === dispute.creator_id.toString()) {
      dispute.round_1_confirmation.creator_agreed = true;
    } else {
      dispute.round_1_confirmation.joiner_agreed = true;
    }

    // Only proceed if BOTH agree
    if (dispute.round_1_confirmation.creator_agreed && dispute.round_1_confirmation.joiner_agreed) {
        // Trigger AI for Round 2 Options
        if (req.io) req.io.to(dispute_id).emit("processing_start", { message: "Generating options..." });
        const options = await runRound2AI(dispute);
        dispute.round_2_options = options.options;
        dispute.status = "ROUND_2_OPTIONS";
        await dispute.save();
        if (req.io) req.io.to(dispute_id).emit("status_update", {
            status: "ROUND_2_OPTIONS",
            data: options.options
        });
    } else {
        await dispute.save();
    }

    res.json({ message: "Confirmation received" });
  } catch (err) {
    res.status(500).json({ message: "Confirmation failed" });
  }
};

// ==========================================
// 6. SUBMIT ROUND 2 (Multi-Select Options)
// ==========================================
export const submitRound2Selection = async (req, res) => {
  try {
    const { dispute_id, selected_ids } = req.body; // Array e.g. ["A", "C"]
    const dispute = await OfficialDispute.findById(dispute_id);

    if (req.user._id.toString() === dispute.creator_id.toString()) {
        dispute.round_2_selections.creator_selected_ids = selected_ids;
    } else {
        dispute.round_2_selections.joiner_selected_ids = selected_ids;
    }

    await dispute.save();

    const c_ids = dispute.round_2_selections.creator_selected_ids;
    const j_ids = dispute.round_2_selections.joiner_selected_ids;

    // Check if both have voted
    if (c_ids.length > 0 && j_ids.length > 0) {
        // Logic: Combine all selected options to find a comprehensive plan
        // You could also look for intersection (c_ids.filter(x => j_ids.includes(x)))
        // For now, we take the UNION of choices to be inclusive
        const final_ids = [...new Set([...c_ids, ...j_ids])];
        dispute.final_selected_option_ids = final_ids;

        // Trigger AI for Round 3 Plan
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


// ==========================================
// AI HELPERS
// ==========================================

async function runRound1AI(dispute) {
  const model = getGeminiModel();
  const preset = PRESETS[dispute.relationship_type];

  // Note: Add logic here to read audio files (using fs.readFileSync) like in SmallDispute
  // For now, assuming audio content is passed or processed similarly

  const prompt = `
    ROLE: You are a ${preset.system_role}.
    OBJECTIVE: ${preset.objective}
    INPUT: Two user arguments (Creator vs Joiner).

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
  return JSON.parse(result.response.text());
}

async function runRound2AI(dispute) {
  const model = getGeminiModel();
  const summary = dispute.round_1_result;

  const prompt = `
    CONTEXT:
    Creator needs: ${summary.summaries.creator}
    Joiner needs: ${summary.summaries.joiner}
    Common Ground: ${summary.common_ground.join(", ")}

    TASK: Generate 3 distinct solutions.
    1. Option A: Prioritizes Creator's perspective slightly.
    2. Option B: Prioritizes Joiner's perspective slightly.
    3. Option C: A balanced compromise.

    OUTPUT JSON:
    {
      "options": [
        {
          "id": "A", "title": "...", "description": "...", "type": "Creator Focused",
          "pros": { "creator": "...", "joiner": "..." },
          "cons": { "creator": "...", "joiner": "..." }
        },
        // ... Option B and C
      ]
    }
  `;
  const result = await model.generateContent(prompt);
  return JSON.parse(result.response.text());
}

async function runRound3AI(dispute) {
  const model = getGeminiModel();
  // Get details of chosen options
  const selectedOptions = dispute.round_2_options
    .filter(o => dispute.final_selected_option_ids.includes(o.id))
    .map(o => `${o.title}: ${o.description}`)
    .join("\n");

  const prompt = `
    DECISION: Users agreed on these approaches:
    ${selectedOptions}

    TASK: Create a comprehensive Action Plan.
    1. Actionable Tasks (Who, What, By When).
    2. Strategic Suggestions broken into timeframes (Short, Medium, Long term).

    OUTPUT JSON:
    {
      "tasks": [
        { "who": "Creator", "what": "...", "by_when": "..." }
      ],
      "suggestions": {
        "short_term": ["Immediate action 1", "Immediate action 2"],
        "medium_term": ["Habit to build over next month"],
        "long_term": ["Lifestyle change for next year"]
      }
    }
  `;
  const result = await model.generateContent(prompt);
  return JSON.parse(result.response.text());
}