import type { ClipColor } from '../../shared/color';
import { colorKey, detailPlan, gblurKernel, GLOW_GAIN, HALATION_TINT, isLutNeutral, LUMA, LUT_SIZE, lutEntries, vignetteShape } from '../../shared/color';
import type { ClipCrop } from '../../shared/project';

/**
 * `pic` is the picture position from its top left; `uv` samples the input, which is the uploaded source (top row
 * first, flip = 1) or a framebuffer of an earlier pass (bottom row first, flip = 0).
 */
const VERT = `#version 300 es
in vec2 pos;
uniform float flip;
out vec2 uv;
out vec2 pic;
void main() {
  pic = vec2((pos.x + 1.0) * 0.5, (1.0 - pos.y) * 0.5);
  uv = flip > 0.5 ? pic : vec2(pic.x, 1.0 - pic.y);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const HEAD = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv;
in vec2 pic;
uniform sampler2D src;
out vec4 color;
`;

/** The LUT (when useLut is 1) and the vignette (when vig is not 0). */
const LUT_FRAG = `${HEAD}
uniform sampler3D lut;
uniform float useLut;
uniform float vig;
uniform vec2 vigShape;
uniform vec4 crop;
void main() {
  vec4 c = texture(src, uv);
  float n = ${LUT_SIZE.toFixed(1)};
  vec3 g = useLut > 0.5 ? texture(lut, c.rgb * ((n - 1.0) / n) + 0.5 / n).rgb : c.rgb;
  // Same as vignettePixel in shared/color.ts, over the cropped picture.
  vec2 q = (pic - crop.xy) / (1.0 - crop.xy - crop.zw);
  float d = length(q - 0.5) * sqrt(2.0);
  float m = abs(vig) * smoothstep(vigShape.x - vigShape.y, vigShape.x + vigShape.y, d);
  g = vig > 0.0 ? g * (1.0 - m) : g + (1.0 - g) * m;
  color = vec4(g, c.a);
}`;

/** 3x3 median per channel, like ffmpeg median=radius=1 (Morgan McGuire's exchange network). */
const MEDIAN_FRAG = `${HEAD}
uniform vec2 px;
#define s2(a, b) t = a; a = min(t, b); b = max(t, b);
#define mn3(a, b, c) s2(a, b); s2(a, c);
#define mx3(a, b, c) s2(b, c); s2(a, c);
#define mnmx3(a, b, c) mx3(a, b, c); s2(a, b);
#define mnmx4(a, b, c, d) s2(a, b); s2(c, d); s2(a, c); s2(b, d);
#define mnmx5(a, b, c, d, e) s2(a, b); s2(c, d); mn3(a, c, e); mx3(b, d, e);
#define mnmx6(a, b, c, d, e, f) s2(a, d); s2(b, e); s2(c, f); mn3(a, b, c); mx3(d, e, f);
void main() {
  vec3 v[9];
  for (int dy = -1; dy <= 1; dy++)
    for (int dx = -1; dx <= 1; dx++) v[(dy + 1) * 3 + dx + 1] = texture(src, uv + vec2(dx, dy) * px).rgb;
  vec3 t;
  mnmx6(v[0], v[1], v[2], v[3], v[4], v[5]);
  mnmx5(v[1], v[2], v[3], v[4], v[6]);
  mnmx4(v[2], v[3], v[4], v[7]);
  mnmx3(v[3], v[4], v[8]);
  color = vec4(v[4], texture(src, uv).a);
}`;

const MAX_TAPS = 192;

/** One direction of a separable blur: taps are (offset in texels, weight). */
const BLUR_FRAG = `${HEAD}
uniform vec2 dir;
uniform int count;
uniform vec2 taps[${MAX_TAPS}];
void main() {
  vec3 sum = vec3(0.0);
  for (int i = 0; i < count; i++) sum += taps[i].y * texture(src, uv + dir * taps[i].x).rgb;
  color = vec4(sum, texture(src, uv).a);
}`;

