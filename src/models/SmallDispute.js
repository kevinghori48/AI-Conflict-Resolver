import mongoose from "mongoose";

const smallDisputeSchema = new mongoose.Schema({
  // The Two Players
  creator_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  joiner_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // Initially null

  // The Invite System
  invite_code: { type: String, required: true, unique: true }, // e.g., "A1B2C3"
  status: {
    type: String,
    enum: ["OPEN", "RECORDING", "PROCESSING", "COMPLETED"],
    default: "OPEN"
  },

  // The Evidence (30s Audio Clips)
  audio_creator: { type: mongoose.Schema.Types.ObjectId, ref: "AudioFile" },
  audio_joiner: { type: mongoose.Schema.Types.ObjectId, ref: "AudioFile" },

  // The AI Verdict (Comparative Analysis)
  result: {
    verdict: { type: String }, // "User A is logical because..."
    conclusion: { type: String }, // Summary

    // Comparison Bars (0-100%)
    logic_score: {
      creator: { type: Number },
      joiner: { type: Number }
    },
    emotional_intelligence: {
      creator: { type: Number },
      joiner: { type: Number }
    },
    fact_accuracy: {
      creator: { type: Number },
      joiner: { type: Number }
    }
  },

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("SmallDispute", smallDisputeSchema);