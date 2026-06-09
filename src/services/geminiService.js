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
  } catch (_) {}

  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (_) {}

  const objectMatch = cleaned.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (_) {}
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
    });

    const parts = [];

    // Prompt instructions
    parts.push({
      text: "You are a dispute and conflict analysis helper. Please analyze the provided text description, audio recordings, and any attached images/audio files, and generate a simple, direct, and concise summary explaining strictly the facts of the conflict, the parties involved, and key details. Do NOT perform advanced analysis, do NOT guess emotions/motives, and do NOT make assumptions or deep speculations. Keep it simple and stick to what is directly visible or stated in the inputs."
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

    return result.response.text();
  } catch (error) {
    console.error("Gemini multimodal analysis error:", error);
    throw new Error("Failed to analyze multimodal content using Gemini: " + error.message);
  }
};