/**
 * screen 0: a + k * (a - b), sharpening and definition against a blur, noise reduction against the median.
 * screen 1: a + k * b * (1 - a), the glow screened over (ffmpeg blend screen at opacity k), b first times gain
 * and clipped to 1.
 */
const COMBINE_FRAG = `${HEAD}
uniform sampler2D other;
uniform float k;
uniform float screen;
uniform float gain;
void main() {
  vec4 a = texture(src, uv);
  vec3 b = min(vec3(1.0), gain * texture(other, uv).rgb);
  vec3 c = screen > 0.5 ? a.rgb + k * b * (1.0 - a.rgb) : a.rgb + k * (a.rgb - b);
  color = vec4(clamp(c, 0.0, 1.0), a.a);
}`;

/**
 * mode 0: glowBright in shared/color.ts on each channel; 1: on the luma in all three; both times tint.
 * mode 2: starBright, the color times the eased luma position.
 */
const BRIGHT_FRAG = `${HEAD}
uniform float threshold;
uniform int mode;
uniform vec3 tint;
void main() {
  vec4 a = texture(src, uv);
  float y = dot(a.rgb, vec3(${LUMA.map((k) => k.toFixed(4)).join(', ')}));
  vec3 v = mode == 0 ? a.rgb : vec3(y);
  vec3 t = clamp((v - threshold) / (1.0 - threshold), 0.0, 1.0);
  vec3 e = t * t * (3.0 - 2.0 * t);
  vec3 g = mode == 2 ? a.rgb * e : tint * min(vec3(1.0), ${GLOW_GAIN.toFixed(4)} * v * e);
  color = vec4(g, a.a);
}`;

type Tap = [number, number];

/** ffmpeg unsharp's kernel: steps passes of [1 2 1], a binomial of size 2 * steps + 1. */
function binomialTaps(steps: number): Tap[] {
  let row = [1];
  for (let i = 0; i < 2 * steps; i++) row = [...row, 0].map((v, j) => v + (j > 0 ? row[j - 1] : 0));
  const total = 4 ** steps;
  return row.map((v, j): Tap => [j - steps, v / total]);
}

/** A symmetric kernel w(0..reach) divided by total, neighboring texels paired into one linear sample. */
function pairedTaps(w: (i: number) => number, reach: number, total: number): Tap[] {
  const taps: Tap[] = [[0, w(0) / total]];
  for (let i = 1; i <= reach; i += 2) {
    const a = w(i);
    const b = i + 1 <= reach ? w(i + 1) : 0;
    const at = (i * a + (i + 1) * b) / (a + b);
    taps.push([at, (a + b) / total], [-at, (a + b) / total]);
  }
  return taps;
}

/** A Gaussian out to 3 sigma. */
function gaussianTaps(sigma: number): Tap[] {
  const reach = Math.min(Math.ceil(3 * sigma), MAX_TAPS - 2);
  const w = (i: number) => Math.exp(-(i * i) / (2 * sigma * sigma));
  let total = w(0);
  for (let i = 1; i <= reach; i++) total += 2 * w(i);
  return pairedTaps(w, reach, total);
}

/** The export's own gblur kernel out to 4 sigma, for the halation and the star, whose gain makes the difference from a Gaussian show. */
function gblurTaps(sigma: number): Tap[] {
  const reach = Math.min(Math.ceil(4 * sigma), MAX_TAPS - 2);
  const k = gblurKernel(sigma, reach);
  return pairedTaps((i) => k[reach + i], reach, 1);
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
  return shader;
}

interface Target {
  tex: WebGLTexture;
  fb: WebGLFramebuffer;
}

/** A pass input: the uploaded source or an earlier pass's framebuffer texture. */
interface Input {
  tex: WebGLTexture;
  flip: boolean;
}

interface Programs {
  lut: WebGLProgram;
  median: WebGLProgram;
  blur: WebGLProgram;
  combine: WebGLProgram;
  bright: WebGLProgram;
}

