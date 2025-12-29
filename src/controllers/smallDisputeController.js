import SmallDispute from "../models/SmallDispute.js"; // 🟢 Updated Import
import AudioFile from "../models/AudioFile.js";
import { GoogleGenerativeAI } from "@google/generative-ai";
import crypto from "crypto";
import fs from "fs";

// Helper: Generate Invite Code
const generateCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();

// Helper: AI Judge Logic
const runJudgeAI = async (smallDispute) => {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json" }
  });

  const creatorAudio = await AudioFile.findById(smallDispute.audio_creator);
  const joinerAudio = await AudioFile.findById(smallDispute.audio_joiner);

  const parts = [
    { inlineData: { mimeType: creatorAudio.mimetype, data: fs.readFileSync(creatorAudio.file_path).toString("base64") } },
    { inlineData: { mimeType: joinerAudio.mimetype, data: fs.readFileSync(joinerAudio.file_path).toString("base64") } },
    { text: `
      ROLE: You are an impartial Logical Judge for a "Small Dispute".
      INPUT: Two 30-second audio arguments. Audio 1 = Creator. Audio 2 = Joiner.
      TASK: Compare them and output a JSON Verdict.
      JSON STRUCTURE:
      {
        "verdict": "The Creator is correct because...",
        "conclusion": "A neutral summary.",
        "logic_score": { "creator": 85, "joiner": 60 },
        "emotional_intelligence": { "creator": 40, "joiner": 90 },
        "fact_accuracy": { "creator": 80, "joiner": 50 }
      }
    `}
  ];

  const result = await model.generateContent({ contents: [{ role: "user", parts }] });
  return JSON.parse(result.response.text());
};

// 1. CREATE ROOM
export const createDispute = async (req, res) => {
  try {
    const code = generateCode();
    const smallDispute = await SmallDispute.create({ //
      creator_id: req.user._id,
      invite_code: code,
      status: "OPEN"
    });
    res.status(201).json({ message: "Room created", invite_code: code, dispute_id: smallDispute._id });
  } catch (err) {
    res.status(500).json({ message: "Failed to create dispute" });
  }
};

// 2. JOIN ROOM
export const joinDispute = async (req, res) => {
  try {
    const { invite_code } = req.body;
    const smallDispute = await SmallDispute.findOne({ invite_code, status: "OPEN" });

    if (!smallDispute) return res.status(404).json({ message: "Invalid code" });
    if (smallDispute.creator_id.toString() === req.user._id.toString()) return res.status(400).json({ message: "Cannot join your own room" });

    smallDispute.joiner_id = req.user._id;
    await smallDispute.save();

    // Socket: Notify Creator that Joiner arrived
    if (req.io) req.io.to(smallDispute._id.toString()).emit("user_joined", { message: "Opponent has joined!" });

    res.json({ message: "Joined successfully", dispute_id: smallDispute._id });
  } catch (err) {
    res.status(500).json({ message: "Failed to join" });
  }
};

// 3. START RECORDING (Triggers Timer)
export const startDispute = async (req, res) => {
  try {
    const { dispute_id } = req.body;
    const smallDispute = await SmallDispute.findById(dispute_id);

    if (!smallDispute) return res.status(404).json({ message: "Dispute not found" });
    if (smallDispute.creator_id.toString() !== req.user._id.toString()) return res.status(403).json({ message: "Only Creator can start" });
    if (!smallDispute.joiner_id) return res.status(400).json({ message: "Wait for opponent" });

    smallDispute.status = "RECORDING";
    await smallDispute.save();

    // Socket: Start 30s Timer on BOTH phones
    if (req.io) req.io.to(dispute_id).emit("timer_start", { duration: 30 });

    res.json({ message: "Session started", status: "RECORDING" });
  } catch (err) {
    res.status(500).json({ message: "Failed to start" });
  }
};

// 4. SUBMIT VOICE & JUDGE
export const submitVoice = async (req, res) => {
  try {
    const { dispute_id } = req.body;
    const file = req.file;

    const smallDispute = await SmallDispute.findById(dispute_id);
    if (!smallDispute) return res.status(404).json({ message: "Dispute not found" });

    // Save Audio
    const audioDoc = await AudioFile.create({
      user_id: req.user._id,
      file_path: file.path,
      original_name: "dispute_arg.mp3",
      mimetype: file.mimetype,
      size: file.size
    });

    // Assign Audio
    if (req.user._id.toString() === smallDispute.creator_id.toString()) smallDispute.audio_creator = audioDoc._id;
    else if (req.user._id.toString() === smallDispute.joiner_id.toString()) smallDispute.audio_joiner = audioDoc._id;

    await smallDispute.save();

    // Socket: Tell everyone someone finished
    if (req.io) req.io.to(dispute_id).emit("status_update", { message: "One user submitted." });

    // CHECK: Are both done?
    if (smallDispute.audio_creator && smallDispute.audio_joiner) {
      console.log("Both done. Judging...");
      if (req.io) req.io.to(dispute_id).emit("processing_start", { message: "Judge is analyzing..." });

      smallDispute.status = "PROCESSING";
      await smallDispute.save();

      const verdict = await runJudgeAI(smallDispute);
      smallDispute.result = verdict;
      smallDispute.status = "COMPLETED";
      await smallDispute.save();

      // Socket: VERDICT READY!
      if (req.io) req.io.to(dispute_id).emit("verdict_ready", { status: "COMPLETED", result: verdict });

      return res.json({ message: "Verdict broadcasted" });
    }

    return res.json({ message: "Waiting for opponent" });

  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Submission failed" });
  }
};

// 5. GET DETAILS (For loading screen)
export const getDispute = async (req, res) => {
  try {
    const smallDispute = await SmallDispute.findById(req.params.id).populate("creator_id joiner_id");
    if (!smallDispute) return res.status(404).json({ message: "Not found" });
    res.json(smallDispute);
  } catch (err) {
    res.status(500).json({ message: "Error" });
  }
};