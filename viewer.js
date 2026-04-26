#!/usr/bin/env node

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const url = require('node:url');
const { spawn } = require('node:child_process');

const OUTPUT_DIR = path.join(process.cwd(), 'output');
const FEEDBACK_PATH = path.join(OUTPUT_DIR, 'feedback.json');
const PORT = parseInt(process.env.PORT, 10) || 3000;
const PNG_EXT = /\.png$/i;

function isSafeFilename(s) {
  return typeof s === 'string' && s.length > 0 && !s.includes('..') && !s.includes('/') && !s.includes('\\');
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function serveStaticFile(res, filePath, contentType, extraHeaders) {
  if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache', ...(extraHeaders || {}) });
  fs.createReadStream(filePath).pipe(res);
}

// ============================================================
// FEEDBACK STORE (atomic read-modify-write)
// ============================================================

function readFeedback() {
  if (!fs.existsSync(FEEDBACK_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(FEEDBACK_PATH, 'utf8'));
  } catch (err) {
    console.error(`Warning: malformed feedback.json: ${err.message}. Starting fresh.`);
    return {};
  }
}

function writeFeedback(data) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const tmp = FEEDBACK_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FEEDBACK_PATH);
}

// ============================================================
// IMAGE LISTING
// ============================================================

function listImages() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  const feedback = readFeedback();
  const files = fs.readdirSync(OUTPUT_DIR).filter(isSourcePng);

  return files.map(filename => {
    const fullPath = path.join(OUTPUT_DIR, filename);
    const stat = fs.statSync(fullPath);
    const sidecarPath = fullPath.replace(/\.png$/i, '.json');
    let sidecar = null;
    if (fs.existsSync(sidecarPath)) {
      try {
        sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
      } catch (err) {
        console.error(`Warning: malformed sidecar ${sidecarPath}: ${err.message}`);
      }
    }
    const baseStem = filename.replace(/\.png$/i, '');
    const svgName = `${baseStem}-mark.svg`;
    const svgPath = path.join(OUTPUT_DIR, svgName);
    const extractedSvg = fs.existsSync(svgPath) ? svgName : null;
    return {
      filename,
      url: `/img/${encodeURIComponent(filename)}`,
      mtime: stat.mtimeMs,
      sidecar,
      feedback: feedback[filename] || null,
      extractedSvg,
      extractedSvgUrl: extractedSvg ? `/svg/${encodeURIComponent(extractedSvg)}` : null,
    };
  });
}

function isSourcePng(filename) {
  return PNG_EXT.test(filename) && !filename.startsWith('_tmp_') && !/-mark\.png$/i.test(filename);
}

// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'GET' && pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderPage());
    return;
  }

  if (req.method === 'GET' && pathname === '/api/images') {
    sendJson(res, 200, listImages());
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/img/')) {
    const raw = decodeURIComponent(pathname.slice('/img/'.length));
    if (!isSafeFilename(raw)) { res.writeHead(400); res.end('Bad filename'); return; }
    serveStaticFile(res, path.join(OUTPUT_DIR, raw), 'image/png');
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/svg/')) {
    const raw = decodeURIComponent(pathname.slice('/svg/'.length));
    if (!isSafeFilename(raw)) { res.writeHead(400); res.end('Bad filename'); return; }
    const isDownload = parsed.query && parsed.query.download === '1';
    serveStaticFile(res, path.join(OUTPUT_DIR, raw), 'image/svg+xml',
      isDownload ? { 'Content-Disposition': `attachment; filename="${raw}"` } : null);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/extract-mark') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400); res.end('Bad JSON'); return; }

      const { filename } = payload;
      if (!isSafeFilename(filename)) { res.writeHead(400); res.end('Bad filename'); return; }
      if (!isSourcePng(filename)) { res.writeHead(400); res.end('Not a source PNG'); return; }
      const inputPath = path.join(OUTPUT_DIR, filename);
      if (!fs.existsSync(inputPath)) { res.writeHead(404); res.end('Source PNG not found'); return; }

      const cliPath = path.join(__dirname, 'img.js');
      console.log(`[extract-mark] starting for ${filename}…`);
      const child = spawn(process.execPath, [cliPath, 'extract-mark', inputPath], {
        cwd: process.cwd(),
        windowsHide: true,
      });
      // Cancel the OpenAI call if the client navigates away — prevents wasted API spend on tab-close.
      req.on('close', () => { if (!res.writableEnded && !child.killed) child.kill(); });
      let stderr = '';
      child.stderr.on('data', d => { stderr += d.toString(); });
      child.on('close', code => {
        if (res.writableEnded) return;
        if (code !== 0) {
          console.error(`[extract-mark] failed (${code}): ${stderr.slice(0, 300)}`);
          sendJson(res, 500, { ok: false, error: stderr.slice(0, 500) });
          return;
        }
        const svgName = `${filename.replace(/\.png$/i, '')}-mark.svg`;
        console.log(`[extract-mark] done → ${svgName}`);
        sendJson(res, 200, { ok: true, svg: svgName, svgUrl: `/svg/${encodeURIComponent(svgName)}` });
      });
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/feedback') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      let payload;
      try { payload = JSON.parse(body); }
      catch { res.writeHead(400); res.end('Bad JSON'); return; }

      const { filename, verdict, notes, clear } = payload;
      if (!isSafeFilename(filename)) { res.writeHead(400); res.end('Bad filename'); return; }

      const data = readFeedback();
      if (clear === true) {
        delete data[filename];
        writeFeedback(data);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (verdict !== null && !['canon', 'ship', 'reject'].includes(verdict)) {
        res.writeHead(400); res.end('Bad verdict'); return;
      }
      data[filename] = {
        verdict: verdict || null,
        notes: typeof notes === 'string' ? notes : '',
        reviewedAt: new Date().toISOString(),
      };
      writeFeedback(data);
      sendJson(res, 200, { ok: true });
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  const target = `http://localhost:${PORT}`;
  console.log(`img-cli viewer: ${target}`);
  if (process.platform === 'win32' && !process.env.NO_OPEN) {
    spawn('cmd', ['/c', 'start', '', target], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  }
});

// ============================================================
// HTML PAGE
// ============================================================

function renderPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>img-cli viewer</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">
<style>
  :root {
    --paper: #F8F7F2;
    --paper-deep: #EFEEE6;
    --ink: #14140F;
    --ink-soft: #5A594F;
    --ink-faint: #A09F94;
    --rule: #DCDBD3;
    --accent: #1F6F4E;
    --accent-bg: #E6EFE9;
    --canon: #B5832A;
    --ship: #4F7A3A;
    --reject: #A23E2E;
    --reject-bg: #F1E0DB;
    --skip: #7A7970;
    --flag: #C75C2E;
    --lightbox-bg: rgba(20, 20, 15, 0.96);
    --mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    --serif: 'Instrument Serif', Georgia, 'Times New Roman', serif;
  }
  * { box-sizing: border-box; }
  html { background: var(--paper); }
  body {
    margin: 0;
    font-family: var(--mono);
    background: var(--paper);
    color: var(--ink);
    font-size: 13px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: geometricPrecision;
  }

  /* ───── Masthead ───── */
  .topbar {
    position: sticky;
    top: 0;
    z-index: 10;
    background: var(--paper);
    border-bottom: 1px solid var(--ink);
    padding: 26px 36px 18px;
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: end;
    gap: 36px;
  }
  .masthead { display: flex; flex-direction: column; gap: 4px; }
  .masthead h1 {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 600;
    margin: 0;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }
  .masthead-sub {
    font-family: var(--serif);
    font-style: italic;
    font-size: 14px;
    color: var(--ink-soft);
    line-height: 1;
  }
  .controls { display: flex; gap: 28px; align-items: end; }
  .control { display: flex; flex-direction: column; gap: 6px; }
  .control label {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .control select, .control button {
    background: transparent;
    border: 0;
    border-bottom: 1px solid var(--ink);
    color: var(--ink);
    padding: 4px 22px 4px 0;
    font-family: var(--mono);
    font-size: 12px;
    letter-spacing: 0.04em;
    cursor: pointer;
    appearance: none;
    background-image:
      linear-gradient(45deg, transparent 50%, var(--ink) 50%),
      linear-gradient(135deg, var(--ink) 50%, transparent 50%);
    background-position: calc(100% - 9px) 52%, calc(100% - 5px) 52%;
    background-size: 4px 4px;
    background-repeat: no-repeat;
  }
  .control button {
    background-image: none;
    padding-right: 0;
    text-transform: lowercase;
    letter-spacing: 0.06em;
  }
  .control button:hover { color: var(--accent); border-color: var(--accent); }
  .count {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--ink-faint);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    align-self: end;
  }
  .count strong { color: var(--ink); font-weight: 600; }

  /* ───── Grid ───── */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: 44px 36px;
    padding: 40px 36px 96px;
  }

  @keyframes card-in {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  .card {
    display: flex;
    flex-direction: column;
    background: var(--paper);
    position: relative;
    animation: card-in 0.5s ease-out both;
  }
  .card:nth-child(1)   { animation-delay: 0ms; }
  .card:nth-child(2)   { animation-delay: 35ms; }
  .card:nth-child(3)   { animation-delay: 70ms; }
  .card:nth-child(4)   { animation-delay: 105ms; }
  .card:nth-child(5)   { animation-delay: 140ms; }
  .card:nth-child(6)   { animation-delay: 175ms; }
  .card:nth-child(7)   { animation-delay: 210ms; }
  .card:nth-child(8)   { animation-delay: 245ms; }
  .card:nth-child(n+9) { animation-delay: 280ms; }

  .card.flagged::before {
    content: "";
    position: absolute;
    top: 0;
    left: 0;
    width: 14px;
    height: 14px;
    background: var(--flag);
    z-index: 2;
    pointer-events: none;
  }

  .card-image-wrap {
    position: relative;
    background: var(--paper-deep);
    border: 1px solid var(--rule);
    overflow: hidden;
  }
  .card img.thumb {
    width: 100%;
    aspect-ratio: 1 / 1;
    object-fit: contain;
    cursor: zoom-in;
    display: block;
    transition: transform 0.5s cubic-bezier(0.16, 1, 0.3, 1);
  }
  .card-image-wrap:hover img.thumb { transform: scale(1.015); }

  .card-body {
    padding: 16px 0 0;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .filename {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--ink-faint);
    letter-spacing: 0.04em;
    word-break: break-all;
  }

  /* Inline · separated chips */
  .chips { display: flex; flex-wrap: wrap; gap: 6px 14px; }
  .chip {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--ink-soft);
    position: relative;
  }
  .chip + .chip::before {
    content: "·";
    position: absolute;
    left: -10px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--ink-faint);
  }
  .chip.flag { color: var(--flag); }

  /* Editorial body */
  .prompt {
    font-family: var(--serif);
    font-style: italic;
    font-size: 17px;
    line-height: 1.32;
    color: var(--ink);
    cursor: pointer;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .prompt.expanded { -webkit-line-clamp: unset; }
  .prompt.empty { color: var(--ink-faint); }

  /* Assessment */
  .assessment {
    border-top: 1px solid var(--rule);
    padding-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .assessment-head {
    display: flex;
    align-items: center;
    gap: 12px;
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ink-faint);
  }
  .rec {
    font-family: var(--mono);
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    padding: 3px 9px;
    border: 1px solid currentColor;
  }
  .rec.canon  { color: var(--canon); }
  .rec.ship   { color: var(--ship); }
  .rec.reject { color: var(--reject); }
  .score {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.12em;
    color: var(--ink);
    margin-left: auto;
  }
  .score-chips { display: flex; flex-wrap: wrap; gap: 5px; }
  .score-chip {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 2px 7px;
    background: var(--paper-deep);
    color: var(--ink-soft);
  }
  .score-chip.full { color: var(--accent); background: var(--accent-bg); }
  .score-chip.zero { color: var(--reject); background: var(--reject-bg); }
  .fail-tag {
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.06em;
    padding: 2px 7px;
    background: var(--reject-bg);
    color: var(--reject);
  }
  .reasoning {
    font-family: var(--serif);
    font-style: italic;
    font-size: 14px;
    color: var(--ink-soft);
    line-height: 1.4;
  }

  /* Mark row */
  .mark-row {
    border-top: 1px solid var(--rule);
    padding-top: 12px;
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .mark-preview {
    width: 60px;
    height: 60px;
    background: var(--paper-deep);
    padding: 8px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .mark-preview img { max-width: 100%; max-height: 100%; object-fit: contain; display: block; }
  .mark-actions {
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1;
    min-width: 0;
  }
  .mark-actions .mark-label {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--ink-faint);
    letter-spacing: 0.04em;
    margin-bottom: 4px;
    word-break: break-all;
  }
  .mark-actions a, .mark-actions button {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.08em;
    text-transform: lowercase;
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--ink);
    cursor: pointer;
    text-align: left;
    text-decoration: underline;
    text-decoration-color: var(--rule);
    text-underline-offset: 4px;
    transition: color 0.15s ease, text-decoration-color 0.15s ease;
  }
  .mark-actions a:hover, .mark-actions button:hover {
    color: var(--accent);
    text-decoration-color: var(--accent);
  }
  .mark-actions button:disabled {
    color: var(--ink-faint);
    cursor: wait;
    text-decoration: none;
  }

  /* Verdicts — text-only mono with hairline underline */
  .verdicts {
    display: flex;
    gap: 22px;
    padding-top: 4px;
  }
  .verdict {
    background: transparent;
    border: 0;
    border-bottom: 1px solid transparent;
    padding: 4px 0;
    font-family: var(--mono);
    font-size: 10px;
    font-weight: 500;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--ink-faint);
    cursor: pointer;
    user-select: none;
    transition: color 0.15s ease, border-color 0.15s ease;
  }
  .verdict:hover { color: var(--ink); border-color: var(--rule); }
  .verdict.active.canon  { color: var(--canon);  border-color: var(--canon); }
  .verdict.active.ship   { color: var(--ship);   border-color: var(--ship); }
  .verdict.active.reject { color: var(--reject); border-color: var(--reject); }
  .verdict.active.skip   { color: var(--skip);   border-color: var(--skip); }

  /* Notes */
  textarea.notes {
    width: 100%;
    min-height: 36px;
    border: 0;
    border-bottom: 1px solid var(--rule);
    padding: 8px 0;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.5;
    resize: vertical;
    background: transparent;
    color: var(--ink);
    letter-spacing: 0.02em;
  }
  textarea.notes::placeholder {
    color: var(--ink-faint);
    font-family: var(--serif);
    font-style: italic;
    font-size: 13px;
    letter-spacing: 0;
  }
  textarea.notes:focus { outline: none; border-bottom-color: var(--ink); }

  .meta-row {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    font-family: var(--mono);
    font-size: 9px;
    letter-spacing: 0.16em;
    text-transform: uppercase;
  }
  .saved {
    color: var(--ink-faint);
    transition: opacity 0.3s ease;
  }

  /* Empty state */
  .empty-state {
    padding: 96px 36px;
    text-align: center;
    font-family: var(--serif);
    font-style: italic;
    font-size: 20px;
    color: var(--ink-faint);
    grid-column: 1 / -1;
  }

  /* Lightbox */
  @keyframes lightbox-in { from { opacity: 0; } to { opacity: 1; } }
  .lightbox {
    position: fixed;
    inset: 0;
    background: var(--lightbox-bg);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 100;
    cursor: zoom-out;
    padding: 36px;
    animation: lightbox-in 0.2s ease-out;
  }
  .lightbox.open { display: flex; }
  .lightbox img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
    box-shadow: 0 32px 80px rgba(0, 0, 0, 0.55);
  }
