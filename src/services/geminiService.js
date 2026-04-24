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
