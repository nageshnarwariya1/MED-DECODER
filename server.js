import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI } from '@google/genai';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
// Used only after short retries of the primary model fail with a 503 overload.
const FALLBACK_MODEL = (process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.7-flash').trim();
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.join(DATA_DIR, 'reports.json');
const RETENTION_DAYS = Math.max(1, Number(process.env.REPORT_RETENTION_DAYS || 30));
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const SESSION_COOKIE = 'meddecoder_admin';
const SESSION_HOURS = 8;

fs.mkdirSync(DATA_DIR, { recursive: true });
let ai = null;
if (process.env.GEMINI_API_KEY) {
  ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function readStore() {
  try {
    if (!fs.existsSync(DB_FILE)) return { reports: [] };
    const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return { reports: Array.isArray(parsed.reports) ? parsed.reports : [] };
  } catch (error) {
    console.error('Could not read report store:', error.message);
    return { reports: [] };
  }
}
function writeStore(store) {
  const temp = `${DB_FILE}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(temp, DB_FILE);
}
function pruneExpired() {
  const store = readStore();
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  const kept = store.reports.filter(r => new Date(r.createdAt).getTime() >= cutoff);
  if (kept.length !== store.reports.length) writeStore({ reports: kept });
}
pruneExpired();
setInterval(pruneExpired, 60 * 60_000).unref();

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const supported = new Set([
      'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
      'text/plain', 'text/csv'
    ]);
    if (supported.has(file.mimetype)) return cb(null, true);
    cb(new Error('Unsupported file type. Upload PDF, JPG, JPEG, PNG, WEBP, TXT or CSV.'));
  }
});

const ipCounters = new Map();
function rateLimit({ limit, windowMs, keyPrefix }) {
  return (req, res, next) => {
    const key = `${keyPrefix}:${req.ip}`;
    const now = Date.now();
    const current = ipCounters.get(key);
    if (!current || current.resetAt <= now) {
      ipCounters.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > limit) return res.status(429).json({ error: 'Too many attempts. Please wait a little and try again.' });
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of ipCounters.entries()) if (value.resetAt <= now) ipCounters.delete(key);
}, 60_000).unref();

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}
function readSession(req) {
  const raw = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${SESSION_COOKIE}=`));
  if (!raw) return null;
  const token = decodeURIComponent(raw.slice(SESSION_COOKIE.length + 1));
  const [body, signature] = token.split('.');
  if (!body || !signature || !process.env.SESSION_SECRET) return null;
  const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp < Date.now() || payload.email !== process.env.ADMIN_EMAIL) return null;
    return payload;
  } catch { return null; }
}
function requireAdmin(req, res, next) {
  const session = readSession(req);
  if (!session) return res.status(401).json({ error: 'Admin sign-in required.' });
  res.setHeader('Cache-Control', 'no-store, private');
  res.setHeader('Pragma', 'no-cache');
  req.admin = session;
  next();
}
function setAdminCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${secure}`);
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, aiConfigured: Boolean(ai), model: MODEL, acceptedFormats: ['PDF', 'JPG', 'JPEG', 'PNG', 'WEBP', 'TXT', 'CSV'], maxUploadMB: 15 });
});

app.get('/admin', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

app.post('/api/admin/login', rateLimit({ limit: 6, windowMs: 15 * 60_000, keyPrefix: 'admin-login' }), (req, res) => {
  const { email, password } = req.body || {};
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD || !process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    return res.status(503).json({ error: 'Admin login is not configured. Set ADMIN_EMAIL, ADMIN_PASSWORD and a 32+ character SESSION_SECRET.' });
  }
  if (!safeEqual(String(email || '').trim().toLowerCase(), process.env.ADMIN_EMAIL.trim().toLowerCase()) || !safeEqual(password, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect admin email or password.' });
  }
  const token = signSession({ email: process.env.ADMIN_EMAIL, exp: Date.now() + SESSION_HOURS * 3600_000 });
  setAdminCookie(res, token);
  res.json({ ok: true, email: process.env.ADMIN_EMAIL });
});
app.get('/api/admin/me', requireAdmin, (req, res) => res.json({ ok: true, email: req.admin.email }));
app.post('/api/admin/logout', requireAdmin, (_req, res) => {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`);
  res.json({ ok: true });
});
app.get('/api/admin/reports', requireAdmin, (_req, res) => {
  pruneExpired();
  const reports = readStore().reports
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(r => ({ id: r.id, createdAt: r.createdAt, fileName: r.fileName, reportType: r.reportType, language: r.language, testCount: r.tests?.length || 0, flaggedCount: r.tests?.filter(t => ['high', 'low'].includes(t.status)).length || 0, confidence: r.confidence }));
  res.json({ reports, retentionDays: RETENTION_DAYS });
});
app.get('/api/admin/reports/:id', requireAdmin, (req, res) => {
  const report = readStore().reports.find(r => r.id === req.params.id);
  if (!report) return res.status(404).json({ error: 'Report not found or expired.' });
  res.json({ report });
});
app.delete('/api/admin/reports/:id', requireAdmin, (req, res) => {
  const store = readStore();
  const next = store.reports.filter(r => r.id !== req.params.id);
  if (next.length === store.reports.length) return res.status(404).json({ error: 'Report not found.' });
  writeStore({ reports: next });
  res.json({ ok: true });
});

