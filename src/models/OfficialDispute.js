import mongoose from "mongoose";

const officialDisputeSchema = new mongoose.Schema({
  // Participants
  creator_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  joiner_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

  // Invite System
  invite_code: { type: String, required: true, unique: true },
  // Intake & Context
  relationship_type: {
    type: String,
    enum: ["couple", "roommate", "workplace", "money", "custom"],
    required: true
  },
  intake_data: {
    goal: String,
    urgency: String,
    is_negotiable: Boolean,
    negotiation_points: String,
    preset_answers: [{ question: String, answer: String }]
  },
  intake_audio: { type: mongoose.Schema.Types.ObjectId, ref: "AudioFile" },

  // Fairness Agreement
  fairness_signatures: {
    creator_signed: { type: Boolean, default: false },
    joiner_signed: { type: Boolean, default: false }
  },

  // State Machine
  status: {
    type: String,
    enum: [
      "PRE_DISPUTE",
      "FAIRNESS_CHECK",
      "ROUND_1_INPUT",
      "ROUND_1_ANALYSIS",
      "ROUND_1_CONFIRMATION",
      "ROUND_2_OPTIONS",
      "ROUND_3_PLAN",
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
    summaries: { creator: String, joiner: String },
    common_ground: [String]
  },
  round_1_confirmation: {
    creator_agreed: { type: Boolean, default: false },
    joiner_agreed: { type: Boolean, default: false }
  },

  // Round 2: Options
  round_2_options: [{
    id: String,
    title: String,
    description: String,
    pros: { creator: String, joiner: String },
    cons: { creator: String, joiner: String },
    type: { type: String }
  }],
  round_2_selections: {
    creator_selected_ids: [String],
    joiner_selected_ids: [String]
  },
  final_selected_option_ids: [String],

  // Round 3: Action Plan
  round_3_plan: {
    tasks: [{
      who: String,
      what: String,
      by_when: String
    }],
    suggestions: {
      short_term: [String],
      medium_term: [String],
      long_term: [String]
    },
    final_signatures: {
      creator: { type: Boolean, default: false },
      joiner: { type: Boolean, default: false }
    }
  },

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("OfficialDispute", officialDisputeSchema);
