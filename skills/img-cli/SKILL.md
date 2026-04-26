---
name: img-cli
description: Generate images via gpt-image-2 with a curated style library, brand-board generation, and SVG mark extraction. Use when the user asks for any image-generation task — logos, app icons, hero shots, brand identity boards, illustrations, photos, or vector marks.
---

# img-cli — Claude Code skill

The user has installed `img-cli` globally. Invoke it as `img <command>` from any working directory. Output images land in `./output/` of the current cwd, with a `<filename>.json` sidecar recording the recipe.

## When to use

- User says: "generate", "make", "create", "render" + image/logo/icon/poster/photo/illustration/mockup
- User says: "brand board", "identity system", "moodboard"
- User says: "extract logo as svg", "vectorize", "trace this image"
- User shares an image and asks to edit it

## Quick reference

```bash
img generate "<prompt>" [--style S] [--mod M] [--ref R] [--no PHRASE] [--quality Q] [-o file]
img edit <image> "<instruction>" [-o file]
img remove-bg <image> [-o file]
img extract-mark <brand-board.png> [-o file.svg]
img styles                # list available presets
img mods                  # list prompt modifiers
img refs                  # list named reference images
```

## Style routing (infer from user request)

If the user did not pass `--style`, infer one from natural-language hints:

- "brand board", "identity system", "moodboard" → `--style brand-board` (use `--quality high` and `--size 2K`)
- "logo", "brand mark", "icon", "app icon", "favicon" → `--style logo`
- "macOS icon", "tactile icon", "Apple Design Award" → `--style macicon-tactile`
- "studio shot", "product shot", "hero shot", "Aesop", "Kinfolk" → `--style studio-luxury`
- "photo", "photorealistic" → `--style photo`
- "watercolor", "painted" → `--style watercolor`
- "ui mockup", "interface" → `--style ui-mockup`
- "diagram", "schematic", "technical drawing" → `--style technical`
- Ambiguous → omit `--style`

## Output path convention

- If user passed `-o`, honor it.
- Otherwise: write to `./output/gen-YYYY-MM-DDTHH-MM-SS.png` for generation and `./output/edit-YYYY-MM-DDTHH-MM-SS.png` for edits.
- Output paths are relative to the cwd where `img` is invoked.

## Brand board pattern (the high-leverage move)

For any brand identity work, prefer `--style brand-board` over single-logo generation. The brand board format generates a 16-tile cohesive identity system (logo lockups, wordmarks, app icons, posters, typography specimens, color palette, mockups) — far stronger than asking the model for a single isolated mark.

After generating a brand board, you can extract a clean isolated SVG mark from it:

```bash
img extract-mark output/brandboard-foo.png
# → output/brandboard-foo-mark.png + output/brandboard-foo-mark.svg
```

## Composition primitives

Logos and marks benefit from the structured-brief format. Prompts should use **verbs and shapes** ("an arc that crosses the X-height"), not adjective stacks ("modern, clean, minimalist"). Adjectives produce category averages; verbs and shapes produce specifics.

Stack additional primitives:
- `--mod NAME` for modifiers (e.g. `--mod golden-hour`)
- `--ref NAME|PATH` for visual reference anchors
- `--no PHRASE` for negative constraints

## Reviewing output

```bash
img viewer
# starts localhost:3000 — grid of all output/ images with verdict buttons + extract-mark button
```

## Error handling

- `Missing OPENAI_API_KEY` → tell user to run `img init`.
- `extract-mark` fails with "venv missing" → tell user to run `img install --venv`.
- Other stderr → surface verbatim, do not retry silently.
