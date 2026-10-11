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
}

export const NEUTRAL_COLOR: ClipColor = { brightness: 0, contrast: 0, saturation: 0, temperature: 0 };

export const LUT_SIZE = 33;

export function isNeutral(c: ClipColor): boolean {
  return c.brightness === 0 && c.contrast === 0 && c.saturation === 0 && c.temperature === 0;
}

export function colorKey(c: ClipColor): string {
  return [c.brightness, c.contrast, c.saturation, c.temperature].map((v) => v.toFixed(3)).join('_');
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Maps one RGB pixel (0..1). Order: temperature, saturation, contrast, brightness. */
export function gradePixel(rgb: [number, number, number], c: ClipColor): [number, number, number] {
  let [r, g, b] = rgb;
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
