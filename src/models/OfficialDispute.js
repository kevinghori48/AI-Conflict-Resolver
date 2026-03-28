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
    custom_relationship: String,
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

  // PRE_DISPUTE      → waiting for joiner
  // CONVERSATION     → active audio/text chat
  // AI_SUMMARIZING   → AI generating summary OR final plan
  // SUMMARY_REVIEW   → both reviewing AI summary
  // OPTIONS_SELECTION      → both selecting preferred solutions
  // SUGGESTED_PLAN_REVIEW  → both reviewing AI-suggested plan (accept or negotiate)
  // NEGOTIATION            → comment thread to align on final plan
  // FINAL_PLAN_REVIEW→ both reviewing the AI-generated final plan
  // COMPLETED        → dispute fully resolved
  status: {
    type: String,
    enum: [
      "PRE_DISPUTE",
      "CONVERSATION",
      "AI_SUMMARIZING",
      "SUMMARY_REVIEW",
      "OPTIONS_SELECTION",
      "SUGGESTED_PLAN_REVIEW",
      "NEGOTIATION",
      "FINAL_PLAN_REVIEW",
      "COMPLETED"
    ],
    default: "PRE_DISPUTE"
  },

  // Conversation Phase
  conversation: {
    messages: [{ type: mongoose.Schema.Types.ObjectId, ref: "DisputeMessage" }],
    audio_count: {
      creator: { type: Number, default: 0 },
      joiner: { type: Number, default: 0 }
    },
    ended_by: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    ended_at: Date
  },

  // AI Summary
  ai_summary: {
    main_topic: String,
    summary_text: String,
    key_points: [{
      point: String,
      mentioned_by: String // "creator" | "joiner" | "both"
    }],
    generated_at: Date,
    regeneration_count: { type: Number, default: 0 }
  },

  summary_approval: {
    creator_approved: { type: Boolean, default: false },
    joiner_approved: { type: Boolean, default: false }
  },

  // Solutions Phase
  solutions: [{
    id: String,
    label: String,
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
    joiner_selected: [String],
    creator_confirmed: { type: Boolean, default: false },
    joiner_confirmed: { type: Boolean, default: false }
  },

  // AI-suggested plan after both select solutions; both can accept or start negotiation.
  suggested_plan: {
    title: String,
    summary: String,
    action_steps: [{
      step: Number,
      action: String,
      responsible: String,
      timeframe: String
    }],
    commitments: {
      creator: [String],
      joiner: [String]
    },
    success_criteria: String,
    generated_at: Date
  },
  suggested_plan_approval: {
    creator_approved: { type: Boolean, default: false },
    joiner_approved: { type: Boolean, default: false },
    rejected_by: { type: String, enum: ["creator", "joiner"] }
  },

  // Comment thread between both parties after solution selection.
  // When both signal ready, AI generates the final_plan.
  negotiation: {
    comments: [{
      sender_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
      sender_role: { type: String, enum: ["creator", "joiner"] },
      text: { type: String, required: true },
      timestamp: { type: Date, default: Date.now }
    }],
    // Posting a new comment resets both flags to false,
    // ensuring both re-confirm after any new message.
    creator_ready: { type: Boolean, default: false },
    joiner_ready: { type: Boolean, default: false }
  },

  // AI-generated resolution plan built from negotiation comments
  // + both parties' selected solutions.
  final_plan: {
    title: String,
    summary: String,
    action_steps: [{
      step: Number,
      action: String,
      responsible: { type: String, enum: ["creator", "joiner", "both"] },
      timeframe: String
    }],
    commitments: {
      creator: [String],
      joiner: [String]
    },
    success_criteria: String
  },

  // Both must approve the final plan to complete the dispute.
  final_plan_approval: {
    creator_approved: { type: Boolean, default: false },
    joiner_approved: { type: Boolean, default: false }
  },

  // Issue reports on the final plan — stored for future product improvement.
  // Reporting counts as an implicit approval so the dispute still completes.
  final_plan_reports: [{
    reporter_id: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    reporter_role: { type: String, enum: ["creator", "joiner"] },
    feedback: String,
    reported_at: { type: Date, default: Date.now }
  }],

  // Timestamp when dispute reached COMPLETED
  completed_at: Date,

  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

officialDisputeSchema.pre('save', function (next) {
  this.updatedAt = Date.now();
  next();
});

export default mongoose.model("OfficialDispute", officialDisputeSchema);