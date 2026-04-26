#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Dev mode: running from a checkout (has .git). Installed mode: ~/.img-cli/ owns state.
const DEV_MODE = fs.existsSync(path.join(__dirname, '.git'));
const HOME_DIR = path.join(os.homedir(), '.img-cli');
const LIBRARY_DIR = DEV_MODE ? __dirname : path.join(HOME_DIR, 'library');
const SEED_LIBRARY_DIR = __dirname;

const STYLES_DIR = path.join(LIBRARY_DIR, 'styles');
const MODS_DIR = path.join(LIBRARY_DIR, 'mods');
const REFS_DIR = path.join(LIBRARY_DIR, 'refs');
const OUTPUT_DIR = path.join(process.cwd(), 'output');
const VENV_DIR = DEV_MODE ? path.join(__dirname, '.venv') : path.join(HOME_DIR, '.venv');

for (const candidate of [path.join(HOME_DIR, '.env'), path.join(__dirname, '.env')]) {
  if (!fs.existsSync(candidate)) continue;
  for (const line of fs.readFileSync(candidate, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && !line.startsWith('#')) {
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
  break;
}

// First-run library seeding (installed mode only, silent).
if (!DEV_MODE && !fs.existsSync(STYLES_DIR)) {
  try { seedLibrarySilent(); } catch (err) { console.error(`Warning: library seed failed — ${err.message}`); }
}

function venvPython() {
  return path.join(VENV_DIR, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
}

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), '.claude');
}

function pythonCandidates() {
  return process.platform === 'win32'
    ? [
        { command: 'python', args: [] },
        { command: 'py', args: ['-3'] },
        { command: 'python3', args: [] },
      ]
    : [
        { command: 'python3', args: [] },
        { command: 'python', args: [] },
      ];
}

function findPythonCommand() {
  const { spawnSync } = require('child_process');
  for (const candidate of pythonCandidates()) {
    const check = spawnSync(candidate.command, [
      ...candidate.args,
      '-c',
      'import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)',
    ], { stdio: 'ignore', windowsHide: true });
    if (check.status === 0) return candidate;
  }
  return null;
}

function formatPythonCommand(candidate) {
  return [candidate.command, ...candidate.args].join(' ');
}

function spawnPython(candidate, args, options) {
  const { spawnSync } = require('child_process');
  return spawnSync(candidate.command, [...candidate.args, ...args], options);
}

// Flip this when Gemini ships something better than gpt-image-2.
const DEFAULT_PROVIDER = 'openai';

const PROVIDERS = {
  openai: {
    keyEnv: 'OPENAI_API_KEY',
    model: 'gpt-image-2',
    call: callOpenAI,
  },
  gemini: {
    keyEnv: 'GEMINI_API_KEY',
    model: 'gemini-3.1-flash-image-preview',
    call: callGemini,
  },
};

const REPEATABLE = new Set(['mod', 'ref', 'sref', 'no']);
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (!cmd || cmd === 'help' || cmd === '--help') {
    console.log(`img — image generation CLI

Setup:
  init                            Set up API key (interactive, secure)
  install --skills                Install Claude Code skill for agent use
  install --venv                  Install Python venv for extract-mark vectorization

Commands:
  generate <prompt> [flags]       Generate an image
  edit <image> <prompt> [flags]   Edit an image
  remove-bg <image> [-o file]     Remove background via chromakey
  extract-mark <board> [-o .svg]  Extract a logo mark from a brand board → PNG + SVG
  styles                          List style presets
  mods                            List prompt modifiers
  refs                            List named reference images
  save-style <name> <prompt>      Save a new style preset
  save-mod <name> <phrase>        Save a stackable prompt modifier
  save-ref <name> <image> [--role subject|style]
                                  Save a named reference image
  viewer                          Start the local review viewer (browser at localhost:3000)

Composition flags (generate):
  --style S         Base preset (one per call)
  --mod NAME        Stackable prompt modifier (repeatable)
  --ref NAME|PATH   Reference image, by library name or path (repeatable)
  --sref PATH       Alias for --ref
  --no PHRASE       Negative prompt phrase (repeatable)

Output flags:
  --provider  openai (default) | gemini
  --size      1K | 2K | 4K | <W>x<H>     (default: style or 1K)
  --ratio     1:1, 16:9, 4:3, etc.        (default: style or 1:1)
  --quality   low | medium | high | auto  (openai only, default: high)
  -o          Output file path (default: output/<timestamp>.png)`);
    return;
  }

  switch (cmd) {
    case 'init': return runInit(parseArgs(rest).flags);
    case 'install': return runInstall(parseArgs(rest).flags);
    case 'viewer': return runViewer();
    case 'generate': return generate(rest);
    case 'edit': return edit(rest);
    case 'remove-bg': return removeBg(rest);
    case 'extract-mark': return extractMark(rest);
    case 'styles': return listStyles();
    case 'mods': return listMods();
    case 'refs': return listRefs();
    case 'save-style': return saveStyle(rest);
    case 'save-mod': return saveMod(rest);
    case 'save-ref': return saveRef(rest);
    default: console.error(`Unknown command: ${cmd}. Run 'img help'.`); process.exit(1);
  }
}

