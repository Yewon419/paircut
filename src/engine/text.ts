import type { FontId, TextClip, TextEffect } from '../../shared/project';
import {
  ANIM_IN,
  ANIM_OUT,
  backdropEffect,
  BLUR_FROM,
  CHROMA_SPLIT,
  clipDuration,
  FROST_LIFT,
  FROST_SIGMA,
  GLITCH_VARIANTS,
  GLOW_BLUR,
  introProgress,
  isIntroAnim,
  letterAlphas,
  POP_FROM,
  RISE_PX,
  spanIndex,
  TRACK_FROM,
  WIPE_EDGE,
} from '../../shared/project';

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
  josefin: { family: 'Josefin Sans', weight: 700 },
  'josefin-light': { family: 'Josefin Sans', weight: 300 },
  'josefin-slab': { family: 'Josefin Slab', weight: 700 },
  montserrat: { family: 'Montserrat', weight: 800 },
  'montserrat-medium': { family: 'Montserrat', weight: 500 },
  inter: { family: 'Inter', weight: 700 },
  'inter-regular': { family: 'Inter', weight: 400 },
  scratch: { family: 'Rock Salt', weight: 400 },
  'instrument-italic': { family: 'Cutdesk Instrument Italic', weight: 400 },
};
/** Shadow blur radius as a fraction of the font size. */
const SHADOW_BLUR = 0.16;
/** Style sizes are authored for a frame whose short side is 1080px and scaled to the target frame. */
const DESIGN_SIDE = 1080;

/** How much style sizes grow on a frame of this size: by its short side, so a wide frame does not blow text up. */
export function designScale(frameW: number, frameH: number): number {
  return Math.min(frameW, frameH) / DESIGN_SIDE;
}
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
  /** Glitch frames, each the same size and place as `canvas`; empty for every other effect. */
  variants: HTMLCanvasElement[];
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

