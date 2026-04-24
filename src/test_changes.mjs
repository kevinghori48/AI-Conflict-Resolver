/**
 * test_changes.mjs
 *
 * Verifies the audio-transcription and modality-neutral summary changes by
 * reading source files directly.
 *
 * Run with:
 *   node src/test_changes.mjs
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { transcribeAudio } from "./services/geminiService.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  ${GREEN}OK${RESET} ${label}`);
  passed++;
}

function fail(label, detail = "") {
  console.log(`  ${RED}FAIL${RESET} ${label}`);
  if (detail) console.log(`      ${RED}${detail}${RESET}`);
  failed++;
}

function section(title) {
  console.log(`\n${CYAN}${BOLD}${title}${RESET}`);
}

function loadFile(relPath) {
  const abs = path.resolve(__dirname, relPath);
  if (!fs.existsSync(abs)) {
    console.error(`${RED}Missing file: ${abs}${RESET}`);
    process.exit(1);
  }
  return fs.readFileSync(abs, "utf8");
}

function check(label, source, ...patterns) {
  const missing = patterns.filter((pattern) =>
    typeof pattern === "string" ? !source.includes(pattern) : !pattern.test(source)
  );

  if (missing.length === 0) {
    pass(label);
    return;
  }

  fail(label, `Missing: ${missing.map((p) => p.toString()).join(" | ")}`);
}

function checkAbsent(label, source, ...patterns) {
  const found = patterns.filter((pattern) =>
    typeof pattern === "string" ? source.includes(pattern) : pattern.test(source)
  );

  if (found.length === 0) {
    pass(label);
    return;
  }

  fail(label, `Unexpected: ${found.map((p) => p.toString()).join(" | ")}`);
}

const CONTROLLER = loadFile("controllers/officialDisputeController.js");
const SOCKET = loadFile("socketHandlers/disputeSocketHandler.js");
const GEMINI = loadFile("services/geminiService.js");
const MESSAGE_MODEL = loadFile("models/DisputeMessage.js");
const DISPUTE_MODEL = loadFile("models/OfficialDispute.js");

for (const envPath of [
  path.resolve(__dirname, "../.env"),
  path.resolve(__dirname, ".env"),
  path.resolve(process.cwd(), ".env")
]) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

console.log(`\n${BOLD}${CYAN}Audio Summary Regression Checks${RESET}`);
console.log(`${"-".repeat(44)}`);

section("1. Schema");

check(
  "audio_data stores transcript",
  MESSAGE_MODEL,
  "transcript: String"
);

section("2. Upload-time transcription");

check(
  "controller imports transcribeAudio helper",
  CONTROLLER,
  "import { transcribeAudio } from \"../services/geminiService.js\";"
);

check(
  "uploadAudio transcribes after mp3 conversion",
  CONTROLLER,
  "const transcript = await transcribeAudio(mp3Path);"
);

check(
  "uploadAudio persists transcript",
  CONTROLLER,
  /export const uploadAudio[\s\S]{0,2200}transcript/
);

check(
  "sendAudioMessage persists transcript",
  CONTROLLER,
  /export const sendAudioMessage[\s\S]{0,2200}transcript/
);

section("3. Shared AI transcript builder");

check(
  "shared transcript builder is exported",
  CONTROLLER,
  "export async function buildDisputeTranscriptForAI(messages, creatorName = \"Person A\", joinerName = \"Person B\") {"
);

check(
  "text messages still use text_content",
  CONTROLLER,
  "return (msg.text_content || \"\").trim();"
);

check(
  "audio messages use stored transcript only",
  CONTROLLER,
  "return msg.audio_data?.transcript?.trim() || \"\";"
);

check(
  "summary generation uses shared transcript builder",
  CONTROLLER,
  "const transcript = await buildDisputeTranscriptForAI(messages, creatorName, joinerName);"
);

check(
  "summary regeneration uses shared transcript builder",
  SOCKET,
  "const transcript = await buildDisputeTranscriptForAI(messages, \"Person A\", \"Person B\");"
);

check(
  "dispute_state includes normalized participant user payloads",
  SOCKET,
  "creator_user: creatorUser",
  "joiner_user: joinerUser",
  "current_user: currentUser",
  "other_user: otherUser"
);

check(
  "new_message emits explicit sender_user for text and audio",
  SOCKET,
  "sender_user: message.sender_id,"
);

section("4. Modality-neutral prompts");

check(
  "summary prompt forbids audio/text wording",
  CONTROLLER,
  "- Do not mention whether any message was audio, voice, spoken, typed, recorded, or text.",
  "- Do not describe delivery details such as \"sent an audio message\"."
);

check(
  "regeneration prompt forbids audio/text wording",
  SOCKET,
  "- Do not mention whether any message was audio, voice, spoken, typed, recorded, or text.",
  "- Do not describe delivery details such as who sent audio messages."
);

checkAbsent(
  "old audio placeholder removed from summary generation",
  CONTROLLER,
  "[Sent ${msg.audio_data?.duration || 30} second audio message]"
);

checkAbsent(
  "old audio placeholder removed from summary regeneration",
  SOCKET,
  "[Audio message - ${msg.audio_data?.duration || 30}s]"
);

section("5. Transcription service");

check(
  "transcribeAudio helper exported",
  GEMINI,
  "export const transcribeAudio = async (filePath) => {"
);

check(
  "Groq Whisper is primary path",
  GEMINI,
  "whisper-large-v3-turbo",
  "https://api.groq.com/openai/v1/audio/transcriptions"
);

check(
  "Gemini transcription remains fallback",
  GEMINI,
  "const geminiResult = await processAudioWithGemini(filePath);"
);

section("6. AI-visible plans and highlighted sensitive topics");

check(
  "suggested_plan schema stores AI-visible guidance fields",
  DISPUTE_MODEL,
  "mediator_note: String",
  "ai_suggestions: [String]",
  "sensitive_topics: [String]",
  "summary_html: String",
  "action_html: String"
);

check(
  "final_plan schema stores AI-visible guidance fields",
  DISPUTE_MODEL,
  "commitments_html: {",
  "success_criteria_html: String"
);

check(
  "controller decorates plans with highlighted HTML",
  CONTROLLER,
  "function decoratePlanWithHighlights(plan) {",
  "'<mark class=\"sensitive-topic\">$1</mark>'",
  "sensitive_topics: [],"
);

check(
  "suggested plan prompt asks for AI-visible additions",
  CONTROLLER,
  "Add a short mediator note explaining why this plan could work in warm, human language.",
  "Add 3 concise AI suggestions that sound supportive and natural, like a thoughtful mediator coaching two real people.",
  "\"mediator_note\": \"2-3 warm, human sentences from the AI mediator explaining the reasoning behind this suggested plan\""
);

check(
  "final plan prompt asks for AI-visible additions",
  CONTROLLER,
  "Add a short mediator note explaining why this final plan is likely to work in warm, human language.",
  "Add 3 concise AI suggestions that sound supportive and natural, like a thoughtful mediator coaching two real people.",
  "Do not reuse the previous summary or action steps with only light rewording.",
  "\"mediator_note\": \"2-3 warm, human sentences from the AI mediator explaining why this final plan fits the conversation and negotiation\""
);

check(
  "suggested and final plan save path uses highlighted decorator",
  CONTROLLER,
  "dispute.suggested_plan = decoratePlanWithHighlights({",
  "dispute.final_plan = decoratePlanWithHighlights(result.final_plan);"
);

check(
  "controller normalizes malformed plan output before save",
  CONTROLLER,
  "function normalizeCommitments(commitments) {",
  "function normalizePlanOutput(plan) {",
  "ai_suggestions: ensureStringArray(plan?.ai_suggestions).slice(0, 3),"
);

const skipLive = process.argv.includes("--skip-live");

section("7. Optional live API sanity");

if (skipLive) {
  console.log(`  ${YELLOW}Skipped with --skip-live${RESET}`);
} else {
  const hasGroqKey = Boolean(process.env.GROQ_API_KEY);
  const hasGeminiKey = Boolean(process.env.GEMINI_API_KEY);
  const sampleAudioPath =
    process.env.TEST_AUDIO_FILE ||
    [
      path.resolve(__dirname, "../uploads/audio/1767591753886-62061292.mp3"),
      path.resolve(__dirname, "../uploads/audio/1767591793817-616906953.mp3")
    ].find((candidate) => fs.existsSync(candidate));

  if (!hasGroqKey && !hasGeminiKey) {
    console.log(`  ${YELLOW}Skipped live checks because no API keys are set${RESET}`);
  } else if (!sampleAudioPath || !fs.existsSync(sampleAudioPath)) {
    console.log(`  ${YELLOW}Skipped live checks because no sample audio file was found${RESET}`);
  } else {
    try {
      const transcript = await transcribeAudio(sampleAudioPath);
      if (transcript && transcript.trim()) {
        pass(`live transcription returned text from ${path.basename(sampleAudioPath)}`);
      } else {
        fail("live transcription returned empty transcript");
      }
    } catch (error) {
      fail("live transcription smoke test failed", error.message);
    }
  }
}

const total = passed + failed;

console.log(`\n${"-".repeat(44)}`);
console.log(`${BOLD}Results: ${passed}/${total} passed${RESET}`);

if (failed > 0) {
  console.log(`${RED}${BOLD}${failed} check(s) failed${RESET}\n`);
  process.exit(1);
}

console.log(`${GREEN}${BOLD}All checks passed${RESET}\n`);
