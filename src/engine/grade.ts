import type { ClipColor } from '../../shared/color';
import { colorKey, LUT_SIZE, lutEntries, vignetteShape } from '../../shared/color';
import type { ClipCrop } from '../../shared/project';

const VERT = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = vec2((pos.x + 1.0) * 0.5, (1.0 - pos.y) * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 uv;
uniform sampler2D src;
uniform sampler3D lut;
uniform float vig;
uniform vec2 vigShape;
uniform vec4 crop;
out vec4 color;
void main() {
  vec4 c = texture(src, uv);
  float n = ${LUT_SIZE.toFixed(1)};
  vec3 p = c.rgb * ((n - 1.0) / n) + 0.5 / n;
  vec3 g = texture(lut, p).rgb;
  // Same as vignettePixel in shared/color.ts, over the cropped picture.
  vec2 q = (uv - crop.xy) / (1.0 - crop.xy - crop.zw);
  float d = length(q - 0.5) * sqrt(2.0);
  float m = abs(vig) * smoothstep(vigShape.x - vigShape.y, vigShape.x + vigShape.y, d);
  g = vig > 0.0 ? g * (1.0 - m) : g + (1.0 - g) * m;
  color = vec4(g, c.a);
}`;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(shader)}`);
  return shader;
}

/**
 * Applies a clip's color LUT on the GPU. The LUT comes from the same function the export
 * writes to a .cube file, sampled trilinearly like ffmpeg lut3d interp=trilinear.
 */
class Grader {
  private canvas = document.createElement('canvas');
  private gl: WebGL2RenderingContext | null = null;
  private srcTex: WebGLTexture | null = null;
  private luts = new Map<string, WebGLTexture>();
  private vigLoc: WebGLUniformLocation | null = null;
  private vigShapeLoc: WebGLUniformLocation | null = null;
  private cropLoc: WebGLUniformLocation | null = null;

  private context(): WebGL2RenderingContext {
    if (this.gl) return this.gl;
    const gl = this.canvas.getContext('webgl2', { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('WebGL2 is not available');
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
    gl.useProgram(program);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, 'pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(gl.getUniformLocation(program, 'src'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'lut'), 1);
    this.vigLoc = gl.getUniformLocation(program, 'vig');
    this.vigShapeLoc = gl.getUniformLocation(program, 'vigShape');
    this.cropLoc = gl.getUniformLocation(program, 'crop');
    this.srcTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.gl = gl;
    return gl;
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
    this.luts.set(key, tex);
    return tex;
  }

  /** Returns a canvas holding `source` graded at w x h, the vignette fitted to the crop. Valid until the next call. */
  apply(source: TexImageSource, w: number, h: number, color: ClipColor, crop: ClipCrop): HTMLCanvasElement {
    const gl = this.context();
    const lut = this.lutTexture(gl, color);
    const shape = vignetteShape(color);
    gl.uniform1f(this.vigLoc, color.vignette);
    gl.uniform2f(this.vigShapeLoc, shape.radius, shape.width);
    gl.uniform4f(this.cropLoc, crop.l, crop.t, crop.r, crop.b);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_3D, lut);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return this.canvas;
  }
}

export const grader = new Grader();
