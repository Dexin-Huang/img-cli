# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `img bundle <board>` — full brand asset ZIP from a brand board: SVG variants, favicons, app/PWA/store icons, social cards, webmanifest, palette, guidelines.
- `img color-trace <image>` — flat icon art → crisp color-preserving SVG plus the full iOS/web raster icon set and zip. Auto-detects the palette (`--colors` to override), floods rounded corners full-bleed, traces each color as one smoothed potrace layer. Complements the silhouette-only `extract-mark`.
- Skill: prompt gallery (`references/gallery-icons.md`) with four worked app-icon examples, and three composition rules (verbs-and-shapes, structure-then-goal, literal text in quotes).

### Changed
- `img install --venv` now provisions numpy + cairosvg alongside pillow + potracer, and upgrades existing venvs instead of skipping them.

## [0.1.0] — 2026-04-26

### Added
- Initial release: plug-and-play install via `npm install -g github:Dexin-Huang/img-cli`.
- `img init` — interactive secure setup for `OPENAI_API_KEY` (and optional `GEMINI_API_KEY`); seeds library, installs Claude Code skill, optionally bootstraps Python venv.
- `img install --skills` / `--venv` — discrete subcommands for the parts `init` automates.
- `img extract-mark <board>` — pipeline that extracts an isolated logo mark from a brand identity board and vectorizes to SVG via potrace.
- `img viewer` — Node http server at `localhost:3000` for reviewing outputs with verdict buttons, notes, and inline mark extraction.
- Curated style library: `brand-board`, `studio-luxury`, `macicon-tactile`, `logo`, `photo`, `watercolor`, `technical`, `ui-mockup`.
- Stackable composition primitives: `--mod`, `--ref`, `--no`, `--style` with structured-brief prompt assembly.
- Sidecar JSON next to every generated image recording the full recipe (prompt, style, mods, refs, negatives, size, ratio, quality, provider, model).
- Cross-machine state: `~/.img-cli/.env` for keys, `~/.img-cli/library/` for the user library, `~/.img-cli/.venv/` for the vectorizer.

### Notes
- Provider-pluggable: `gpt-image-2` (default) and `gemini-3.1-flash-image-preview`. Flip the default by editing one constant.
- Zero npm dependencies. Externals: Python 3 (for `extract-mark`), `ffmpeg` (for `remove-bg`).
