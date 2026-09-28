// Local API for the draw UI. Holds the RandomDraws credentials server-side,
// reads the entries/prize CSVs and runs draws through api.randomdraws.com.
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.RD_BASE_URL || 'https://api.randomdraws.com/').replace(/\/?$/, '/');
const DEFAULT_ENTRIES_FILE = path.resolve(ROOT, process.env.ENTRIES_FILE || 'll-entries.csv');
// Where uploads/ and data/ live. On a host, point this at a persistent disk.
const DATA_DIR = path.resolve(ROOT, process.env.DATA_DIR || '.');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const ACTIVE_FILE = path.join(UPLOAD_DIR, 'active.json'); // remembers the uploaded file across restarts
const UPLOAD_PASSCODE = process.env.UPLOAD_PASSCODE || '';
const DRAW_META_FILE = path.join(DATA_DIR, 'data', 'draws.json');
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // RandomDraws upload limit
const PRIZE_FILE = path.resolve(ROOT, process.env.PRIZE_FILE || 'll-prize.csv');
const PORT = Number(process.env.PORT || 5174);
// Localhost only by default; a host like Render sets HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';
// Optional sign-in for the whole site (page and API), required when hosted
const APP_USER = process.env.APP_USER || '';
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const TEST_MODE_MAX_ENTRIES = 20; // RandomDraws test mode limit

if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !(APP_USER && APP_PASSWORD)) {
  console.error('APP_USER and APP_PASSWORD must be set when the app is reachable from other machines');
  process.exit(1);
}

if (!process.env.RD_EMAIL || !process.env.RD_PASSWORD) {
  console.error('RD_EMAIL and RD_PASSWORD must be set in server/.env or the host environment');
  process.exit(1);
}

// ---------- CSV data ----------

let entriesFile = DEFAULT_ENTRIES_FILE;
try {
  const saved = JSON.parse(fs.readFileSync(ACTIVE_FILE, 'utf8')).file;
  const p = path.join(UPLOAD_DIR, path.basename(saved));
  if (fs.existsSync(p)) entriesFile = p;
} catch {
  /* no uploaded file yet */
}

const readLines = (file) =>
  fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');

let data = null;

function parseEntries(file) {
  const lines = readLines(file);
  if (lines.length === 0) throw new ApiError(400, 'The file is empty');
  const header = lines[0].split(',').map((h) => h.trim());
  const cardCol = header.findIndex((h) => /reward_card_id/i.test(h));
  if (cardCol < 0) throw new ApiError(400, 'The header row must include a Reward_Card_ID column');
  const rows = lines.slice(1);
  if (rows.length < 2) throw new ApiError(400, 'The file needs at least 2 entries');
  if (rows.length > 20_000_000) throw new ApiError(400, 'RandomDraws allows at most 20,000,000 entries');
  const cards = new Array(rows.length);
  const counts = new Map();
  for (let i = 0; i < rows.length; i++) {
    const card = rows[i].split(',')[cardCol]?.trim();
    cards[i] = card;
    counts.set(card, (counts.get(card) || 0) + 1);
  }
  const blanks = cards.filter((c) => !c).length;
  if (blanks) throw new ApiError(400, `${blanks.toLocaleString()} rows have no Reward_Card_ID`);
  return { header: lines[0], headerCols: header, rows, cards, counts };
}

const EMPTY_ENTRIES = { header: '', headerCols: [], rows: [], cards: [], counts: new Map() };