/**
 * Applies a clip's color on the GPU in the export's order: noise reduction, LUT, definition, sharpness, blur, glow,
 * halation, star, vignette.
 * The LUT comes from the same function the export writes to a .cube file, sampled trilinearly like ffmpeg lut3d
 * interp=trilinear; the detail passes use the export's kernels at the same picture size.
 */
class Grader {
  private canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext | null = null;
  private programs: Programs | null = null;
  private srcTex: WebGLTexture | null = null;
  private luts = new Map<string, WebGLTexture>();
  private targets: Target[] = [];
  private targetSize = '';

  private context(): WebGL2RenderingContext {
    if (this.gl) return this.gl;
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available');
    const vert = compile(gl, gl.VERTEX_SHADER, VERT);
    const link = (frag: string): WebGLProgram => {
      const program = gl.createProgram();
      gl.attachShader(program, vert);
      gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, frag));
      gl.bindAttribLocation(program, 0, 'pos');
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
      return program;
    };
    this.programs = {
      lut: link(LUT_FRAG),
      median: link(MEDIAN_FRAG),
      blur: link(BLUR_FRAG),
      combine: link(COMBINE_FRAG),
      bright: link(BRIGHT_FRAG),
    };
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.srcTex = this.texture(gl);
    this.gl = gl;
    return gl;
  }

  private texture(gl: WebGL2RenderingContext): WebGLTexture {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private lutTexture(gl: WebGL2RenderingContext, color: ClipColor): WebGLTexture {
    const key = colorKey(color);
    const cached = this.luts.get(key);
    if (cached) return cached;
    const data = new Uint8Array(LUT_SIZE ** 3 * 4);
    lutEntries(color).forEach(([r, g, b], i) => {
      data.set([Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), 255], i * 4);
    });
    const tex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, tex);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const p of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, p, gl.CLAMP_TO_EDGE);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, LUT_SIZE, LUT_SIZE, LUT_SIZE, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.activeTexture(gl.TEXTURE0);
    this.luts.set(key, tex);
    return tex;
  }

  /** Framebuffers at w x h for the passes, made again when the size changes. */
  private ensureTargets(gl: WebGL2RenderingContext, w: number, h: number): void {
    const size = `${w}x${h}`;
    if (this.targetSize === size) return;
    for (const t of this.targets) {
      gl.deleteFramebuffer(t.fb);
      gl.deleteTexture(t.tex);
    }
    this.targets = [0, 1, 2, 3].map(() => {
      const tex = this.texture(gl);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fb };
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.targetSize = size;
  }

  /** Draws one pass from `input` into a free framebuffer (or the canvas when `to` is null) and returns its output. */
  private pass(
    gl: WebGL2RenderingContext,
    program: WebGLProgram,
    input: Input,
    to: Target | null,
    uniforms: (u: (name: string) => WebGLUniformLocation | null) => void,
  ): Input {
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, to ? to.fb : null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input.tex);
    const u = (name: string) => gl.getUniformLocation(program, name);
    gl.uniform1i(u('src'), 0);
    gl.uniform1f(u('flip'), input.flip ? 1 : 0);
    uniforms(u);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return { tex: to ? to.tex : input.tex, flip: false };
  }

  private freeTarget(...busy: Input[]): Target {
    const target = this.targets.find((t) => !busy.some((b) => b.tex === t.tex));
    if (!target) throw new Error('no free framebuffer for the grade pass');
    return target;
  }

  /** Returns a canvas holding `source` graded at w x h, the vignette fitted to the crop. Valid until the next call. */
  apply(source: TexImageSource, w: number, h: number, color: ClipColor, crop: ClipCrop): HTMLCanvasElement {
    const gl = this.context();
    const prog = this.programs as Programs;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const plan = detailPlan(color, w, h);
    const useLut = !isLutNeutral(color);
    const lutTex = useLut ? this.lutTexture(gl, color) : null;
    const lutPass = (input: Input, to: Target | null, lut: boolean, vignette: boolean) =>
      this.pass(gl, prog.lut, input, to, (u) => {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, lut ? lutTex : null);
        gl.uniform1i(u('lut'), 1);
        gl.uniform1f(u('useLut'), lut ? 1 : 0);
        const shape = vignetteShape(color);
        gl.uniform1f(u('vig'), vignette ? color.vignette : 0);
        gl.uniform2f(u('vigShape'), shape.radius, shape.width);
        gl.uniform4f(u('crop'), crop.l, crop.t, crop.r, crop.b);
      });
    let cur: Input = { tex: this.srcTex as WebGLTexture, flip: true };
    if (plan.noise === 0 && !plan.definition && !plan.sharpness && !plan.blur && !plan.glow && !plan.halation && !plan.star) {
      lutPass(cur, null, useLut, true);
      return this.canvas;
    }
    this.ensureTargets(gl, w, h);
    const combine = (a: Input, b: Input, k: number, screen = false, gain = 1, keep: Input = a): Input =>
      this.pass(gl, prog.combine, a, this.freeTarget(a, b, keep), (u) => {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, b.tex);
        gl.uniform1i(u('other'), 2);
        gl.uniform1f(u('k'), k);
        gl.uniform1f(u('screen'), screen ? 1 : 0);
        gl.uniform1f(u('gain'), gain);
      });
    /** One direction of a blur into a free framebuffer, leaving `a` and `keep` untouched. */
    const line = (a: Input, taps: Tap[], dir: [number, number], ...keep: Input[]): Input =>
      this.pass(gl, prog.blur, a, this.freeTarget(a, ...keep), (u) => {
        gl.uniform2f(u('dir'), dir[0], dir[1]);
        gl.uniform1i(u('count'), taps.length);
        gl.uniform2fv(u('taps'), taps.flat());
      });
    /** Blurs `a` into free framebuffers, leaving `a` and `keep` untouched. */
    const blur = (a: Input, taps: Tap[], keep: Input = a): Input => line(line(a, taps, [1 / w, 0], keep), taps, [0, 1 / h], a, keep);
    const bright = (a: Input, threshold: number, mode: 0 | 1 | 2, tint: [number, number, number] = [1, 1, 1]): Input =>
      this.pass(gl, prog.bright, a, this.freeTarget(a), (u) => {
        gl.uniform1f(u('threshold'), threshold);
        gl.uniform1i(u('mode'), mode);
        gl.uniform3f(u('tint'), ...tint);
      });
    cur = lutPass(cur, this.targets[0], false, false);
    if (plan.noise > 0) {
      const median = this.pass(gl, prog.median, cur, this.freeTarget(cur), (u) => gl.uniform2f(u('px'), 1 / w, 1 / h));
      cur = combine(cur, median, -plan.noise);
    }
    if (useLut) cur = lutPass(cur, this.freeTarget(cur), true, false);
    if (plan.definition) cur = combine(cur, blur(cur, gaussianTaps(plan.definition.sigma)), plan.definition.k);
    if (plan.sharpness) cur = combine(cur, blur(cur, binomialTaps(plan.sharpness.steps)), plan.sharpness.k);
    if (plan.blur) cur = blur(cur, gaussianTaps(plan.blur.sigma));
    if (plan.glow) cur = combine(cur, blur(bright(cur, plan.glow.threshold, 0), gaussianTaps(plan.glow.sigma), cur), plan.glow.amount, true);
    if (plan.halation) {
      const { sigma, threshold, gain, amount } = plan.halation;
      cur = combine(cur, blur(bright(cur, threshold, 1, HALATION_TINT), gblurTaps(sigma), cur), amount, true, gain);
    }
    if (plan.star) {
      const { sigma, threshold, gain, amount } = plan.star;
      const taps = gblurTaps(sigma);
      const lit = bright(cur, threshold, 2);
      cur = combine(cur, line(lit, taps, [1 / w, 0], cur), amount, true, gain, lit);
      cur = combine(cur, line(lit, taps, [0, 1 / h], cur), amount, true, gain);
    }
    lutPass(cur, null, false, true);
    return this.canvas;
  }
}

export const grader = new Grader();
