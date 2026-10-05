"""Cuts the subject out of extracted frames with rembg.

Usage: python matte.py <frames_dir> <out_dir> <model>
Reads f00000.png.. from frames_dir in order and writes m00000.png.. to out_dir: white RGBA with
alpha = subject mask. Prints "<done>/<total>" after each frame so the caller can show progress.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image
from rembg import new_session, remove


def cut(frames_dir: Path, out_dir: Path, model: str) -> None:
    frames = sorted(frames_dir.glob("f*.png"))
    if not frames:
        raise SystemExit(f"no frames (f*.png) in {frames_dir}")
    out_dir.mkdir(parents=True, exist_ok=True)
    session = new_session(model)
    for i, frame in enumerate(frames):
        with Image.open(frame) as img:
            mask = remove(img.convert("RGB"), session=session, only_mask=True)
        if not isinstance(mask, Image.Image):
            raise TypeError(
                f"rembg returned {type(mask).__name__} for {frame}, expected a PIL image"
            )
        out = Image.new("RGBA", mask.size, (255, 255, 255, 0))
        out.putalpha(mask.convert("L"))
        out.save(out_dir / f"m{i:05d}.png")
        print(f"{i + 1}/{len(frames)}", flush=True)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    cut(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
