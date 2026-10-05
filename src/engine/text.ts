import type { FontId, ProjectVars, TextClip } from '../../shared/project';
import { ANIM_IN, ANIM_OUT, clipDuration, POP_FROM, resolveTokens, RISE_PX, spanIndex } from '../../shared/project';

const FONTS: Record<FontId, { family: string; weight: number }> = {
  black: { family: 'Pretendard', weight: 900 },
  extrabold: { family: 'Pretendard', weight: 800 },
  bold: { family: 'Pretendard', weight: 700 },
  semibold: { family: 'Pretendard', weight: 600 },
  medium: { family: 'Pretendard', weight: 500 },
  regular: { family: 'Pretendard', weight: 400 },
  light: { family: 'Pretendard', weight: 300 },
  extralight: { family: 'Pretendard', weight: 200 },
  thin: { family: 'Pretendard', weight: 100 },
  serif: { family: 'Cutdesk Serif', weight: 800 },
  'pres-bold': { family: 'Cutdesk Presentation', weight: 700 },
  'pres-black': { family: 'Cutdesk Presentation', weight: 900 },
  hand: { family: 'Cutdesk Hand', weight: 400 },
};
/** Shadow blur radius as a fraction of the font size. */
const SHADOW_BLUR = 0.16;
/** Style sizes are authored for a 1080px-wide frame and scaled to the target frame. */
export const DESIGN_WIDTH = 1080;
const MAX_WIDTH_FRAC = 0.88;
const LINE_HEIGHT = 1.22;

export async function loadFonts(): Promise<void> {
  await Promise.all(
    Object.values(FONTS).map((f) => document.fonts.load(`${f.weight} 40px "${f.family}"`, '가A1')),
  );
}

export interface TextRaster {
  canvas: HTMLCanvasElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** How one character is drawn: base style, highlight and spans already folded in. Lengths in frame pixels. */
interface Look {
  color: string;
  font: string;
  tracking: number;
  scale: number;
  /** Radians, clockwise. */
  rotate: number;
  dx: number;
  dy: number;
}

interface Run {
  text: string;
  look: Look;
  width: number;
}

function fontString(id: FontId, customFont: string, px: number): string {
  const f = FONTS[id];
  // Regular weight so a single-face installed font is not synthetically bolded.
  if (customFont && fontInstalled(customFont)) return `400 ${px}px "${customFont}", "${f.family}"`;
  return `${f.weight} ${px}px "${f.family}"`;
}

const installed = new Map<string, boolean>();

/**
 * Whether a font with this family name is installed. The probe text is measured with the name in
 * front of two different generic fallbacks; if neither width changes, the name matched nothing.
 */
export function fontInstalled(name: string): boolean {
  const known = installed.get(name);
  if (known !== undefined) return known;
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) throw new Error('2d canvas unavailable');
  const probe = 'abcmwiIl1 가나다힣';
  const width = (font: string) => {
    ctx.font = font;
    return ctx.measureText(probe).width;
  };
  const found = ['monospace', 'serif'].some((g) => width(`72px "${name}", ${g}`) !== width(`72px ${g}`));
  installed.set(name, found);
  return found;
}

function highlightMarks(text: string, clip: TextClip): boolean[] {
  const { highlight, highlightDigits } = clip.style;
  const marks = new Array<boolean>(text.length).fill(false);
  if (highlight) {
    let from = 0;
    for (;;) {
      const i = text.indexOf(highlight, from);
      if (i === -1) break;
      for (let j = i; j < i + highlight.length; j++) marks[j] = true;
      from = i + highlight.length;
    }
  }
  if (highlightDigits) {
    for (let i = 0; i < text.length; i++) {
      if (/[0-9]/.test(text[i])) marks[i] = true;
      else if (text[i] === ',' && /[0-9]/.test(text[i - 1] ?? '') && /[0-9]/.test(text[i + 1] ?? '')) marks[i] = true;
    }
  }
  return marks;
}

/** Per-character look; later spans win where spans overlap. */
function looksOf(text: string, clip: TextClip, k: number): Look[] {
  const s = clip.style;
  const size = s.size * k;
  const marks = highlightMarks(text, clip);
  const base = { font: fontString(s.font, s.customFont, size), tracking: s.tracking * size, scale: 1, rotate: 0, dx: 0, dy: 0 };
  // Indexed by UTF-16 unit, like indexOf and slice.
  const looks: Look[] = Array.from({ length: text.length }, (_, i) => ({ ...base, color: marks[i] ? s.highlightColor : s.color }));
  for (const span of clip.spans) {
    const at = spanIndex(text, span.match, span.nth);
    if (at === -1) continue;
    const scale = span.scale ?? 1;
    const font =
      span.font !== undefined
        ? fontString(span.font, '', size * scale)
        : scale !== 1
          ? fontString(s.font, s.customFont, size * scale)
          : null;
    for (let j = at; j < at + span.match.length; j++) {
      const l = looks[j];
      looks[j] = {
        color: span.color ?? l.color,
        font: font ?? l.font,
        tracking: s.tracking * size * scale,
        scale,
        rotate: ((span.rotate ?? 0) * Math.PI) / 180,
        dx: (span.dx ?? 0) * k,
        dy: (span.dy ?? 0) * k,
      };
    }
  }
  return looks;
}