</style>
</head>
<body>
<div class="topbar">
  <div class="masthead">
    <h1>img / viewer</h1>
    <div class="masthead-sub">a contact sheet for generative work</div>
  </div>
  <div class="controls">
    <div class="control">
      <label for="filter-verdict">verdict</label>
      <select id="filter-verdict">
        <option value="all">all</option>
        <option value="unreviewed">unreviewed</option>
        <option value="flagged">flagged</option>
        <option value="canon">canon</option>
        <option value="ship">ship</option>
        <option value="reject">reject</option>
      </select>
    </div>
    <div class="control">
      <label for="filter-style">style</label>
      <select id="filter-style"><option value="all">all</option></select>
    </div>
    <div class="control">
      <label>&nbsp;</label>
      <button id="refresh">refresh</button>
    </div>
  </div>
  <div class="count" id="count"></div>
</div>
<div class="grid" id="grid"></div>
<div class="lightbox" id="lightbox"><img id="lightbox-img" alt=""></div>

<script>
const VERDICTS = [
  { key: 'canon', label: 'canon' },
  { key: 'ship', label: 'ship' },
  { key: 'reject', label: 'reject' },
  { key: 'skip', label: 'skip' },
];

let images = [];
const saveTimers = new Map();

async function load() {
  const r = await fetch('/api/images');
  images = await r.json();
  populateStyleFilter();
  render();
}

