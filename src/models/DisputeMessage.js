import mongoose from "mongoose";

const disputeMessageSchema = new mongoose.Schema({
  dispute_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "OfficialDispute",
    index: true
  },
  sender_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },
  sender_role: {
    type: String,
    enum: ["creator", "joiner"],
  },
  message_type: {
    type: String,
    enum: ["text", "audio"],
    required: true
  },
  // For text messages
  text_content: String,
  // For audio messages
  audio_data: {
    file_path: String,
    original_name: String,
    mimetype: String,
    size: Number,
    duration: Number // in seconds
  },

  // Message status (WhatsApp-like)
  status: {
    type: String,
    enum: ["sent", "delivered", "read"],
    default: "sent"
  },
  delivered_at: Date,
  read_at: Date,

  timestamp: {
    type: Date,
    default: Date.now
  },
  // For AI to track important messages
  is_flagged: {
    type: Boolean,
    default: false
  },
  flag_reason: String
});

// Indexes for efficient querying
disputeMessageSchema.index({ dispute_id: 1, timestamp: 1 });
disputeMessageSchema.index({ sender_id: 1 });

export default mongoose.model("DisputeMessage", disputeMessageSchema);