const KEY_HINTS = {
  OPENAI_API_KEY: 'Get one at: https://platform.openai.com/api-keys',
  GEMINI_API_KEY: 'Get one at: https://aistudio.google.com/apikey',
};

async function pickProvider(flags) {
  const name = flags.provider || DEFAULT_PROVIDER;
  const provider = PROVIDERS[name];
  if (!provider) { console.error(`Unknown provider "${name}". Use openai or gemini.`); process.exit(1); }
  if (!process.env[provider.keyEnv]) {
    if (!process.stdin.isTTY) {
      console.error(`Missing ${provider.keyEnv}. Run 'img init' or set the env var.`);
      process.exit(1);
    }
    const key = await promptAndSaveKey(provider.keyEnv);
    if (!key) { console.error('Aborted.'); process.exit(1); }
    process.env[provider.keyEnv] = key;
  }
  return { name, ...provider, apiKey: process.env[provider.keyEnv] };
}

async function promptAndSaveKey(keyEnv) {
  const envDir = DEV_MODE ? __dirname : HOME_DIR;
  fs.mkdirSync(envDir, { recursive: true });
  const envPath = path.join(envDir, '.env');
  console.error(`img — first-time use of ${keyEnv}`);
  if (KEY_HINTS[keyEnv]) console.error(KEY_HINTS[keyEnv]);
  const key = await promptSecret(`  ${keyEnv} (input hidden): `);
  if (!key) return null;
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  fs.writeFileSync(envPath, appendEnvLine(existing, keyEnv, key), { mode: 0o600 });
  console.error(`  ✓ saved to ${envPath}`);
  console.error('');
  return key;
}

// ============================================================
// SETUP: init / install / viewer
// ============================================================