function populateStyleFilter() {
  const styleSel = document.getElementById('filter-style');
  const current = styleSel.value;
  const styles = new Set();
  for (const im of images) {
    if (im.sidecar && im.sidecar.style) styles.add(im.sidecar.style);
  }
  styleSel.innerHTML = '<option value="all">all</option>' +
    [...styles].sort().map(s => '<option value="' + escapeHtml(s) + '">' + escapeHtml(s) + '</option>').join('');
  if ([...styleSel.options].some(o => o.value === current)) styleSel.value = current;
}

function currentVerdictFilter() { return document.getElementById('filter-verdict').value; }
function currentStyleFilter() { return document.getElementById('filter-style').value; }

function filtered() {
  const v = currentVerdictFilter();
  const s = currentStyleFilter();
  return images.filter(im => {
    if (s !== 'all') {
      if (!im.sidecar || im.sidecar.style !== s) return false;
    }
    if (v === 'all') return true;
    if (v === 'unreviewed') return !im.feedback;
    if (v === 'flagged') return im.sidecar && im.sidecar.flagged === true;
    return im.feedback && im.feedback.verdict === v;
  });
}

function sortItems(items) {
  return items.slice().sort((a, b) => {
    const aFlag = !!(a.sidecar && a.sidecar.flagged);
    const bFlag = !!(b.sidecar && b.sidecar.flagged);
    if (aFlag !== bFlag) return aFlag ? -1 : 1;
    const aReviewed = !!a.feedback;
    const bReviewed = !!b.feedback;
    if (aReviewed !== bReviewed) return aReviewed ? 1 : -1;
    if (!aReviewed) return b.mtime - a.mtime;
    return (b.feedback.reviewedAt || '').localeCompare(a.feedback.reviewedAt || '');
  });
}

