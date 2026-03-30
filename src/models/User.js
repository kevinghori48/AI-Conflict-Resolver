import mongoose from "mongoose";

const userSchema = new mongoose.Schema({
  firstName: { type: String, required: true },
  lastName: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  isAdmin: { type: Boolean, default: false },
  gender: { type: String, enum: ["male", "female", "other"] },
  avatarId: { type: Number },
  // true  → just registered, show profile setup screen
  // false → profile complete, go straight to home
  isNewUser: { type: Boolean, default: true }
}, { timestamps: true });

export default mongoose.model("User", userSchema);