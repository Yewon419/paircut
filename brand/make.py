"""Builds the paircut mark, wordmark logo and app icon from one geometry.

Mark: a circle cut down the middle, coral half lifted, violet half dropped.
Outputs (next to this file): mark.svg, icon.svg, logo.svg, icon.png (256), icon.ico.
Run: python brand/make.py
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from fontTools.pens.svgPathPen import SVGPathPen  # type: ignore[import-untyped]
from fontTools.pens.transformPen import TransformPen  # type: ignore[import-untyped]
from fontTools.ttLib import TTFont  # type: ignore[import-untyped]
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
FONT = HERE.parent / "src" / "fonts" / "Pretendard-Bold.woff2"

SLATE = "#dde3ec"
CORAL = "#f0585c"
VIOLET = "#4b3ff0"
INK = "#3b4250"

RADIUS = 320
GAP = 36
SHIFT = 40
CENTER = 512


@dataclass(frozen=True)
class Half:
    cx: float
    cy: float
    left: bool
    color: str


HALVES = (
    Half(CENTER - GAP / 2, CENTER - SHIFT / 2, True, CORAL),
    Half(CENTER + GAP / 2, CENTER + SHIFT / 2, False, VIOLET),
)


def half_path(h: Half, scale: float, dx: float, dy: float) -> str:
    x = dx + h.cx * scale
    top = dy + (h.cy - RADIUS) * scale
    bottom = dy + (h.cy + RADIUS) * scale
    r = RADIUS * scale
    sweep = 0 if h.left else 1
    return f'<path d="M{x:.2f} {top:.2f} A{r:.2f} {r:.2f} 0 0 {sweep} {x:.2f} {bottom:.2f} Z" fill="{h.color}"/>'


def mark_paths(scale: float, dx: float, dy: float) -> str:
    return "".join(half_path(h, scale, dx, dy) for h in HALVES)


def word_path(
    text: str, size: float, x0: float, baseline: float, tracking: float
) -> tuple[str, float]:
    font = TTFont(str(FONT))
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    upm = font["head"].unitsPerEm
    s = size / upm
    pen = SVGPathPen(glyphs)
    x = x0
    for ch in text:
        name = cmap.get(ord(ch))
        if name is None:
            raise ValueError(f"glyph for {ch!r} missing in {FONT.name}")
        glyphs[name].draw(TransformPen(pen, (s, 0, 0, -s, x, baseline)))
        x += glyphs[name].width * s + tracking * size
    return pen.getCommands(), x - tracking * size


def write_svgs() -> None:
    mark = mark_paths(1, 0, 0)
    svg = 'xmlns="http://www.w3.org/2000/svg"'
    (HERE / "mark.svg").write_text(
        f'<svg {svg} viewBox="150 150 724 724">{mark}</svg>\n', encoding="utf-8"
    )
    (HERE / "icon.svg").write_text(
        f'<svg {svg} viewBox="0 0 1024 1024"><rect width="1024" height="1024" fill="{SLATE}"/>{mark}</svg>\n',
        encoding="utf-8",
    )

    height = 160
    scale = height / (2 * RADIUS + SHIFT)
    mark_w = (2 * RADIUS + GAP) * scale
    pad = 24
    mark_small = mark_paths(
        scale,
        pad - (CENTER - RADIUS - GAP / 2) * scale,
        pad - (CENTER - RADIUS - SHIFT / 2) * scale,
    )
    size = 132
    baseline = pad + height * 0.78
    word, end = word_path("paircut", size, pad + mark_w + 40, baseline, -0.03)
    dot, end = word_path(".", size, end + 0.01 * size, baseline, 0)
    width = end + pad
    total_h = height + 2 * pad
    (HERE / "logo.svg").write_text(
        f'<svg {svg} viewBox="0 0 {width:.0f} {total_h}">{mark_small}'
        f'<path d="{word}" fill="{INK}"/><path d="{dot}" fill="{CORAL}"/></svg>\n',
        encoding="utf-8",
    )


def draw_icon(px: int) -> Image.Image:
    ss = 4
    size = px * ss
    k = size / 1024
    img = Image.new("RGBA", (size, size), SLATE)
    d = ImageDraw.Draw(img)
    for h in HALVES:
        box = (
            (h.cx - RADIUS) * k,
            (h.cy - RADIUS) * k,
            (h.cx + RADIUS) * k,
            (h.cy + RADIUS) * k,
        )
        start, end = (90, 270) if h.left else (270, 90)
        d.pieslice(box, start, end, fill=h.color)
    return img.resize((px, px), Image.Resampling.LANCZOS)


def write_icons() -> None:
    big = draw_icon(256)
    big.save(HERE / "icon.png")
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = [draw_icon(s) for s in sizes]
    frames[-1].save(
        HERE / "icon.ico",
        format="ICO",
        sizes=[(s, s) for s in sizes],
        append_images=frames[:-1],
    )


if __name__ == "__main__":
    write_svgs()
    write_icons()
    print("wrote mark.svg icon.svg logo.svg icon.png icon.ico")
