#!/usr/bin/env python
"""
Bundle a brand identity into a ZIP of ready-to-ship assets.

Inputs are the outputs of `img extract-mark` plus the original brand board
plus brand metadata (color, name, brief).

Outputs a ZIP at the path given by --out containing all four tiers:
  Tier 1: logo SVG/PNG, mono variants, favicons (PNG + ICO), apple-touch,
          PWA icons, og-image, manifest, palette, brand-board, guidelines
  Tier 2: ios-1024, android-512, maskable-512, windows.ico, macos.icns
  Tier 3: twitter-card, linkedin-banner, github-social
  Tier 4: brand-guidelines.md
"""
import argparse
import io
import json
import re
import sys
import zipfile
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


def hex_to_rgb(hex_str: str):
    h = hex_str.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def load_font(size: int):
    candidates = [
        'C:/Windows/Fonts/segoeuib.ttf',
        'C:/Windows/Fonts/arialbd.ttf',
        'C:/Windows/Fonts/arial.ttf',
        '/System/Library/Fonts/SFNS.ttf',
        '/System/Library/Fonts/Helvetica.ttc',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    ]
    for path in candidates:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def silhouette_to_mask(silhouette_png: str) -> Image.Image:
    """Load black-on-white silhouette PNG → alpha mask (mark = 255)."""
    img = Image.open(silhouette_png).convert('L')
    return img.point(lambda p: 255 if p < 128 else 0)


def colorize(mask: Image.Image, rgb: tuple) -> Image.Image:
    """Mask → RGBA filled with `rgb` where mask is opaque."""
    out = Image.new('RGBA', mask.size, (0, 0, 0, 0))
    layer = Image.new('RGBA', mask.size, (*rgb, 255))
    out.paste(layer, mask=mask)
    return out