function extractJson(text) {
  const trimmed = String(text || '').trim();
  try { return JSON.parse(trimmed); } catch {}
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
  throw new Error('AI returned an unreadable response. Please try a clearer scan.');
}
function numeric(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (match) return Number(match[0]);
  }
  return null;
}
function computeStatus(test) {
  const value = numeric(test.value);
  const low = numeric(test.referenceLow);
  const high = numeric(test.referenceHigh);
  if (value === null || (low === null && high === null)) return 'review';
  if (low !== null && value < low) return 'low';
  if (high !== null && value > high) return 'high';
  return 'normal';
}
function cleanReport(raw, fileType, language) {
  const tests = (Array.isArray(raw.tests) ? raw.tests : []).slice(0, 100).map((t, i) => {
    const item = {
      id: `test-${i + 1}`,
      name: String(t.name || `Test ${i + 1}`).slice(0, 100),
      value: String(t.value ?? 'Not read').slice(0, 80),
      unit: String(t.unit || '').slice(0, 40),
      referenceRange: String(t.referenceRange || 'Not clearly visible on report').slice(0, 100),
      referenceLow: numeric(t.referenceLow),
      referenceHigh: numeric(t.referenceHigh),
      explanation: String(t.explanation || 'Please verify this item against the original report.').slice(0, 800),
      possibleMeaning: String(t.possibleMeaning || 'This result needs interpretation in the context of your health and other tests.').slice(0, 800),
      confidence: Math.max(0, Math.min(100, numeric(t.confidence) ?? 50)),
    };
    item.status = computeStatus(item);
    return item;
  });
  if (!tests.length) throw new Error('No test values could be extracted. Please upload a clearer report image or PDF.');
  const modelConfidence = Math.max(0, Math.min(100, numeric(raw.confidence) ?? (tests.reduce((sum, t) => sum + t.confidence, 0) / tests.length)));
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    fileName: fileType === 'application/pdf' ? 'PDF upload' : fileType.startsWith('image/') ? 'Image upload' : 'Text data upload',
    language,
    reportType: String(raw.reportType || 'Laboratory report').slice(0, 80),
    summary: String(raw.summary || 'The report has been read. Review each value and its reference range below.').slice(0, 1600),
    keyFindings: stringArray(raw.keyFindings, 8),
    tests,
    questionsForDoctor: stringArray(raw.questionsForDoctor, 8),
    medicineQuestions: stringArray(raw.medicineQuestions, 6),
    dietQuestions: stringArray(raw.dietQuestions, 6),
    nextStepQuestions: stringArray(raw.nextStepQuestions, 6),
    limitations: stringArray(raw.limitations, 6),
    confidence: Math.round(modelConfidence)
  };
}
function stringArray(value, max) {
  return (Array.isArray(value) ? value : []).slice(0, max).map(x => String(x).slice(0, 500));
}