async function runInit(flags = {}) {
  const envDir = DEV_MODE ? __dirname : HOME_DIR;
  fs.mkdirSync(envDir, { recursive: true });
  const envPath = path.join(envDir, '.env');
  const existing = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const hasOpenai = /^OPENAI_API_KEY=\S/m.test(existing);
  const hasGemini = /^GEMINI_API_KEY=\S/m.test(existing);

  console.error('img — first-time setup');
  console.error('');

  let envBlock = existing;

  if (hasOpenai) {
    console.error(`✓ OPENAI_API_KEY already configured at ${envPath}`);
  } else {
    let key = flags.key;
    if (!key) {
      console.error('Get an OpenAI key at: https://platform.openai.com/api-keys');
      key = await promptSecret('  OPENAI_API_KEY (input hidden): ');
    }
    if (!key) { console.error('Aborted — no key provided.'); process.exit(1); }
    envBlock = appendEnvLine(envBlock, 'OPENAI_API_KEY', key);
    console.error('  ✓ saved');
  }

  if (!hasGemini && process.stdin.isTTY && flags['skip-gemini'] !== true) {
    console.error('');
    console.error('Optional: Gemini API key (fallback provider via --provider gemini).');
    console.error('Get one at: https://aistudio.google.com/apikey  — or just press enter to skip.');
    const gemini = await promptSecret('  GEMINI_API_KEY (optional, hidden): ');
    if (gemini) {
      envBlock = appendEnvLine(envBlock, 'GEMINI_API_KEY', gemini);
      console.error('  ✓ saved');
    }
  }

  if (envBlock !== existing) {
    fs.writeFileSync(envPath, envBlock, { mode: 0o600 });
  }

  if (!DEV_MODE) {
    console.error('');
    seedLibrary();
  }

  console.error('');
  try {
    installSkills();
  } catch (err) {
    console.error(`  WARNING: skill install failed — ${err.message}`);
    console.error("  Claude Code integration won't work until you run 'img install --skills' manually.");
  }

  if (flags['no-venv'] !== true) {
    console.error('');
    const wantVenv = flags.venv === true ? true : await promptYesNo('Set up Python venv for extract-mark vectorization? (y/N) ', false);
    if (wantVenv) {
      try {
        await installVenv();
      } catch (err) {
        console.error(`  (skipped venv install: ${err.message})`);
      }
    } else {
      console.error('  (skipped — run "img install --venv" later if you want extract-mark)');
    }
  }

  console.error('');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.error('img is ready.');
  console.error('');
  console.error('Try one of these:');
  console.error('  img generate "a single matte ceramic bottle of hand wash" --style studio-luxury');
  console.error('  img styles                          # list curated style library');
  console.error('  img viewer                          # open localhost:3000 review UI');
  console.error('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

function appendEnvLine(block, key, value) {
  const lines = block.split(/\r?\n/).filter(line => {
    const eq = line.indexOf('=');
    return !(eq > 0 && line.slice(0, eq).trim() === key);
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push(`${key}=${value}`);
  return lines.join('\n') + '\n';
}

function promptYesNo(label, defaultYes) {
  if (!process.stdin.isTTY) return Promise.resolve(defaultYes);
  return new Promise(resolve => {
    const readline = require('node:readline');
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(label, answer => {
      rl.close();
      const a = (answer || '').trim().toLowerCase();
      if (!a) return resolve(defaultYes);
      resolve(a === 'y' || a === 'yes');
    });
  });
}

function promptSecret(label) {
  const readline = require('node:readline');
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    process.stderr.write(label);
    if (!process.stdin.isTTY) {
      rl.question('', answer => { rl.close(); resolve(answer.trim()); });
      return;
    }
    const stdin = process.stdin;
    stdin.setRawMode(true);
    let buf = '';
    const cleanup = () => { stdin.setRawMode(false); stdin.removeListener('data', onData); rl.close(); };
    const onData = ch => {
      const code = ch[0];
      if (code === 0x0d || code === 0x0a) { cleanup(); process.stderr.write('\n'); resolve(buf.trim()); return; }
      if (code === 0x03) { cleanup(); process.stderr.write('\n'); process.exit(130); }
      if (code === 0x08 || code === 0x7f) { buf = buf.slice(0, -1); return; }
      if (code < 0x20 || code === 0x1b) return;
      buf += ch.toString('utf8');
    };
    stdin.on('data', onData);
  });
}

function seedLibrary(silent) {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  for (const sub of ['styles', 'mods', 'refs']) {
    const src = path.join(SEED_LIBRARY_DIR, sub);
    const dest = path.join(LIBRARY_DIR, sub);
    fs.mkdirSync(dest, { recursive: true });
    if (!fs.existsSync(src)) continue;
    const copied = copyDirMissing(src, dest);
    if (copied && !silent) console.error(`Seeded ${sub}/ → ${dest} (${copied} new file${copied === 1 ? '' : 's'})`);
  }
}

function seedLibrarySilent() { seedLibrary(true); }

function copyDirMissing(src, dest) {
  let copied = 0;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copied += copyDirMissing(s, d);
    else if (!fs.existsSync(d)) {
      fs.copyFileSync(s, d);
      copied++;
    }
  }
  return copied;
}

async function runInstall(flags) {
  const did = [];
  if (flags.skills) { installSkills(); did.push('skills'); }
  if (flags.venv) { await installVenv(); did.push('venv'); }
  if (!did.length) {
    console.error('Usage: img install --skills | --venv');
    console.error('  --skills   Copy bundled Claude Code skill to ~/.claude/skills/img-cli/ (or $CLAUDE_CONFIG_DIR)');
    console.error('  --venv     Create ~/.img-cli/.venv with pillow + potracer (for extract-mark)');
    process.exit(1);
  }
}

function installSkills() {
  const skillSource = path.join(__dirname, 'skills', 'img-cli');
  const skillDest = path.join(claudeConfigDir(), 'skills', 'img-cli');
  if (!fs.existsSync(skillSource)) {
    throw new Error(`skill files not found at ${skillSource}`);
  }
  fs.mkdirSync(path.dirname(skillDest), { recursive: true });
  fs.cpSync(skillSource, skillDest, { recursive: true, force: true });
  console.error(`✓ Claude Code skill installed → ${skillDest}`);
}

async function installVenv() {
  fs.mkdirSync(path.dirname(VENV_DIR), { recursive: true });
  if (fs.existsSync(VENV_DIR)) {
    console.error(`✓ venv already exists at ${VENV_DIR}`);
    return;
  }
  const python = findPythonCommand();
  if (!python) throw new Error('Python 3 not found on PATH (tried python3, python, and py -3 where available)');
  console.error(`Creating venv at ${VENV_DIR}...`);
  const create = spawnPython(python, ['-m', 'venv', VENV_DIR], { stdio: 'inherit', windowsHide: true });
  if (create.status !== 0) throw new Error(`${formatPythonCommand(python)} -m venv failed (is venv available?)`);
  console.error('Installing pillow + potracer...');
  const pip = spawnPython({ command: venvPython(), args: [] }, ['-m', 'pip', 'install', '--quiet', 'pillow', 'potracer', 'numpy', 'scipy'], { stdio: 'inherit', windowsHide: true });
  if (pip.status !== 0) throw new Error('pip install failed');
  console.error('✓ venv ready — extract-mark will use it automatically');
}

function runViewer() {
  const viewerPath = path.join(__dirname, 'viewer.js');
  if (!fs.existsSync(viewerPath)) { console.error(`viewer.js not found at ${viewerPath}`); process.exit(1); }
  const { spawn } = require('child_process');
  const child = spawn(process.execPath, [viewerPath], { stdio: 'inherit' });
  let shuttingDown = false;
  const forwardSignal = signal => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!child.killed) child.kill(signal);
    const timer = setTimeout(() => process.exit(signal === 'SIGINT' ? 130 : 143), 1500);
    timer.unref();
  };
  process.once('SIGINT', () => forwardSignal('SIGINT'));
  process.once('SIGTERM', () => forwardSignal('SIGTERM'));
  child.on('close', (code, signal) => {
    if (signal === 'SIGINT') process.exit(130);
    if (signal === 'SIGTERM') process.exit(143);
    process.exit(code ?? 0);
  });
}