function render() {
  const grid = document.getElementById('grid');
  const items = sortItems(filtered());
  const pad = n => String(n).padStart(3, '0');
  document.getElementById('count').innerHTML = '<strong>' + pad(items.length) + '</strong> / ' + pad(images.length);
  if (!items.length) {
    grid.innerHTML = '<div class="empty-state">No images match.</div>';
    return;
  }
  grid.innerHTML = items.map(renderCard).join('');
  for (const im of items) {
    const card = grid.querySelector('[data-file="' + cssEscape(im.filename) + '"]');
    if (!card) continue;
    card.querySelector('img.thumb').addEventListener('click', () => openLightbox(im.url));
    const promptEl = card.querySelector('.prompt');
    if (promptEl) promptEl.addEventListener('click', () => promptEl.classList.toggle('expanded'));
    card.querySelectorAll('.verdict').forEach(btn => {
      btn.addEventListener('click', () => onVerdict(im.filename, btn.dataset.verdict));
    });
    const notes = card.querySelector('textarea.notes');
    notes.addEventListener('input', () => scheduleSave(im.filename));
    notes.addEventListener('blur', () => flushSave(im.filename));
    const extractBtn = card.querySelector('button[data-extract]');
    if (extractBtn) extractBtn.addEventListener('click', () => onExtract(im.filename));
  }
}

