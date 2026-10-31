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
  /** Which of FILTERS is laid over the adjustments: 0 = none, 1 = FILTERS[0] and so on. */
  filter: number;
  /** 0..1: how much of the filter shows over the adjusted picture. */
  filterAmount: number;
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
  /** 0..1: film halation, a warm red fringe around the brightest parts. */
  halation: number;
  /** 0..1: star filter, four still rays (across and up) from bright points. */
  star: number;
  /** How long the star rays reach. */
  starLength: number;
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
  'filter',
  'filterAmount',
];

/** Filters that look at neighboring pixels, so they run as their own passes around the LUT. */
export const DETAIL_KEYS: (keyof ClipColor)[] = ['sharpness', 'definition', 'noiseReduction'];

/** Camera-lens looks drawn after the detail passes; glow size and threshold, and star length, only matter while on. */
export const LENS_KEYS: (keyof ClipColor)[] = ['blur', 'glow', 'glowSize', 'glowThreshold', 'halation', 'star', 'starLength'];

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
  filter: 0,
  filterAmount: 0,
  sharpness: 0,
  definition: 0,
  noiseReduction: 0,
  blur: 0,
  glow: 0,
  glowSize: 0,
  glowThreshold: 0,
  halation: 0,
  star: 0,
  starLength: 0,
  vignette: 0,
  vignetteRadius: 0,
  vignetteSoftness: 0,
};

export const LUT_SIZE = 33;

const FILTER_KEYS: (keyof ClipColor)[] = ['filter', 'filterAmount'];

/** Whether a filter is picked and shows at all. */
export function filterOn(c: ClipColor): boolean {
  return c.filter !== 0 && c.filterAmount !== 0;
}

/** Whether the LUT leaves every pixel as it is. */
export function isLutNeutral(c: ClipColor): boolean {
  return LUT_KEYS.every((k) => c[k] === 0 || (FILTER_KEYS.includes(k) && !filterOn(c)));
}

export function isNeutral(c: ClipColor): boolean {
  return isLutNeutral(c) && DETAIL_KEYS.every((k) => c[k] === 0) && c.blur === 0 && c.glow === 0 && c.halation === 0 && c.star === 0 && c.vignette === 0;
}

export const GLOW_GAIN = 1.5;

/** The glow's bright pass on one channel: tones above the threshold, eased in, boosted by the gain. */
export function glowBright(v: number, threshold: number): number {
  const t = Math.min(1, Math.max(0, (v - threshold) / (1 - threshold)));
  return Math.min(1, GLOW_GAIN * v * t * t * (3 - 2 * t));
}

/** ffmpeg gblur passes in the export; more is closer to a true Gaussian. */
export const GBLUR_STEPS = 3;

/**
 * ffmpeg gblur's impulse response from -reach to reach: GBLUR_STEPS passes of a causal and an anticausal first-order
 * filter (Alvarez-Mazorra), then its postscale. Its tail is heavier than a Gaussian's, which shows once a gain lifts it.
 */
export function gblurKernel(sigma: number, reach: number): number[] {
  const lambda = (sigma * sigma) / (2 * GBLUR_STEPS);
  const nu = (1 + 2 * lambda - Math.sqrt(1 + 4 * lambda)) / (2 * lambda);
  const pad = 8 * reach;
  const buf = new Float64Array(2 * reach + 1 + 2 * pad);
  buf[pad + reach] = 1;
  for (let s = 0; s < GBLUR_STEPS; s++) {
    for (let i = 1; i < buf.length; i++) buf[i] += nu * buf[i - 1];
    for (let i = buf.length - 1; i > 0; i--) buf[i - 1] += nu * buf[i];
  }
  const post = Math.pow(nu / lambda, GBLUR_STEPS);
  return Array.from(buf.subarray(pad, pad + 2 * reach + 1), (v) => v * post);
}

/** Luma weights the halation's and the star's bright passes read. */
export const LUMA: [number, number, number] = [0.2126, 0.7152, 0.0722];

/** The star's bright pass: the color kept as it is, scaled by how far its luma is over the threshold, eased in. */
export function starBright(rgb: [number, number, number], threshold: number): [number, number, number] {
  const y = LUMA[0] * rgb[0] + LUMA[1] * rgb[1] + LUMA[2] * rgb[2];
  const t = Math.min(1, Math.max(0, (y - threshold) / (1 - threshold)));
  const k = t * t * (3 - 2 * t);
  return [rgb[0] * k, rgb[1] * k, rgb[2] * k];
}