// ============================================================
// GENERATE
// ============================================================

async function generate(args) {
  const { positionals, flags } = parseArgs(args);
  const userPrompt = positionals.join(' ');
  if (!userPrompt) { console.error('Usage: img generate "description" [--style S] [--mod M] [--ref R] [--no PHRASE]'); process.exit(1); }

  const provider = await pickProvider(flags);
  const output = flags.o || autoOutput('gen');
  const quality = flags.quality || 'high';

  const assembled = assemblePrompt({ userPrompt, flags, allowRefs: true });

  console.error(`[${provider.name}] Generating: "${assembled.fullPrompt.slice(0, 100)}${assembled.fullPrompt.length > 100 ? '...' : ''}"`);
  if (assembled.refImages.length) console.error(`  Refs: ${assembled.refImages.length} image(s)`);
  console.error(`  Size: ${assembled.size}, Ratio: ${assembled.ratio}`);

  const result = await provider.call({
    prompt: assembled.fullPrompt,
    images: assembled.refImages,
    size: assembled.size,
    ratio: assembled.ratio,
    quality,
    apiKey: provider.apiKey,
    model: provider.model,
  });

  if (!result) { console.error('Generate failed'); process.exit(1); }
  saveImageWithSidecar(output, result, {
    command: 'generate',
    prompt: userPrompt,
    fullPrompt: assembled.fullPrompt,
    style: flags.style || null,
    mods: flags.mod || [],
    refs: assembled.refImages,
    no: assembled.negatives,
    size: assembled.size,
    ratio: assembled.ratio,
    quality,
    provider: provider.name,
    model: provider.model,
  });
}

// ============================================================
// EDIT
// ============================================================

async function edit(args) {
  const { positionals, flags } = parseArgs(args);
  const imagePath = positionals[0];
  const userPrompt = positionals.slice(1).join(' ');
  if (!imagePath || !userPrompt) { console.error('Usage: img edit <image> "instruction" [--mod M] [--no PHRASE]'); process.exit(1); }

  const provider = await pickProvider(flags);
  const output = flags.o || autoOutput('edit');
  const quality = flags.quality || 'high';

  const assembled = assemblePrompt({ userPrompt, flags, allowRefs: false });

  console.error(`[${provider.name}] Editing: ${imagePath}`);
  console.error(`  Instruction: "${assembled.fullPrompt.slice(0, 100)}${assembled.fullPrompt.length > 100 ? '...' : ''}"`);

  const result = await provider.call({
    prompt: assembled.fullPrompt,
    images: [imagePath],
    size: assembled.size,
    ratio: assembled.ratio,
    quality,
    apiKey: provider.apiKey,
    model: provider.model,
  });

  if (!result) { console.error('Edit failed'); process.exit(1); }
  saveImageWithSidecar(output, result, {
    command: 'edit',
    prompt: userPrompt,
    fullPrompt: assembled.fullPrompt,
    style: null,
    mods: flags.mod || [],
    refs: [],
    no: assembled.negatives,
    size: assembled.size,
    ratio: assembled.ratio,
    quality,
    provider: provider.name,
    model: provider.model,
  });
}

// ============================================================
// REMOVE-BG
// ============================================================

