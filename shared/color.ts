/**
 * Clip color correction, after the Photos app's adjust sliders. One pixel function is sampled into a 3D LUT; the
 * preview applies it with WebGL (trilinear 3D texture) and the export with ffmpeg lut3d (interp=trilinear), so both
 * match. Every field is -1..1 with 0 = untouched.
 */
export interface ClipColor {
  /** Stops of light in linear RGB: ±1.5 stops at the ends. */
  exposure: number;
  /** Fixed-curve stand-in for Photos' adaptive brilliance: lifts shadows and pulls highlights in. */
  brilliance: number;
  /** Positive brightens the bright tones, negative recovers them. */
  highlights: number;
  /** Positive opens up the dark tones, negative deepens them. */
  shadows: number;
  contrast: number;
  /** Midtone gamma. */
  brightness: number;
  /** Positive crushes the darkest tones to black, negative lifts them. */
  blackPoint: number;
  saturation: number;
  /** Saturation that favors muted colors (and leaves saturated ones mostly alone). */
  vibrance: number;
  /** Positive is warmer. */
  temperature: number;
  /** Positive is magenta, negative green. */
  tint: number;
}

export const COLOR_KEYS: (keyof ClipColor)[] = [
  'exposure',
  'brilliance',
  'highlights',
  'shadows',
  'contrast',
  'brightness',
  'blackPoint',
  'saturation',
  'vibrance',
  'temperature',
  'tint',
];

export const NEUTRAL_COLOR: ClipColor = {
  exposure: 0,
  brilliance: 0,
  highlights: 0,
  shadows: 0,
  contrast: 0,
  brightness: 0,
  blackPoint: 0,
  saturation: 0,
  vibrance: 0,
  temperature: 0,
  tint: 0,
};

export const LUT_SIZE = 33;

export function isNeutral(c: ClipColor): boolean {
  return COLOR_KEYS.every((k) => c[k] === 0);
}

export function colorKey(c: ClipColor): string {
  return COLOR_KEYS.map((k) => c[k].toFixed(3)).join('_');
}

/** Only the known fields, missing ones 0: older files and presets carry four fields (and some a dropped 'look'). */
export function pickColor(c: Partial<Record<keyof ClipColor, number>>): ClipColor {
  return Object.fromEntries(COLOR_KEYS.map((k) => [k, c[k] ?? 0])) as unknown as ClipColor;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const toLinear = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const toSrgb = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Highlight and shadow moves on luminance; the color keeps its ratios so hues do not shift. */
function toneRegions(rgb: [number, number, number], highlights: number, shadows: number): [number, number, number] {
  const [r, g, b] = rgb;
  const l = clamp01(luma(r, g, b));
  let target = l;
  if (highlights !== 0) {
    const w = smooth(0.35, 1, l);
    target += 0.35 * highlights * w * (highlights > 0 ? 1 - l : l);
  }
  if (shadows !== 0) {
    const w = 1 - smooth(0, 0.65, l);
    target += 0.45 * shadows * w * (shadows > 0 ? 1 - l : l);
  }
  if (l <= 1e-6) return [r + (target - l), g + (target - l), b + (target - l)];
  const k = target / l;
  return [r * k, g * k, b * k];
}

/**
 * Maps one RGB pixel (0..1). Light first (exposure, brilliance, highlights, shadows, black point), then the
 * original four in their original order (temperature with tint, saturation with vibrance, contrast, brightness),
 * so clips made before the light controls existed look the same.
 */
export function gradePixel(rgb: [number, number, number], c: ClipColor): [number, number, number] {
  let [r, g, b] = rgb;
  if (c.exposure !== 0) {
    const gain = Math.pow(2, 1.5 * c.exposure);
    [r, g, b] = [toSrgb(toLinear(r) * gain), toSrgb(toLinear(g) * gain), toSrgb(toLinear(b) * gain)];
  }
  const highlights = c.highlights - 0.5 * c.brilliance;
  const shadows = c.shadows + 0.6 * c.brilliance;
  if (highlights !== 0 || shadows !== 0) [r, g, b] = toneRegions([r, g, b], highlights, shadows);
  if (c.blackPoint !== 0) {
    const k = 0.15 * c.blackPoint;
    [r, g, b] = [r, g, b].map((v) => (v - k) / (1 - k)) as [number, number, number];
  }
  if (c.exposure !== 0 || highlights !== 0 || shadows !== 0 || c.blackPoint !== 0) [r, g, b] = [clamp01(r), clamp01(g), clamp01(b)];
  if (c.temperature !== 0) {
    r *= 1 + 0.1 * c.temperature;
    b *= 1 - 0.1 * c.temperature;
  }
  if (c.tint !== 0) g *= 1 - 0.1 * c.tint;
  if (c.saturation !== 0) {
    const l = luma(r, g, b);
    const k = 1 + c.saturation;
    [r, g, b] = [l + (r - l) * k, l + (g - l) * k, l + (b - l) * k];
  }
  if (c.vibrance !== 0) {
    const l = luma(r, g, b);
    const sat = clamp01(Math.max(r, g, b) - Math.min(r, g, b));
    const k = 1 + c.vibrance * (c.vibrance > 0 ? 1 - sat : 1);
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
