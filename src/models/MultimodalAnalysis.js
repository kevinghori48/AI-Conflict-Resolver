import mongoose from "mongoose";

const multimodalAnalysisSchema = new mongoose.Schema({
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  summary_text: {
    type: String
  },
  summary_audio_url: {
    type: String
  },
  uploaded_media: [{
    file_path: { type: String, required: true },
    mime_type: { type: String, required: true }
  }],
  ai_summary: {
    type: Object,
    required: true
  },
  title: {
    type: String
  },
  status: {
    type: String,
    enum: ["ai_summary", "active_chat"],
    default: "ai_summary"
  },


}, { timestamps: true });

export default mongoose.model("MultimodalAnalysis", multimodalAnalysisSchema);
