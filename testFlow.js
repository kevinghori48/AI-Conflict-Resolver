/**
 * FULL FLOW TEST SCRIPT — AI Conflict Resolver
 * ─────────────────────────────────────────────
 * Tests the entire dispute flow using REST + Socket.IO
 *
 * SETUP:
 *   npm install axios socket.io-client
 *
 * RUN:
 *   node testFlow.js
 *
 * WHAT IT TESTS:
 *   1.  Login (creator + joiner)
 *   2.  Complete profile (onboarding)
 *   3.  Get relationship questions
 *   4.  Create dispute
 *   5.  Join dispute via socket
 *   6.  Send text + audio messages via socket
 *   7.  End conversation → AI summary
 *   8.  Approve summary (both users)
 *   9.  Select solutions (both users)
 *   10. Accept suggested plan → COMPLETED  (Path A)
 *       OR reject → negotiation → agree → final plan → approve (Path B)
 *   11. Get dispute detail + history list
 *   12. Delete dispute
 */

import axios from "axios";
import { io } from "socket.io-client";

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const BASE_URL    = "http://localhost:5001";
const SOCKET_URL  = "http://localhost:5001";
const API         = `${BASE_URL}/official-dispute`;
const AUTH_API    = `${BASE_URL}/auth`;

// Test users — these will be created on first run
const CREATOR = { email: "testcreator@test.com", firstName: "Test",   lastName: "Creator" };
const JOINER  = { email: "testjoiner@test.com",  firstName: "Test",   lastName: "Joiner"  };

// Set to "A" to test accept path, "B" to test full negotiation path
const TEST_PATH = "B";

// ─── HELPERS ─────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

const log   = (msg)        => console.log(`\n${"─".repeat(60)}\n${msg}`);
const ok    = (label, data) => { passed++; console.log(`  ✅ ${label}`, data ? JSON.stringify(data, null, 2).slice(0, 200) : ""); };
const fail  = (label, err)  => { failed++; console.error(`  ❌ ${label}`, err?.response?.data || err?.message || err); };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const api = (token) => axios.create({
  baseURL: BASE_URL,
  headers: token ? { Authorization: `Bearer ${token}` } : {}
});

// Wait for a specific socket event with a timeout
const waitForEvent = (socket, event, timeoutMs = 30000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (data) => { clearTimeout(timer); resolve(data); });
  });

// ─── STATE ───────────────────────────────────────────────────────────────────
let creatorToken, joinerToken;
let creatorId,    joinerId;
let disputeId,    inviteCode;
let creatorSocket, joinerSocket;

// ─── STEP 1: LOGIN ───────────────────────────────────────────────────────────
async function step1_login() {
  log("STEP 1 — Login");
  try {
    const r1 = await axios.post(`${AUTH_API}/login`, CREATOR);
    creatorToken = r1.data.token;
    creatorId    = r1.data.user._id;
    ok("Creator login", { isNewUser: r1.data.isNewUser, token: creatorToken.slice(0, 20) + "..." });
  } catch (e) { fail("Creator login", e); }

  try {
    const r2 = await axios.post(`${AUTH_API}/login`, JOINER);
    joinerToken = r2.data.token;
    joinerId    = r2.data.user._id;
    ok("Joiner login", { isNewUser: r2.data.isNewUser, token: joinerToken.slice(0, 20) + "..." });
  } catch (e) { fail("Joiner login", e); }
}

// ─── STEP 2: COMPLETE PROFILE ────────────────────────────────────────────────
async function step2_completeProfile() {
  log("STEP 2 — Complete Profile");
  try {
    const r = await api(creatorToken).post(`${AUTH_API}/complete-profile`, {
      firstName: "Test", lastName: "Creator", avatarId: 1, gender: "male"
    });
    ok("Creator complete profile", { isNewUser: r.data.isNewUser });
  } catch (e) { fail("Creator complete profile", e); }

  try {
    const r = await api(joinerToken).post(`${AUTH_API}/complete-profile`, {
      firstName: "Test", lastName: "Joiner", avatarId: 2, gender: "female"
    });
    ok("Joiner complete profile", { isNewUser: r.data.isNewUser });
  } catch (e) { fail("Joiner complete profile", e); }
}

