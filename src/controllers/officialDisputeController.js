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
