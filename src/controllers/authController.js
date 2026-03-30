import jwt from "jsonwebtoken";
import User from "../models/User.js";

const formatUser = (user) => ({
  _id:       user._id,
  email:     user.email,
  firstName: user.firstName,
  lastName:  user.lastName,
  gender:    user.gender   ?? null,
  avatarId:  user.avatarId ?? null,
  isNewUser: user.isNewUser,
  isAdmin:   user.isAdmin
});

export const login = async (req, res) => {
  try {
    const { email, firstName, lastName } = req.body;

    if (!email || !firstName || !lastName) {
      return res.status(400).json({ message: "Email, First Name, and Last Name are required" });
    }

    let user = await User.findOne({ email });
    let isNewUser = false;

    if (!user) {
      console.log("Creating new user:", email);
      user = await User.create({ email, firstName, lastName });
      isNewUser = true;
    } else {
      console.log("Existing user login:", email);
      user.firstName = firstName;
      user.lastName  = lastName;
      await user.save();
      isNewUser = user.isNewUser;
    }

    const token = jwt.sign(
      { _id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      message:   "Authentication successful",
      token,
      isNewUser,
      user:      formatUser(user)
    });

  } catch (err) {
    console.error("Auth error:", err);
    res.status(500).json({ message: "Authentication failed" });
  }
};

// POST /auth/complete-profile
// Called once after first login — sets up profile and marks isNewUser = false
export const completeProfile = async (req, res) => {
  try {
    const { firstName, lastName, avatarId, gender } = req.body;

    if (!firstName || !lastName) {
      return res.status(400).json({ message: "firstName and lastName are required" });
    }
    if (!avatarId && avatarId !== 0) {
      return res.status(400).json({ message: "avatarId is required" });
    }
    if (!gender) {
      return res.status(400).json({ message: "gender is required" });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      {
        $set: {
          firstName,
          lastName,
          avatarId: Number(avatarId),
          gender,
          isNewUser: false
        }
      },
      { new: true }
    );

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({
      success:   true,
      message:   "Profile setup complete.",
      isNewUser: false,
      user:      formatUser(user)
    });
  } catch (err) {
    console.error("Complete profile error:", err);
    res.status(500).json({ message: "Failed to complete profile", error: err.message });
  }
};

// PATCH /auth/update-profile
// Called by existing users to update name or avatar
export const updateProfile = async (req, res) => {
  try {
    const { firstName, lastName, avatarId } = req.body;

    if (!firstName && !lastName && avatarId === undefined) {
      return res.status(400).json({ message: "Provide at least one field to update: firstName, lastName, or avatarId" });
    }

    const updates = {};
    if (firstName)             updates.firstName = firstName;
    if (lastName)              updates.lastName  = lastName;
    if (avatarId !== undefined) updates.avatarId = Number(avatarId);

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: updates },
      { new: true }
    );

    if (!user) return res.status(404).json({ message: "User not found" });

    res.json({
      success:   true,
      message:   "Profile updated successfully.",
      isNewUser: user.isNewUser,
      user:      formatUser(user)
    });
  } catch (err) {
    console.error("Update profile error:", err);
    res.status(500).json({ message: "Failed to update profile", error: err.message });
  }
};