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

## Brand identity workflow (the high-leverage pipeline)

When a user asks for a logo, brand identity, app icons, or any complete visual identity for a project, **do not generate a single logo directly** — model-generated isolated logos are competent-not-iconic. Instead, run the two-step brand pipeline. It generalizes to any brand, any industry.

### Step 1 — Generate the brand identity board

Compose a structured brief and pass it as the prompt to `--style brand-board`. The brief should cover these axes (don't skip any — each one anchors a different decision the model has to make):

```
Brand: <name> — <one-line description>.
Personality: <3-5 adjectives>.
Industry: <category>.
Audience: <who uses it, what they care about>.
Mood: <a sensory image: "morning light through a gym window", "candle-lit library evening">.
Typography: <face character, with named exemplars: "geometric sans-serif (the spirit of Söhne, GT America)">.
Shape language: <how the mark should feel — "sharp angular", "soft custom geometry", "single iconic gesture">.
Color direction: <accent + neutral, with hex if known>.
Visual elements: <what the supporting tiles should show — UI, photography, data viz, patterns>.
Style keywords: <3-5 vibe descriptors>.
Aesthetic references: <3-5 named brands/studios that anchor the canon>.
```

Then:

```bash
img generate "<the full brief above>" --style brand-board --quality high -o output/brandboard-<slug>.png
```

This produces a 16-tile cohesive identity system at 2K resolution: hero poster, app icons at multiple scales, wordmark lockups, typography specimen, UI mockups, color palette, business card, t-shirt mockup, and one tile dedicated to the canonical mark isolated on white (labeled "PRIMARY MARK / VECTOR ASSET"). Cost: ~$0.30, runtime: ~2 min.

### Step 2 — Extract the canonical mark + SVG

```bash
img extract-mark output/brandboard-<slug>.png -o output/<slug>-logo.svg
# → output/<slug>-logo.png   (clean black silhouette, model-cleaned from the board)
# → output/<slug>-logo.svg   (vector, traced via potrace from the silhouette)
```

The pipeline is two steps: model edit ("create a clean mark from this brand board") then potrace. The output PNG is monochrome black silhouette (potracer is single-color); the actual brand-color version of the mark lives inside the brand board itself (tile 02 PRIMARY MARK + every applied tile).

### Step 3 — Use the assets

- **SVG**: drop into Figma / inline into HTML. To recolor, change `fill="black"` to your brand color in the `<path>` element.
- **PNG silhouette**: use as-is for monochrome contexts, or recolor in Pillow / any image editor.
- **Colored mark**: open the brand board PNG, screenshot/crop tile 02 (always labeled `PRIMARY MARK / VECTOR ASSET`).
- **Other applied forms** (app icon, t-shirt, business card): all visible as tiles in the brand board.

### Failure modes to watch

- **Safety filter false positive**: gpt-image-2 occasionally rejects benign brand-board edits with `safety_violations=[abuse]`. Retry once — almost always succeeds.
- **Model picks wrong tile during extract**: if the brand board tile is busy or the canonical mark is hard to identify, the silhouette can come out wrong. Re-run extract-mark — different sample, often fixes it.
- **Brief too vague**: outputs default to category averages. The named exemplars (Stripe, Strava, Aesop, Tracksmith, etc.) are what produce on-brand specifics. Always include 3-5 references.

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
