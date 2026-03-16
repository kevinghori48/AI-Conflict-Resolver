import dotenv from "dotenv";
dotenv.config();

console.log("GEMINI KEY:", process.env.GEMINI_API_KEY?.slice(0, 8));