def trim_to_mark(img: Image.Image) -> Image.Image:
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def fit_transparent(mark: Image.Image, size: int) -> Image.Image:
    """Resize mark to fit a size×size square with transparent background and no padding override."""
    mw, mh = mark.size
    scale = size / max(mw, mh)
    nw, nh = max(1, int(mw * scale)), max(1, int(mh * scale))
    resized = mark.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((size - nw) // 2, (size - nh) // 2))
    return canvas


def fit_on_bg(mark: Image.Image, size: int, bg_rgb: tuple, padding_frac: float = 0.15) -> Image.Image:
    """Resize mark to fit a size×size square with the given background and padding."""
    canvas = Image.new('RGBA', (size, size), (*bg_rgb, 255))
    target = int(size * (1 - 2 * padding_frac))
    mw, mh = mark.size
    scale = min(target / mw, target / mh)
    nw, nh = max(1, int(mw * scale)), max(1, int(mh * scale))
    resized = mark.resize((nw, nh), Image.LANCZOS)
    canvas.alpha_composite(resized, ((size - nw) // 2, (size - nh) // 2))
    return canvas


def compose_social(mark: Image.Image, name: str, color_rgb: tuple, paper_rgb: tuple,
                   ink_rgb: tuple, w: int, h: int) -> Image.Image:
    """Mark on the left, brand name on the right, paper bg."""
    canvas = Image.new('RGBA', (w, h), (*paper_rgb, 255))
    mark_h = int(h * 0.45)
    mw, mh = mark.size
    scale = mark_h / mh
    new_w = max(1, int(mw * scale))
    mark_resized = mark.resize((new_w, mark_h), Image.LANCZOS)
    pad_x = int(w * 0.07)
    pad_y = (h - mark_h) // 2
    canvas.alpha_composite(mark_resized, (pad_x, pad_y))

    font_size = max(24, int(h * 0.18))
    font = load_font(font_size)
    draw = ImageDraw.Draw(canvas)
    text_x = pad_x + new_w + int(w * 0.04)
    bbox = draw.textbbox((0, 0), name, font=font)
    text_h = bbox[3] - bbox[1]
    text_y = (h - text_h) // 2 - bbox[1]
    draw.text((text_x, text_y), name, fill=(*ink_rgb, 255), font=font)
    return canvas


def recolor_svg(svg_text: str, color_hex: str) -> str:
    out = re.sub(r'fill="[^"]*"', f'fill="{color_hex}"', svg_text)
    out = re.sub(r'fill:\s*[^;"\s]+', f'fill: {color_hex}', out)
    return out


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format='PNG')
    return buf.getvalue()


def jpeg_bytes(img: Image.Image, quality: int = 90) -> bytes:
    buf = io.BytesIO()
    if img.mode == 'RGBA':
        img = img.convert('RGB')
    img.save(buf, format='JPEG', quality=quality)
    return buf.getvalue()


def ico_bytes(mark_rgba: Image.Image, sizes: list) -> bytes:
    """Pillow ICO needs the source large enough to downsample to all requested sizes."""
    buf = io.BytesIO()
    largest = max(sizes)
    src = fit_transparent(mark_rgba, largest)
    src.save(buf, format='ICO', sizes=[(s, s) for s in sizes])
    return buf.getvalue()


def icns_bytes(mark_rgba: Image.Image) -> bytes:
    buf = io.BytesIO()
    src = fit_transparent(mark_rgba, 1024)
    src.save(buf, format='ICNS')
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--board', required=True)
    ap.add_argument('--silhouette', required=True)
    ap.add_argument('--svg', required=True)
    ap.add_argument('--color', required=True)
    ap.add_argument('--ink', default='#14140F')
    ap.add_argument('--paper', default='#F8F7F2')
    ap.add_argument('--name', required=True)
    ap.add_argument('--brief', default='')
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    color_rgb = hex_to_rgb(args.color)
    ink_rgb = hex_to_rgb(args.ink)
    paper_rgb = hex_to_rgb(args.paper)

    mask = silhouette_to_mask(args.silhouette)
    color_mark = trim_to_mark(colorize(mask, color_rgb))
    svg_text = Path(args.svg).read_text(encoding='utf-8')

    files: dict = {}

    # Tier 1 — Web essentials
    files['logo.png'] = png_bytes(fit_transparent(color_mark, 1024))
    files['logo.svg'] = recolor_svg(svg_text, args.color).encode('utf-8')
    files['logo-mono-light.svg'] = recolor_svg(svg_text, '#000000').encode('utf-8')
    files['logo-mono-dark.svg'] = recolor_svg(svg_text, '#FFFFFF').encode('utf-8')
    for size in (16, 32, 48, 96):
        files[f'favicon-{size}.png'] = png_bytes(fit_transparent(color_mark, size))
    files['favicon.ico'] = ico_bytes(color_mark, [16, 32, 48])
    files['apple-touch-icon.png'] = png_bytes(
        fit_on_bg(color_mark, 180, paper_rgb, padding_frac=0.15).convert('RGB'))
    files['icon-192.png'] = png_bytes(fit_transparent(color_mark, 192))
    files['icon-512.png'] = png_bytes(fit_transparent(color_mark, 512))

    # Tier 2 — App store
    files['ios-1024.png'] = png_bytes(
        fit_on_bg(color_mark, 1024, paper_rgb, padding_frac=0.15).convert('RGB'))
    files['android-512.png'] = png_bytes(fit_transparent(color_mark, 512))
    files['maskable-512.png'] = png_bytes(
        fit_on_bg(color_mark, 512, paper_rgb, padding_frac=0.25).convert('RGB'))
    files['windows.ico'] = ico_bytes(color_mark, [16, 32, 48, 64, 128, 256])
    files['macos.icns'] = icns_bytes(color_mark)

    # Tier 3 — Marketing
    files['og-image.png'] = png_bytes(
        compose_social(color_mark, args.name, color_rgb, paper_rgb, ink_rgb, 1200, 630).convert('RGB'))
    files['twitter-card.png'] = png_bytes(
        compose_social(color_mark, args.name, color_rgb, paper_rgb, ink_rgb, 1600, 900).convert('RGB'))
    files['linkedin-banner.png'] = png_bytes(
        compose_social(color_mark, args.name, color_rgb, paper_rgb, ink_rgb, 1584, 396).convert('RGB'))
    files['github-social.png'] = png_bytes(
        compose_social(color_mark, args.name, color_rgb, paper_rgb, ink_rgb, 1280, 640).convert('RGB'))

    # Tier 4 — Source / metadata
    manifest = {
        'name': args.name,
        'short_name': args.name,
        'icons': [
            {'src': 'icon-192.png', 'sizes': '192x192', 'type': 'image/png'},
            {'src': 'icon-512.png', 'sizes': '512x512', 'type': 'image/png'},
            {'src': 'maskable-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'},
        ],
        'theme_color': args.color,
        'background_color': args.paper,
        'display': 'standalone',
    }
    files['site.webmanifest'] = json.dumps(manifest, indent=2).encode('utf-8')
    files['palette.json'] = json.dumps(
        {'primary': args.color, 'ink': args.ink, 'paper': args.paper}, indent=2).encode('utf-8')
    files['brand-guidelines.md'] = (
        f'# {args.name} — Brand Guidelines\n\n'
        f'## Palette\n'
        f'- **Primary**: `{args.color}`\n'
        f'- **Ink**: `{args.ink}`\n'
        f'- **Paper**: `{args.paper}`\n\n'
        f'## Brief\n{args.brief or "(no brief recorded)"}\n\n'
        f'## Files in this bundle\n'
        f'- `logo.svg` / `logo.png` — primary brand-color mark\n'
        f'- `logo-mono-light.svg` / `logo-mono-dark.svg` — monochrome variants for context\n'
        f'- `favicon.ico` + `favicon-{{16,32,48,96}}.png` — browser tab icons\n'
        f'- `apple-touch-icon.png` — iOS home screen (180×180, opaque)\n'
        f'- `icon-192.png` / `icon-512.png` — PWA / Android Chrome\n'
        f'- `maskable-512.png` — PWA maskable (safe-zone padded)\n'
        f'- `ios-1024.png` — iOS App Store marketing (no alpha)\n'
        f'- `android-512.png` — Play Store\n'
        f'- `windows.ico` / `macos.icns` — desktop application icons\n'
        f'- `og-image.png` — social sharing card (1200×630)\n'
        f'- `twitter-card.png` / `linkedin-banner.png` / `github-social.png` — platform-specific\n'
        f'- `site.webmanifest` / `palette.json` — declarative metadata\n'
        f'- `brand-board.png` — full identity board (the source artifact)\n'
    ).encode('utf-8')
    files['brand-board.png'] = Path(args.board).read_bytes()

    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.out, 'w', zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)

    out_size = Path(args.out).stat().st_size
    print(f'wrote {args.out} ({len(files)} files, {out_size:,} bytes)')
    return 0


if __name__ == '__main__':
    sys.exit(main())