async function removeBg(args) {
  const { positionals, flags } = parseArgs(args);
  const imagePath = positionals[0];
  if (!imagePath) { console.error('Usage: img remove-bg <image>'); process.exit(1); }

  const provider = await pickProvider(flags);
  const output = flags.o || autoOutput('nobg');

  console.error(`[${provider.name}] Step 1: Generating green-screen version...`);
  const greenResult = await provider.call({
    prompt: 'Place the main subject of this image on a perfectly solid #00FF00 bright green background. Keep the subject exactly the same. The background must be pure uniform green with no gradients or shadows.',
    images: [imagePath],
    size: '1K', ratio: '1:1', quality: 'high',
    apiKey: provider.apiKey,
    model: provider.model,
  });

  if (!greenResult) { console.error('Failed to generate green-screen version'); process.exit(1); }

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
// EXTRACT-MARK (brand board → isolated PNG + SVG)
// ============================================================

async function extractMark(args) {
  const { positionals, flags } = parseArgs(args);
  const inputBoard = positionals[0];
  if (!inputBoard) { console.error('Usage: img extract-mark <brand-board.png> [-o file.svg]'); process.exit(1); }
  if (!fs.existsSync(inputBoard)) { console.error(`Input not found: ${inputBoard}`); process.exit(1); }

  const baseName = path.basename(inputBoard, path.extname(inputBoard));
  const outputSvg = flags.o || path.join(OUTPUT_DIR, `${baseName}-mark.svg`);
  const silhouettePng = outputSvg.replace(/\.svg$/i, '.png');
  const colorPng = outputSvg.replace(/\.svg$/i, '-color.png');
  fs.mkdirSync(path.dirname(outputSvg), { recursive: true });

  if (!fs.existsSync(venvPython())) {
    if (process.stdin.isTTY) {
      console.error('extract-mark needs a Python venv with pillow + potracer + scipy (one-time setup).');
      const ok = await promptYesNo('Set it up now? (Y/n) ', true);
      if (ok) { try { await installVenv(); } catch (err) { console.error(`venv setup failed — ${err.message}`); process.exit(1); } }
      else { console.error("Run 'img install --venv' when you're ready."); process.exit(1); }
    } else {
      console.error("extract-mark needs a Python venv. Run 'img install --venv'.");
      process.exit(1);
    }
  }

  const venvBin = venvPython();
  const python = fs.existsSync(venvBin) ? { command: venvBin, args: [] } : findPythonCommand();
  if (!python) { console.error('Python 3 not found.'); process.exit(1); }

  console.error('[1/2] CV: detecting canonical mark and rendering clean silhouette...');
  const cropScript = path.join(__dirname, 'scripts', 'crop_mark.py');
  if (!fs.existsSync(cropScript)) { console.error(`Missing crop script: ${cropScript}`); process.exit(1); }
  const cropResult = spawnPython(python, [cropScript, inputBoard, silhouettePng, colorPng], { encoding: 'utf8', windowsHide: true });
  if (cropResult.status !== 0) {
    console.error('CV crop failed:', (cropResult.stderr || '').slice(0, 500));
    process.exit(1);
  }

  console.error('[2/2] Vectorizing silhouette with potrace...');
  const traceScript = path.join(__dirname, 'scripts', 'extract_mark.py');
  if (!fs.existsSync(traceScript)) { console.error(`Missing trace script: ${traceScript}`); process.exit(1); }
  const py = spawnPython(python, [traceScript, silhouettePng, outputSvg], { encoding: 'utf8', windowsHide: true });
  if (py.status !== 0) {
    console.error('Vectorization failed:', (py.stderr || '').slice(0, 500));
    process.exit(1);
  }

  console.log(outputSvg);
  console.error(`(also wrote silhouette PNG to ${silhouettePng})`);
  console.error(`(also wrote color crop to ${colorPng})`);
}

// ============================================================
// PROMPT ASSEMBLY
// ============================================================

function assemblePrompt({ userPrompt, flags, allowRefs }) {
  const style = flags.style ? loadStyle(flags.style) : null;
  if (flags.style && !style) { console.error(`Style "${flags.style}" not found. Run 'img styles'.`); process.exit(1); }

  const mods = (flags.mod || []).map(name => {
    const m = loadMod(name);
    if (!m) { console.error(`Mod "${name}" not found. Run 'img mods'.`); process.exit(1); }
    return m;
  });

  const cliRefSpecs = allowRefs ? (flags.ref || []) : [];
  const cliRefs = cliRefSpecs.map(spec => {
    const r = resolveRef(spec);
    if (!r) { console.error(`Ref "${spec}" not found. Run 'img refs' or pass a path.`); process.exit(1); }
    return r;
  });

  const styleRefs = allowRefs && style?.refs
    ? style.refs.map(name => {
        const r = resolveRef(name);
        if (!r) { console.error(`Style "${flags.style}" references unknown ref "${name}".`); process.exit(1); }
        return r;
      })
    : [];

  const legacyStyleRefs = allowRefs && style?.legacyImages?.length
    ? [{ images: style.legacyImages, role: 'style' }]
    : [];

  const allNegs = dedupe([
    ...(style?.no || []),
    ...mods.flatMap(m => m.no || []),
    ...(flags.no || []),
  ].map(cleanPromptBlock).filter(Boolean));

  const promptParts = [];
  const prefix = cleanPromptBlock(style?.prefix);
  const prompt = cleanPromptBlock(userPrompt);
  const mergedPrompt = prefix && prompt ? mergePromptWithPrefix(prefix, prompt) : null;
  if (mergedPrompt) {
    promptParts.push(mergedPrompt);
  } else {
    if (prefix) promptParts.push(prefix);
    if (prompt) promptParts.push(prompt);
  }
  for (const m of mods) {
    const text = cleanPromptBlock(m.text);
    if (text) promptParts.push(text);
  }
  const suffix = cleanPromptBlock(style?.suffix);
  if (suffix) promptParts.push(suffix);
  if (allNegs.length) {
    promptParts.push(['DO NOT INCLUDE:', ...allNegs.map(n => `- ${n}`)].join('\n'));
  }

  const orderedRefs = [...sortRefsByRole(cliRefs), ...sortRefsByRole(styleRefs), ...legacyStyleRefs];
  const refImages = dedupe(orderedRefs.flatMap(r => r.images));

  return {
    fullPrompt: promptParts.join('\n\n'),
    refImages,
    negatives: allNegs,
    size: flags.size || style?.imageSize || '1K',
    ratio: flags.ratio || style?.aspectRatio || '1:1',
  };
}

function cleanPromptBlock(value) {
  return String(value || '').trim().replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function mergePromptWithPrefix(prefix, prompt) {
  if (/^\s*:/.test(prompt)) {
    const body = prompt.replace(/^\s*:\s*/, '');
    const separator = body.startsWith('- ') ? ':\n' : ': ';
    return `${prefix.replace(/\s*[:.]\s*$/, '')}${separator}${body}`;
  }
  const lastLine = prefix.split('\n').pop().trim();
  if (lastLine === 'CONCEPT') return `${prefix}:\n${prompt}`;
  return null;
}

function sortRefsByRole(refs) {
  const subjects = refs.filter(r => r.role === 'subject');
  const others = refs.filter(r => r.role !== 'subject');
  return [...subjects, ...others];
}

function dedupe(arr) {
  return [...new Set(arr)];
}

// ============================================================
// LIBRARY: STYLES
// ============================================================

function loadStyle(name) {
  const dir = path.join(STYLES_DIR, name);
  const cfgPath = path.join(dir, 'config.json');
  if (!fs.existsSync(cfgPath)) return null;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.legacyImages = fs.readdirSync(dir)
    .filter(f => IMAGE_EXT.test(f))
    .map(f => path.join(dir, f));
  return cfg;
}

function listStyles() {
  fs.mkdirSync(STYLES_DIR, { recursive: true });
  const styles = fs.readdirSync(STYLES_DIR)
    .filter(f => fs.existsSync(path.join(STYLES_DIR, f, 'config.json')))
    .map(name => {
      const cfg = JSON.parse(fs.readFileSync(path.join(STYLES_DIR, name, 'config.json'), 'utf8'));
      const imgs = fs.readdirSync(path.join(STYLES_DIR, name)).filter(f => IMAGE_EXT.test(f)).length;
      return { name, description: cfg.description || '', imgs, refs: (cfg.refs || []).length };
    });

  if (!styles.length) { console.log('No styles. Run: img save-style <name> "prompt prefix"'); return; }
  for (const s of styles) {
    const tags = [s.imgs && `${s.imgs} imgs`, s.refs && `${s.refs} refs`].filter(Boolean).join(' ');
    console.log(`  ${s.name.padEnd(20)} ${tags.padEnd(16)} ${s.description}`);
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
    refs: [],
    no: [],
  };

  fs.writeFileSync(path.join(styleDir, 'config.json'), JSON.stringify(config, null, 2));
  console.log(`Saved style "${name}" at ${styleDir}`);
  console.log('Add reference images: copy .png/.jpg files into that directory.');
}

// ============================================================
// LIBRARY: MODS
// ============================================================

function loadMod(name) {
  const txt = path.join(MODS_DIR, name + '.txt');
  if (fs.existsSync(txt)) {
    return { text: fs.readFileSync(txt, 'utf8').trim(), no: [] };
  }
  const json = path.join(MODS_DIR, name + '.json');
  if (fs.existsSync(json)) {
    const cfg = JSON.parse(fs.readFileSync(json, 'utf8'));
    return { text: cfg.text || '', no: cfg.no || [] };
  }
  return null;
}

function listMods() {
  fs.mkdirSync(MODS_DIR, { recursive: true });
  const files = fs.readdirSync(MODS_DIR).filter(f => /\.(txt|json)$/.test(f));
  if (!files.length) { console.log('No mods. Run: img save-mod <name> "phrase"'); return; }
  for (const f of files) {
    const name = f.replace(/\.(txt|json)$/, '');
    const m = loadMod(name);
    const preview = (m.text || '').slice(0, 60);
    const negs = m.no.length ? ` (no: ${m.no.join(', ').slice(0, 30)})` : '';
    console.log(`  ${name.padEnd(20)} ${preview}${negs}`);
  }
}

function saveMod(args) {
  const name = args[0];
  const phrase = args.slice(1).join(' ');
  if (!name || !phrase) { console.error('Usage: img save-mod <name> "phrase"'); process.exit(1); }
  fs.mkdirSync(MODS_DIR, { recursive: true });
  const target = path.join(MODS_DIR, name + '.txt');
  fs.writeFileSync(target, phrase + '\n');
  console.log(`Saved mod "${name}" at ${target}`);
}

// ============================================================
// LIBRARY: REFS
// ============================================================

function resolveRef(spec) {
  if (/[/\\]/.test(spec) || IMAGE_EXT.test(spec)) {
    if (!fs.existsSync(spec)) return null;
    return { images: [spec], role: 'style' };
  }
  const dir = path.join(REFS_DIR, spec);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const cfgPath = path.join(dir, 'config.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  const images = fs.readdirSync(dir)
    .filter(f => IMAGE_EXT.test(f))
    .sort()
    .map(f => path.join(dir, f));
  if (!images.length) return null;
  return { images, role: cfg.role || 'style', note: cfg.note };
}

function listRefs() {
  fs.mkdirSync(REFS_DIR, { recursive: true });
  const dirs = fs.readdirSync(REFS_DIR).filter(d => fs.statSync(path.join(REFS_DIR, d)).isDirectory());
  if (!dirs.length) { console.log('No refs. Run: img save-ref <name> <image>'); return; }
  for (const d of dirs) {
    const r = resolveRef(d);
    if (!r) continue;
    const role = `(${r.role})`.padEnd(10);
    console.log(`  ${d.padEnd(20)} ${role} ${r.images.length} img  ${r.note || ''}`);
  }
}

function saveRef(args) {
  const { positionals, flags } = parseArgs(args);
  const name = positionals[0];
  const imgPath = positionals[1];
  if (!name || !imgPath) { console.error('Usage: img save-ref <name> <image> [--role subject|style]'); process.exit(1); }
  if (!fs.existsSync(imgPath)) { console.error(`Image not found: ${imgPath}`); process.exit(1); }

  const role = flags.role && ['subject', 'style'].includes(flags.role) ? flags.role : 'style';
  const refDir = path.join(REFS_DIR, name);
  fs.mkdirSync(refDir, { recursive: true });

  const existing = fs.readdirSync(refDir).filter(f => IMAGE_EXT.test(f));
  const nextN = String(existing.length + 1).padStart(2, '0');
  const ext = path.extname(imgPath).toLowerCase() || '.png';
  const target = path.join(refDir, `${nextN}${ext}`);
  fs.copyFileSync(imgPath, target);

  const cfgPath = path.join(refDir, 'config.json');
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {};
  cfg.role = role;
  if (flags.note) cfg.note = flags.note;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  console.log(`Saved ref "${name}" (${role}) — ${existing.length + 1} image(s) total`);
}

// ============================================================
// OPENAI (gpt-image-2)
// ============================================================

async function callOpenAI({ prompt, images, size, ratio, quality, apiKey, model }) {
  const sizeStr = openaiSize(size, ratio);
  const useEdits = images.length > 0;
  const url = useEdits
    ? 'https://api.openai.com/v1/images/edits'
    : 'https://api.openai.com/v1/images/generations';

  let request;
  if (useEdits) {
    const boundary = '----imgcli' + crypto.randomBytes(8).toString('hex');
    const fields = [
      { name: 'model', value: model },
      { name: 'prompt', value: prompt },
      { name: 'size', value: sizeStr },
      { name: 'quality', value: quality },
      { name: 'n', value: '1' },
    ];
    for (const img of images) {
      fields.push({
        name: 'image[]',
        filename: path.basename(img),
        contentType: mimeFor(img),
        value: fs.readFileSync(img),
      });
    }
    request = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
      },
      body: buildMultipart(boundary, fields),
    };
  } else {
    request = {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model, prompt, size: sizeStr, quality, n: 1 }),
    };
  }

  const result = await fetchJsonWithTimeout(url, request, 600000, 'OpenAI');
  if (!result) return null;

  const { response, payload } = result;
  if (!response.ok) {
    console.error('OpenAI error:', payload.error?.message || JSON.stringify(payload));
    return null;
  }
  const b64 = payload.data?.[0]?.b64_json;
  if (!b64) {
    console.error('OpenAI returned no image:', JSON.stringify(payload).slice(0, 200));
    return null;
  }
  return Buffer.from(b64, 'base64');
}

