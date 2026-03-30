import express from "express";
import auth from "../middleware/auth.js";
import { login, completeProfile, updateProfile } from "../controllers/authController.js";

const router = express.Router();

router.post("/login", login);

router.post("/complete-profile", auth, completeProfile);

router.patch("/update-profile", auth, updateProfile);

export default router;