/** A run placed in block coordinates (origin = center of the unrotated text block). */
interface Placed {
  run: Run;
  /** Index of the run's first character in the text. */
  from: number;
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

/**
 * Renders a text clip for a frame of the given size. `alphas` gives each character (UTF-16 unit) its opacity, null =
 * all opaque; line breaks always come from the whole text, so letters never jump while they appear. `spread` adds
 * letter spacing in font sizes on top of the style's, keeping those line breaks.
 */
export function rasterizeText(
  clip: TextClip,
  frameW: number,
  frameH: number,
  alphas: readonly number[] | null,
  spread: number,
): TextRaster {
  const k = designScale(frameW, frameH);
  const style = clip.style;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  const text = clip.text;
  const looks = looksOf(text, clip, k);
  const ranges = wrapRanges(text, MAX_WIDTH_FRAC * frameW, (a, b) => advance(ctx, text, looks, a, b));
  const size = style.size * k;
  const drawn = spread === 0 ? looks : looks.map((l) => ({ ...l, tracking: l.tracking + spread * size * l.scale }));
  const baseLineH = size * LINE_HEIGHT;
  const knockout = style.effect === 'knockout';
  // A knockout needs a plate to cut the letters out of: the box color if there is one, else the text color.
  const plate = knockout ? (style.background ?? style.color) : style.background;
  const stroke = plate ? 0 : style.strokeWidth * k;
  const blur = plate ? 0 : style.shadow > 0 ? size * SHADOW_BLUR : 0;
  const padX = plate ? size * 0.45 : stroke + blur * 2 + 2;
  const padY = plate ? size * 0.28 : stroke + blur * 2 + 2;
  const glyphPad = stroke + blur * 2 + 2;

  const lines = ranges.map(([a, b]) => {
    const runs = runsIn(ctx, text, drawn, a, b);
    const trailing = b > a ? drawn[b - 1].tracking : 0;
    const width = runs.reduce((sum, r) => sum + r.width, 0) - trailing;
    const h = baseLineH * Math.max(1, ...runs.map((r) => r.look.scale));
    return { runs, width, h, a };
  });
  const blockW = Math.max(1, ...lines.map((l) => l.width));
  const blockH = lines.reduce((sum, l) => sum + l.h, 0);
  const boxW = blockW + padX * 2;
  const boxH = blockH + padY * 2;

  const placed: Placed[] = [];
  let top = -blockH / 2;
  for (const line of lines) {
    let x = style.align === 'center' ? -line.width / 2 : -blockW / 2;
    let from = line.a;
    for (const run of line.runs) {
      placed.push({ run, from, cx: x + run.width / 2 + run.look.dx, cy: top + line.h / 2 + run.look.dy, h: baseLineH * run.look.scale });
      x += run.width;
      from += run.text.length;
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
  if (plate) {
    ctx.save();
    ctx.translate(-boxW / 2, -boxH / 2);
    ctx.fillStyle = plate;
    roundRect(ctx, boxW, boxH, 6 * k);
    ctx.fill();
    ctx.restore();
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';
  // Runs are drawn left-aligned from their start, so a cut-off run or a single letter lands where the whole run would.
  const drawRuns = (paint: (r: Run, text: string, x: number) => void) => {
    for (const p of placed) {
      const run = p.run;
      const a = alphas ? alphas.slice(p.from, p.from + run.text.length) : [];
      const cut = a.findIndex((v) => v < 1);
      ctx.save();
      ctx.translate(p.cx, p.cy);
      if (run.look.rotate !== 0) ctx.rotate(run.look.rotate);
      ctx.font = run.look.font;
      ctx.letterSpacing = `${run.look.tracking}px`;
      const left = -run.width / 2;
      if (cut === -1) {
        paint(run, run.text, left);
      } else if (a.slice(cut).every((v) => v <= 0)) {
        if (cut > 0) paint(run, run.text.slice(0, cut), left);
      } else {
        const alpha = ctx.globalAlpha;
        let i = 0;
        for (const ch of run.text) {
          if (a[i] > 0) {
            ctx.globalAlpha = alpha * a[i];
            paint(run, ch, left + ctx.measureText(run.text.slice(0, i)).width);
          }
          i += ch.length;
        }
      }
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
    drawRuns((_r, t, x) => ctx.strokeText(t, x, 0));
    ctx.shadowColor = 'transparent';
  }
  if (knockout) ctx.globalCompositeOperation = 'destination-out';
  drawRuns((r, t, x) => {
    ctx.fillStyle = r.look.color;
    ctx.fillText(t, x, 0);
  });
  ctx.globalCompositeOperation = 'source-over';

  // The unrotated block box keeps the old anchor: its center for centered text, its left edge otherwise.
  const ax = clip.x * frameW + (style.align === 'center' ? 0 : boxW / 2);
  const ay = clip.y * frameH;
  const raster = { canvas, x: Math.round(ax + minX), y: Math.round(ay + minY), w, h, variants: [] };
  if (style.effect === 'glow') return glow(raster, size, style.color);
  if (style.effect === 'chroma') return chroma(raster, size);
  if (style.effect === 'glitch') return glitch(raster, size, text);
  return raster;
}

function blank(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  if (!g) throw new Error('2d context unavailable');
  return g;
}

/** The raster grown by m on every side, same place on screen. */
function grown(r: TextRaster, m: number, draw: (g: CanvasRenderingContext2D) => void): TextRaster {
  const g = blank(r.w + 2 * m, r.h + 2 * m);
  draw(g);
  return { canvas: g.canvas, x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m, variants: [] };
}

function tinted(src: HTMLCanvasElement, color: string): HTMLCanvasElement {
  const g = blank(src.width, src.height);
  g.drawImage(src, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, src.width, src.height);
  return g.canvas;
}

function glow(r: TextRaster, size: number, color: string): TextRaster {
  const blur = size * GLOW_BLUR;
  // Canvas shadows are a gaussian of sigma blur/2; 1.5 * blur keeps the tail inside the raster.
  const m = Math.ceil(blur * 1.5);
  return grown(r, m, (g) => {
    g.shadowColor = color;
    g.shadowBlur = blur;
    g.drawImage(r.canvas, m, m);
    g.shadowBlur = blur / 3;
    g.drawImage(r.canvas, m, m);
    g.shadowColor = 'transparent';
    g.drawImage(r.canvas, m, m);
  });
}

/** Red copy left, cyan copy right, the letters on top. */
function split(g: CanvasRenderingContext2D, src: HTMLCanvasElement, x: number, y: number, d: number): void {
  g.drawImage(tinted(src, '#FF2A4F'), x - d, y);
  g.globalCompositeOperation = 'lighter';
  g.drawImage(tinted(src, '#00E5FF'), x + d, y);
  g.globalCompositeOperation = 'source-over';
  g.drawImage(src, x, y);
}

function chroma(r: TextRaster, size: number): TextRaster {
  const d = Math.max(1, Math.round(size * CHROMA_SPLIT));
  return grown(r, d, (g) => split(g, r.canvas, d, d, d));
}

/** Seeded so a text always glitches the same way, in the preview and in every export. */
function random(seedText: string, variant: number): () => number {
  let s = variant * 0x9e3779b1;
  for (let i = 0; i < seedText.length; i++) s = Math.imul(s ^ seedText.charCodeAt(i), 0x85ebca6b);
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function glitch(r: TextRaster, size: number, text: string): TextRaster {
  const shift = Math.round(size * 0.18);
  const d = Math.max(2, Math.round(size * CHROMA_SPLIT * 2));
  const m = shift + d;
  const base = grown(r, m, (g) => g.drawImage(r.canvas, m, m));
  for (let v = 0; v < GLITCH_VARIANTS; v++) {
    const rand = random(text, v + 1);
    const torn = blank(base.w, base.h);
    split(torn, r.canvas, m, m, d);
    const g = blank(base.w, base.h);
    for (let y = 0; y < base.h; ) {
      const band = Math.max(2, Math.round(base.h * (0.06 + rand() * 0.18)));
      const dx = rand() < 0.55 ? Math.round((rand() * 2 - 1) * shift) : 0;
      g.drawImage(torn.canvas, 0, y, base.w, band, dx, y, base.w, band);
      y += band;
    }
    base.variants.push(g.canvas);
  }
  return base;
}

/** Blurred copy, grown so the blur's tail stays inside; alpha multiplies the whole raster. */
function blurred(r: TextRaster, sigma: number, alpha: number): TextRaster {
  const m = Math.ceil(3 * sigma);
  return grown(r, m, (g) => {
    g.globalAlpha = alpha;
    if (sigma > 0) g.filter = `blur(${sigma}px)`;
    g.drawImage(r.canvas, m, m);
  });
}

/** Left to right reveal: opaque up to the front, a soft edge after it, nothing past that. */
function wiped(r: TextRaster, p: number): TextRaster {
  return grown(r, 0, (g) => {
    g.drawImage(r.canvas, 0, 0);
    const edge = Math.max(1, WIPE_EDGE * r.w);
    const front = p * (r.w + edge) - edge;
    const ramp = g.createLinearGradient(front, 0, front + edge, 0);
    ramp.addColorStop(0, 'rgba(0,0,0,1)');
    ramp.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = ramp;
    g.fillRect(0, 0, r.w, r.h);
  });
}

/** One frame of an intro anim, `local` seconds into the clip. Preview and export both draw intros with this. */
export function introRaster(clip: TextClip, frameW: number, frameH: number, local: number): TextRaster {
  const text = clip.text;
  const duration = clipDuration(clip);
  const anim = clip.anim;
  if (anim === 'type' || anim === 'word' || anim === 'letters') {
    return rasterizeText(clip, frameW, frameH, letterAlphas(anim, text, duration, local), 0);
  }
  if (anim !== 'blur' && anim !== 'track' && anim !== 'wipe') throw new Error(`not an intro anim: ${anim}`);
  const p = introProgress(anim, text, duration, local);
  if (anim === 'track') return blurred(rasterizeText(clip, frameW, frameH, null, TRACK_FROM * (1 - p)), 0, p);
  const full = cachedRaster(clip, frameW, frameH);
  if (anim === 'wipe') return wiped(full, p);
  return blurred(full, BLUR_FROM * clip.style.size * designScale(frameW, frameH) * (1 - p), p);
}

const cache = new Map<string, TextRaster>();
const CACHE_LIMIT = 400;

function remembered(key: string, make: () => TextRaster): TextRaster {
  const hit = cache.get(key);
  if (hit) return hit;
  const raster = make();
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, raster);
  return raster;
}

function looksKey(clip: TextClip, frameW: number, frameH: number): unknown[] {
  return [clip.text, clip.style, clip.x, clip.y, clip.rotation, clip.spans, frameW, frameH];
}

export function cachedRaster(clip: TextClip, frameW: number, frameH: number): TextRaster {
  const key = JSON.stringify(looksKey(clip, frameW, frameH));
  return remembered(key, () => rasterizeText(clip, frameW, frameH, null, 0));
}

/** Intro frame `frame` (at frame / fps seconds into the clip). */
export function cachedIntro(clip: TextClip, frameW: number, frameH: number, frame: number, fps: number): TextRaster {
  const key = JSON.stringify([...looksKey(clip, frameW, frameH), clip.anim, clipDuration(clip), fps, frame]);
  return remembered(key, () => introRaster(clip, frameW, frameH, frame / fps));
}

export interface AnimState {
  alpha: number;
  scale: number;
  /** Vertical offset in design pixels (short side 1080). */
  dy: number;
}

/** Linear in/out ramps; the export graph uses the same formulas in ffmpeg expressions. */
export function animState(clip: TextClip, t: number): AnimState {
  if (clip.anim === 'none') return { alpha: 1, scale: 1, dy: 0 };
  const local = t - clip.start;
  // Intro anims bring the letters in themselves, so they only fade out.
  const pIn = isIntroAnim(clip.anim) ? 1 : Math.max(0, Math.min(1, local / ANIM_IN));
  const pOut = Math.max(0, Math.min(1, (clipDuration(clip) - local) / ANIM_OUT));
  return {
    alpha: pIn * pOut,
    scale: clip.anim === 'pop' ? POP_FROM + (1 - POP_FROM) * pIn : 1,
    dy: clip.anim === 'rise' ? RISE_PX * (1 - pIn) : 0,
  };
}

let scratchCanvas: HTMLCanvasElement | null = null;

function scratch(w: number, h: number): CanvasRenderingContext2D {
  scratchCanvas ??= document.createElement('canvas');
  scratchCanvas.width = w;
  scratchCanvas.height = h;
  const g = scratchCanvas.getContext('2d');
  if (!g) throw new Error('2d context unavailable');
  return g;
}

/**
 * Draws a text raster over what is already on ctx. Backdrop effects read the picture under the letters, so text
 * must be drawn after the tracks below it. Every effect ends as (1 - a) * under + a * treated(under), the same
 * blend the exporter builds with ffmpeg.
 */
export function drawText(ctx: CanvasRenderingContext2D, raster: TextRaster, state: AnimState, k: number, effect: TextEffect): void {
  if (state.alpha <= 0) return;
  const w = raster.w * state.scale;
  const h = raster.h * state.scale;
  const x = raster.x + raster.w / 2 - w / 2;
  const y = raster.y + raster.h / 2 + state.dy * k - h / 2;
  const backdrop = backdropEffect(effect);
  ctx.save();
  ctx.globalAlpha = state.alpha;
  if (backdrop === 'invert') {
    ctx.globalCompositeOperation = 'difference';
    ctx.drawImage(raster.canvas, x, y, w, h);
  } else if (backdrop === 'mono') {
    // Only the letter shape matters: a gray source has no saturation, so 'saturation' leaves the luminosity.
    const g = scratch(Math.ceil(w) + 1, Math.ceil(h) + 1);
    g.drawImage(raster.canvas, 0, 0, w, h);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = '#808080';
    g.fillRect(0, 0, g.canvas.width, g.canvas.height);
    ctx.globalCompositeOperation = 'saturation';
    ctx.drawImage(g.canvas, x, y);
  } else if (backdrop === 'frost') {
    const sigma = FROST_SIGMA * k;
    const m = Math.ceil(sigma * 3);
    const rx = Math.floor(x) - m;
    const ry = Math.floor(y) - m;
    const g = scratch(Math.ceil(w) + 2 * m + 2, Math.ceil(h) + 2 * m + 2);
    // Drawing the whole frame offset lets the blur read real pixels past the region's edge.
    g.filter = `blur(${sigma}px)`;
    g.drawImage(ctx.canvas, -rx, -ry);
    g.filter = 'none';
    g.fillStyle = `rgba(255,255,255,${FROST_LIFT})`;
    g.fillRect(0, 0, g.canvas.width, g.canvas.height);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(raster.canvas, x - rx, y - ry, w, h);
    ctx.drawImage(g.canvas, rx, ry);
  } else {
    ctx.drawImage(raster.canvas, x, y, w, h);
  }
  ctx.restore();
}