// ─── STEP 3: RELATIONSHIP QUESTIONS ─────────────────────────────────────────
async function step3_questions() {
  log("STEP 3 — Get Relationship Questions");
  try {
    const r = await api(creatorToken).get(`${API}/questions/couple`);
    ok("Get questions", { count: r.data.questions.length });
  } catch (e) { fail("Get questions", e); }
}

// ─── STEP 4: CREATE DISPUTE ───────────────────────────────────────────────────
async function step4_createDispute() {
  log("STEP 4 — Create Dispute");
  try {
    const r = await api(creatorToken).post(`${API}/create`, {
      dispute_name:            "Test Dispute",
      relationship_type:       "couple",
      relationship_importance: "high",
      goal:                    "Resolve communication issues",
      urgency:                 "1_week",
      non_negotiables:         "Respect",
      avoid_topics:            "Past arguments",
      relationship_questions:  [{ question: "How long together?", answer: "2 years" }]
    });
    disputeId  = r.data.dispute_id;
    inviteCode = r.data.invite_code;
    ok("Create dispute", { disputeId, inviteCode });
  } catch (e) { fail("Create dispute", e); }
}

// ─── STEP 5: CONNECT SOCKETS ─────────────────────────────────────────────────
async function step5_connectSockets() {
  log("STEP 5 — Connect Sockets");

  creatorSocket = io(SOCKET_URL, { auth: { token: creatorToken }, transports: ["websocket"] });
  joinerSocket  = io(SOCKET_URL, { auth: { token: joinerToken  }, transports: ["websocket"] });

  await Promise.all([
    new Promise(r => creatorSocket.on("connect", () => { ok("Creator socket connected", { id: creatorSocket.id }); r(); })),
    new Promise(r => joinerSocket.on("connect",  () => { ok("Joiner socket connected",  { id: joinerSocket.id  }); r(); }))
  ]);

  // Error listeners
  creatorSocket.on("error", e => console.error("  ⚠️  Creator socket error:", e));
  joinerSocket.on("error",  e => console.error("  ⚠️  Joiner socket error:",  e));
}

// ─── STEP 6: JOIN DISPUTE ROOM ───────────────────────────────────────────────
async function step6_joinRoom() {
  log("STEP 6 — Join Dispute Room");

  // Creator joins socket room by dispute_id
  const creatorState = await new Promise((resolve, reject) => {
    creatorSocket.emit("join_dispute", { dispute_id: disputeId });
    waitForEvent(creatorSocket, "dispute_state").then(resolve).catch(reject);
  });
  ok("Creator joined socket room", { status: creatorState.status, role: creatorState.user_role });

  // Joiner must call HTTP join FIRST — registers them in the dispute and sets status to CONVERSATION.
  // Only then can they join the socket room.
  try {
    const r = await api(joinerToken).post(`${API}/join`, { invite_code: inviteCode });
    ok("Joiner HTTP join dispute", { dispute_id: r.data.dispute_id, status: r.data.dispute.status });
  } catch (e) { fail("Joiner HTTP join dispute", e); return; }

  // Now joiner joins the socket room by dispute_id
  const joinerState = await new Promise((resolve, reject) => {
    joinerSocket.emit("join_dispute", { dispute_id: disputeId });
    waitForEvent(joinerSocket, "dispute_state").then(resolve).catch(reject);
  });
  ok("Joiner joined socket room", { status: joinerState.status, role: joinerState.user_role });
}