/** The halation's color: film's red layer catching light bounced back through the base. */
export const HALATION_TINT: [number, number, number] = [1, 0.35, 0.12];

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
  /** Then glowBright of the luma times HALATION_TINT, blurred, times gain clipped to 1, screened over at amount. */
  halation: { sigma: number; threshold: number; gain: number; amount: number } | null;
  /**
   * Then starBright blurred along rows only and, apart, along columns only; each times gain, clipped
   * to 1, screened over at amount.
   */
  star: { sigma: number; threshold: number; gain: number; amount: number } | null;
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
    halation: c.halation > 0 ? { sigma: Math.max(1, 16 * scale), threshold: 0.6, gain: 2, amount: Math.min(1, c.halation) } : null,
    star:
      c.star > 0
        ? {
            sigma: Math.max(1, 24 * scale * Math.pow(2, c.starLength)),
            threshold: 0.8,
            gain: 3 * Math.pow(2, 0.5 * c.starLength),
            amount: Math.min(1, c.star),
          }
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
 * A filter's look, applied in this order: channel gains (warm or cool), saturation around luma (0 = gray), then one
 * tone curve per channel: an S-curve by `contrast` (negative flattens), the midtone `gamma`, and black and white
 * levels.
 */
interface FilterLook {
  gains: [number, number, number];
  saturation: number;
  contrast: number;
  gamma: number;
  black: number;
  white: number;
}

/** The Photos app's filters, by eye: close in spirit, not the same pixels. */
export const FILTERS: { name: string; label: string; look: FilterLook }[] = [
  { name: 'vivid', label: '비비드', look: { gains: [1, 1, 1], saturation: 1.35, contrast: 0.25, gamma: 1, black: 0, white: 1 } },
  { name: 'vividWarm', label: '비비드 웜', look: { gains: [1.08, 1, 0.86], saturation: 1.3, contrast: 0.25, gamma: 1, black: 0, white: 1 } },
  { name: 'vividCool', label: '비비드 쿨', look: { gains: [0.88, 0.99, 1.1], saturation: 1.3, contrast: 0.25, gamma: 1, black: 0, white: 1 } },
  { name: 'dramatic', label: '드라마틱', look: { gains: [1, 1, 1], saturation: 0.7, contrast: 0.6, gamma: 1.12, black: 0, white: 0.96 } },
  { name: 'dramaticWarm', label: '드라마틱 웜', look: { gains: [1.1, 1, 0.82], saturation: 0.75, contrast: 0.6, gamma: 1.12, black: 0, white: 0.96 } },
  { name: 'dramaticCool', label: '드라마틱 쿨', look: { gains: [0.86, 1, 1.12], saturation: 0.75, contrast: 0.6, gamma: 1.12, black: 0, white: 0.96 } },
  { name: 'mono', label: '모노', look: { gains: [1, 1, 1], saturation: 0, contrast: 0.15, gamma: 1, black: 0, white: 1 } },
  { name: 'silvertone', label: '실버톤', look: { gains: [1, 1, 1], saturation: 0, contrast: -0.25, gamma: 0.85, black: 0.06, white: 1 } },
  { name: 'noir', label: '누아르', look: { gains: [1, 1, 1], saturation: 0, contrast: 0.9, gamma: 1.2, black: 0, white: 1 } },
];

function filterPixel(rgb: [number, number, number], look: FilterLook): [number, number, number] {
  let [r, g, b] = [rgb[0] * look.gains[0], rgb[1] * look.gains[1], rgb[2] * look.gains[2]];
  const l = luma(r, g, b);
  [r, g, b] = [l + (r - l) * look.saturation, l + (g - l) * look.saturation, l + (b - l) * look.saturation];
  const tone = (x: number) => {
    const v = clamp01(x);
    const s = clamp01(v + look.contrast * (v * v * (3 - 2 * v) - v));
    return look.black + (look.white - look.black) * Math.pow(s, look.gamma);
  };
  return [tone(r), tone(g), tone(b)];
}

