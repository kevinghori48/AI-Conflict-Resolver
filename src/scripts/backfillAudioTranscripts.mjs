import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import DisputeMessage from "../models/DisputeMessage.js";
import { transcribeAudio } from "../services/geminiService.js";

dotenv.config();

const args = new Set(process.argv.slice(2));
const isDryRun = args.has("--dry-run");
const force = args.has("--force");

const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : null;

if (limitArg && (!Number.isFinite(limit) || limit <= 0)) {
  console.error("Invalid --limit value. Use a positive number, e.g. --limit=25");
  process.exit(1);
}

const resolveAudioPath = (filePath) => {
  if (!filePath) return null;
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(process.cwd(), filePath);
};

async function run() {
  await connectDB();

  const query = {
    message_type: "audio",
    "audio_data.file_path": { $exists: true, $ne: null }
  };

  if (!force) {
    query.$or = [
      { "audio_data.transcript": { $exists: false } },
      { "audio_data.transcript": null },
      { "audio_data.transcript": "" }
    ];
  }

  const cursor = DisputeMessage.find(query)
    .sort({ timestamp: 1 })
    .cursor();

  let scanned = 0;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for await (const message of cursor) {
    if (limit && scanned >= limit) break;
    scanned++;

    const resolvedPath = resolveAudioPath(message.audio_data?.file_path);
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
      skipped++;
      console.warn(`[skip] Missing audio file for message ${message._id}`);
      continue;
    }

    const existingTranscript = message.audio_data?.transcript?.trim();
    if (existingTranscript && !force) {
      skipped++;
      continue;
    }

    try {
      const transcript = await transcribeAudio(resolvedPath);
      if (!transcript) {
        skipped++;
        console.warn(`[skip] No transcript returned for message ${message._id}`);
        continue;
      }

      if (isDryRun) {
        updated++;
        console.log(`[dry-run] Would update ${message._id}: ${transcript.slice(0, 80)}`);
        continue;
      }

      message.audio_data = {
        ...message.audio_data,
        transcript
      };
      await message.save();
      updated++;
      console.log(`[updated] ${message._id}`);
    } catch (error) {
      failed++;
      console.error(`[failed] ${message._id}: ${error.message}`);
    }
  }

  console.log("");
  console.log(`Scanned: ${scanned}`);
  console.log(`Updated: ${updated}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Failed: ${failed}`);
}

run()
  .catch((error) => {
    console.error("Backfill failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.connection.close().catch(() => {});
  });
