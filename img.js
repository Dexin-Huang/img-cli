#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

// Load .env
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = 'gemini-3.1-flash-image-preview';
const STYLES_DIR = path.join(__dirname, 'styles');
const OUTPUT_DIR = path.join(__dirname, 'output');

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(`img — image generation CLI

Commands:
  generate <prompt> [--style S] [--sref image] [--size S] [--ratio R] [-o file]
  edit <image> <prompt> [-o file]
  remove-bg <image> [-o file]
  styles                          List available styles
  save-style <name> <prompt>      Save a new style from prompt

Options:
  --style   Style preset name (see 'img styles')
  --sref    Style reference image path
  --size    Image size: 512, 1K, 2K, 4K (default: 1K)
  --ratio   Aspect ratio: 1:1, 16:9, 4:3, etc. (default: 1:1)
  -o        Output file path (default: output/<timestamp>.png)`);
    return;
  }

  if (!API_KEY) {
    console.error('Missing GEMINI_API_KEY in .env');
    process.exit(1);
  }

  switch (cmd) {
    case 'generate': return generate(rest);
    case 'edit': return edit(rest);
    case 'remove-bg': return removeBg(rest);
    case 'styles': return listStyles();
    case 'save-style': return saveStyle(rest);
    default: console.error(`Unknown command: ${cmd}. Run 'img help'.`); process.exit(1);
  }
}

// ============================================================
// GENERATE
// ============================================================

async function generate(args) {
  const { positionals, flags } = parseArgs(args);
  const prompt = positionals.join(' ');
  if (!prompt) { console.error('Usage: img generate "description" [--style S]'); process.exit(1); }

  const styleName = flags.style;
  const srefPath = flags.sref;
  const size = flags.size || '1K';
  const ratio = flags.ratio || '1:1';
  const output = flags.o || autoOutput('gen');

  // Build full prompt from style + user prompt
  let fullPrompt = prompt;
  const refImages = [];

  if (styleName) {
    const style = loadStyle(styleName);
    if (!style) { console.error(`Style "${styleName}" not found. Run 'img styles'.`); process.exit(1); }
    fullPrompt = [style.prefix, prompt, style.suffix].filter(Boolean).join('. ');
    // Load style reference images
    const styleDir = path.join(STYLES_DIR, styleName);
    if (fs.existsSync(styleDir)) {
      for (const file of fs.readdirSync(styleDir)) {
        if (/\.(png|jpg|jpeg|webp)$/i.test(file)) {
          refImages.push(path.join(styleDir, file));
        }
      }
    }
  }

  if (srefPath) refImages.push(srefPath);

  console.error(`Generating: "${fullPrompt.slice(0, 80)}${fullPrompt.length > 80 ? '...' : ''}"`);
  if (refImages.length) console.error(`  Style refs: ${refImages.length} image(s)`);
  console.error(`  Size: ${size}, Ratio: ${ratio}`);

  const parts = [];
  for (const ref of refImages) {
    const data = fs.readFileSync(ref).toString('base64');
    const mime = ref.endsWith('.png') ? 'image/png' : 'image/jpeg';
    parts.push({ inlineData: { mimeType: mime, data } });
  }
  parts.push({ text: fullPrompt });

  const result = await callGemini(parts, { imageSize: size, aspectRatio: ratio });
  if (result) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, result);
    console.log(output);
  }
}

// ============================================================
// EDIT
// ============================================================

async function edit(args) {
  const { positionals, flags } = parseArgs(args);
  const imagePath = positionals[0];
  const prompt = positionals.slice(1).join(' ');
  if (!imagePath || !prompt) { console.error('Usage: img edit <image> "instruction"'); process.exit(1); }

  const output = flags.o || autoOutput('edit');
  console.error(`Editing: ${imagePath}`);
  console.error(`  Instruction: "${prompt}"`);

  const imageData = fs.readFileSync(imagePath).toString('base64');
  const mime = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const result = await callGemini([
    { inlineData: { mimeType: mime, data: imageData } },
    { text: prompt },
  ], {});

  if (result) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, result);
    console.log(output);
  }
}

// ============================================================
// REMOVE-BG
// ============================================================

