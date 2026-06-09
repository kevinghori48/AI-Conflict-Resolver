import mongoose from "mongoose";

const multimodalChatSchema = new mongoose.Schema({
  user_id: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  analysis_id: { type: mongoose.Schema.Types.ObjectId, ref: "MultimodalAnalysis", required: true },
  messages: [
    {
      role: { type: String, enum: ["user", "model"], required: true },
      content: { type: String, required: true },
      timestamp: { type: Date, default: Date.now }
    }
  ],
  createdAt: { type: Date, default: Date.now }
});

export default mongoose.model("MultimodalChat", multimodalChatSchema);
