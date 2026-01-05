import mongoose from "mongoose";

const reportSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

  audio_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: "AudioFile" }],

  title: { type: String, default: "Conflict Analysis" },
  conversation_type: {
    type: String,
    required: true,
    enum: ["Relationship", "Work", "Family", "Friendship", "Other"]
  },
  objective: { type: String, default: "General resolution" },

  conflict_score: { type: Number, required: true },
  emotional_intensity: [
    {
      speaker_label: { type: String, required: true },
      score: { type: Number, required: true }
    }
  ],

  advice: {
    quick_fixes: [{ type: String }],
    better_communication: [{ type: String }],
    long_term_harmony: [{ type: String }]
  },

  summary_points: [{ type: String }],

  suggested_replies: [{ type: String }],

  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("Report", reportSchema);
