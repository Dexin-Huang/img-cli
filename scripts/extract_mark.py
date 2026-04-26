#!/usr/bin/env python
"""
Threshold a PNG and vectorize to SVG using potrace.
Used by `img extract-mark` after the gpt-image-2 extract step.

Usage: python extract_mark.py <input.png> <output.svg>
"""
import sys
from pathlib import Path
from PIL import Image
import potrace


def main(input_path: str, output_path: str) -> int:
    with Image.open(input_path) as source:
        img = source.convert("L")
    bitmap = potrace.Bitmap(img, blacklevel=0.5)
    path = bitmap.trace()

    width, height = img.size
    parts: list[str] = [
        '<?xml version="1.0" encoding="UTF-8" standalone="no"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}" '
        f'width="{width}" height="{height}">',
    ]

    d_segments: list[str] = []
    for curve in path:
        d_segments.append(f'M{curve.start_point.x:.2f},{curve.start_point.y:.2f}')
        for segment in curve:
            if segment.is_corner:
                c = segment.c
                end = segment.end_point
                d_segments.append(f'L{c.x:.2f},{c.y:.2f} L{end.x:.2f},{end.y:.2f}')
            else:
                c1, c2, end = segment.c1, segment.c2, segment.end_point
                d_segments.append(
                    f'C{c1.x:.2f},{c1.y:.2f} {c2.x:.2f},{c2.y:.2f} {end.x:.2f},{end.y:.2f}'
                )
        d_segments.append('Z')

    parts.append(
        f'  <path fill="black" stroke="none" fill-rule="evenodd" d="{" ".join(d_segments)}"/>'
    )
    parts.append('</svg>')

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(parts), encoding="utf-8")
    print(output_path)
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: extract_mark.py <input.png> <output.svg>", file=sys.stderr)
        sys.exit(2)
    sys.exit(main(sys.argv[1], sys.argv[2]))