function providerStatus(error) {
  const candidates = [error?.status, error?.code, error?.response?.status, error?.error?.code];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 400 && value <= 599) return value;
  }
  const message = String(error?.message || error || '');
  const match = message.match(/\b(429|500|502|503|504)\b/);
  return match ? Number(match[1]) : null;
}
function isOverload(error) {
  const status = providerStatus(error);
  const message = String(error?.message || error || '');
  return status === 503 || /UNAVAILABLE|high demand|temporarily overloaded|service unavailable|capacity/i.test(message);
}
function friendlyProviderError(error) {
  const status = providerStatus(error);
  if (isOverload(error)) {
    return { status: 503, message: 'The AI service is temporarily busy. Your file is still selected and no analysis was saved. Please wait 30–60 seconds, then click Analyse report again.' };
  }
  if (status === 429 || /RESOURCE_EXHAUSTED|quota exceeded|rate.?limit/i.test(String(error?.message || error || ''))) {
    return { status: 429, message: 'The AI service request limit has been reached. Please wait a few minutes and try again, or check the Gemini API quota for this project.' };
  }
  if (status === 401 || status === 403) {
    return { status: 502, message: 'The AI service rejected the server API key. The website administrator must check GEMINI_API_KEY in the server environment.' };
  }
  return { status: 502, message: 'The AI service could not complete this request. Please try a smaller, clearer report. If the problem continues, the website administrator should check the server logs.' };
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function generateWithRetry(request) {
  const models = [MODEL];
  if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL) models.push(FALLBACK_MODEL);
  let lastError;
  for (const model of models) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await ai.models.generateContent({ ...request, model });
      } catch (error) {
        lastError = error;
        if (!isOverload(error)) throw error;
        if (attempt < 2) {
          const delayMs = [1200, 2800][attempt] + Math.floor(Math.random() * 400);
          console.warn(`Gemini model ${model} returned 503; retry ${attempt + 1}/2 in ${delayMs}ms.`);
          await wait(delayMs);
        }
      }
    }
    if (models.length > 1) console.warn(`Gemini model ${model} remained overloaded; trying configured fallback if available.`);
  }
  throw lastError || new Error('Gemini service unavailable');
}

const analysisLimiter = rateLimit({ limit: 8, windowMs: 60 * 60_000, keyPrefix: 'analysis' });
app.post('/api/analyze', analysisLimiter, upload.single('report'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Please choose a report file first.' });
    if (req.body.consent !== 'yes') return res.status(400).json({ error: 'Please read and accept the privacy notice before analysis.' });
    if (!ai) return res.status(503).json({ error: 'AI analysis is not configured yet. Add GEMINI_API_KEY to your .env file and restart the server. You can still try the sample report.' });
    const language = ['en', 'hi', 'mr'].includes(req.body.language) ? req.body.language : 'en';
    const languageName = ({ en: 'simple English', hi: 'simple Hindi (हिंदी)', mr: 'simple Marathi (मराठी)' })[language];
    const textTypes = ['text/plain', 'text/csv'];
    const parts = [];
    if (textTypes.includes(req.file.mimetype)) {
      parts.push({ text: `Uploaded report text:\n${req.file.buffer.toString('utf8').slice(0, 45000)}` });
    } else {
      parts.push({ inlineData: { mimeType: req.file.mimetype, data: req.file.buffer.toString('base64') } });
    }
    parts.push({ text: `You are Med-Decoder, a careful medical laboratory report reading and health-literacy assistant. Read the attached report and return ONLY valid JSON matching this schema:
{
 "reportType": "short report type",
 "summary": "2-4 short sentences in ${languageName}, understandable to a non-medical reader",
 "keyFindings": ["plain-language finding"],
 "tests": [{"name":"test name","value":"exact value as printed","unit":"unit","referenceRange":"exact range as printed or Not printed","referenceLow":number|null,"referenceHigh":number|null,"explanation":"simple explanation in ${languageName}","possibleMeaning":"careful educational context in ${languageName}; do not diagnose","confidence":number 0-100}],
 "questionsForDoctor": ["specific question about the report"],
 "medicineQuestions": ["questions to ask the doctor about whether medicine is needed, purpose, risks, interactions, dose and duration; never name or prescribe a medicine"],
 "dietQuestions": ["questions to ask the doctor/dietitian about diet, hydration, restrictions, allergies and portions; do not prescribe a personalized diet"],
 "nextStepQuestions": ["questions about repeat tests, follow-up timing and what symptoms should prompt medical review"],
 "limitations": ["unclear items, missing reference ranges, scan issues or relevant uncertainty"],
 "confidence": number 0-100
}
Important rules:
- Extract only laboratory tests and report information. Do not return patient name, address, phone, email, Aadhaar, medical record number, QR/barcodes or other identifiers. Do not include patient identifiers anywhere in the output.
- Preserve every numeric result and unit exactly as shown. Never invent a missing value, unit, reference interval, date or test.
- referenceLow and referenceHigh must be numbers only when explicit numeric bounds are printed for that test. Otherwise use null. Do not substitute generic ranges from memory.
- status will be calculated by the server strictly from the printed bounds; never assume high/low when a report range is absent.
- Do not diagnose, predict disease, prescribe medicines, recommend dose changes, or give a personalized treatment or diet plan. Explain findings as educational context only.
- If handwriting, scan quality, or any value is unclear, say it is unclear and reduce confidence. Never guess silently.
- Use simple ${languageName}; retain medical test names and units with simple explanations.
- Return a short list of tailored questions for the clinician, including medication/diet/follow-up questions where relevant.
- Confidence is only a model estimate of how well the document was read, NOT a validated diagnostic or clinical accuracy rate. Be conservative.
- If this is not a laboratory report, return an empty tests array and explain that the file is not supported.
` });
    const response = await generateWithRetry({
      contents: [{ role: 'user', parts }],
      config: { responseMimeType: 'application/json', temperature: 0.1 }
    });
    const raw = extractJson(response.text);
    const report = cleanReport(raw, req.file.mimetype, language);
    report.tests = report.tests.map(test => ({ ...test, status: computeStatus(test) }));
    report.flaggedCount = report.tests.filter(t => ['high', 'low'].includes(t.status)).length;
    // Original upload is processed in memory only. Only the de-identified interpretation is retained.
    const store = readStore();
    store.reports.push(report);
    store.reports = store.reports.slice(-2000);
    writeStore(store);
    res.json({ report });
  } catch (error) {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is larger than 15 MB. Please compress it or upload a clearer, smaller copy.' });
    console.error('Report analysis error:', error);
    const friendly = friendlyProviderError(error);
    res.status(friendly.status).json({ error: friendly.message });
  }
});