function openaiSize(size, ratio) {
  if (/^\d+x\d+$/.test(size)) return size;
  const map = {
    '1K:1:1': '1024x1024',
    '1K:3:2': '1536x1024',
    '1K:2:3': '1024x1536',
    '1K:16:9': '1536x1024',
    '1K:9:16': '1024x1536',
    '2K:1:1': '2048x2048',
    '2K:16:9': '2048x1152',
    '2K:9:16': '1152x2048',
    '4K:16:9': '3840x2160',
    '4K:9:16': '2160x3840',
  };
  return map[`${size}:${ratio}`] || 'auto';
}

function buildMultipart(boundary, fields) {
  const chunks = [];
  for (const f of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (f.filename) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${f.name}"; filename="${f.filename}"\r\n` +
        `Content-Type: ${f.contentType || 'application/octet-stream'}\r\n\r\n`
      ));
      chunks.push(f.value);
      chunks.push(Buffer.from('\r\n'));
    } else {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${f.name}"\r\n\r\n${f.value}\r\n`
      ));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

// ============================================================
// GEMINI
// ============================================================

async function callGemini({ prompt, images, size, ratio, apiKey, model }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const parts = [];
  for (const ref of images) {
    parts.push({ inlineData: { mimeType: mimeFor(ref), data: fs.readFileSync(ref).toString('base64') } });
  }
  parts.push({ text: prompt });

  const generationConfig = {
    responseModalities: ['TEXT', 'IMAGE'],
    imageConfig: { imageSize: size, aspectRatio: ratio },
  };

  const result = await fetchJsonWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts }], generationConfig }),
  }, 120000, 'Gemini');
  if (!result) return null;

  const { response, payload } = result;
  if (!response.ok) {
    console.error('Gemini error:', payload.error?.message || JSON.stringify(payload));
    return null;
  }

  const resParts = payload.candidates?.[0]?.content?.parts || [];
  for (const part of resParts) {
    if (part.inlineData) return Buffer.from(part.inlineData.data, 'base64');
  }
  const text = resParts.map(p => p.text || '').join('');
  if (text) console.error('Model response (no image):', text.slice(0, 200));
  return null;
}

