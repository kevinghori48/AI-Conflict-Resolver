import { GoogleGenerativeAI } from "@google/generative-ai";
import Chat from "../models/Chat.js";
import Report from "../models/Report.js";

// =============================
// CONFIG: GEMINI INSTANCE
// =============================
const getGeminiModel = () => {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  // We force JSON output to handle the "Conditional Summary" cleanly
  return genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    generationConfig: { responseMimeType: "application/json" }
  });
};

// =============================
// HELPER: SAFE JSON PARSER
// =============================
function safeJSONParse(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  } catch {
    return null;
  }
}

// =============================
// 1. SEND MESSAGE (Batch Phase Logic)
// =============================
export const sendMessage = async (req, res) => {
  try {
    const { report_id, message } = req.body;
    const user_id = req.user._id;

    if (!report_id || !message) return res.status(400).json({ message: "Report ID and message are required" });

    // 1. Fetch Data
    const report = await Report.findById(report_id);
    if (!report) return res.status(404).json({ message: "Report not found" });

    let chat = await Chat.findOne({ user_id, report_id });
    // Initialize with empty phases array
    if (!chat) chat = await Chat.create({ user_id, report_id, messages: [], phases: [] });

    // 2. Add User Message (Working Memory)
    chat.messages.push({ role: "user", content: message });

    // ====================================================
    // THE "PHASE END" DETECTOR
    // ====================================================
    // We want a summary after every 5 exchanges (10 messages).
    // Current length is odd (e.g., 9) because we just added the User message.
    // The NEXT message (AI reply) will make it even (10).
    // So if length is 9, 19, 29... we are at the end of a phase.
    const isPhaseEnd = (chat.messages.length % 10 === 9);
    const currentPhaseNum = Math.ceil(chat.messages.length / 10);

    // ====================================================
    // CONTEXT ASSEMBLY
    // ====================================================
    // A. Long-Term Memory (Completed Phases)
    const phasesHistory = chat.phases
        .map(p => `[PHASE ${p.phase_number} SUMMARY]: ${p.summary}`)
        .join("\n\n");

    // B. Short-Term Memory (Sliding Window)
    // Always show the last 20 messages so the AI has immediate context
    const recentHistory = chat.messages
        .slice(-10)
        .map(m => `${m.role === "user" ? "User" : "AI"}: ${m.content}`)
        .join("\n");

    const reportContext = report.chat_context || "No background context.";

    let taskInstructions = `
      1. Analyze the USER'S MESSAGE ("${message}").
      2. Generate a tactical REPLY (1-2 sentences).
      3. "phase_summary" field should be NULL (do not summarize yet).
    `;

    // IF 10th TURN: We inject extra instructions to summarize the block
    if (isPhaseEnd) {
        taskInstructions = `
      1. Analyze the USER'S MESSAGE ("${message}").
      2. Generate a tactical REPLY (1-2 sentences).
      3. CRITICAL: This is the end of Phase ${currentPhaseNum}.
         You MUST summarize the last 5 exchanges (the content in RECENT MESSAGES) into the "phase_summary" field.
         Focus on key decisions, emotional shifts, and the result of this block.
    `;
    }

    const prompt = `
      ROLE: You are an elite Crisis Negotiator.
      
      === STATIC CONTEXT ===
      ${reportContext}
      
      === PREVIOUS COMPLETED PHASES ===
      ${phasesHistory || "Start of conversation (No phases yet)."}
      
      === RECENT MESSAGES (Current Phase) ===
      ${recentHistory}
      
      TASK:
      ${taskInstructions}
      
      OUTPUT JSON FORMAT:
      {
        "reply": "response text...",
        "phase_summary": "Summary text ONLY if requested, otherwise null"
      }
    `;

    // 3. Single Gemini Call
    const model = getGeminiModel();
    const result = await model.generateContent(prompt);
    const parsedOutput = safeJSONParse(result.response.text());

    const aiReply = parsedOutput?.reply || "I'm listening.";

    // 4. Save AI Reply
    chat.messages.push({ role: "model", content: aiReply });

    // 5. Handle Phase Summary (If Gemini generated one)
    let newPhase = null;
    if (isPhaseEnd && parsedOutput?.phase_summary) {
        newPhase = {
            phase_number: currentPhaseNum,
            summary: parsedOutput.phase_summary
        };
        chat.phases.push(newPhase);
        console.log(`Phase ${currentPhaseNum} Complete. Summary Saved.`);
    }

    await chat.save();

    // 6. WebSocket Broadcast
    const io = req.app.get("io");
    if (io) {
      io.to(report_id).emit("receive_message", {
        role: "model",
        content: aiReply,
        chat_id: chat._id,
        timestamp: new Date()
      });
    }

    return res.json({
      message: "Reply generated",
      reply: aiReply,
      chat_id: chat._id,
      phase_completed: newPhase // Send to frontend to show a "Phase Complete" badge
    });

  } catch (err) {
    console.error("Chat Error:", err);
    res.status(500).json({ message: "Failed to generate reply" });
  }
};

// =============================
// 2. GET CHAT HISTORY
// =============================
export const getChatHistory = async (req, res) => {
  try {
    const { report_id } = req.params;
    const chat = await Chat.findOne({ user_id: req.user._id, report_id });
    
    if (!chat) return res.json({ messages: [], phases: [] });
    
    res.json({ 
        messages: chat.messages, 
        phases: chat.phases // Return the list of phase summaries
    });
  } catch (err) {
    console.error("Get History Error:", err);
    res.status(500).json({ message: "Failed to fetch history" });
  }
};

// =============================
// 3. DELETE CHAT HISTORY
// =============================
export const deleteChatHistory = async (req, res) => {
  try {
    const { report_id } = req.params;
    const user_id = req.user._id;

    await Chat.findOneAndDelete({ user_id, report_id });
    res.json({ message: "Chat history cleared successfully" });
  } catch (err) {
    console.error("Delete Chat Error:", err);
    res.status(500).json({ message: "Failed to clear chat history" });
  }
};