app.post('/api/assistant', rateLimit({ limit: 30, windowMs: 60 * 60_000, keyPrefix: 'assistant' }), async (req, res) => {
  const { message, language = 'en', reportContext = null, mode = 'support' } = req.body || {};
  if (typeof message !== 'string' || !message.trim() || message.length > 2000) return res.status(400).json({ error: 'Please enter a message (up to 2,000 characters).' });
  if (!ai) return res.status(503).json({ error: 'AI assistant is not configured. Add GEMINI_API_KEY to the server environment.' });
  const languageName = ({ en: 'simple English', hi: 'simple Hindi', mr: 'simple Marathi' })[language] || 'simple English';
  const contextText = reportContext ? JSON.stringify({ reportType: reportContext.reportType, summary: reportContext.summary, tests: (reportContext.tests || []).slice(0, 40).map(t => ({ name: t.name, value: t.value, unit: t.unit, range: t.referenceRange, status: t.status, explanation: t.explanation })) }) : 'No report is attached to this chat.';
  const systemInstruction = `You are Med-Decoder's friendly ${mode === 'support' ? 'website support and health-literacy' : 'report explanation'} assistant. Reply in ${languageName}, using short clear language suitable for a non-medical reader. If a report context is supplied, answer about that report only and distinguish its printed results from general educational information. Never diagnose, prescribe, recommend starting/stopping/changing medication, or create a personalized treatment/diet plan. For medication, diet and next steps, give questions the user can ask their qualified doctor or dietitian. Never claim a reading is certainly accurate. If the user reports severe symptoms such as chest pain, severe breathing difficulty, fainting or sudden weakness, advise urgent medical care. If the user asks how to use the site, explain upload, supported formats, privacy notice and PDF save. Do not request personal identifiers.`;
  try {
    const response = await generateWithRetry({
      contents: `Report context (may be empty): ${contextText}\n\nUser message: ${message.trim()}`,
      config: { systemInstruction, temperature: 0.25 }
    });
    res.json({ reply: response.text || 'I could not form a clear reply. Please try asking in another way.' });
  } catch (error) {
    console.error('Assistant error:', error.message);
    const friendly = friendlyProviderError(error);
    res.status(friendly.status).json({ error: friendly.message });
  }
});

app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is larger than 15 MB. Please compress it or upload a smaller copy.' });
  if (String(error.message || '').startsWith('Unsupported file type')) return res.status(415).json({ error: error.message });
  console.error('Request error:', error);
  return res.status(400).json({ error: 'The request could not be processed. Please check the file and try again.' });
});

function startServer(port, host = '0.0.0.0', attempt = 0) {
  const maxAttempts = 20;
  const server = app.listen(port, host, () => {
    console.log(`Med-Decoder is running on http://localhost:${port}`);
    console.log(`AI configured: ${Boolean(ai)} | Model: ${MODEL} | Fallback: ${FALLBACK_MODEL || 'disabled'} | Data: ${DATA_DIR}`);
  });

  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      if (attempt >= maxAttempts) {
        console.error(`Port ${port} is unavailable and all fallback ports (${port}..${port + maxAttempts}) are in use. Please free a port or set PORT to a different value.`);
        process.exit(1);
      }
      const nextPort = port + 1;
      console.warn(`Port ${port} is already in use. Retrying on ${nextPort}...`);
      startServer(nextPort, host, attempt + 1);
      return;
    }
    throw error;
  });
}

const requestedPort = Number.isFinite(Number(process.env.PORT)) && Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000;
startServer(requestedPort);