// ============================================================
// UTILS
// ============================================================

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

async function fetchJsonWithTimeout(url, options, timeoutMs, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const text = await response.text();
      let payload;
      try {
        payload = text ? JSON.parse(text) : {};
      } catch {
        console.error(`${label} returned non-JSON response (${response.status}): ${text.slice(0, 200)}`);
        return null;
      }
      return { response, payload };
    } catch (err) {
      if (err.name === 'AbortError') {
        console.error(`${label} request timed out after ${Math.round(timeoutMs / 1000)}s`);
        return null;
      }
      if (attempt === 0) {
        console.error(`${label} request failed: ${err.message}. Retrying once...`);
        continue;
      }
      console.error(`${label} request failed: ${err.message}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      const value = (next && !next.startsWith('--') && next !== '-o') ? (i++, next) : true;
      if (REPEATABLE.has(key)) {
        flags[key] ||= [];
        flags[key].push(value);
      } else {
        flags[key] = value;
      }
    } else if (arg === '-o') {
      flags.o = argv[++i];
    } else {
      positionals.push(arg);
    }
  }
  if (flags.sref) {
    flags.ref = [...(flags.ref || []), ...flags.sref];
    delete flags.sref;
  }
  return { positionals, flags };
}

function autoOutput(prefix) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(OUTPUT_DIR, `${prefix}-${ts}.png`);
}

function saveImageWithSidecar(imagePath, image, meta) {
  fs.mkdirSync(path.dirname(imagePath), { recursive: true });
  fs.writeFileSync(imagePath, image);
  writeSidecar(imagePath, meta);
  console.log(imagePath);
}

function writeSidecar(imagePath, meta) {
  const sidecar = {
    command: meta.command,
    prompt: meta.prompt,
    fullPrompt: meta.fullPrompt,
    style: meta.style,
    mods: meta.mods,
    refs: meta.refs,
    no: meta.no,
    size: meta.size,
    ratio: meta.ratio,
    quality: meta.quality,
    provider: meta.provider,
    model: meta.model,
    flagged: false,
    ts: new Date().toISOString(),
  };
  const sidecarPath = imagePath.replace(/\.[^.]+$/, '') + '.json';
  try {
    fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));
  } catch (err) {
    console.error(`Warning: failed to write sidecar ${sidecarPath}: ${err.message}`);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
