require("dotenv").config();
const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
const PORT = process.env.PORT || 4000;
const GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`;

if (!GEMINI_KEY) {
  console.error("❌  GEMINI_API_KEY is not set. Add it to your .env file.");
  process.exit(1);
}

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(express.json({ limit: "20mb" })); // prescriptions can be large images
app.use(cors({
  origin: process.env.FRONTEND_URL || "*", // lock down to your Vercel URL in production
  methods: ["POST", "GET"],
}));

// Rate limiting — prevents abuse
// 30 requests per minute per IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "Too many requests. Please wait a minute and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Stricter limit for scan endpoint (image processing is expensive)
const scanLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: "Scan limit reached (10/min). Please wait and try again." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// ── Helper ─────────────────────────────────────────────────────────────────────

async function callGemini(body) {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    const msg = data?.error?.message || `Gemini error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  return data.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("") || "";
}

// ── Routes ─────────────────────────────────────────────────────────────────────

// Health check — Vercel/Railway ping this to confirm the server is alive
app.get("/health", (req, res) => {
  res.json({ status: "ok", model: GEMINI_MODEL, time: new Date().toISOString() });
});

// POST /scan — reads a prescription image
// Body: { image: "<base64 string>", mime: "image/jpeg" }
app.post("/scan", scanLimiter, async (req, res) => {
  const { image, mime } = req.body;

  if (!image || !mime) {
    return res.status(400).json({ error: "Missing image or mime field." });
  }

  if (!mime.startsWith("image/")) {
    return res.status(400).json({ error: "Only image files are supported." });
  }

  // Check base64 size — reject anything over 10MB encoded
  const sizeBytes = Buffer.byteLength(image, "base64");
  if (sizeBytes > 10 * 1024 * 1024) {
    return res.status(400).json({ error: "Image too large. Please use a smaller photo." });
  }

  const prompt = `You are an expert medical transcription AI. Carefully analyze this prescription image.

Return ONLY a valid JSON object, no markdown fences, no extra text:
{
  "patient_name": "string or null",
  "patient_age": "string or null",
  "patient_weight": "string or null",
  "doctor_name": "string or null",
  "hospital": "string or null",
  "date": "string or null",
  "complaints": ["symptom1", "symptom2"],
  "medications": [
    { "name": "string", "dosage": "string or null", "frequency": "string or null", "duration": "string or null", "route": "string or null", "notes": "string or null" }
  ],
  "instructions": "string or null",
  "nebulization": "string or null",
  "follow_up": "string or null",
  "raw_text": "verbatim transcription of all handwritten text",
  "confidence": "high or medium or low",
  "unclear_parts": ["part1"],
  "language_detected": "english or hindi or mixed"
}`;

  try {
    const raw = await callGemini({
      contents: [{
        parts: [
          { inline_data: { mime_type: mime, data: image } },
          { text: prompt },
        ]
      }],
      generationConfig: { maxOutputTokens: 8192, responseMimeType: "application/json" },
    });

    // Parse and validate
    let parsed;
    try {
      const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
      parsed = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: "Could not parse prescription data. Try a clearer image." });
    }

    res.json({ success: true, data: parsed });
  } catch (err) {
    console.error("Scan error:", err.message);
    if (err.status === 429) {
      return res.status(429).json({ error: "Gemini rate limit reached. Wait 60 seconds and try again." });
    }
    res.status(500).json({ error: err.message || "Scan failed." });
  }
});

// POST /search — look up medicine info
// Body: { medicine: "Amoxicillin" }
app.post("/search", async (req, res) => {
  const { medicine } = req.body;
  if (!medicine || typeof medicine !== "string" || medicine.trim().length < 2) {
    return res.status(400).json({ error: "Please provide a medicine name." });
  }

  const name = medicine.trim().slice(0, 100); // cap length

  const prompt = `You are a clinical pharmacist. Provide detailed information about: "${name}"

Return ONLY a valid JSON object, no markdown fences, no extra text:
{
  "brand_names": ["name1", "name2"],
  "generic_name": "string",
  "drug_class": "string",
  "uses": ["use1", "use2"],
  "how_it_works": "string",
  "common_dosage": "string",
  "side_effects": { "common": ["effect1"], "serious": ["effect1"] },
  "contraindications": ["item1"],
  "drug_interactions": ["item1"],
  "warnings": ["item1"],
  "storage": "string",
  "pregnancy_safety": "string",
  "otc_or_prescription": "OTC or Prescription or Both",
  "interesting_fact": "one surprising clinical fact"
}`;

  try {
    const raw = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 4096, responseMimeType: "application/json" },
    });

    let parsed;
    try {
      const clean = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/i, "").trim();
      parsed = JSON.parse(clean);
    } catch {
      return res.status(500).json({ error: "Could not parse medicine data. Try again." });
    }

    // Normalize arrays
    const normalized = {
      ...parsed,
      brand_names:       Array.isArray(parsed.brand_names)       ? parsed.brand_names       : [],
      uses:              Array.isArray(parsed.uses)               ? parsed.uses              : [],
      contraindications: Array.isArray(parsed.contraindications)  ? parsed.contraindications : [],
      drug_interactions: Array.isArray(parsed.drug_interactions)  ? parsed.drug_interactions : [],
      warnings:          Array.isArray(parsed.warnings)           ? parsed.warnings          : [],
      side_effects: {
        common:  Array.isArray(parsed.side_effects?.common)  ? parsed.side_effects.common  : [],
        serious: Array.isArray(parsed.side_effects?.serious) ? parsed.side_effects.serious : [],
      },
    };

    res.json({ success: true, data: normalized });
  } catch (err) {
    console.error("Search error:", err.message);
    if (err.status === 429) {
      return res.status(429).json({ error: "Rate limit reached. Wait 60 seconds and try again." });
    }
    res.status(500).json({ error: err.message || "Search failed." });
  }
});

// POST /ask — answer a question about a prescription
// Body: { prescription: {...}, question: "string" }
app.post("/ask", async (req, res) => {
  const { prescription, question } = req.body;
  if (!prescription || !question || typeof question !== "string") {
    return res.status(400).json({ error: "Missing prescription or question." });
  }

  const q = question.trim().slice(0, 500);

  const prompt = `You are a helpful medical assistant. The patient has this prescription:
${JSON.stringify(prescription, null, 2)}

Patient question: "${q}"

Answer in 2-4 clear, friendly sentences specific to their prescription. Start with a relevant emoji.`;

  try {
    const answer = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1024, responseMimeType: "text/plain" },
    });
    res.json({ success: true, answer: answer.trim() });
  } catch (err) {
    console.error("Ask error:", err.message);
    res.status(500).json({ error: err.message || "Could not get answer." });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅  RxReader backend running on http://localhost:${PORT}`);
  console.log(`   Model: ${GEMINI_MODEL}`);
  console.log(`   Health: http://localhost:${PORT}/health`);
});
