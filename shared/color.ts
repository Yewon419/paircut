/**
 * Clip color correction. One pixel function is sampled into a 3D LUT; the preview applies it with
 * WebGL (trilinear 3D texture) and the export with ffmpeg lut3d (interp=trilinear), so both match.
 */
export interface ClipColor {
  /** -1..1 */
  brightness: number;
  /** -1..1 */
  contrast: number;
  /** -1..1 */
  saturation: number;
  /** -1..1, positive is warmer */
  temperature: number;
  /** 0..1 strength of the Bitteul look (hue-selective part of CHARACTER.md 2-1) */
  look: number;
}

export const NEUTRAL_COLOR: ClipColor = { brightness: 0, contrast: 0, saturation: 0, temperature: 0, look: 0 };

/** Starting values from CHARACTER.md 2-1: brighter, softer contrast, plus the look (greens down, blues to cerulean). */
export const BITTEUL_COLOR: ClipColor = { brightness: 0.2, contrast: -0.15, saturation: 0, temperature: 0, look: 1 };

export const LUT_SIZE = 33;

/** Hue of cerulean #2B86C5. */
const CERULEAN_HUE = 204.5;

export function isNeutral(c: ClipColor): boolean {
  return c.brightness === 0 && c.contrast === 0 && c.saturation === 0 && c.temperature === 0 && c.look === 0;
}

export function colorKey(c: ClipColor): string {
  return [c.brightness, c.contrast, c.saturation, c.temperature, c.look].map((v) => v.toFixed(3)).join('_');
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** 1 inside [lo, hi] degrees, linear falloff over `soft` degrees outside. */
function band(h: number, lo: number, hi: number, soft: number): number {
  if (h >= lo && h <= hi) return 1;
  const d = h < lo ? lo - h : h - hi;
  return Math.max(0, 1 - d / soft);
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = 60 * (((g - b) / d + 6) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  return [h, max === 0 ? 0 : d / max, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** Maps one RGB pixel (0..1). Order: look, temperature, saturation, contrast, brightness. */
export function gradePixel(rgb: [number, number, number], c: ClipColor): [number, number, number] {
  let [r, g, b] = rgb;
  if (c.look > 0) {
    const [h, s, v] = rgbToHsv(r, g, b);
    const green = 1 - 0.5 * c.look * band(h, 75, 165, 30);
    const pull = 0.7 * c.look * band(h, 185, 260, 25);
    [r, g, b] = hsvToRgb(h + (CERULEAN_HUE - h) * pull, s * green, v);
  }
  if (c.temperature !== 0) {
    r *= 1 + 0.1 * c.temperature;
    b *= 1 - 0.1 * c.temperature;
  }
  if (c.saturation !== 0) {
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const k = 1 + c.saturation;
    [r, g, b] = [l + (r - l) * k, l + (g - l) * k, l + (b - l) * k];
  }
  const tone = (x: number) => {
    let y = clamp01(0.5 + (clamp01(x) - 0.5) * (1 + c.contrast));
    if (c.brightness !== 0) y = Math.pow(y, Math.pow(2, -c.brightness));
    return y;
  };
  return [tone(r), tone(g), tone(b)];
}

/** LUT entries, red index fastest (the .cube order). */
export function lutEntries(c: ClipColor): [number, number, number][] {
  const n = LUT_SIZE;
  const out: [number, number, number][] = [];
  for (let bi = 0; bi < n; bi++) {
    for (let gi = 0; gi < n; gi++) {
      for (let ri = 0; ri < n; ri++) out.push(gradePixel([ri / (n - 1), gi / (n - 1), bi / (n - 1)], c));
    }
  }
  return out;
}

export function cubeFile(c: ClipColor): string {
  const lines = [`LUT_3D_SIZE ${LUT_SIZE}`];
  for (const [r, g, b] of lutEntries(c)) lines.push(`${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)}`);
  return `${lines.join('\n')}\n`;
}