async function onExtract(filename) {
  const card = document.querySelector('[data-file="' + cssEscape(filename) + '"]');
  if (!card) return;
  const btn = card.querySelector('button[data-extract]');
  const status = card.querySelector('[data-extract-status]');
  if (btn) { btn.disabled = true; btn.textContent = 'extracting…'; }
  if (status) status.textContent = '~30s — gpt-image-2 + potrace';
  try {
    const r = await fetch('/api/extract-mark', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      if (status) status.textContent = 'failed: ' + (data.error || r.statusText).slice(0, 80);
      if (btn) { btn.disabled = false; btn.textContent = 'retry extract'; }
      return;
    }
    const im = findImage(filename);
    if (im) { im.extractedSvg = data.svg; im.extractedSvgUrl = data.svgUrl; }
    render();
  } catch (err) {
    if (status) status.textContent = 'error: ' + err.message;
    if (btn) { btn.disabled = false; btn.textContent = 'retry extract'; }
  }
}

function renderCard(im) {
  const sc = im.sidecar;
  const fb = im.feedback;
  const verdict = fb && fb.verdict;
  const flagged = sc && sc.flagged === true;

  const chips = [];
  if (sc) {
    if (sc.style) chips.push(chip(sc.style));
    for (const m of sc.mods || []) chips.push(chip('+' + m));
    if (sc.ratio) chips.push(chip(sc.ratio));
    if (sc.size) chips.push(chip(sc.size));
    if (sc.quality && sc.quality !== 'high') chips.push(chip(sc.quality));
    if (sc.provider && sc.provider !== 'openai') chips.push(chip(sc.provider));
  } else {
    chips.push(chip('no sidecar'));
  }
  if (flagged) chips.push('<span class="chip flag">flagged</span>');

  const promptText = sc && sc.prompt ? sc.prompt : '(no recipe recorded)';
  const promptClass = sc && sc.prompt ? 'prompt' : 'prompt empty';

  const verdictBtns = VERDICTS.map(v => {
    const active = (v.key === 'skip' ? fb && verdict === null : verdict === v.key);
    const isSkip = v.key === 'skip';
    const activeClass = active && !isSkip ? ' active ' + v.key : (active && isSkip ? ' active skip' : '');
    return '<button class="verdict' + activeClass + '" data-verdict="' + v.key + '">' + v.label + '</button>';
  }).join('');

  const notesText = fb && fb.notes ? fb.notes : '';
  const reviewedAt = fb && fb.reviewedAt ? new Date(fb.reviewedAt).toLocaleString() : '';

  return '<div class="card' + (flagged ? ' flagged' : '') + '" data-file="' + escapeAttr(im.filename) + '">' +
    '<div class="card-image-wrap"><img class="thumb" loading="lazy" src="' + im.url + '" alt=""></div>' +
    '<div class="card-body">' +
      '<div class="filename">' + escapeHtml(im.filename) + '</div>' +
      '<div class="chips">' + chips.join('') + '</div>' +
      renderAssessment(sc) +
      renderMarkRow(im) +
      '<div class="' + promptClass + '">' + escapeHtml(promptText) + '</div>' +
      '<div class="verdicts">' + verdictBtns + '</div>' +
      '<textarea class="notes" placeholder="notes…">' + escapeHtml(notesText) + '</textarea>' +
      '<div class="meta-row"><span class="saved" data-saved>' + (reviewedAt ? 'reviewed ' + reviewedAt : '') + '</span></div>' +
    '</div>' +
  '</div>';
}

function renderMarkRow(im) {
  if (im.extractedSvg) {
    return '<div class="mark-row" data-mark-row>' +
      '<div class="mark-preview"><img src="' + im.extractedSvgUrl + '" alt="extracted mark"></div>' +
      '<div class="mark-actions">' +
        '<span class="mark-label">' + escapeHtml(im.extractedSvg) + '</span>' +
        '<a href="' + im.extractedSvgUrl + '?download=1" download>download svg</a>' +
        '<a href="' + im.extractedSvgUrl + '" target="_blank" rel="noreferrer">open</a>' +
      '</div>' +
    '</div>';
  }
  return '<div class="mark-row" data-mark-row>' +
    '<div class="mark-actions">' +
      '<button class="extract-btn" data-extract>extract mark → svg</button>' +
      '<span class="mark-label" data-extract-status></span>' +
    '</div>' +
  '</div>';
}

