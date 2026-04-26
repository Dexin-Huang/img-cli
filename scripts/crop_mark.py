#!/usr/bin/env python
"""
Auto-crop the canonical brand mark from a brand identity board, and produce a clean
black silhouette of it on white — ready for vectorization.

Pipeline:
  1. find the largest mark-shaped (squarish + angular cuts) chromatic region
  2. fill any internal holes from texture patterns via morphological closing
  3. output a black-on-white silhouette at high resolution

Usage: python crop_mark.py <input.png> <silhouette.png> [<color-crop.png>]
"""
import sys
from pathlib import Path
import numpy as np
from PIL import Image
from scipy.ndimage import label, binary_closing, binary_fill_holes


BG_THRESHOLD = 30           # chroma below this = background (paper / pure black)
MIN_FRAC = 0.0005           # ignore components smaller than 0.05% of the image
MAX_FILL_RATIO = 0.75       # marks have angular cuts (≤75% of their bbox); swatches are ≥95%
ASPECT_RANGE = (0.5, 2.0)   # marks are roughly square; swatches are wide-and-short
TOP_N = 30                  # consider this many largest colored components
PAD_FRAC = 0.18             # padding around the chosen mark


def main(input_path: str, silhouette_path: str, color_path: str = None) -> int:
    img = Image.open(input_path).convert("RGB")
    arr = np.array(img)
    H, W = arr.shape[:2]
    total_px = H * W

    r = arr[:, :, 0].astype(int)
    g = arr[:, :, 1].astype(int)
    b = arr[:, :, 2].astype(int)
    chroma = np.maximum(np.maximum(np.abs(r - g), np.abs(g - b)), np.abs(r - b))
    colored = chroma > BG_THRESHOLD

    if not colored.any():
        print("no colored regions found", file=sys.stderr)
        return 1

    labeled, n = label(colored)
    sizes = np.bincount(labeled.ravel())
    sizes[0] = 0
    min_size = int(total_px * MIN_FRAC)

    # Rank components by size, filter for mark-shaped (squarish + low fill ratio).
    candidates = []
    top_ids = np.argsort(sizes)[::-1][:TOP_N]
    for cid in top_ids:
        if sizes[cid] < min_size:
            break
        ys, xs = np.where(labeled == cid)
        y0, y1 = int(ys.min()), int(ys.max() + 1)
        x0, x1 = int(xs.min()), int(xs.max() + 1)
        bw, bh = x1 - x0, y1 - y0
        bbox_area = bw * bh
        fill = sizes[cid] / bbox_area
        aspect = bw / bh if bh else 99
        squarish = ASPECT_RANGE[0] <= aspect <= ASPECT_RANGE[1]
        angular = fill <= MAX_FILL_RATIO
        if squarish and angular:
            candidates.append((int(cid), int(sizes[cid]), x0, y0, x1, y1, fill, aspect))

    if not candidates:
        print("no mark-shaped components found (everything looked like swatches/text)", file=sys.stderr)
        return 1

    candidates.sort(key=lambda c: -c[1])
    cid, size, x0, y0, x1, y1, fill, aspect = candidates[0]
    print(f"chose component #{cid}: {size}px, bbox {x1-x0}x{y1-y0}, fill={fill:.2f}, aspect={aspect:.2f}")

    pad = int(max(x1 - x0, y1 - y0) * PAD_FRAC)
    box = (max(0, x0 - pad), max(0, y0 - pad),
           min(W, x1 + pad), min(H, y1 + pad))

    Path(silhouette_path).parent.mkdir(parents=True, exist_ok=True)

    # Build the silhouette from the *full* color of the mark — match all pixels with
    # similar chroma to the median of the chosen component. This is more robust than
    # using only the connected-component mask, because it captures pixels that share
    # the mark's color but were broken into smaller components by texture.
    cm = labeled == cid
    median_r = int(np.median(arr[cm, 0]))
    median_g = int(np.median(arr[cm, 1]))
    median_b = int(np.median(arr[cm, 2]))
    color_dist = np.sqrt(
        (arr[:, :, 0].astype(int) - median_r) ** 2
        + (arr[:, :, 1].astype(int) - median_g) ** 2
        + (arr[:, :, 2].astype(int) - median_b) ** 2
    )
    same_color = color_dist < 60
    # Limit to the bbox region so we don't pick up other instances of the same color
    # (e.g., wordmarks on other tiles)
    region = np.zeros_like(same_color)
    region[box[1]:box[3], box[0]:box[2]] = True
    region_mask = same_color & region

    # Fill internal holes (texture pattern, antialiasing breaks)
    filled = binary_fill_holes(region_mask)
    # Also close small gaps (open spaces between mark sub-shapes that shouldn't be there)
    closed = binary_closing(filled, structure=np.ones((3, 3)), iterations=2)

    # Crop to bbox and render as black-on-white
    sil = closed[box[1]:box[3], box[0]:box[2]]
    h, w = sil.shape
    out = np.full((h, w, 3), 255, dtype=np.uint8)
    out[sil] = 0
    Image.fromarray(out).save(silhouette_path)
    print(f"saved silhouette {silhouette_path} ({w}x{h})")

    # Optional: also save the original-color crop
    if color_path:
        crop = img.crop(box)
        crop.save(color_path)
        print(f"saved color crop {color_path} ({crop.size[0]}x{crop.size[1]})")

    return 0


if __name__ == "__main__":
    if len(sys.argv) not in (3, 4):
        print("Usage: crop_mark.py <input.png> <silhouette.png> [<color-crop.png>]", file=sys.stderr)
        sys.exit(2)
    silhouette_path = sys.argv[2]
    color_path = sys.argv[3] if len(sys.argv) > 3 else None
    sys.exit(main(sys.argv[1], silhouette_path, color_path))
