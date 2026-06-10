import fs from "fs";
import genAI from "../utils/gemini.js";
import path from "path";

const getAudioMimeType = (filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".m4a") return "audio/m4a";
  if (ext === ".ogg") return "audio/ogg";
  if (ext === ".webm") return "audio/webm";
  return "audio/mpeg";
};

const parseJsonResponse = (text) => {
  try {
    return JSON.parse(text);
  } catch (_) { }

  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) { }

  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (_) { }
  }

  return null;
};

async function transcribeAudioWithGroq(filePath) {
  if (!process.env.GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY not set");
  }

  const audioBuffer = await fs.promises.readFile(filePath);
  const form = new FormData();
  form.append(
    "file",
    new Blob([audioBuffer], { type: getAudioMimeType(filePath) }),
    path.basename(filePath)
  );
  form.append("model", "whisper-large-v3-turbo");
  form.append("response_format", "verbose_json");
  form.append("language", "en");
  form.append("temperature", "0");

  const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`
    },
    body: form
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq transcription failed (${response.status}): ${errorText}`);
  }

  const data = await response.json();
  return typeof data?.text === "string" ? data.text.trim() : "";
}

export const processAudioWithGemini = async (filePath) => {
  try {
    // 1. Load audio file as base64
    const audioBuffer = fs.readFileSync(filePath);
    const base64Audio = audioBuffer.toString("base64");

    // 2. Choose model
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    // 3. Construct prompt
    const prompt = `
You are an expert conflict analysis system.

Given this audio conversation, provide a detailed JSON response containing:

{
  "transcript": "...",
  "speakers": [
      { "start": "", "end": "", "speaker": "A or B", "text": "" }
  ],
  "issues": [
      { "title": "", "description": "", "severity": 1-10 }
  ],
  "emotions": {
      "person_a": { "dominant": "", "tone": "" },
      "person_b": { "dominant": "", "tone": "" }
  },
  "recommendations": {
      "for_person_a": [...],
      "for_person_b": [...],
      "general": [...]
  },
  "summary": ""
}

Follow this EXACT JSON structure with valid JSON only.
`;

    // 4. Send request to Gemini
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inlineData: {
                mimeType: "audio/mp3",
                data: base64Audio,
              },
            },
          ],
        },
      ],
    });

    // 5. Parse JSON output
    const responseText = result.response.text();

    let jsonOutput;
    try {
      jsonOutput = JSON.parse(responseText);
    } catch (error) {
      console.error("Gemini JSON parse error:", error);
      jsonOutput = { error: "Invalid JSON returned by Gemini", raw: responseText };
    }

    return jsonOutput;

  } catch (err) {
    console.error("Gemini processing error:", err);
    return { error: "Gemini failed to process audio" };
  }
};

export const transcribeAudio = async (filePath) => {
  try {
    const groqTranscript = await transcribeAudioWithGroq(filePath);
    if (groqTranscript) return groqTranscript;
  } catch (error) {
    console.error("Groq transcription error:", error.message);
  }

  try {
    const geminiResult = await processAudioWithGemini(filePath);
    if (typeof geminiResult?.transcript === "string" && geminiResult.transcript.trim()) {
      return geminiResult.transcript.trim();
    }
    if (typeof geminiResult?.raw === "string") {
      const parsed = parseJsonResponse(geminiResult.raw);
      if (typeof parsed?.transcript === "string" && parsed.transcript.trim()) {
        return parsed.transcript.trim();
      }
    }
  } catch (error) {
    console.error("Gemini transcription fallback error:", error.message);
  }

  return null;
};