async function removeBg(args) {
  const { positionals, flags } = parseArgs(args);
  const imagePath = positionals[0];
  if (!imagePath) { console.error('Usage: img remove-bg <image>'); process.exit(1); }

  const output = flags.o || autoOutput('nobg').replace('.png', '.png');

  // Step 1: Ask Gemini to put it on a solid green background
  console.error('Step 1: Generating green-screen version...');
  const imageData = fs.readFileSync(imagePath).toString('base64');
  const mime = imagePath.endsWith('.png') ? 'image/png' : 'image/jpeg';

  const greenResult = await callGemini([
    { inlineData: { mimeType: mime, data: imageData } },
    { text: 'Place the main subject of this image on a perfectly solid #00FF00 bright green background. Keep the subject exactly the same. The background must be pure uniform green with no gradients or shadows.' },
  ], {});

  if (!greenResult) { console.error('Failed to generate green-screen version'); process.exit(1); }

  // Step 2: Remove green using ffmpeg chromakey
  const tmpGreen = path.join(OUTPUT_DIR, '_tmp_green.png');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(tmpGreen, greenResult);

  console.error('Step 2: Removing green background...');
  const { spawnSync } = require('child_process');
  const result = spawnSync('ffmpeg', [
    '-y', '-i', tmpGreen,
    '-filter_complex', 'chromakey=0x00FF00:0.15:0.1',
    output,
  ], { encoding: 'utf8', windowsHide: true });

  fs.unlinkSync(tmpGreen);

  if (result.status !== 0) {
    console.error('ffmpeg chromakey failed:', (result.stderr || '').slice(0, 200));
    process.exit(1);
  }

  console.log(output);
}

// ============================================================
// STYLES
// ============================================================

function listStyles() {
  fs.mkdirSync(STYLES_DIR, { recursive: true });
  const styles = fs.readdirSync(STYLES_DIR)
    .filter(f => fs.existsSync(path.join(STYLES_DIR, f, 'config.json')))
    .map(name => {
      const config = JSON.parse(fs.readFileSync(path.join(STYLES_DIR, name, 'config.json'), 'utf8'));
      const refs = fs.readdirSync(path.join(STYLES_DIR, name)).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).length;
      return { name, description: config.description || '', refs };
    });

  if (styles.length === 0) {
    console.log('No styles yet. Run: img save-style <name> "prompt prefix"');
    return;
  }

  for (const s of styles) {
    console.log(`  ${s.name.padEnd(20)} ${s.refs ? s.refs + ' refs  ' : '       '}${s.description}`);
  }
}

function saveStyle(args) {
  const name = args[0];
  const rest = args.slice(1).join(' ');
  if (!name || !rest) { console.error('Usage: img save-style <name> "prompt prefix"'); process.exit(1); }

  const styleDir = path.join(STYLES_DIR, name);
  fs.mkdirSync(styleDir, { recursive: true });

  const config = {
    name,
    description: rest.slice(0, 60),
    prefix: rest,
    suffix: '',
    aspectRatio: '1:1',
    imageSize: '1K',
  };

  fs.writeFileSync(path.join(styleDir, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`Saved style "${name}" at ${styleDir}`);
  console.log('Add reference images: copy .png/.jpg files into that directory.');
}

function loadStyle(name) {
  const configPath = path.join(STYLES_DIR, name, 'config.json');
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// ============================================================
// GEMINI API
// ============================================================

async function callGemini(parts, imageConfig) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(API_KEY)}`;

  const genConfig = { responseModalities: ['TEXT', 'IMAGE'] };
  if (imageConfig.imageSize || imageConfig.aspectRatio) {
    genConfig.imageConfig = {};
    if (imageConfig.imageSize) genConfig.imageConfig.imageSize = imageConfig.imageSize;
    if (imageConfig.aspectRatio) genConfig.imageConfig.aspectRatio = imageConfig.aspectRatio;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: genConfig,
      }),
    });

    const payload = await response.json();
    if (!response.ok) {
      console.error('Gemini error:', payload.error?.message || JSON.stringify(payload));
      return null;
    }

    const resParts = payload.candidates?.[0]?.content?.parts || [];
    for (const part of resParts) {
      if (part.inlineData) {
        return Buffer.from(part.inlineData.data, 'base64');
      }
    }

    const text = resParts.map(p => p.text || '').join('');
    if (text) console.error('Model response (no image):', text.slice(0, 200));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ============================================================
// UTILS
// ============================================================

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) { flags[key] = next; i++; }
      else flags[key] = true;
    } else if (arg === '-o') {
      flags.o = argv[++i];
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function autoOutput(prefix) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(OUTPUT_DIR, `${prefix}-${ts}.png`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
