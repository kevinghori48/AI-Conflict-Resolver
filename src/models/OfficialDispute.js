import mongoose from "mongoose";

const officialDisputeSchema = new mongoose.Schema({
  // Participants
  creator_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  joiner_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

  // Invite System
  invite_code: { type: String, required: true, unique: true },

  // Intake & Context (Screen 1 & 2)
  relationship_type: {
    type: String,
    enum: ["couple", "roommate", "workplace", "money", "custom"],
    required: true
  },
  intake_data: {
    goal: String,
    urgency: String, // e.g., "Low", "High"
    is_negotiable: Boolean,
    negotiation_points: String,
    preset_answers: [{ question: String, answer: String }] // The 3-5 questions
  },
  intake_audio: { type: mongoose.Schema.Types.ObjectId, ref: "AudioFile" },

  // Fairness Agreement (Screen 3)
  fairness_signatures: {
    creator_signed: { type: Boolean, default: false },
    joiner_signed: { type: Boolean, default: false }
  },

  // The State Machine
  status: {
    type: String,
    enum: [
      "PRE_DISPUTE",       // Waiting for B
      "FAIRNESS_CHECK",    // Waiting for signatures
      "ROUND_1_INPUT",     // Recording main arguments
      "ROUND_1_ANALYSIS",  // AI Processing Understanding
      "ROUND_1_CONFIRMATION", // Waiting for users to agree with AI summary
      "ROUND_2_OPTIONS",   // Viewing/Selecting Options
      "ROUND_3_PLAN",      // Reviewing Action Plan
      "COMPLETED"
    ],
    default: "PRE_DISPUTE"
  },

  // Round 1: Understanding
  round_1_inputs: {
    creator_audio: { type: mongoose.Schema.Types.ObjectId, ref: "AudioFile" },
    joiner_audio: { type: mongoose.Schema.Types.ObjectId, ref: "AudioFile" },
    creator_text: String,
    joiner_text: String
  },
  round_1_result: {
    summaries: { creator: String, joiner: String }, // "What they are really saying"
    common_ground: [String] // Points both agree on
  },
  //Confirmation Logic
  round_1_confirmation: {
    creator_agreed: { type: Boolean, default: false },
    joiner_agreed: { type: Boolean, default: false }
  },

  // Round 2: Options
  round_2_options: [{
    id: String, // "A", "B", "C"
    title: String,
    description: String,
    pros: { creator: String, joiner: String },
    cons: { creator: String, joiner: String },
    type: String // "Creator Focused", "Joiner Focused", "Balanced"
  }],
  //Multi-Select Logic
  round_2_selections: {
    creator_selected_ids: [String],
    joiner_selected_ids: [String]
  },
  final_selected_option_ids: [String], // The options that made it to the final plan

  // Round 3: Action Plan
  round_3_plan: {
    tasks: [{
      who: String, // "Creator" or "Joiner"
      what: String,
      by_when: String
    }],
    suggestions: {
      short_term: [String],  // "Immediate"
      medium_term: [String], // "Next few weeks"
      long_term: [String]    // "Long term habits"
    },
    final_signatures: {
      creator: { type: Boolean, default: false },
      joiner: { type: Boolean, default: false }
    }
  },

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("OfficialDispute", officialDisputeSchema);