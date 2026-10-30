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
  /** Positive sharpens fine edges (ffmpeg unsharp's kernel), negative softens them. */
  sharpness: number;
  /** Local contrast: positive adds punch to midsize detail, negative flattens it. */
  definition: number;
  /** 0..1: a 3x3 median blended in. */
  noiseReduction: number;
  /** 0..1: an even Gaussian blur over the whole picture. */
  blur: number;
  /** 0..1: soft glow, the bright parts blurred wide and screened back over the picture (a mist filter look). */
  glow: number;
  /** How far the glow spreads. */
  glowSize: number;
  /** Which tones glow: positive keeps it to the brightest, negative lets midtones glow too. */
  glowThreshold: number;
  /** Positive darkens the edges, negative lightens them. Applied after the LUT, on the cropped picture. */
  vignette: number;
  /** Where the vignette is half strength: larger pushes it out to the corners. */
  vignetteRadius: number;
  /** How wide the fade from center to edge is. */
  vignetteSoftness: number;
}

/** The fields baked into the 3D LUT; the vignette depends on position, so it is not one of them. */
export const LUT_KEYS: (keyof ClipColor)[] = [
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

/** Filters that look at neighboring pixels, so they run as their own passes around the LUT. */
export const DETAIL_KEYS: (keyof ClipColor)[] = ['sharpness', 'definition', 'noiseReduction'];

/** Camera-lens looks drawn after the detail passes; size and threshold only matter while glow is on. */
export const LENS_KEYS: (keyof ClipColor)[] = ['blur', 'glow', 'glowSize', 'glowThreshold'];

export const COLOR_KEYS: (keyof ClipColor)[] = [...LUT_KEYS, ...DETAIL_KEYS, ...LENS_KEYS, 'vignette', 'vignetteRadius', 'vignetteSoftness'];

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
  sharpness: 0,
  definition: 0,
  noiseReduction: 0,
  blur: 0,
  glow: 0,
  glowSize: 0,
  glowThreshold: 0,
  vignette: 0,
  vignetteRadius: 0,
  vignetteSoftness: 0,
};

export const LUT_SIZE = 33;

/** Whether the LUT leaves every pixel as it is. */
export function isLutNeutral(c: ClipColor): boolean {
  return LUT_KEYS.every((k) => c[k] === 0);
}

export function isNeutral(c: ClipColor): boolean {
  return isLutNeutral(c) && DETAIL_KEYS.every((k) => c[k] === 0) && c.blur === 0 && c.glow === 0 && c.vignette === 0;
}

export const GLOW_GAIN = 1.5;

/** The glow's bright pass on one channel: tones above the threshold, eased in, boosted by the gain. */
export function glowBright(v: number, threshold: number): number {
  const t = Math.min(1, Math.max(0, (v - threshold) / (1 - threshold)));
  return Math.min(1, GLOW_GAIN * v * t * t * (3 - 2 * t));
}

/**
 * The detail passes for a picture processed at w x h (before any crop), in order: noise reduction before the LUT,
 * then definition and sharpness after it. Sizes scale with the picture so a small overlay gets the same look.
 * Each pass is out = a + k * (a - b), b being the median or the blur of a.
 */
export interface DetailPlan {
  /** Median weight, 0 for none (k = -noise). */
  noise: number;
  definition: { sigma: number; k: number } | null;
  /** Half size of ffmpeg unsharp's binomial kernel (msize = 2 * steps + 1). */
  sharpness: { steps: number; k: number } | null;
  /** Then the whole picture blurred. */
  blur: { sigma: number } | null;
  /** Then glowBright of each channel, blurred, screened over: a + amount * b * (1 - a). */
  glow: { sigma: number; threshold: number; amount: number } | null;
}

export function detailPlan(c: ClipColor, w: number, h: number): DetailPlan {
  const scale = Math.min(w, h) / 1080;
  return {
    noise: Math.min(1, Math.max(0, c.noiseReduction)),
    definition: c.definition === 0 ? null : { sigma: Math.max(1, 16 * scale), k: 0.8 * c.definition },
    sharpness:
      c.sharpness === 0
        ? null
        : { steps: Math.min(6, Math.max(1, Math.round(2 * scale))), k: c.sharpness > 0 ? 1.5 * c.sharpness : c.sharpness },
    blur: c.blur > 0 ? { sigma: Math.max(0.5, 28 * scale * c.blur) } : null,
    glow:
      c.glow > 0
        ? { sigma: Math.max(1, 16 * scale * Math.pow(2, 0.7 * c.glowSize)), threshold: 0.55 + 0.25 * c.glowThreshold, amount: Math.min(1, c.glow) }
        : null,
  };
}

/** Cache key of the LUT, so moving a vignette slider does not rebuild it. */
export function colorKey(c: ClipColor): string {
  return LUT_KEYS.map((k) => c[k].toFixed(3)).join('_');
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

/** Vignette radius and half width in the units of vignetteDistance; the preview shader uses the same numbers. */
export function vignetteShape(c: ClipColor): { radius: number; width: number } {
  return { radius: 0.75 + 0.25 * c.vignetteRadius, width: 0.35 + 0.25 * c.vignetteSoftness };
}

/** 0 at the center, 1 at the corners, elliptical with the picture. u and v are 0..1 across it. */
export function vignetteDistance(u: number, v: number): number {
  return Math.hypot(u - 0.5, v - 0.5) * Math.SQRT2;
}

/** How far a pixel moves toward black (vignette > 0) or white (vignette < 0), 0..1. */
export function vignetteAmount(c: ClipColor, u: number, v: number): number {
  const { radius, width } = vignetteShape(c);
  return Math.abs(c.vignette) * smooth(radius - width, radius + width, vignetteDistance(u, v));
}

/** Applies the vignette to one graded pixel at u, v. */
export function vignettePixel(rgb: [number, number, number], c: ClipColor, u: number, v: number): [number, number, number] {
  const m = vignetteAmount(c, u, v);
  return rgb.map((x) => (c.vignette > 0 ? x * (1 - m) : x + (1 - x) * m)) as [number, number, number];
}

/**
 * The export's vignette as a binary PPM at the picture's size, sampled at pixel centers. Black-going vignettes hold
 * 1 - amount for ffmpeg blend multiply, white-going ones hold amount for blend screen. RGB rather than gray, so no
 * range conversion touches the values on the way to gbrap.
 */
export function vignetteMask(c: ClipColor, w: number, h: number): Uint8Array {
  const header = new TextEncoder().encode(`P6\n${w} ${h}\n255\n`);
  const out = new Uint8Array(header.length + w * h * 3);
  out.set(header);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = vignetteAmount(c, (x + 0.5) / w, (y + 0.5) / h);
      const v = Math.round(255 * (c.vignette > 0 ? 1 - m : m));
      out.fill(v, header.length + (y * w + x) * 3, header.length + (y * w + x) * 3 + 3);
    }
  }
  return out;
}