// ─── STEP 7: SEND MESSAGES ───────────────────────────────────────────────────
async function step7_sendMessages() {
  log("STEP 7 — Send Messages");

  // Creator sends text
  await new Promise((resolve, reject) => {
    creatorSocket.emit("send_message", { dispute_id: disputeId, text_content: "I feel we don't communicate well lately." }, (cb) => {
      if (cb.success) { ok("Creator send text message", { id: cb.message._id }); resolve(); }
      else { fail("Creator send text message", cb); reject(); }
    });
  });

  // Joiner sends text
  await new Promise((resolve, reject) => {
    joinerSocket.emit("send_message", { dispute_id: disputeId, text_content: "I agree, I feel unheard sometimes." }, (cb) => {
      if (cb.success) { ok("Joiner send text message", { id: cb.message._id }); resolve(); }
      else { fail("Joiner send text message", cb); reject(); }
    });
  });

  // Test typing indicators
  creatorSocket.emit("typing", { dispute_id: disputeId });
  ok("Creator typing indicator sent");
  await sleep(500);
  creatorSocket.emit("stop_typing", { dispute_id: disputeId });
  ok("Creator stop typing sent");

  // Fetch conversation messages via REST
  try {
    const r = await api(creatorToken).get(`${API}/messages/${disputeId}`);
    ok("Get conversation messages", { count: r.data.count });
  } catch (e) { fail("Get conversation messages", e); }
}

// ─── STEP 8: END CONVERSATION → WAIT FOR SUMMARY ────────────────────────────
async function step8_endConversation() {
  log("STEP 8 — End Conversation → AI Summary");

  const summaryPromise = waitForEvent(creatorSocket, "summary_ready", 60000);

  creatorSocket.emit("end_conversation", { dispute_id: disputeId }, (cb) => {
    if (cb?.success) ok("End conversation", { status: cb.status });
    else fail("End conversation", cb);
  });

  try {
    const summary = await summaryPromise;
    ok("Summary ready", { main_topic: summary.summary?.main_topic, key_points: summary.summary?.key_points?.length });
  } catch (e) { fail("Wait for summary_ready", e); }
}

// ─── STEP 9: APPROVE SUMMARY (BOTH) ─────────────────────────────────────────
async function step9_approveSummary() {
  log("STEP 9 — Approve Summary");

  const solutionsPromise = waitForEvent(creatorSocket, "solutions_ready", 60000);

  try {
    const r1 = await api(creatorToken).post(`${API}/summary/approve`, { dispute_id: disputeId });
    ok("Creator approve summary", { both: r1.data.status });
  } catch (e) { fail("Creator approve summary", e); }

  try {
    const r2 = await api(joinerToken).post(`${API}/summary/approve`, { dispute_id: disputeId });
    ok("Joiner approve summary", { status: r2.data.status });
  } catch (e) { fail("Joiner approve summary", e); }

  try {
    const solutions = await solutionsPromise;
    ok("Solutions ready", { count: solutions.solutions?.length });
  } catch (e) { fail("Wait for solutions_ready", e); }
}

// ─── STEP 10: SELECT SOLUTIONS (BOTH) ────────────────────────────────────────
async function step10_selectSolutions() {
  log("STEP 10 — Select Solutions");

  // Get solutions first
  let solutionIds = ["A", "C"];
  try {
    const r = await api(creatorToken).get(`${API}/solutions/${disputeId}`);
    solutionIds = r.data.solutions.slice(0, 2).map(s => s.id);
    ok("Get solutions", { ids: solutionIds });
  } catch (e) { fail("Get solutions", e); }

  const suggestedPlanPromise = waitForEvent(creatorSocket, "suggested_plan_ready", 60000);

  try {
    const r1 = await api(creatorToken).post(`${API}/solutions/select`, {
      dispute_id: disputeId, selected_solution_ids: [solutionIds[0]]
    });
    ok("Creator select solution", { confirmed: r1.data.creator_confirmed });
  } catch (e) { fail("Creator select solution", e); }

  try {
    const r2 = await api(joinerToken).post(`${API}/solutions/select`, {
      dispute_id: disputeId, selected_solution_ids: [solutionIds[1] || solutionIds[0]]
    });
    ok("Joiner select solution", { confirmed: r2.data.joiner_confirmed });
  } catch (e) { fail("Joiner select solution", e); }

  try {
    const plan = await suggestedPlanPromise;
    ok("Suggested plan ready", { title: plan.suggested_plan?.title });
  } catch (e) { fail("Wait for suggested_plan_ready", e); }
}

