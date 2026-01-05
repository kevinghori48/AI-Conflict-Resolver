import mongoose from "mongoose";

const officialDisputeSchema = new mongoose.Schema({
  // Basic Info
  dispute_name: { type: String, required: true },

  // Participants
  creator_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  joiner_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

  // Invite System
  invite_code: { type: String, required: true, unique: true },

  // Intake & Context (Screen 1 & 2 data)
  intake_data: {
    relationship_type: {
      type: String,
      enum: ["couple", "roommates", "friends", "family", "workplace", "other"],
      required: true
    },
    custom_relationship: String, // For "other" type
    relationship_importance: {
      type: String,
      enum: ["low", "medium", "high"],
      required: true
    },
    goal: { type: String, required: true },
    non_negotiables: String,
    avoid_topics: String,
    urgency: {
      type: String,
      enum: ["1_day", "1_week", "1_month", "1_year", "no_rush"],
      required: true
    },
    relationship_questions: [{
      question: String,
      answer: String
    }]
  },

  // State Machine
  status: {
    type: String,
    enum: [
      "PRE_DISPUTE",           // Waiting for joiner
      "CONVERSATION",          // Active chat (Screen 5)
      "AI_SUMMARIZING",        // AI generating summary
      "SUMMARY_REVIEW",        // Screen 6 - reviewing summary
      "OPTIONS_SELECTION",     // Screen 7 - selecting solutions
      "COMPLETED"
    ],
    default: "PRE_DISPUTE"
  },

  // Conversation Phase (Screen 5)
  conversation: {
    messages: [{ type: mongoose.Schema.Types.ObjectId, ref: "DisputeMessage" }],
    audio_count: {
      creator: { type: Number, default: 0 },
      joiner: { type: Number, default: 0 }
    },
    ended_by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    ended_at: Date
  },

  // AI Summary (Screen 6)
  ai_summary: {
    summary_text: String,
    key_points: [{
      point: String,
      mentioned_by: String // "creator" or "joiner" or "both"
    }],
    generated_at: Date,
    regeneration_count: { type: Number, default: 0 }
  },

  summary_approval: {
    creator_approved: { type: Boolean, default: false },
    joiner_approved: { type: Boolean, default: false }
  },

  // Solutions Phase (Screen 7)
  solutions: [{
    id: String,
    label: String, // A, B, C, D, E
    title: String,
    description: String,
    pros: {
      creator: [String],
      joiner: [String]
    },
    cons: {
      creator: [String],
      joiner: [String]
    }
  }],

  solution_selections: {
    creator_selected: [String],
    joiner_selected: [String]
  },

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Update timestamp on save
officialDisputeSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model("OfficialDispute", officialDisputeSchema);