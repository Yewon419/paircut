import type { FontId, ProjectVars, TextClip } from '../../shared/project';
import { ANIM_IN, ANIM_OUT, clipDuration, POP_FROM, resolveTokens, RISE_PX } from '../../shared/project';

export const FONT_FAMILY = 'Pretendard';
export const FONT_WEIGHT: Record<FontId, number> = { black: 900, bold: 700, medium: 500 };
/** Style sizes are authored for a 1080px-wide frame and scaled to the target frame. */
export const DESIGN_WIDTH = 1080;
const MAX_WIDTH_FRAC = 0.88;
const LINE_HEIGHT = 1.22;

export async function loadFonts(): Promise<void> {
  await Promise.all(
    Object.values(FONT_WEIGHT).map((w) => document.fonts.load(`${w} 40px "${FONT_FAMILY}"`, '가A1')),
  );
}

export interface TextRaster {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Run {
  text: string;
  color: string;
}

function fontOf(clip: TextClip, k: number): string {
  return `${FONT_WEIGHT[clip.style.font]} ${clip.style.size * k}px "${FONT_FAMILY}"`;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const words = para.split(' ');
    let line = '';
    for (const word of words) {
      const candidate = line ? `${line} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxWidth || !line) {
        line = candidate;
      } else {
        out.push(line);
        line = word;
      }
      while (ctx.measureText(line).width > maxWidth && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && ctx.measureText(line.slice(0, cut)).width > maxWidth) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out;
}

function runsOf(line: string, clip: TextClip): Run[] {
  const { color, highlight, highlightColor, highlightDigits } = clip.style;
  const marks = new Array<boolean>(line.length).fill(false);
  if (highlight) {
    let from = 0;
    for (;;) {
      const i = line.indexOf(highlight, from);
      if (i === -1) break;
      for (let j = i; j < i + highlight.length; j++) marks[j] = true;
      from = i + highlight.length;
    }
  }
  if (highlightDigits) {
    for (let i = 0; i < line.length; i++) {
      if (/[0-9]/.test(line[i])) marks[i] = true;
      else if (line[i] === ',' && /[0-9]/.test(line[i - 1] ?? '') && /[0-9]/.test(line[i + 1] ?? '')) marks[i] = true;
    }
  }
  const runs: Run[] = [];
  for (let i = 0; i < line.length; i++) {
    const c = marks[i] ? highlightColor : color;
    const last = runs.at(-1);
    if (last && last.color === c) last.text += line[i];
    else runs.push({ text: line[i], color: c });
  }
  return runs;
}

function roundRect(ctx: CanvasRenderingContext2D, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(r, 0);
  ctx.arcTo(w, 0, w, h, r);
  ctx.arcTo(w, h, 0, h, r);
  ctx.arcTo(0, h, 0, 0, r);
  ctx.arcTo(0, 0, w, 0, r);
  ctx.closePath();
}

/** Renders a text clip at its settled (post-animation) state for a frame of the given size. */
export function rasterizeText(clip: TextClip, vars: ProjectVars, frameW: number, frameH: number): TextRaster {
  const k = frameW / DESIGN_WIDTH;
  const style = clip.style;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const font = fontOf(clip, k);
  ctx.font = font;
  const text = resolveTokens(clip.text, vars);
  const lines = wrapLines(ctx, text, MAX_WIDTH_FRAC * frameW);
  const widths = lines.map((l) => ctx.measureText(l).width);
  const size = style.size * k;
  const lineH = size * LINE_HEIGHT;
  const stroke = style.background ? 0 : style.strokeWidth * k;
  const padX = style.background ? size * 0.45 : stroke + 2;
  const padY = style.background ? size * 0.28 : stroke + 2;
  const w = Math.ceil(Math.max(1, ...widths) + padX * 2);
  const h = Math.ceil(lines.length * lineH + padY * 2);
  canvas.width = w;
  canvas.height = h;

  if (style.background) {
    ctx.fillStyle = style.background;
    roundRect(ctx, w, h, 6 * k);
    ctx.fill();
  }
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  lines.forEach((line, i) => {
    const y = padY + lineH * (i + 0.5);
    let x = style.align === 'center' ? (w - widths[i]) / 2 : padX;
    const runs = runsOf(line, clip);
    if (stroke > 0) {
      ctx.lineWidth = stroke * 2;
      ctx.strokeStyle = style.strokeColor;
      let sx = x;
      for (const r of runs) {
        ctx.strokeText(r.text, sx, y);
        sx += ctx.measureText(r.text).width;
      }
    }
    for (const r of runs) {
      ctx.fillStyle = r.color;
      ctx.fillText(r.text, x, y);
      x += ctx.measureText(r.text).width;
    }
  });

  const ax = clip.x * frameW;
  const ay = clip.y * frameH;
  return {
    canvas,
    x: Math.round(style.align === 'center' ? ax - w / 2 : ax),
    y: Math.round(ay - h / 2),
    w,
    h,
  };
}

const cache = new Map<string, TextRaster>();
const CACHE_LIMIT = 400;

export function cachedRaster(clip: TextClip, vars: ProjectVars, frameW: number, frameH: number): TextRaster {
  const key = JSON.stringify([clip.text, clip.style, clip.x, clip.y, vars, frameW, frameH]);
  const hit = cache.get(key);
  if (hit) return hit;
  const raster = rasterizeText(clip, vars, frameW, frameH);
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, raster);
  return raster;
}

export interface AnimState {
  alpha: number;
  scale: number;
  /** Vertical offset in design (1080-wide) pixels. */
  dy: number;
}

/** Linear in/out ramps; the export graph uses the same formulas in ffmpeg expressions. */
export function animState(clip: TextClip, t: number): AnimState {
  if (clip.anim === 'none') return { alpha: 1, scale: 1, dy: 0 };
  const local = t - clip.start;
  const pIn = Math.max(0, Math.min(1, local / ANIM_IN));
  const pOut = Math.max(0, Math.min(1, (clipDuration(clip) - local) / ANIM_OUT));
  return {
    alpha: pIn * pOut,
    scale: clip.anim === 'pop' ? POP_FROM + (1 - POP_FROM) * pIn : 1,
    dy: clip.anim === 'rise' ? RISE_PX * (1 - pIn) : 0,
  };
}

export function drawText(ctx: CanvasRenderingContext2D, raster: TextRaster, state: AnimState, k: number): void {
  if (state.alpha <= 0) return;
  const w = raster.w * state.scale;
  const h = raster.h * state.scale;
  const cx = raster.x + raster.w / 2;
  const cy = raster.y + raster.h / 2 + state.dy * k;
  ctx.save();
  ctx.globalAlpha = state.alpha;
  ctx.drawImage(raster.canvas, cx - w / 2, cy - h / 2, w, h);
  ctx.restore();
}
