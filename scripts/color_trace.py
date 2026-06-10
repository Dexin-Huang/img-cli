"""Crisp color-preserving vector + icon set from flat-color art.

Turns a raster icon/logo (e.g. a gpt-image-2 render) into a clean layered
SVG that keeps the original palette, plus the full iOS/web raster icon set,
zipped. Built for flat art (2-6 colors); gradients are intentionally
flattened — that is what makes the output crisp.

Usage (via the CLI, preferred):
    img color-trace <image.png> [options]

Or directly:
    python color_trace.py <image.png> [options]

Options:
    -o DIR            output directory (default: ./output/<stem>-icons)
    --colors LIST     comma-separated hex palette override, first = background
                      (default: auto-detected)
    --max-colors N    cap for auto-detected palette size (default 6)
    --no-flood        skip flooding rounded corners with the background color
    --no-zip          skip writing the zip bundle

Pipeline: detect/parse palette -> flood corners full-bleed -> snap pixels to
palette -> upscale 2x -> per-color smoothed masks -> potrace each as one
filled layer -> SVG -> render 1024 master -> raster icon set -> zip.

Deps: pillow, numpy, potracer, cairosvg  (pip install pillow numpy potracer cairosvg)

Hard-won constraints (do not "fix" these):
- vtracer's Python binding (0.6.15, Python 3.14) SEGFAULTS if you pass ANY
  keyword argument. That is why this uses potracer instead.
- potracer's foreground is 0/False: the mask must be INVERTED before
  Bitmap(), or you trace the complement of every region.
- potrace emits paths for NONZERO winding. Do not add fill-rule="evenodd";
  it inverts nested shapes (rings render as filled discs and vice versa).
"""

import argparse
import io
import sys
import zipfile
from collections import Counter
from pathlib import Path

try:
    import numpy as np
    import potrace
    from PIL import Image, ImageDraw, ImageFilter
except ImportError as e:
    sys.exit(f"missing dependency: {e.name} - pip install pillow numpy potracer cairosvg")

SCALE = 2          # upscale factor before tracing (smoother curves)
BLUR = 2.2         # mask smoothing radius at upscaled size (rounds jaggies)
TURD = 30          # despeckle: drop traced regions smaller than this (px area)
ALPHAMAX = 1.2     # corner rounding (higher = smoother)
OPTTOL = 0.4       # curve-fit tolerance (higher = simpler paths)
MERGE_DIST = 60    # RGB euclidean distance below which detected colors merge
MIN_AREA = 0.01    # drop detected colors covering less than 1% of pixels

RASTER_SIZES = {
    "ios-appstore-1024.png": 1024,
    "ios-app-180.png": 180,
    "ios-app-120.png": 120,
    "android-play-512.png": 512,
    "pwa-512.png": 512,
    "pwa-192.png": 192,
    "apple-touch-icon-180.png": 180,
    "favicon-48.png": 48,
    "favicon-32.png": 32,
    "favicon-16.png": 16,
}


def hexc(c):
    return "#%02X%02X%02X" % tuple(c)


def parse_palette(spec):
    colors = []
    for tok in spec.split(","):
        tok = tok.strip().lstrip("#")
        if len(tok) != 6:
            sys.exit(f"bad hex color: {tok!r}")
        colors.append(tuple(int(tok[i : i + 2], 16) for i in (0, 2, 4)))
    return colors


def detect_palette(im, max_colors):
    """Cluster to 16 colors, merge near-duplicates, keep significant ones.
    Returns colors sorted by area, largest (background) first."""
    q = im.quantize(colors=16, method=Image.MEDIANCUT, dither=Image.NONE)
    idx = np.array(q)
    pal = q.getpalette()[:48]
    raw = [(int((idx == i).sum()), tuple(pal[i * 3 : i * 3 + 3])) for i in range(16)]
    merged = []  # list of [count, color] — color of the largest member wins
    for n, c in sorted(raw, reverse=True):
        if n == 0:
            continue
        for m in merged:
            if sum((a - b) ** 2 for a, b in zip(c, m[1])) < MERGE_DIST**2:
                m[0] += n
                break
        else:
            merged.append([n, c])
    total = idx.size
    colors = [c for n, c in sorted(merged, reverse=True) if n / total >= MIN_AREA]
    return colors[:max_colors]


def flood_corners(im, bg):
    """Flood the rounded-corner margin with the background color so the tile
    is full-bleed square (Apple rejects alpha and masks corners itself).
    Flooding from corners stops at the tile edge; interior regions of the
    same color are untouched unless connected to a corner."""
    w, h = im.size
    if all(im.getpixel(p) == tuple(bg) for p in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]):
        return im
    for corner in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        ImageDraw.floodfill(im, corner, tuple(bg), thresh=60)
    return im