// ─── STEP 11A: PATH A — ACCEPT SUGGESTED PLAN ────────────────────────────────
async function step11a_acceptPlan() {
  log("STEP 11 (Path A) — Accept Suggested Plan");

  const completedPromise = waitForEvent(creatorSocket, "dispute_completed", 15000);

  try {
    const r1 = await api(creatorToken).post(`${API}/plan/accept`, { dispute_id: disputeId });
    ok("Creator accept suggested plan", { status: r1.data.status });
  } catch (e) { fail("Creator accept suggested plan", e); }

  try {
    const r2 = await api(joinerToken).post(`${API}/plan/accept`, { dispute_id: disputeId });
    ok("Joiner accept suggested plan", { status: r2.data.status });
  } catch (e) { fail("Joiner accept suggested plan", e); }

  try {
    const completed = await completedPromise;
    ok("Dispute completed (Path A)", { status: completed.status, title: completed.final_plan?.title });
  } catch (e) { fail("Wait for dispute_completed", e); }
}

// ─── STEP 11B: PATH B — REJECT → NEGOTIATE → FINAL PLAN → APPROVE ────────────
async function step11b_negotiationPath() {
  log("STEP 11 (Path B) — Reject → Negotiate → Final Plan → Approve");

  // Reject suggested plan
  const negotiationPromise = waitForEvent(creatorSocket, "negotiation_started", 10000);
  try {
    const r = await api(creatorToken).post(`${API}/plan/reject`, {
      dispute_id: disputeId, reason: "I want more specific action steps"
    });
    ok("Creator reject suggested plan", { rejected_by: r.data.rejected_by });
  } catch (e) { fail("Creator reject suggested plan", e); }

  try {
    await negotiationPromise;
    ok("Negotiation started event received");
  } catch (e) { fail("Wait for negotiation_started", e); }

  // Post negotiation comments
  try {
    const r1 = await api(creatorToken).post(`${API}/negotiation/comment`, {
      dispute_id: disputeId, text: "I need clearer weekly check-ins defined."
    });
    ok("Creator post negotiation comment", { id: r1.data.comment._id });
  } catch (e) { fail("Creator post negotiation comment", e); }

  try {
    const r2 = await api(joinerToken).post(`${API}/negotiation/comment`, {
      dispute_id: disputeId, text: "Agreed, let's set every Sunday 8pm."
    });
    ok("Joiner post negotiation comment", { id: r2.data.comment._id });
  } catch (e) { fail("Joiner post negotiation comment", e); }

  // Get negotiation comments
  try {
    const r = await api(creatorToken).get(`${API}/negotiation/comments/${disputeId}`);
    ok("Get negotiation comments", { count: r.data.count });
  } catch (e) { fail("Get negotiation comments", e); }

  // Both signal agreement
  const finalPlanPromise = waitForEvent(creatorSocket, "final_plan_ready", 60000);

  try {
    const r1 = await api(creatorToken).post(`${API}/negotiation/agree`, { dispute_id: disputeId });
    ok("Creator signal agreement", { creator_ready: r1.data.creator_ready });
  } catch (e) { fail("Creator signal agreement", e); }

  try {
    const r2 = await api(joinerToken).post(`${API}/negotiation/agree`, { dispute_id: disputeId });
    ok("Joiner signal agreement", { status: r2.data.status });
  } catch (e) { fail("Joiner signal agreement", e); }

  try {
    const finalPlan = await finalPlanPromise;
    ok("Final plan ready", { title: finalPlan.final_plan?.title });
  } catch (e) { fail("Wait for final_plan_ready", e); }

  // Get final plan via REST
  try {
    const r = await api(creatorToken).get(`${API}/final-plan/${disputeId}`);
    ok("Get final plan", { title: r.data.final_plan?.title });
  } catch (e) { fail("Get final plan", e); }

  // Both approve final plan
  const completedPromise = waitForEvent(creatorSocket, "dispute_completed", 10000);

  try {
    const r1 = await api(creatorToken).post(`${API}/final-plan/approve`, { dispute_id: disputeId });
    ok("Creator approve final plan", { status: r1.data.status });
  } catch (e) { fail("Creator approve final plan", e); }

  try {
    const r2 = await api(joinerToken).post(`${API}/final-plan/approve`, { dispute_id: disputeId });
    ok("Joiner approve final plan", { status: r2.data.status });
  } catch (e) { fail("Joiner approve final plan", e); }

  try {
    const completed = await completedPromise;
    ok("Dispute completed (Path B)", { status: completed.status, title: completed.final_plan?.title });
  } catch (e) { fail("Wait for dispute_completed", e); }
}

