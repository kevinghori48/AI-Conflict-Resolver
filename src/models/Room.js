import mongoose from "mongoose";

const roomSchema = new mongoose.Schema(
  {
    report_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Report",
      required: true
    },

    // User 1 = creator, User 2 = joiner
    created_by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    members: [
      {
        user_id:   { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        joined_at: { type: Date, default: Date.now }
      }
    ],

    // Invite code User 1 generates
    invite_code: {
      type: String,
      unique: true,
      sparse: true
    },
    invite_expires_at: { type: Date },

    // Summary approval tracking
    summary_approvals: [
      {
        user_id:     { type: mongoose.Schema.Types.ObjectId, ref: "User" },
        approved_at: { type: Date, default: Date.now }
      }
    ],
    summary_fully_approved: { type: Boolean, default: false }
  },
  { timestamps: true }
);

export default mongoose.model("Room", roomSchema);