def trace_layer(mask):
    """bool HxW mask (at upscaled size) -> SVG path 'd' string (source scale)."""
    m = Image.fromarray((mask * 255).astype("uint8")).filter(ImageFilter.GaussianBlur(BLUR))
    a = np.array(m) > 127
    if not a.any():
        return ""
    path = potrace.Bitmap(~a).trace(  # inverted: potracer foreground is 0
        turdsize=TURD, alphamax=ALPHAMAX, opticurve=True, opttolerance=OPTTOL
    )
    s = 1.0 / SCALE
    out = []
    for curve in path:
        p = curve.start_point
        out.append(f"M{p.x*s:.2f} {p.y*s:.2f}")
        for seg in curve.segments:
            e = seg.end_point
            if seg.is_corner:
                c = seg.c
                out.append(f"L{c.x*s:.2f} {c.y*s:.2f}L{e.x*s:.2f} {e.y*s:.2f}")
            else:
                out.append(
                    f"C{seg.c1.x*s:.2f} {seg.c1.y*s:.2f} "
                    f"{seg.c2.x*s:.2f} {seg.c2.y*s:.2f} {e.x*s:.2f} {e.y*s:.2f}"
                )
        out.append("Z")
    return "".join(out)


def build_svg(im, palette):
    """Snap to palette, trace each non-background color as one filled layer."""
    w0, h0 = im.size
    up = im.resize((w0 * SCALE, h0 * SCALE), Image.LANCZOS)
    arr = np.asarray(up, dtype=np.int32)
    pal = np.array(palette, dtype=np.int32)
    idx = ((arr[:, :, None, :] - pal[None, None, :, :]) ** 2).sum(-1).argmin(-1)

    layers = []
    coverage = Counter(idx.ravel())
    # draw larger layers first so small details land on top
    order = sorted(range(1, len(palette)), key=lambda i: -coverage[i])
    for i in order:
        d = trace_layer(idx == i)
        if d:
            layers.append(f'<path d="{d}" fill="{hexc(palette[i])}"/>')
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w0} {h0}" '
        f'width="{w0}" height="{h0}">\n'
        f'<rect width="{w0}" height="{h0}" fill="{hexc(palette[0])}"/>\n'
        + "\n".join(layers)
        + "\n</svg>\n"
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("image")
    ap.add_argument("-o", dest="outdir")
    ap.add_argument("--colors")
    ap.add_argument("--max-colors", type=int, default=6)
    ap.add_argument("--no-flood", action="store_true")
    ap.add_argument("--no-zip", action="store_true")
    args = ap.parse_args()

    src_path = Path(args.image)
    if not src_path.is_file():
        sys.exit(f"input not found: {src_path}")
    stem = src_path.stem

    im = Image.open(src_path).convert("RGB")
    palette = parse_palette(args.colors) if args.colors else detect_palette(im, args.max_colors)
    if len(palette) < 2:
        sys.exit("palette has fewer than 2 colors - nothing to trace")

    out = Path(args.outdir) if args.outdir else Path("output") / f"{stem}-icons"
    out.mkdir(parents=True, exist_ok=True)
    print("palette (bg first):", " ".join(hexc(c) for c in palette))

    if not args.no_flood:
        im = flood_corners(im, palette[0])
    im.save(out / f"{stem}-fullbleed.png")

    svg = build_svg(im, palette)
    svg_path = out / f"{stem}.svg"
    svg_path.write_text(svg)
    print(f"svg: {svg_path}  ({len(svg)} bytes, {svg.count('M')} subpaths)")

    import cairosvg  # deferred: slow import, and only needed past this point

    master_png = cairosvg.svg2png(url=str(svg_path), output_width=1024, output_height=1024)
    master = Image.open(io.BytesIO(master_png)).convert("RGB")
    for name, px in RASTER_SIZES.items():
        master.resize((px, px), Image.LANCZOS).save(out / name)
    master.resize((48, 48), Image.LANCZOS).save(
        out / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)]
    )
    print(f"raster set: {len(RASTER_SIZES)} PNGs + favicon.ico + fullbleed master")

    if not args.no_zip:
        zip_path = out.parent / f"{out.name}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for p in sorted(out.iterdir()):
                zf.write(p, p.name)
        print(f"zip: {zip_path}")


if __name__ == "__main__":
    main()
