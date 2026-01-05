import express from "express";
import multer from "multer";
import {
  createReport,
  appendAudio,
  getReports,
  getReport
} from "../controllers/reportController.js";
import auth  from "../middleware/auth.js";

const router = express.Router();

const upload = multer({ dest: "uploads/" });

// 1. CREATE NEW REPORT (Multiple Audios)
// upload.array("audio", 5) allows up to 5 files with the key "audio"
router.post("/generate", auth, upload.array("audio", 5), createReport);

// 2. APPEND AUDIO (Single Audio)
// upload.single("audio") allows just 1 file for appending
router.post("/append", auth, upload.single("audio"), appendAudio);

// 3. GET REPORTS
router.get("/history", auth, getReports);
router.get("/:id", auth, getReport);

export default router;