/**
 * Maps one RGB pixel (0..1). Light first (exposure, brilliance, highlights, shadows, black point), then the
 * original four in their original order (temperature with tint, saturation with vibrance, contrast, brightness),
 * so clips made before the light controls existed look the same. A filter goes over the result, mixed in by its
 * amount, so the sliders still steer the picture under it.
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
  const adjusted: [number, number, number] = [tone(r), tone(g), tone(b)];
  if (!filterOn(c)) return adjusted;
  const entry = FILTERS[c.filter - 1];
  if (!entry) throw new Error(`unknown filter ${c.filter}; expected 1..${FILTERS.length}`);
  const looked = filterPixel(adjusted, entry.look);
  return adjusted.map((v, i) => v + (looked[i] - v) * c.filterAmount) as [number, number, number];
}

/** The fields the auto button sets; white balance and the rest of the color stay as they are. */
export type AutoLight = Pick<ClipColor, 'exposure' | 'highlights' | 'shadows' | 'blackPoint' | 'vibrance'>;

/** How far auto moves any one slider. */
export const AUTO_LIMIT = 0.6;

/** Most pixels autoLight grades per try; more are thinned evenly. */
const AUTO_PIXELS = 4096;

/**
 * Slider values for the auto button from sample pixels (rgb24) of the clip, tried through gradePixel with the rest of
 * `base`: exposure brings a median luma outside 0.38..0.65 to the nearer end (darkening at most 0.3, a bright
 * picture is often meant bright), highlights pull down (at most 0.3) as more
 * of the picture is bright but not clipped (clipped white would only turn gray), shadows lift the 10th percentile to
 * 0.08 when it is darker, black point sets the 1st percentile to 0.02 when it is lighter, and vibrance grows as the
 * picture is more muted.
 */
export function autoLight(rgb: Uint8Array, base: ClipColor): AutoLight {
  const total = Math.floor(rgb.length / 3);
  if (total === 0) throw new Error('autoLight got no pixels');
  const step = Math.max(1, Math.floor(total / AUTO_PIXELS));
  const px: [number, number, number][] = [];
  for (let i = 0; i < total; i += step) px.push([rgb[3 * i] / 255, rgb[3 * i + 1] / 255, rgb[3 * i + 2] / 255]);
  const out: AutoLight = { exposure: 0, highlights: 0, shadows: 0, blackPoint: 0, vibrance: 0 };
  const lumas = (c: ClipColor) => px.map((p) => luma(...gradePixel(p, c))).sort((a, b) => a - b);
  const lumaAt = (c: ClipColor, q: number) => {
    const sorted = lumas(c);
    return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  };
  /** Where the q-quantile, rising with the slider, meets target within [lo, hi]; an end when it never does. */
  const solve = (key: keyof AutoLight, lo: number, hi: number, q: number, target: number) => {
    const f = (v: number) => lumaAt({ ...base, ...out, [key]: v }, q);
    if (f(lo) >= target) return lo;
    if (f(hi) <= target) return hi;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (f(mid) < target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  for (let round = 0; round < 2; round++) {
    out.exposure = 0;
    const mid = lumaAt({ ...base, ...out }, 0.5);
    if (mid < 0.38 || mid > 0.65) out.exposure = solve('exposure', -0.3, AUTO_LIMIT, 0.5, mid < 0.38 ? 0.38 : 0.65);
    out.highlights = 0;
    const bright = lumas({ ...base, ...out }).filter((l) => l >= 0.8 && l < 0.98).length / px.length;
    out.highlights = -Math.min(0.3, Math.max(0, 1.5 * (bright - 0.1)));
    out.shadows = 0;
    if (lumaAt({ ...base, ...out }, 0.1) < 0.08) out.shadows = solve('shadows', 0, AUTO_LIMIT, 0.1, 0.08);
    out.blackPoint = 0;
    const black = lumaAt({ ...base, ...out }, 0.01);
    out.blackPoint = Math.min(AUTO_LIMIT, Math.max(0, (black - 0.02) / 0.98 / 0.15));
  }
  const muted = px.reduce((sum, [r, g, b]) => sum + Math.max(r, g, b) - Math.min(r, g, b), 0) / px.length;
  out.vibrance = Math.min(AUTO_LIMIT, Math.max(0, 0.1 + 1.5 * (0.3 - muted)));
  const round2 = (v: number) => Math.round(v * 100) / 100;
  return {
    exposure: round2(out.exposure),
    highlights: round2(out.highlights),
    shadows: round2(out.shadows),
    blackPoint: round2(out.blackPoint),
    vibrance: round2(out.vibrance),
  };
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
