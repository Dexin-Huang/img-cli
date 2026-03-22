---
name: handoff_shortcut_skill
description: Handoff note for packaging the shortcut skill + img-cli as shareable tools
type: project
---

## Task: Package shortcut skill + img-cli for sharing

The `/shortcut` Claude Code skill creates desktop shortcuts with AI-generated icons.
It works beautifully and should be packaged for others to use.

### What exists today

**Shortcut skill**: `C:\Users\dexin\.claude\commands\shortcut\`
- SKILL.md with full prompt template
- Hardcoded paths to `C:\Users\dexin\...`
- Depends on img-cli for icon generation
- Depends on Pillow for ICO conversion

**img-cli**: `D:\Projects\img-cli\` (also at github.com/Dexin-Huang/img-cli)
- 280-line single-file CLI (`img.js`)
- Gemini 3.1 Flash Image for generation
- Style library with presets + visual references (--sref)
- Commands: generate, edit, remove-bg, styles, save-style
- Zero npm deps, uses Gemini API key

### What needs to happen to share

1. **img-cli**: Publish to npm (`npm install -g img-cli`)
   - Add `init` command for API key setup (same as video-cli)
   - Add `install --skills` for Claude Code skill integration
   - Make paths dynamic (not hardcoded to dexin's machine)

2. **Shortcut skill**: Package as a Claude Code plugin
   - Replace hardcoded `C:\Users\dexin\...` with `os.homedir()` equivalents
   - Replace hardcoded `D:\Projects\img-cli\img.js` with just `img` (global npm bin)
   - The skill should work after: `npm install -g img-cli && img init`

3. **Dependency chain**: `shortcut skill → img-cli → Gemini API + ffmpeg + Pillow`

### Design pattern to follow

Same as video-cli:
- Single-file CLI, zero npm deps
- `init` command for secure API key setup
- `install --skills` copies SKILL.md to `~/.claude/skills/`
- Style library grows with use (like video-cli's JIT enrichment)

**Why:** After the third CLI (video-cli, img-cli, shortcut), the pattern will be clear enough to extract a reusable CLI scaffolding skill.