function loadData() {
  const stat = fs.existsSync(entriesFile) ? fs.statSync(entriesFile) : null;
  const mtimeMs = stat ? stat.mtimeMs : 0;
  if (data && data.file === entriesFile && data.mtimeMs === mtimeMs) return data;

  // No file yet: start empty and wait for an upload
  const { header, headerCols, rows, cards, counts } = stat ? parseEntries(entriesFile) : EMPTY_ENTRIES;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

  const prizeLines = readLines(PRIZE_FILE);
  const ph = prizeLines[0].split(',').map((h) => h.trim().toLowerCase());
  const col = (name) => ph.indexOf(name);
  const prizeRows = prizeLines.slice(1).map((l) => l.split(','));
  const prizes = prizeRows
    .filter((r) => r[col('isreserve')]?.trim() !== '1')
    .map((r) => ({
      id: Number(r[col('id')]),
      description: r[col('description')].replace(/^"|"$/g, '').trim(),
      quantity: Number(r[col('quantity')] || 1),
      reserves: 0,
    }));
  // Optional reserve rows ("Reserve: <prize>") attach to the matching prize
  for (const r of prizeRows.filter((r) => r[col('isreserve')]?.trim() === '1')) {
    const desc = r[col('description')].replace(/^"|"$/g, '').replace(/^Reserve:\s*/i, '').trim();
    const p = prizes.find((x) => x.description === desc) || prizes[0];
    if (p) p.reserves += Number(r[col('quantity')] || 0);
  }

  data = {
    file: entriesFile,
    mtimeMs,
    header,
    headerCols,
    rows,
    cards,
    counts,
    summary: {
      entriesFile: stat ? path.basename(entriesFile) : null,
      isUpload: entriesFile !== DEFAULT_ENTRIES_FILE,
      defaultFile: path.basename(DEFAULT_ENTRIES_FILE),
      sizeBytes: stat ? stat.size : 0,
      entries: rows.length,
      uniqueCards: counts.size,
      topCards: top.map(([card, entries]) => ({ card, entries })),
      prizes,
    },
  };
  console.log(stat ? `Loaded ${rows.length.toLocaleString()} entries, ${counts.size.toLocaleString()} cards` : 'No entries file yet: upload one from the page');
  return data;
}

const randInt = (n) => crypto.randomInt(n);

function sampleIndexes(n, k) {
  const picked = new Set();
  while (picked.size < Math.min(k, n)) picked.add(randInt(n));
  return [...picked];
}

// ---------- RandomDraws client ----------

const tokens = {}; // mode -> { token, exp }

async function getToken(mode) {
  const cached = tokens[mode];
  if (cached && cached.exp - Date.now() > 120_000) return cached.token;
  const res = await fetch(BASE + 'tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.RD_EMAIL,
      password: process.env.RD_PASSWORD,
      testMode: mode === 'test',
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.message || 'Authentication failed');
  const payload = JSON.parse(Buffer.from(body.token.split('.')[1], 'base64url').toString());
  tokens[mode] = { token: body.token, exp: payload.exp * 1000 };
  return body.token;
}

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function rd(mode, method, route, { json, form } = {}) {
  const headers = { Authorization: 'Bearer ' + (await getToken(mode)) };
  let body;
  if (json) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }
  const res = await fetch(BASE + route, { method, headers, body });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { message: text };
  }
  if (!res.ok) throw new ApiError(res.status, parsed.message || `RandomDraws returned ${res.status}`);
  return parsed;
}

// ---------- Routes ----------

const app = express();

// Health check for the host; answers before sign-in and reveals nothing
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Browser sign-in (HTTP Basic) for everything when APP_USER/APP_PASSWORD are set
if (APP_USER && APP_PASSWORD) {
  const expected = Buffer.from(`${APP_USER}:${APP_PASSWORD}`);
  app.use((req, res, next) => {
    const [scheme, value] = String(req.get('authorization') || '').split(' ');
    const given = scheme === 'Basic' ? Buffer.from(value || '', 'base64') : Buffer.alloc(0);
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Basic realm="Rewards Prize Draw", charset="UTF-8"').status(401).send('Sign in required');
  });
}

app.use(express.json());

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    console.error(err.status ? `${err.status} ${err.message}` : err);
    const send = () => res.status(err.status && err.status < 600 ? err.status : 500).json({ message: err.message });
    // Browsers report "Failed to fetch" if we answer before an upload body is fully sent
    if (!req.complete && !req.destroyed) {
      req.resume();
      req.once('end', send);
    } else send();
  });

