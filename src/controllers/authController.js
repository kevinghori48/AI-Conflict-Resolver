import jwt from "jsonwebtoken";
import User from "../models/User.js";

export const login = async (req, res) => {
  try {
    const { email, firstName, lastName } = req.body;

    if (!email || !firstName || !lastName) {
      return res.status(400).json({ message: "Email, First Name, and Last Name are required" });
    }

    let user = await User.findOne({ email });

    if (!user) {
      console.log("Creating new user:", email);
      user = await User.create({
        email,
        firstName,
        lastName
      });
    } else {
      console.log("Existing user login:", email);
      user.firstName = firstName;
      user.lastName = lastName;
      await user.save();
    }

    const token = jwt.sign(
      { _id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.json({
      message: "Authentication successful",
      token,
      user: {
        _id: user._id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName
      }
    });

  } catch (err) {
    console.error("Auth error:", err);
    res.status(500).json({ message: "Authentication failed" });
  }
};