function sameLook(a: Look, b: Look): boolean {
  return (
    a.color === b.color &&
    a.font === b.font &&
    a.tracking === b.tracking &&
    a.scale === b.scale &&
    a.rotate === b.rotate &&
    a.dx === b.dx &&
    a.dy === b.dy
  );
}

/** Characters [a, b) grouped into runs that share a look, each measured with its own font. */
function runsIn(ctx: CanvasRenderingContext2D, text: string, looks: Look[], a: number, b: number): Run[] {
  const runs: { text: string; look: Look }[] = [];
  for (let i = a; i < b; i++) {
    const last = runs.at(-1);
    if (last && sameLook(last.look, looks[i])) last.text += text[i];
    else runs.push({ text: text[i], look: looks[i] });
  }
  return runs.map((r) => {
    ctx.font = r.look.font;
    ctx.letterSpacing = `${r.look.tracking}px`;
    return { ...r, width: ctx.measureText(r.text).width };
  });
}

/** Advance of [a, b) including the spacing after the last letter, as measureText reports it. */
function advance(ctx: CanvasRenderingContext2D, text: string, looks: Look[], a: number, b: number): number {
  return runsIn(ctx, text, looks, a, b).reduce((sum, r) => sum + r.width, 0);
}

/** Line breaks as [start, end) ranges of the text: explicit newlines, then word wrap, then hard breaks. */
function wrapRanges(text: string, maxWidth: number, width: (a: number, b: number) => number): [number, number][] {
  const out: [number, number][] = [];
  let pos = 0;
  for (const para of text.split('\n')) {
    let ls = pos;
    let le = pos;
    let wpos = pos;
    for (const word of para.split(' ')) {
      const ws = wpos;
      const we = wpos + word.length;
      wpos = we + 1;
      const empty = le === ls;
      if (empty || width(ls, we) <= maxWidth) {
        if (empty) ls = ws;
        le = we;
      } else {
        out.push([ls, le]);
        ls = ws;
        le = we;
      }
      while (width(ls, le) > maxWidth && le - ls > 1) {
        let cut = le - ls - 1;
        while (cut > 1 && width(ls, ls + cut) > maxWidth) cut--;
        out.push([ls, ls + cut]);
        ls += cut;
      }
    }
    out.push([ls, le]);
    pos += para.length + 1;
  }
  return out;
}

/** '#RRGGBB' plus an opacity as an rgba() string. */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`expected #RRGGBB color, got ${hex}`);
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
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

let measureCtx: CanvasRenderingContext2D | null = null;

/** Lines exactly as rasterizeText breaks them, for rule checks. */
export function wrappedLines(clip: TextClip, vars: ProjectVars, frameW: number): string[] {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) throw new Error('2d context unavailable');
  const ctx = measureCtx;
  const text = resolveTokens(clip.text, vars);
  const looks = looksOf(text, clip, frameW / DESIGN_WIDTH);
  const ranges = wrapRanges(text, MAX_WIDTH_FRAC * frameW, (a, b) => advance(ctx, text, looks, a, b));
  return ranges.map(([a, b]) => text.slice(a, b));
}

/** A run placed in block coordinates (origin = center of the unrotated text block). */
interface Placed {
  run: Run;
  cx: number;
  cy: number;
  h: number;
}

/** Corners of a w x h rect centered at (cx, cy) turned by `a`, then the whole thing turned by `g` around the origin. */
function corners(cx: number, cy: number, w: number, h: number, a: number, g: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [ux, uy] of [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ]) {
    const x = cx + ux * Math.cos(a) - uy * Math.sin(a);
    const y = cy + ux * Math.sin(a) + uy * Math.cos(a);
    out.push([x * Math.cos(g) - y * Math.sin(g), x * Math.sin(g) + y * Math.cos(g)]);
  }
  return out;
}