app.get('/api/summary', wrap(async (req, res) => res.json(loadData().summary)));

// Random entries to label the wheel segments with
app.get('/api/sample', wrap(async (req, res) => {
  const d = loadData();
  const n = Math.max(2, Math.min(Number(req.query.n) || 72, 360));
  res.json(sampleIndexes(d.cards.length, n).map((i) => d.cards[i]));
}));

app.get('/api/account', wrap(async (req, res) => {
  const mode = req.query.mode === 'live' ? 'live' : 'test';
  const a = await rd(mode, 'GET', 'account');
  res.json({ mode, remainingCredits: a.remainingCredits, creditsExpiry: a.creditsExpiry || null });
}));

// Per-draw details needed to map winners back to the entries file later,
// e.g. when a scheduled draw is revealed after a restart or a new upload.
function readDrawMeta() {
  try {
    return JSON.parse(fs.readFileSync(DRAW_META_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveDrawMeta(drawId, meta) {
  fs.mkdirSync(path.dirname(DRAW_META_FILE), { recursive: true });
  const all = readDrawMeta();
  all[drawId] = meta;
  fs.writeFileSync(DRAW_META_FILE, JSON.stringify(all));
}

const modeOf = (req) => ((req.body?.mode || req.query.mode) === 'live' ? 'live' : 'test');

function listItem(draw, mode) {
  return {
    mode,
    drawId: draw.id,
    drawNumber: draw.drawNumber,
    name: draw.name,
    state: draw.state,
    isTest: !!draw.isTest,
    entriesDrawnFrom: draw.entrantCount,
    scheduleDate: draw.scheduleDate,
    dateCreated: draw.dateCreated,
    dateDrawn: draw.dateDrawn,
    certificateUrl: draw.certificateUrl || null,
    emptyRowCount: draw.emptyRowCount ?? 0,
    warnings: draw.warnings || [],
    ...draftFile(draw.id),
  };
}

// Which local file a draft was made from, and how many rows it had here
function draftFile(drawId) {
  const meta = readDrawMeta()[drawId];
  return meta ? { entriesFile: meta.file, localEntries: meta.localEntries ?? null } : {};
}

function formatDraw(draw, mode) {
  const d = loadData();
  const meta = readDrawMeta()[draw.id] || {};
  const headerCols = meta.headerCols || d.headerCols;
  const cardCol = headerCols.findIndex((h) => /reward_card_id/i.test(h));
  const oidCol = headerCols.findIndex((h) => /^oid$/i.test(h));
  // Entry counts only make sense against the file the draw was made from
  const sameFile = meta.file === path.basename(entriesFile);
  const prizes = (draw.prizes || []).map((p) => ({
    id: p.id,
    description: p.description,
    isReserve: /^reserve:/i.test(p.description),
    winners: (p.winners || []).map((w) => {
      const cols = w.text.split(',');
      const card = cols[cardCol]?.trim();
      return {
        row: w.row,
        // Row number within the entries file (1 = first entry after header)
        entryNo: meta.rowMap ? meta.rowMap[w.sourceRow - 1] + 1 : w.sourceRow,
        oid: cols[oidCol]?.trim(),
        card,
        cardEntries: sameFile ? d.counts.get(card) || 0 : null,
      };
    }),
  }));
  return {
    ...listItem(draw, mode),
    entriesFile: meta.file || null,
    certificateUrl: draw.certificateUrl,
    winnersTruncated: draw.winnersTruncated,
    prizes,
  };
}

function parseScheduleDate(value) {
  if (!value) return null;
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) throw new ApiError(400, 'Invalid schedule date');
  if (when.getTime() < Date.now() + 60_000) throw new ApiError(400, 'Schedule time must be at least 1 minute from now');
  return when.toISOString().replace(/\.\d+Z$/, 'Z');
}

// Upload the current entries file and create an unconfirmed (draft) draw.
// Drafts use no credit and can be checked, then drawn, scheduled or deleted.
async function createDraft(mode, name) {
  const d = loadData();
  if (d.rows.length === 0) throw new ApiError(400, 'No entries file is loaded. Upload one first.');

  // Test mode only accepts 20 entries, so a larger file is cut down to a random
  // 20-row subset. Otherwise the entries file is uploaded untouched.
  let uploadPath = entriesFile;
  let rowMap = null;
  if (mode === 'test' && d.rows.length > TEST_MODE_MAX_ENTRIES) {
    rowMap = sampleIndexes(d.rows.length, TEST_MODE_MAX_ENTRIES);
    uploadPath = path.join(os.tmpdir(), `ll-test-entries-${Date.now()}.csv`);
    fs.writeFileSync(uploadPath, [d.header, ...rowMap.map((i) => d.rows[i])].join('\r\n') + '\r\n');
  }

  try {
    const form = new FormData();
    form.append('file', await fs.openAsBlob(uploadPath, { type: 'text/csv' }), path.basename(uploadPath));
    const { filename } = await rd(mode, 'POST', 'upload', { form });

    const { drawId } = await rd(mode, 'POST', 'draws', {
      json: {
        name,
        organisation: 'Liquor Legends',
        uploadFilename: filename,
        headerRowsIncluded: true,
        isScheduled: false,
        timezone: 'Australia/Sydney',
        prizes: d.summary.prizes,
      },
    });
    saveDrawMeta(drawId, {
      mode,
      file: path.basename(entriesFile),
      localEntries: d.rows.length,
      headerCols: d.headerCols,
      rowMap,
    });
    return drawId;
  } finally {
    if (rowMap) fs.rm(uploadPath, () => {});
  }
}

// Confirm a draft: schedule it, or draw it now and wait for the result
async function confirmDraw(mode, drawId, scheduleDate) {
  const current = await rd(mode, 'GET', `draws/${drawId}`);
  if (current.state !== 'draft') throw new ApiError(409, `This draw is already ${current.state}`);
  await rd(mode, 'PUT', `draws/${drawId}`, {
    json: scheduleDate ? { isScheduled: true, scheduleDate } : { isScheduled: false },
  });

  let draw = await rd(mode, 'POST', `draws/${drawId}`);
  if (scheduleDate) {
    if (draw.state !== 'scheduled') throw new ApiError(502, `Draw ended in state "${draw.state}"`);
    return listItem(draw, mode);
  }
  for (let i = 0; i < 30 && !['drawn', 'error', 'cancelled'].includes(draw.state); i++) {
    await new Promise((r) => setTimeout(r, 2000));
    draw = await rd(mode, 'GET', `draws/${drawId}`);
  }
  if (draw.state !== 'drawn') throw new ApiError(502, `Draw ended in state "${draw.state}"`);
  return formatDraw(draw, mode);
}

const drawName = (req) => String(req.body.name || 'Liquor Legends Rewards Draw').slice(0, 50);

// Step 1: create a draft from the current entries file
app.post('/api/drafts', wrap(async (req, res) => {
  const mode = modeOf(req);
  const drawId = await createDraft(mode, drawName(req));
  res.json(listItem(await rd(mode, 'GET', `draws/${drawId}`), mode));
}));

// Step 2: draw a draft now, or schedule it when scheduleDate (ISO string) is given
app.post('/api/draws/:id/confirm', wrap(async (req, res) => {
  const mode = modeOf(req);
  const scheduleDate = parseScheduleDate(req.body.scheduleDate);
  res.json(await confirmDraw(mode, req.params.id, scheduleDate));
}));

// Both steps in one call
app.post('/api/draw', wrap(async (req, res) => {
  const mode = modeOf(req);
  const scheduleDate = parseScheduleDate(req.body.scheduleDate);
  const drawId = await createDraft(mode, drawName(req));
  res.json(await confirmDraw(mode, drawId, scheduleDate));
}));

// Drafts, scheduled and recent draws, excluding cancelled ones
app.get('/api/draws', wrap(async (req, res) => {
  const mode = modeOf(req);
  const list = await rd(mode, 'GET', 'draws/?page=1&count=20&sortField=date&descending=true&showCancelled=false');
  res.json((list.draws || []).map((x) => listItem(x, mode)));
}));

app.get('/api/draws/:id', wrap(async (req, res) => {
  const mode = modeOf(req);
  const draw = await rd(mode, 'GET', `draws/${encodeURIComponent(req.params.id)}`);
  res.json(draw.state === 'drawn' ? formatDraw(draw, mode) : listItem(draw, mode));
}));

// Delete a draft, or cancel a scheduled draw (RandomDraws refunds the credit)
app.delete('/api/draws/:id', wrap(async (req, res) => {
  const mode = modeOf(req);
  await rd(mode, 'DELETE', `draws/${encodeURIComponent(req.params.id)}`);
  res.json({ ok: true });
}));

// ---------- Entries upload (passcode protected) ----------

const failedAttempts = []; // timestamps of wrong passcodes
const LOCKOUT_ATTEMPTS = 5;
const LOCKOUT_MS = 10 * 60 * 1000;

function checkPasscode(req) {
  if (!UPLOAD_PASSCODE) throw new ApiError(503, 'Uploads are disabled: set UPLOAD_PASSCODE in server/.env');
  const now = Date.now();
  while (failedAttempts.length && now - failedAttempts[0] > LOCKOUT_MS) failedAttempts.shift();
  if (failedAttempts.length >= LOCKOUT_ATTEMPTS) {
    throw new ApiError(429, 'Too many wrong passcodes. Try again in 10 minutes.');
  }
  const given = Buffer.from(String(req.get('x-passcode') || ''));
  const expected = Buffer.from(UPLOAD_PASSCODE);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    failedAttempts.push(now);
    throw new ApiError(401, 'Incorrect passcode');
  }
  failedAttempts.length = 0;
}

function setActiveEntries(file) {
  entriesFile = file;
  if (file === DEFAULT_ENTRIES_FILE) fs.rmSync(ACTIVE_FILE, { force: true });
  else fs.writeFileSync(ACTIVE_FILE, JSON.stringify({ file: path.basename(file) }));
}

// Body is the raw CSV; the original name comes in X-Filename
app.post('/api/entries', wrap(async (req, res) => {
  checkPasscode(req);
  const original = decodeURIComponent(String(req.get('x-filename') || 'entries.csv'));
  if (!/\.(csv|txt|tsv)$/i.test(original)) throw new ApiError(400, 'File must be .csv, .txt or .tsv');
  if (Number(req.get('content-length') || 0) > MAX_UPLOAD_BYTES) throw new ApiError(413, 'File is over 100 MB');

  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const safeName = path.basename(original).replace(/[^\w.-]+/g, '_');
  const dest = path.join(UPLOAD_DIR, `${stamp}-${safeName}`);

  await new Promise((resolve, reject) => {
    let bytes = 0;
    const out = fs.createWriteStream(dest);
    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        req.destroy();
        out.destroy();
        reject(new ApiError(413, 'File is over 100 MB'));
      }
    });
    req.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    req.on('error', reject);
  }).catch((err) => {
    fs.rmSync(dest, { force: true });
    throw err;
  });

  try {
    parseEntries(dest);
  } catch (err) {
    fs.rmSync(dest, { force: true });
    throw err;
  }
  setActiveEntries(dest);
  console.log(`Entries switched to upload ${path.basename(dest)}`);
  res.json(loadData().summary);
}));

// Switch back to the entries file configured in server/.env
app.post('/api/entries/default', wrap(async (req, res) => {
  checkPasscode(req);
  setActiveEntries(DEFAULT_ENTRIES_FILE);
  console.log('Entries switched back to default file');
  res.json(loadData().summary);
}));

// Serve the built client when running `npm start`
const dist = path.join(ROOT, 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^\/(?!api).*/, (req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, HOST, () => {
  console.log(`Draw API on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${APP_USER ? ' (sign-in on)' : ''}`);
  loadData();
});