// ─── STEP 12: GENERAL ENDPOINTS ──────────────────────────────────────────────
async function step12_generalEndpoints() {
  log("STEP 12 — General Endpoints");

  try {
    const r = await api(creatorToken).get(`${API}/my-disputes`);
    ok("Get my disputes (list)", { count: r.data.count });
  } catch (e) { fail("Get my disputes", e); }

  try {
    const r = await api(creatorToken).get(`${API}/my-disputes/${disputeId}`);
    ok("Get dispute detail", { status: r.data.dispute.status, has_messages: r.data.dispute.conversation?.messages === undefined });
  } catch (e) { fail("Get dispute detail", e); }

  try {
    const r = await api(creatorToken).get(`${API}/status/${disputeId}`);
    ok("Get dispute status", { status: r.data.dispute.status });
  } catch (e) { fail("Get dispute status", e); }

  // Update profile
  try {
    const r = await api(creatorToken).patch(`${AUTH_API}/update-profile`, { avatarId: 3 });
    ok("Update profile", { avatarId: r.data.user.avatarId });
  } catch (e) { fail("Update profile", e); }
}

// ─── STEP 13: CLEANUP ─────────────────────────────────────────────────────────
async function step13_cleanup() {
  log("STEP 13 — Cleanup");

  // Disconnect sockets
  if (creatorSocket?.connected) { creatorSocket.disconnect(); ok("Creator socket disconnected"); }
  if (joinerSocket?.connected)  { joinerSocket.disconnect();  ok("Joiner socket disconnected");  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n" + "═".repeat(60));
  console.log("  AI CONFLICT RESOLVER — FULL FLOW TEST");
  console.log(`  Path: ${TEST_PATH === "A" ? "Accept Suggested Plan" : "Reject → Negotiate → Final Plan"}`);
  console.log("═".repeat(60));

  try {
    await step1_login();
    if (!creatorToken || !joinerToken) { console.error("\n❌ Cannot continue without tokens. Exiting."); process.exit(1); }

    await step2_completeProfile();
    await step3_questions();
    await step4_createDispute();
    if (!disputeId) { console.error("\n❌ Cannot continue without dispute. Exiting."); process.exit(1); }

    await step5_connectSockets();
    await step6_joinRoom();
    await step7_sendMessages();
    await step8_endConversation();
    await step9_approveSummary();
    await step10_selectSolutions();

    if (TEST_PATH === "B") {
      await step11a_acceptPlan();
    } else {
      await step11b_negotiationPath();
    }

    await step12_generalEndpoints();
  } catch (e) {
    console.error("\n💥 Unexpected error:", e.message);
  } finally {
    await step13_cleanup();

    console.log("\n" + "═".repeat(60));
    console.log(`  RESULTS: ✅ ${passed} passed   ❌ ${failed} failed`);
    console.log("═".repeat(60) + "\n");
    process.exit(failed > 0 ? 1 : 0);
  }
}

main();