export const analyzeMultimodalContent = async (summaryText, summaryAudioFile, mediaFiles) => {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-2.5-flash",
      generationConfig: { responseMimeType: "application/json" }
    });

    const parts = [];

    // Prompt instructions
    parts.push({
      text: `You are a dispute and conflict analysis helper. Please analyze the provided text description, audio recordings, and any attached images/audio files together. Generate a SINGLE, unified, and concise summary report that combines all of these inputs into one cohesive situation. Do NOT separate them into different conflict sections. Treat the text description as the primary explanation and the attached files (images/audios) as the supporting evidence/context for that same conflict. Stick strictly to the visible/stated facts and explain the overall situation.

CRITICAL: Your output MUST be in valid JSON conforming to the following structure. Generate fully custom, dynamic, and context-specific values based on your analysis of this specific conflict. Do NOT repeat or copy the example placeholder text verbatim:
{
  "dispute_name": "A short 3-6 word title summarizing the conflict",
  "short_summary": "A very short, one-sentence high-level summary of the overall conflict (maximum 15 words)",
  "conflict_snapshot": {
    "main_disagreement": "Brief description of the main disagreement based on the inputs",
    "core_concerns": {
      "user_side": "Core concern of the user's side",
      "other_side": "Core concern of the other side (from the proof or context)"
    },
    "overall_tone": "Overall tone of conversation (e.g. calm, defensive, angry, misunderstood, tense)"
  },
  "key_insights": [
    "Custom pattern or insight 1 detected from this conversation/evidence",
    "Custom pattern or insight 2 detected from this conversation/evidence"
  ],
  "hidden_tension": "One interesting custom hidden insight or underlying tension not explicitly mentioned in this conflict",
  "what_happens_next": [
    "A custom teaser about identified communication patterns specific to this conflict (e.g., 'I\\'ve identified N communication patterns contributing to this conflict.')",
    "A custom teaser about possible resolution paths specific to this conflict (e.g., 'There are N possible resolution paths based on the conversation.')",
    "A custom teaser about drafting responses or reducing tension specific to this conflict"
  ]
}`
    });

    // 1. Handle summary text if provided
    if (summaryText) {
      parts.push({ text: `Summary Text/Context: ${summaryText}` });
    }

    // Helper to get mime type for all media files (image & audio)
    const getMimeType = (filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
      if (ext === ".png") return "image/png";
      if (ext === ".webp") return "image/webp";
      if (ext === ".gif") return "image/gif";
      if (ext === ".wav") return "audio/wav";
      if (ext === ".m4a") return "audio/m4a";
      if (ext === ".ogg") return "audio/ogg";
      if (ext === ".webm") return "audio/webm";
      if (ext === ".mp3") return "audio/mpeg";
      return "application/octet-stream";
    };

    // 2. Handle summary audio file if provided
    if (summaryAudioFile) {
      console.log(`[analyzeMultimodalContent] Processing summary audio: ${summaryAudioFile.originalname || summaryAudioFile.path}`);
      const audioBuffer = fs.readFileSync(summaryAudioFile.path);
      const base64Audio = audioBuffer.toString("base64");
      const mime = getMimeType(summaryAudioFile.path);
      parts.push({
        inlineData: {
          mimeType: mime,
          data: base64Audio
        }
      });
      parts.push({ text: "The audio above is the primary summary explanation provided by the user." });
    }

    // 3. Handle mediaFiles array
    if (mediaFiles && mediaFiles.length > 0) {
      console.log(`[analyzeMultimodalContent] Processing ${mediaFiles.length} media evidence files.`);
      for (const file of mediaFiles) {
        const mime = getMimeType(file.path);
        console.log(`[analyzeMultimodalContent] -> Loading file: ${file.originalname || file.path} (Mime: ${mime})`);
        const fileBuffer = fs.readFileSync(file.path);
        const base64Data = fileBuffer.toString("base64");
        parts.push({
          inlineData: {
            mimeType: mime,
            data: base64Data
          }
        });
        parts.push({ text: `Above is an attached evidence/media file of type ${mime}.` });
      }
    }

    // Call Gemini
    const result = await model.generateContent({
      contents: [
        {
          role: "user",
          parts: parts
        }
      ]
    });

    const textResponse = result.response.text();
    const parsed = parseJsonResponse(textResponse);
    return parsed || {
      dispute_name: "Multimodal Dispute",
      short_summary: "Dispute Analysis Summary",
      conflict_snapshot: {
        main_disagreement: "Dispute Analysis",
        core_concerns: { user_side: "Not specified", other_side: "Not specified" },
        overall_tone: "Tense"
      },
      key_insights: [],
      hidden_tension: "None detected",
      what_happens_next: []
    };
  } catch (error) {
    console.error("Gemini multimodal analysis error:", error);
    throw new Error("Failed to analyze multimodal content using Gemini: " + error.message);
  }
};