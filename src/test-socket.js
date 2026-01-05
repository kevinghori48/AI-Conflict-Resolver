// ============================================
// TEST WEBSOCKET CONNECTION (Backend Only)
// Run: node test-socket.js
// ============================================
import { io } from "socket.io-client";

// CONFIGURE THESE
const SERVER_URL = "http://localhost:5001";
const JWT_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJfaWQiOiI2OTViNGU3ZTViNTE2NjQxMDYwYjhlMTUiLCJlbWFpbCI6InVzZXIxQGV4YW1wbGUuY29tIiwiaWF0IjoxNzY3NTkxNTUwLCJleHAiOjE3NjgxOTYzNTB9.gtGSjRQ8TKPpngqS6BurBzUe6vV5U7qJOT-AfUySQ20"; // Get from login endpoint
const DISPUTE_ID = "YOUR_DISPUTE_ID_HERE"; // Get from create dispute endpoint

console.log("🧪 Testing WebSocket Connection...\n");

// ============================================
// CREATE SOCKET CONNECTION
// ============================================
const socket = io(SERVER_URL, {
  auth: { token: JWT_TOKEN },
  transports: ['websocket', 'polling']
});

// ============================================
// CONNECTION EVENTS
// ============================================
socket.on("connect", () => {
  console.log("✅ Connected to server!");
  console.log(`   Socket ID: ${socket.id}\n`);
  
  // Join dispute room
  console.log(`📥 Joining dispute: ${DISPUTE_ID}...`);
  socket.emit("join_dispute", { dispute_id: DISPUTE_ID });
});

socket.on("disconnect", (reason) => {
  console.log(`❌ Disconnected: ${reason}\n`);
});

socket.on("connect_error", (error) => {
  console.error("❌ Connection error:", error.message);
});

// ============================================
// DISPUTE EVENTS
// ============================================
socket.on("dispute_state", (data) => {
  console.log("📊 Dispute State Received:");
  console.log(`   Status: ${data.dispute.status}`);
  console.log(`   Your Role: ${data.user_role}`);
  console.log(`   Audio Count: Creator=${data.audio_count.creator}, Joiner=${data.audio_count.joiner}\n`);
  
  // After joining, send a test message
  setTimeout(() => {
    console.log("💬 Sending test message...");
    socket.emit("send_message", {
      dispute_id: DISPUTE_ID,
      text_content: "Hello! This is a test message from the WebSocket test script."
    });
  }, 2000);
});

socket.on("user_online", (data) => {
  console.log(`✅ User Online: ${data.user_name} (${data.user_role})\n`);
});

socket.on("user_offline", (data) => {
  console.log(`❌ User Offline: ${data.user_name}\n`);
});

// ============================================
// MESSAGE EVENTS
// ============================================
socket.on("new_message", (data) => {
  console.log("📩 New Message Received:");
  console.log(`   From: ${data.message.sender_id.firstName} ${data.message.sender_id.lastName}`);
  console.log(`   Role: ${data.sender_role}`);
  console.log(`   Type: ${data.message.message_type}`);
  console.log(`   Content: ${data.message.text_content || "[Audio Message]"}`);
  console.log(`   Time: ${new Date(data.message.timestamp).toLocaleTimeString()}\n`);
});

socket.on("messages_loaded", (data) => {
  console.log(`📜 Message History Loaded: ${data.count} messages\n`);
  data.messages.forEach((msg, index) => {
    console.log(`   ${index + 1}. [${msg.sender_role}] ${msg.sender_id.firstName}: ${msg.text_content || "[Audio]"}`);
  });
  console.log("");
});

socket.on("message_status_update", (data) => {
  console.log(`✓ Message Status: ${data.message_id} → ${data.status}\n`);
});

// ============================================
// TYPING INDICATORS
// ============================================
socket.on("user_typing", (data) => {
  console.log(`✍️ ${data.user_name} is typing...\n`);
});

socket.on("user_stop_typing", (data) => {
  console.log(`✍️ ${data.user_name} stopped typing\n`);
});

// ============================================
// AUDIO INDICATORS
// ============================================
socket.on("user_recording_audio", (data) => {
  console.log(`🎤 ${data.user_name} is recording audio...\n`);
});

socket.on("user_stopped_recording", (data) => {
  console.log(`🎤 Recording stopped\n`);
});

// ============================================
// CONVERSATION FLOW
// ============================================
socket.on("joiner_connected", (data) => {
  console.log(`🎉 Joiner Connected: ${data.joiner_name}\n`);
});

socket.on("conversation_ended", (data) => {
  console.log("🛑 Conversation Ended");
  console.log(`   Ended by: ${data.ended_by_role}`);
  console.log(`   Status: ${data.status}\n`);
});

socket.on("summary_ready", (data) => {
  console.log("📄 Summary Ready!");
  console.log(`   Status: ${data.status}\n`);
});

socket.on("solutions_ready", (data) => {
  console.log("✅ Solutions Ready!");
  console.log(`   Number of solutions: ${data.solutions.length}\n`);
});

socket.on("dispute_completed", (data) => {
  console.log("🎉 Dispute Completed!");
  console.log(`   Common solutions: ${data.common_solutions.join(", ")}\n`);
});

// ============================================
// ERROR HANDLING
// ============================================
socket.on("error", (data) => {
  console.error("❌ Error:", data.message, "\n");
});

// ============================================
// INTERACTIVE TESTING (Optional)
// ============================================
import readline from 'readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log("\n📝 Interactive Commands:");
console.log("   Type 'message <text>' to send a message");
console.log("   Type 'typing' to send typing indicator");
console.log("   Type 'stop' to stop typing");
console.log("   Type 'end' to end conversation");
console.log("   Type 'leave' to leave dispute");
console.log("   Type 'exit' to quit\n");

rl.on('line', (input) => {
  const [command, ...args] = input.trim().split(' ');
  
  switch(command) {
    case 'message':
      const text = args.join(' ');
      socket.emit("send_message", {
        dispute_id: DISPUTE_ID,
        text_content: text
      });
      console.log(`📤 Sent: "${text}"\n`);
      break;
      
    case 'typing':
      socket.emit("typing", { dispute_id: DISPUTE_ID });
      console.log("✍️ Typing indicator sent\n");
      break;
      
    case 'stop':
      socket.emit("stop_typing", { dispute_id: DISPUTE_ID });
      console.log("✍️ Stopped typing\n");
      break;
      
    case 'end':
      socket.emit("end_conversation", { dispute_id: DISPUTE_ID });
      console.log("🛑 Ending conversation...\n");
      break;
      
    case 'leave':
      socket.emit("leave_dispute", { dispute_id: DISPUTE_ID });
      console.log("👋 Leaving dispute...\n");
      break;
      
    case 'exit':
      console.log("👋 Goodbye!");
      socket.disconnect();
      process.exit(0);
      break;
    default:
      console.log("Unknown command\n");
  }
});

// Keep script running
process.on('SIGINT', () => {
  console.log("\n👋 Goodbye!");
  socket.disconnect();
  process.exit(0);
});