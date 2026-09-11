#!/usr/bin/env python3
"""Generate the Maestro macOS app icon from build/logo-source.png.

Produces, in build/:
  - icon.png        1024x1024 master (rounded-rect, transparent outside)
  - icon.iconset/   all sizes macOS wants
  - icon.icns       packaged icon consumed by electron-builder (mac.icon)

macOS does NOT auto-round app icons, so we composite the mark onto a
rounded-rectangle background sized to Apple's icon grid (~80% of the
canvas, ~22% corner radius) with internal padding.

Regenerate with:  python3 build/make-icon.py && \
  iconutil -c icns build/icon.iconset -o build/icon.icns
"""
import os
from PIL import Image, ImageChops, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "logo-source.png")

CANVAS = 1024                 # master icon size
RECT = 824                    # rounded-rect body (Apple grid ~80.5% of canvas)
RADIUS = 185                  # corner radius (~22.4% of RECT — the macOS squircle)
MARK_TARGET = 600             # longest side of the mark inside the rect (~73%)
BG = (255, 255, 255, 255)     # white background, faithful to the source art

ICONSET_SPECS = [
    (16, "icon_16x16.png"), (32, "icon_16x16@2x.png"),
    (32, "icon_32x32.png"), (64, "icon_32x32@2x.png"),
    (128, "icon_128x128.png"), (256, "icon_128x128@2x.png"),
    (256, "icon_256x256.png"), (512, "icon_256x256@2x.png"),
    (512, "icon_512x512.png"), (1024, "icon_512x512@2x.png"),
]


def main() -> None:
    im = Image.open(SRC).convert("RGBA")

    # Crop the mark out of its surrounding whitespace: anything that differs
    # from pure white (beyond anti-aliasing noise) is part of the mark.
    diff = ImageChops.difference(im.convert("RGB"), Image.new("RGB", im.size, (255, 255, 255)))
    bbox = diff.convert("L").point(lambda p: 255 if p > 8 else 0).getbbox()
    mark = im.crop(bbox)

    # Scale the mark to fit the target size, preserving aspect ratio.
    scale = MARK_TARGET / max(mark.size)
    mark = mark.resize((round(mark.size[0] * scale), round(mark.size[1] * scale)), Image.LANCZOS)

    # Rounded-rect white background, transparent outside the corners.
    off = (CANVAS - RECT) // 2
    rmask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(rmask).rounded_rectangle(
        [off, off, off + RECT - 1, off + RECT - 1], radius=RADIUS, fill=255
    )
    canvas = Image.composite(
        Image.new("RGBA", (CANVAS, CANVAS), BG),
        Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0)),
        rmask,
    )

    # Center the mark.
    canvas.alpha_composite(mark, ((CANVAS - mark.size[0]) // 2, (CANVAS - mark.size[1]) // 2))

    master = os.path.join(HERE, "icon.png")
    canvas.save(master)

    iconset = os.path.join(HERE, "icon.iconset")
    os.makedirs(iconset, exist_ok=True)
    for size, name in ICONSET_SPECS:
        canvas.resize((size, size), Image.LANCZOS).save(os.path.join(iconset, name))

    print(f"source bbox={bbox} mark={mark.size} -> {master} + {iconset}")


if __name__ == "__main__":
    main()