/** Renders a text clip at its settled (post-animation) state for a frame of the given size. */
export function rasterizeText(clip: TextClip, vars: ProjectVars, frameW: number, frameH: number): TextRaster {
  const k = frameW / DESIGN_WIDTH;
  const style = clip.style;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const text = resolveTokens(clip.text, vars);
  const looks = looksOf(text, clip, k);
  const ranges = wrapRanges(text, MAX_WIDTH_FRAC * frameW, (a, b) => advance(ctx, text, looks, a, b));
  const size = style.size * k;
  const baseLineH = size * LINE_HEIGHT;
  const stroke = style.background ? 0 : style.strokeWidth * k;
  const blur = style.background ? 0 : style.shadow > 0 ? size * SHADOW_BLUR : 0;
  const padX = style.background ? size * 0.45 : stroke + blur * 2 + 2;
  const padY = style.background ? size * 0.28 : stroke + blur * 2 + 2;
  const glyphPad = stroke + blur * 2 + 2;

  const lines = ranges.map(([a, b]) => {
    const runs = runsIn(ctx, text, looks, a, b);
    const trailing = b > a ? looks[b - 1].tracking : 0;
    const width = runs.reduce((sum, r) => sum + r.width, 0) - trailing;
    const h = baseLineH * Math.max(1, ...runs.map((r) => r.look.scale));
    return { runs, width, h };
  });
  const blockW = Math.max(1, ...lines.map((l) => l.width));
  const blockH = lines.reduce((sum, l) => sum + l.h, 0);
  const boxW = blockW + padX * 2;
  const boxH = blockH + padY * 2;

  const placed: Placed[] = [];
  let top = -blockH / 2;
  for (const line of lines) {
    let x = style.align === 'center' ? -line.width / 2 : -blockW / 2;
    for (const run of line.runs) {
      placed.push({ run, cx: x + run.width / 2 + run.look.dx, cy: top + line.h / 2 + run.look.dy, h: baseLineH * run.look.scale });
      x += run.width;
    }
    top += line.h;
  }

  const rot = (clip.rotation * Math.PI) / 180;
  const pts = corners(0, 0, boxW, boxH, 0, rot);
  for (const p of placed) {
    const l = p.run.look;
    if (l.rotate !== 0 || l.dx !== 0 || l.dy !== 0 || l.scale !== 1) {
      pts.push(...corners(p.cx, p.cy, p.run.width + glyphPad * 2, p.h + glyphPad * 2, l.rotate, rot));
    }
  }
  const minX = Math.min(...pts.map((p) => p[0]));
  const minY = Math.min(...pts.map((p) => p[1]));
  const w = Math.ceil(Math.max(...pts.map((p) => p[0])) - minX);
  const h = Math.ceil(Math.max(...pts.map((p) => p[1])) - minY);
  canvas.width = w;
  canvas.height = h;

  ctx.translate(-minX, -minY);
  ctx.rotate(rot);
  if (style.background) {
    ctx.save();
    ctx.translate(-boxW / 2, -boxH / 2);
    ctx.fillStyle = style.background;
    roundRect(ctx, boxW, boxH, 6 * k);
    ctx.fill();
    ctx.restore();
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  const drawRuns = (paint: (r: Run) => void) => {
    for (const p of placed) {
      ctx.save();
      ctx.translate(p.cx, p.cy);
      if (p.run.look.rotate !== 0) ctx.rotate(p.run.look.rotate);
      ctx.font = p.run.look.font;
      ctx.letterSpacing = `${p.run.look.tracking}px`;
      paint(p.run);
      ctx.restore();
    }
  };
  // The shadow goes on the first pass only (stroke if any, else fill) so it is cast once.
  if (blur > 0) {
    ctx.shadowColor = withAlpha(style.strokeColor, style.shadow);
    ctx.shadowBlur = blur;
  }
  if (stroke > 0) {
    ctx.lineWidth = stroke * 2;
    ctx.strokeStyle = style.strokeColor;
    drawRuns((r) => ctx.strokeText(r.text, -r.width / 2, 0));
    ctx.shadowColor = 'transparent';
  }
  drawRuns((r) => {
    ctx.fillStyle = r.look.color;
    ctx.fillText(r.text, -r.width / 2, 0);
  });

  // The unrotated block box keeps the old anchor: its center for centered text, its left edge otherwise.
  const ax = clip.x * frameW + (style.align === 'center' ? 0 : boxW / 2);
  const ay = clip.y * frameH;
  return { canvas, x: Math.round(ax + minX), y: Math.round(ay + minY), w, h };
}

const cache = new Map<string, TextRaster>();
const CACHE_LIMIT = 400;

export function cachedRaster(clip: TextClip, vars: ProjectVars, frameW: number, frameH: number): TextRaster {
  const key = JSON.stringify([clip.text, clip.style, clip.x, clip.y, clip.rotation, clip.spans, vars, frameW, frameH]);
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