function renderAssessment(sc) {
  const a = sc && sc.claudeAssessment;
  if (!a) return '';
  const rec = a.recommendedVerdict || 'ship';
  const scoreLabels = {
    iconicGesture: 'gesture', platformFit: 'platform', depthMaterial: 'material', thumbnailStrength: 'thumb',
    productTruth: 'product', lightingDiscipline: 'light', compositionSpace: 'composition', brandRestraint: 'restraint',
  };
  const scoreChips = Object.entries(a.scores || {}).map(([k, v]) => {
    const cls = v === 2 ? 'full' : v === 0 ? 'zero' : '';
    return '<span class="score-chip ' + cls + '">' + (scoreLabels[k] || k) + ' ' + v + '</span>';
  }).join('');
  const failTags = (a.failureTags || []).map(t => '<span class="fail-tag">' + escapeHtml(t) + '</span>').join('');
  return '<div class="assessment">' +
    '<div class="assessment-head">' +
      '<span>claude</span>' +
      '<span class="rec ' + rec + '">' + rec + '</span>' +
      '<span class="score">' + (a.total || 0) + '/' + (a.max || 8) + '</span>' +
    '</div>' +
    '<div class="score-chips">' + scoreChips + failTags + '</div>' +
    '<div class="reasoning">' + escapeHtml(a.reasoning || '') + '</div>' +
  '</div>';
}

function chip(text) { return '<span class="chip">' + escapeHtml(text) + '</span>'; }

function findImage(filename) { return images.find(i => i.filename === filename); }

async function onVerdict(filename, key) {
  const im = findImage(filename);
  if (!im) return;
  const current = im.feedback && im.feedback.verdict;
  const notes = im.feedback ? im.feedback.notes : '';
  if (key === 'skip') {
    if (im.feedback && current === null && !notes) {
      await clearFeedback(filename);
      return;
    }
    await saveFeedback(filename, null, notes);
    return;
  }
  await saveFeedback(filename, current === key ? null : key, notes);
}

function scheduleSave(filename) {
  if (saveTimers.has(filename)) clearTimeout(saveTimers.get(filename));
  saveTimers.set(filename, setTimeout(() => flushSave(filename), 800));
}

async function flushSave(filename) {
  if (saveTimers.has(filename)) {
    clearTimeout(saveTimers.get(filename));
    saveTimers.delete(filename);
  }
  const card = document.querySelector('[data-file="' + cssEscape(filename) + '"]');
  if (!card) return;
  const notes = card.querySelector('textarea.notes').value;
  const im = findImage(filename);
  const verdict = im && im.feedback ? im.feedback.verdict : null;
  if (!notes && !(im && im.feedback)) return;
  const ok = await saveFeedback(filename, verdict, notes, false);
  const savedEl = card.querySelector('[data-saved]');
  if (savedEl) {
    savedEl.textContent = ok ? 'saved' : 'save failed';
    savedEl.style.opacity = '1';
    setTimeout(() => { savedEl.style.opacity = '0.5'; }, 1500);
  }
}

async function saveFeedback(filename, verdict, notes, reRender = true) {
  const ok = await postFeedback({ filename, verdict, notes: notes || '' });
  if (!ok) return false;
  const im = findImage(filename);
  if (im) {
    im.feedback = { verdict, notes: notes || '', reviewedAt: new Date().toISOString() };
  }
  if (reRender) render();
  return true;
}

async function clearFeedback(filename) {
  const ok = await postFeedback({ filename, clear: true });
  if (!ok) return false;
  const im = findImage(filename);
  if (im) im.feedback = null;
  render();
  return true;
}

async function postFeedback(payload) {
  let r;
  try {
    r = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error('save failed:', err.message);
    return false;
  }
  if (!r.ok) {
    console.error('save failed:', await r.text().catch(() => r.statusText));
    return false;
  }
  return true;
}

function openLightbox(src) {
  const lb = document.getElementById('lightbox');
  document.getElementById('lightbox-img').src = src;
  lb.classList.add('open');
}
document.getElementById('lightbox').addEventListener('click', () => {
  document.getElementById('lightbox').classList.remove('open');
  document.getElementById('lightbox-img').src = '';
});

document.getElementById('filter-verdict').addEventListener('change', render);
document.getElementById('filter-style').addEventListener('change', render);
document.getElementById('refresh').addEventListener('click', load);

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
function cssEscape(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/["\\\\]/g, '\\\\$&'); }

load();
</script>
</body>
</html>`;
}
