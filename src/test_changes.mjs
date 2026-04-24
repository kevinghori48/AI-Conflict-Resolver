/**
 * test_changes.mjs
 *
 * Verifies every change made to:
 *   - officialDisputeController.js
 *   - disputeSocketHandler.js
 *   - officialDisputeRoutes.js
 *
 * Run with:
 *   node test_changes.mjs
 *
 * No DB, no server, no .env needed.
 * All tests run by reading and analysing the source files directly.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Colours ─────────────────────────────────────────────────────────────────
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const BOLD   = "\x1b[1m";
const RESET  = "\x1b[0m";

// ─── Helpers ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function pass(label) {
  console.log(`  ${GREEN}✓${RESET}  ${label}`);
  passed++;
}

function fail(label, detail = "") {
  console.log(`  ${RED}✗${RESET}  ${label}`);
  if (detail) console.log(`      ${RED}→ ${detail}${RESET}`);
  failed++;
}

function section(title) {
  console.log(`\n${CYAN}${BOLD}━━━ ${title} ━━━${RESET}`);
}

function loadFile(relPath) {
  const abs = path.resolve(__dirname, relPath);
  if (!fs.existsSync(abs)) {
    console.error(`${RED}File not found: ${abs}${RESET}`);
    process.exit(1);
  }
  return fs.readFileSync(abs, "utf8");
}

function check(label, source, ...patterns) {
  const missing = patterns.filter(p =>
    typeof p === "string" ? !source.includes(p) : !p.test(source)
  );
  if (missing.length === 0) {
    pass(label);
  } else {
    fail(label, `Missing: ${missing.map(p => p.toString()).join(" | ")}`);
  }
}

function checkAbsent(label, source, ...patterns) {
  const found = patterns.filter(p =>
    typeof p === "string" ? source.includes(p) : p.test(source)
  );
  if (found.length === 0) {
    pass(label);
  } else {
    fail(label, `Should NOT contain: ${found.map(p => p.toString()).join(" | ")}`);
  }
}

// ─── Load files ───────────────────────────────────────────────────────────────
const CONTROLLER  = loadFile("controllers/officialDisputeController.js");
const SOCKET      = loadFile("socketHandlers/disputeSocketHandler.js");
const ROUTES      = loadFile("routes/officialDisputeRoutes.js");

console.log(`\n${BOLD}${CYAN}AI Conflict Resolver — Change Verification Tests${RESET}`);
console.log(`${"─".repeat(52)}`);

// ═════════════════════════════════════════════════════════════════════════════
// 1. REAL NAMES IN AI PROMPTS
// ═════════════════════════════════════════════════════════════════════════════
section("1. Real Names in AI Prompts");

// 1a. generateAISummary
check(
  "generateAISummary — populates creator_id if not hydrated",
  CONTROLLER,
  "await dispute.populate(\"creator_id\", \"firstName lastName email\")",
);
check(
  "generateAISummary — builds creatorName / joinerName variables",
  CONTROLLER,
  "const creatorName = dispute.creator_id?.firstName",
  "const joinerName = dispute.joiner_id?.firstName",
);
check(
  "generateAISummary — uses creatorName/joinerName in transcript (not hardcoded Person A/B)",
  CONTROLLER,
  "const senderName = msg.sender_role === \"creator\" ? creatorName : joinerName",
);
checkAbsent(
  "generateAISummary — no hardcoded \"Person A\" in transcript loop",
  CONTROLLER,
  // The only allowed Person A/B occurrences are in the fallback ternary `? \`...\` : "Person A"`
  // So we check the transcript line specifically
  "? \"Person A\" : \"Person B\";",   // this would be a hardcoded sender in the loop
);

// 1b. generateSolutions
check(
  "generateSolutions — populates creator/joiner if not hydrated",
  CONTROLLER,
  // This block appears in generateSolutions
  /generateSolutions[\s\S]{0,400}await dispute\.populate\("creator_id"/,
);
check(
  "generateSolutions — option bias labels use real names",
  CONTROLLER,
  "- Option A: Should favor ${creatorName} (creator) more",
  "- Option B: Should favor ${joinerName} (joiner) more",
);
check(
  "generateSolutions — pros/cons keys use real names",
  CONTROLLER,
  "\"creator\": [\"Specific benefit 1 for ${creatorName}\"",
  "\"joiner\": [\"Specific benefit 1 for ${joinerName}\"",
);
checkAbsent(
  "generateSolutions — no hardcoded Person A/B in prompt text",
  CONTROLLER,
  "Should favor Person A",
  "Should favor Person B",
  "for Person A\"",
  "for Person B\"",
);

// 1c. generateSuggestedPlan
check(
  "generateSuggestedPlan — uses real names in solution sections",
  CONTROLLER,
  "${creatorName} (Creator) selected these solutions:",
  "${joinerName} (Joiner) selected these solutions:",
);
check(
  "generateSuggestedPlan — commitments use real names",
  CONTROLLER,
  "\"creator\": [\"Specific commitment for ${creatorName}\"]",
  "\"joiner\": [\"Specific commitment for ${joinerName}\"]",
);
checkAbsent(
  "generateSuggestedPlan — no hardcoded Person A/B in prompt text",
  CONTROLLER,
  "PERSON A (Creator) selected",
  "PERSON B (Joiner) selected",
  "Specific commitment for Person A",
  "Specific commitment for Person B",
);

// 1d. generateFinalPlan
check(
  "generateFinalPlan — negotiation thread uses real names",
  CONTROLLER,
  "c.sender_role === \"creator\" ? creatorName : joinerName",
);
check(
  "generateFinalPlan — rejected plan section uses real names",
  CONTROLLER,
  "${creatorName}: ${(dispute.suggested_plan.commitments?.creator || []).join(\"; \")}",
  "${joinerName}: ${(dispute.suggested_plan.commitments?.joiner || []).join(\"; \")}",
);
check(
  "generateFinalPlan — preferred solutions sections use real names",
  CONTROLLER,
  "${creatorName} (Creator) preferred these solutions:",
  "${joinerName} (Joiner) preferred these solutions:",
);
check(
  "generateFinalPlan — commitments use real names",
  CONTROLLER,
  "\"creator\": [\"Specific commitment ${creatorName} is making\"]",
  "\"joiner\": [\"Specific commitment ${joinerName} is making\"]",
);
checkAbsent(
  "generateFinalPlan — no hardcoded Person A/B in prompt text",
  CONTROLLER,
  "PERSON A (Creator) preferred",
  "PERSON B (Joiner) preferred",
  "Person A is making",
  "Person B is making",
  "Person A: ${(dispute.suggested_plan",
  "Person B: ${(dispute.suggested_plan",
);

// 1e. approveSummary waiting message
check(
  "approveSummary — waiting message uses real user name (not Person A/B)",
  CONTROLLER,
  "`${req.user.firstName} ${req.user.lastName} approved the summary. Waiting for the other party.`",
);
checkAbsent(
  "approveSummary — no hardcoded Person A/B in message",
  CONTROLLER,
  "? \"Person A\" : \"Person B\"} approved the summary",
);

// ═════════════════════════════════════════════════════════════════════════════
// 2. REJECTION AUTO-CANCELS OTHER PARTY'S ACCEPTANCE
// ═════════════════════════════════════════════════════════════════════════════
section("2. Rejection Auto-Cancels Other Party's Acceptance");

// 2a. Controller rejectSuggestedPlan
check(
  "rejectSuggestedPlan (REST) — checks if other party had accepted before resetting",
  CONTROLLER,
  "const otherHadAccepted = isCreator",
  "? dispute.suggested_plan_approval?.joiner_approved",
  ": dispute.suggested_plan_approval?.creator_approved",
);
check(
  "rejectSuggestedPlan (REST) — emits cancelled_acceptance_of in negotiation_started",
  CONTROLLER,
  "cancelled_acceptance_of: otherHadAccepted ? otherRole : null",
);
check(
  "rejectSuggestedPlan (REST) — returns cancelled_acceptance_of in response",
  CONTROLLER,
  /rejectSuggestedPlan[\s\S]{0,2500}cancelled_acceptance_of: otherHadAccepted \? otherRole : null/,
);
check(
  "rejectSuggestedPlan (REST) — emits rejected_by_name with full name",
  CONTROLLER,
  "rejected_by_name:        `${req.user.firstName} ${req.user.lastName}`",
);

// 2b. Socket reject_suggested_plan
check(
  "reject_suggested_plan (socket) — checks if other party had accepted",
  SOCKET,
  "const otherHadAccepted = isCreator",
);
check(
  "reject_suggested_plan (socket) — emits cancelled_acceptance_of",
  SOCKET,
  "cancelled_acceptance_of: otherHadAccepted ? otherRole : null,",
);
check(
  "reject_suggested_plan (socket) — emits rejected_by_name",
  SOCKET,
  "rejected_by_name:        `${socket.user.firstName} ${socket.user.lastName}`",
);
check(
  "reject_suggested_plan (socket) — callback includes cancelled_acceptance_of",
  SOCKET,
  "cancelled_acceptance_of: otherHadAccepted ? otherRole : null });",
);

// ═════════════════════════════════════════════════════════════════════════════
// 3. NEW: CANCEL ACCEPTANCE
// ═════════════════════════════════════════════════════════════════════════════
section("3. New: Cancel Acceptance");

// 3a. Controller handler
check(
  "cancelAcceptance (REST) — handler exported from controller",
  CONTROLLER,
  "export const cancelAcceptance = async (req, res) => {",
);
check(
  "cancelAcceptance (REST) — guards: status must be SUGGESTED_PLAN_REVIEW",
  CONTROLLER,
  /cancelAcceptance[\s\S]{0,300}SUGGESTED_PLAN_REVIEW/,
);
check(
  "cancelAcceptance (REST) — checks user actually accepted before cancelling",
  CONTROLLER,
  /cancelAcceptance[\s\S]{0,1100}You have not accepted the plan yet/,
);
check(
  "cancelAcceptance (REST) — blocks cancel when other party already accepted",
  CONTROLLER,
  /cancelAcceptance[\s\S]{0,1500}Cannot cancel — other party has already accepted/,
);
check(
  "cancelAcceptance (REST) — only resets this user's own flag",
  CONTROLLER,
  /cancelAcceptance[\s\S]{0,1700}dispute\.suggested_plan_approval\.creator_approved = false/,
  /cancelAcceptance[\s\S]{0,1700}dispute\.suggested_plan_approval\.joiner_approved  = false/,
);
check(
  "cancelAcceptance (REST) — emits acceptance_cancelled event to room",
  CONTROLLER,
  /cancelAcceptance[\s\S]{0,1900}"acceptance_cancelled"/,
);
check(
  "cancelAcceptance (REST) — acceptance_cancelled includes cancelled_by_name",
  CONTROLLER,
  /cancelAcceptance[\s\S]{0,2100}cancelled_by_name.*firstName.*lastName/,
);

// 3b. Route
check(
  "POST /plan/cancel-acceptance route added",
  ROUTES,
  "router.post(\"/plan/cancel-acceptance\", auth, controller.cancelAcceptance);",
);

// 3c. Socket event
check(
  "cancel_acceptance (socket) — event registered",
  SOCKET,
  "requireAuth(\"cancel_acceptance\", async ({ dispute_id }, callback) => {",
);
check(
  "cancel_acceptance (socket) — guards: status must be SUGGESTED_PLAN_REVIEW",
  SOCKET,
  /cancel_acceptance[\s\S]{0,800}SUGGESTED_PLAN_REVIEW/,
);
check(
  "cancel_acceptance (socket) — checks user actually accepted",
  SOCKET,
  /cancel_acceptance[\s\S]{0,1600}You have not accepted the plan yet/,
);
check(
  "cancel_acceptance (socket) — blocks when other party already accepted",
  SOCKET,
  /cancel_acceptance[\s\S]{0,2000}Cannot cancel — other party has already accepted/,
);
check(
  "cancel_acceptance (socket) — emits acceptance_cancelled to room",
  SOCKET,
  /cancel_acceptance[\s\S]{0,1000}io\.to\(roomId\)\.emit\("acceptance_cancelled"/,
);
check(
  "cancel_acceptance (socket) — acceptance_cancelled has cancelled_by_name",
  SOCKET,
  /cancel_acceptance[\s\S]{0,1200}cancelled_by_name.*socket\.user\.firstName/,
);

// ═════════════════════════════════════════════════════════════════════════════
// 4. FINAL PLAN IS ACCEPT-ONLY (reject_final_plan REMOVED)
// ═════════════════════════════════════════════════════════════════════════════
section("4. Final Plan is Accept-Only");

checkAbsent(
  "reject_final_plan socket event removed from handler",
  SOCKET,
  "requireAuth(\"reject_final_plan\"",
);
checkAbsent(
  "plan_rejected emit removed from socket handler",
  SOCKET,
  // The only plan_rejected that should be gone is the final plan one
  // It was inside reject_final_plan so if the event is gone this is also gone
  "io.to(roomId).emit(\"plan_rejected\"",
);
check(
  "confirm_final_plan socket event still present",
  SOCKET,
  "requireAuth(\"confirm_final_plan\"",
);
check(
  "approve_final_plan socket event still present",
  SOCKET,
  "requireAuth(\"approve_final_plan\"",
);
check(
  "approveFinalPlan REST handler still present",
  CONTROLLER,
  "export const approveFinalPlan = async (req, res) => {",
);
check(
  "POST /final-plan/approve route still present",
  ROUTES,
  "router.post(\"/final-plan/approve\", auth, controller.approveFinalPlan);",
);

// ═════════════════════════════════════════════════════════════════════════════
// 5. RICHER plan_approval_update EMIT
// ═════════════════════════════════════════════════════════════════════════════
section("5. Richer plan_approval_update Emit");

// 5a. REST handler approveFinalPlan
check(
  "approveFinalPlan (REST) — plan_approval_update includes approved_by field",
  CONTROLLER,
  /plan_approval_update[\s\S]{0,200}approved_by:.*isCreator.*\"creator\".*\"joiner\"/,
);
check(
  "approveFinalPlan (REST) — plan_approval_update includes approved_by_name",
  CONTROLLER,
  /plan_approval_update[\s\S]{0,300}approved_by_name:.*req\.user\.firstName.*req\.user\.lastName/,
);
check(
  "approveFinalPlan (REST) — plan_approval_update includes both_approved: false",
  CONTROLLER,
  /plan_approval_update[\s\S]{0,400}both_approved:.*false/,
);
check(
  "approveFinalPlan (REST) — plan_approval_update message uses first name",
  CONTROLLER,
  /plan_approval_update[\s\S]{0,500}message:.*req\.user\.firstName.*approved the final plan/,
);

// 5b. Socket approve_final_plan
check(
  "approve_final_plan (socket) — plan_approval_update includes approved_by",
  SOCKET,
  /plan_approval_update[\s\S]{0,200}approved_by:.*isCreator.*\"creator\".*\"joiner\"/,
);
check(
  "approve_final_plan (socket) — plan_approval_update includes approved_by_name",
  SOCKET,
  /plan_approval_update[\s\S]{0,300}approved_by_name:.*socket\.user\.firstName.*socket\.user\.lastName/,
);
check(
  "approve_final_plan (socket) — plan_approval_update includes both_approved: false",
  SOCKET,
  /plan_approval_update[\s\S]{0,400}both_approved:.*false/,
);
check(
  "approve_final_plan (socket) — message uses first name",
  SOCKET,
  /plan_approval_update[\s\S]{0,500}message:.*socket\.user\.firstName.*approved the final plan/,
);

// ═════════════════════════════════════════════════════════════════════════════
// 6. EXISTING FUNCTIONALITY NOT BROKEN
// ═════════════════════════════════════════════════════════════════════════════
section("6. Existing Functionality Not Broken");

// Routes still all present
const expectedRoutes = [
  "router.post(\"/plan/accept\", auth, controller.acceptSuggestedPlan);",
  "router.post(\"/plan/reject\", auth, controller.rejectSuggestedPlan);",
  "router.get(\"/plan/suggested/:dispute_id\", auth, controller.getSuggestedPlan);",
  "router.post(\"/negotiation/comment\", auth, controller.postNegotiationComment);",
  "router.get(\"/negotiation/comments/:dispute_id\", auth, controller.getNegotiationComments);",
  "router.post(\"/negotiation/agree\", auth, controller.signalAgreement);",
  "router.get(\"/final-plan/:dispute_id\", auth, controller.getFinalPlan);",
  "router.post(\"/final-plan/approve\", auth, controller.approveFinalPlan);",
  "router.post(\"/final-plan/report\", auth, controller.reportFinalPlanIssue);",
  "router.post(\"/summary/approve\", auth, controller.approveSummary);",
  "router.post(\"/solutions/select\", auth, controller.selectSolutions);",
];
for (const route of expectedRoutes) {
  check(`Route present: ${route.split(",")[0].replace("router.", "").trim()}`, ROUTES, route);
}

// Key controller functions still exported
const expectedExports = [
  "export const acceptSuggestedPlan",
  "export const rejectSuggestedPlan",
  "export const cancelAcceptance",
  "export const approveFinalPlan",
  "export const reportFinalPlanIssue",
  "export const postNegotiationComment",
  "export const getNegotiationComments",
  "export const signalAgreement",
  "export async function generateAISummary",
  "export async function generateSolutions",
  "export async function generateSuggestedPlan",
  "export async function generateFinalPlan",
  "export const approveSummary",
  "export const getFinalPlan",
];
for (const exp of expectedExports) {
  check(`Controller export: ${exp.replace("export ", "").split(" ")[1]}`, CONTROLLER, exp);
}

// Key socket events still registered
const expectedSocketEvents = [
  "requireAuth(\"accept_suggested_plan\"",
  "requireAuth(\"reject_suggested_plan\"",
  "requireAuth(\"cancel_acceptance\"",
  "requireAuth(\"post_negotiation_comment\"",
  "requireAuth(\"signal_agreement\"",
  "requireAuth(\"agree_negotiation\"",
  "requireAuth(\"approve_final_plan\"",
  "requireAuth(\"confirm_final_plan\"",
  "requireAuth(\"get_suggested_plan\"",
  "requireAuth(\"get_negotiation_comments\"",
  "requireAuth(\"get_final_plan\"",
  "requireAuth(\"send_negotiation_comment\"",
  "requireAuth(\"revoke_agreement\"",
];
for (const evt of expectedSocketEvents) {
  check(`Socket event: ${evt.replace("requireAuth(\"", "").replace("\"", "")}`, SOCKET, evt);
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. LIVE AI MODEL TEST
// Requires GEMINI_API_KEY (and optionally GROQ_API_KEY) in environment.
// Skip this section by running:  node test_changes.mjs --skip-ai
// ═════════════════════════════════════════════════════════════════════════════
section("7. Live AI Model Test");

const skipAI = process.argv.includes("--skip-ai");

if (skipAI) {
  console.log(`  ${YELLOW}⚠${RESET}  Skipped (--skip-ai flag passed)`);
} else {
  // Dynamically load .env if dotenv is available
  try {
    const dotenv = await import("dotenv");
    // look for .env one directory up (inside src/..) or same dir
    const envPaths = ["../.env", ".env", "../../.env"];
    for (const p of envPaths) {
      const abs = path.resolve(__dirname, p);
      if (fs.existsSync(abs)) {
        dotenv.config({ path: abs });
        console.log(`  ${YELLOW}ℹ${RESET}  Loaded .env from ${abs}`);
        break;
      }
    }
  } catch (_) {
    // dotenv not installed — rely on env vars already set in shell
  }

  // ── Helper: call Gemini directly (mirrors the logic in the controller) ──────
  async function testGemini(modelName) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not set");

    const { GoogleGenerativeAI } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { responseMimeType: "application/json", temperature: 0 }
    });

    const prompt = `Return a JSON object with exactly two fields: "status" set to "ok" and "model" set to "${modelName}". Nothing else.\n\nCRITICAL: Your response MUST be valid JSON only. No markdown, no backticks, no explanation. Start with { and end with }.`;
    const result = await model.generateContent(prompt);
    const text   = result.response.text().trim();
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    if (!parsed.status) throw new Error(`Unexpected response shape: ${text}`);
    return parsed;
  }

  // ── Helper: call Groq directly ───────────────────────────────────────────────
  async function testGroq() {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY not set");

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model:       "llama-3.3-70b-versatile",
        temperature: 0,
        messages: [
          { role: "system", content: "You are a helpful assistant that responds only in valid JSON." },
          { role: "user",   content: `Return a JSON object with exactly two fields: "status" set to "ok" and "model" set to "llama-3.3-70b-versatile". Nothing else.\n\nCRITICAL: Your response MUST be valid JSON only. No markdown, no backticks, no explanation. Start with { and end with }.` }
        ]
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data   = await res.json();
    const text   = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from Groq");
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    if (!parsed.status) throw new Error(`Unexpected response shape: ${text}`);
    return parsed;
  }

  // ── Run tests ────────────────────────────────────────────────────────────────

  // 7a. gemini-2.5-flash (primary)
  try {
    process.stdout.write(`  ${CYAN}…${RESET}  gemini-2.5-flash — calling API...\r`);
    const r = await testGemini("gemini-2.5-flash");
    pass(`gemini-2.5-flash — returned valid JSON  { status: "${r.status}", model: "${r.model}" }`);
  } catch (e) {
    const is503 = e.message.includes("503") || e.message.includes("high demand") || e.message.includes("Service Unavailable");
    fail(
      `gemini-2.5-flash — ${is503 ? "503 Service Unavailable (server overloaded, not your key)" : "FAILED"}`,
      e.message.slice(0, 120)
    );
  }

  // 7b. gemini-1.5-flash (fallback)
  try {
    process.stdout.write(`  ${CYAN}…${RESET}  gemini-1.5-flash — calling API...\r`);
    const r = await testGemini("gemini-1.5-flash");
    pass(`gemini-1.5-flash — returned valid JSON  { status: "${r.status}", model: "${r.model}" }`);
  } catch (e) {
    const is503 = e.message.includes("503") || e.message.includes("high demand") || e.message.includes("Service Unavailable");
    fail(
      `gemini-1.5-flash — ${is503 ? "503 Service Unavailable (server overloaded, not your key)" : "FAILED"}`,
      e.message.slice(0, 120)
    );
  }

  // 7c. Groq (optional — only tested if GROQ_API_KEY is set)
  if (process.env.GROQ_API_KEY) {
    try {
      process.stdout.write(`  ${CYAN}…${RESET}  groq/llama-3.3-70b — calling API...\r`);
      const r = await testGroq();
      pass(`groq/llama-3.3-70b — returned valid JSON  { status: "${r.status}", model: "${r.model}" }`);
    } catch (e) {
      fail(`groq/llama-3.3-70b — FAILED`, e.message.slice(0, 120));
    }
  } else {
    console.log(`  ${YELLOW}⚠${RESET}  groq/llama-3.3-70b — skipped (GROQ_API_KEY not set)`);
  }

  // 7d. callGemini function exported and uses correct fallback chain
  check(
    "callGemini — Groq fallback function defined",
    CONTROLLER,
    "async function callGroq(prompt)",
  );
  check(
    "callGemini — switches to Groq after 2 consecutive 503s",
    CONTROLLER,
    "gemini503Count >= 2 && process.env.GROQ_API_KEY",
  );
  check(
    "callGemini — final Groq fallback after all Gemini attempts exhausted",
    CONTROLLER,
    "final Groq fallback",
  );
  check(
    "callGemini — uses groq/llama-3.3-70b model",
    CONTROLLER,
    '"llama-3.3-70b-versatile"',
  );
  check(
    "callGemini — Groq hits api.groq.com endpoint",
    CONTROLLER,
    "https://api.groq.com/openai/v1/chat/completions",
  );
}

// ─── Summary ──────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${"─".repeat(52)}`);
console.log(`${BOLD}Results: ${passed}/${total} passed${RESET}`);
if (failed === 0) {
  console.log(`${GREEN}${BOLD}All checks passed ✓${RESET}\n`);
} else {
  console.log(`${RED}${BOLD}${failed} check(s) failed ✗${RESET}\n`);
  process.exit(1);
}
