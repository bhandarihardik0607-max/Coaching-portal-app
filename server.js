// server.js
import 'dotenv/config';
import express from "express";
import fetch from "node-fetch";
import cors from "cors";
import bodyParser from "body-parser";
import { createClient } from "@supabase/supabase-js";
import { google } from "googleapis";
import path from 'path';
import { fileURLToPath } from 'url';

// --- Basic Setup ---
const app = express();
const PORT = process.env.PORT || 8080;

// ES Module equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(cors());
app.use(bodyParser.json());
// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));


// ----------- ENV VARS -----------
const {
  META_WABA_TOKEN, META_PHONE_NUMBER_ID, // WhatsApp Cloud API
  SUPABASE_URL, SUPABASE_SERVICE_KEY,    // Storage
  GCP_PROJECT_EMAIL, GCP_PRIVATE_KEY,    // Google service account (Calendar + Sheets)
  CALENDAR_ID, SHEET_ID,                 // Target Calendar & Sheet
  GEMINI_API_KEY                         // AI
} = process.env;

// ----------- FRONTEND ROUTE -----------
// Serve the main HTML file on the root route
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// ----------- WHATSAPP CLOUD API -----------
app.post("/api/whatsapp/send", async (req, res) => {
  if (!META_WABA_TOKEN || !META_PHONE_NUMBER_ID) {
    return res.status(400).json({ ok: false, error: "WhatsApp API credentials are not configured on the server." });
  }
  const { to, text, templateName, templateParams } = req.body;
  try {
    const url = `https://graph.facebook.com/v20.0/${META_PHONE_NUMBER_ID}/messages`;
    const payload = templateName ? {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: templateName,
        language: { code: "en_US" },
        components: templateParams ? [{ type: "body", parameters: templateParams.map(t => ({ type:"text", text:t })) }] : []
      }
    } : {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text }
    };

    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${META_WABA_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----------- SUPABASE SIGNED UPLOAD URL -----------
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
app.post("/api/materials/sign-url", async (req, res) => {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    return res.status(400).json({ ok: false, error: "Supabase credentials are not configured on the server." });
  }
  const { fileName } = req.body;
  try {
    const bucket = "materials";
    // Ensure bucket exists from Supabase dashboard (public read disabled; use signed URLs)
    const { data, error } = await supabase
      .storage
      .from(bucket)
      .createSignedUploadUrl(`${Date.now()}-${fileName}`);

    if (error) throw error;
    res.json({ ok: true, ...data, bucket });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/api/materials/public-url", async (req, res) => {
  const { path } = req.body; // returned after upload
  const { data } = supabase.storage.from("materials").getPublicUrl(path);
  res.json({ ok: true, url: data.publicUrl });
});

// ----------- GOOGLE CALENDAR (service account) -----------
function googleClient() {
  return new google.auth.JWT(
    GCP_PROJECT_EMAIL,
    undefined,
    GCP_PRIVATE_KEY.replace(/\\n/g, "\n"),
    ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/spreadsheets"]
  );
}

app.post("/api/calendar/create", async (req, res) => {
  if (!GCP_PROJECT_EMAIL || !GCP_PRIVATE_KEY || !CALENDAR_ID) {
    return res.status(400).json({ ok: false, error: "Google Calendar credentials are not configured on the server." });
  }
  const { summary, description, startISO, endISO } = req.body;
  try {
    const auth = googleClient();
    const calendar = google.calendar({ version: "v3", auth });
    const { data } = await calendar.events.insert({
      calendarId: CALENDAR_ID,
      requestBody: {
        summary, description,
        start: { dateTime: startISO },
        end: { dateTime: endISO }
      }
    });
    res.json({ ok: true, eventId: data.id, htmlLink: data.htmlLink });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----------- GOOGLE SHEETS APPEND -----------
app.post("/api/sheets/append", async (req, res) => {
  if (!GCP_PROJECT_EMAIL || !GCP_PRIVATE_KEY || !SHEET_ID) {
    return res.status(400).json({ ok: false, error: "Google Sheets credentials are not configured on the server." });
  }
  const { range, values } = req.body; // e.g., range: "Attendance!A:D"
  try {
    const auth = googleClient();
    const sheets = google.sheets({ version: "v4", auth });
    const { data } = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values }
    });
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----------- AI PROXY (Gemini) -----------
app.post("/api/ai/generate", async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(400).json({ ok: false, error: "Gemini API key is not configured on the server." });
  }
  const { prompt } = req.body;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: prompt }] }] })
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    res.json({ ok: true, text });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));