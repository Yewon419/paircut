import {
  ANIM_IN,
  ANIM_OUT,
  assetById,
  backdropEffect,
  clipDuration,
  clipEnd,
  cropBox,
  FROST_LIFT,
  FROST_SIGMA,
  GLITCH_BURST,
  GLITCH_EPS,
  GLITCH_EVERY,
  GLITCH_STEP,
  hasCrop,
  hasKeys,
  isIntroAnim,
  isMediaClip,
  isTextClip,
  layerBlend,
  layerGroups,
  layerOpacity,
  mixesAsLayer,
  MONO_WEIGHTS,
  placeVisual,
  POP_FROM,
  projectDuration,
  RISE_PX,
  visualSpan,
} from './project';
import type { BackdropEffect, BlendMode, Clip, Project, Track, TransformKey } from './project';
import { colorKey, cubeFile, detailPlan, GBLUR_STEPS, GLOW_GAIN, HALATION_TINT, isLutNeutral, LUMA, vignetteMask } from './color';

/** A text clip rasterized by the renderer at export resolution, placed at its settled position. */
export interface TextLayer {
  clipId: string;
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Glitch frame PNGs, same size and place as `path`. */
  variants: string[];
  /** Intro anim frames as an image2 pattern (numbered from 0, the last one the settled text), in their own box. */
  intro: IntroLayer | null;
}

export interface IntroLayer {
  pattern: string;
  count: number;
  x: number;
  y: number;
}

/** A .cube LUT or a vignette mask the exporter writes next to the filter script; ffmpeg runs with that folder as cwd. */
export interface SideFile {
  name: string;
  content: string | Uint8Array;
}

export interface ExportPlan {
  inputArgs: string[];
  files: SideFile[];
  filterGraph: string;
  duration: number;
  width: number;
  height: number;
  fps: number;
  /** Whether any clip is heard; a baked layer leaves its sound out when none is. */
  audible: boolean;
}

/**
 * ffmpeg blend modes matching the canvas ones, with the layer as the top input and the picture under it as the bottom.
 * The canvas 'overlay' looks at the picture under it, which is ffmpeg's 'hardlight' with these inputs.
 */
const FFMPEG_BLEND: Record<BlendMode, string> = {
  normal: 'normal',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'hardlight',
  darken: 'darken',
  lighten: 'lighten',
  add: 'addition',
  difference: 'difference',
};

/**
 * Pixel format conversions for every filter in the graph. ffmpeg's defaults band smooth skies a little more on each
 * YUV-RGB round trip (one per backdrop text or blended layer) and, in 8.1, black out the last width%16 columns of
 * yuv420p->gbrp.
 */
const SWS_FLAGS = 'sws_flags=bicubic+accurate_rnd+full_chroma_int+full_chroma_inp';

function num(n: number): string {
  return n.toFixed(4).replace(/\.?0+$/, '') || '0';
}

/**
 * A keyframed transform value as an ffmpeg expression of `u`, seconds into the clip: the same holds, segments and
 * easing as transformAt().
 */
function keyExpr(keys: TransformKey[], prop: 'scale' | 'x' | 'y', u: string): string {
  let expr = num(keys[keys.length - 1][prop]);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i];
    const b = keys[i + 1];
    if (b.t - a.t <= 0) continue;
    const p = `clip((${u}-(${num(a.t)}))/${num(b.t - a.t)},0,1)`;
    const e = a.ease === 'smooth' ? `(${p})*(${p})*(3-2*(${p}))` : p;
    expr = `if(lt(${u},${num(b.t)}),${num(a[prop])}+(${num(b[prop] - a[prop])})*${e},${expr})`;
  }
  return expr;
}

export function outputSize(project: Project, height: number): { width: number; height: number } {
  const width = Math.round((project.width * height) / project.height / 2) * 2;
  return { width, height };
}

/**
 * Builds ffmpeg inputs and a filter graph that mirror the preview compositor:
 * video tracks are stacked with tracks[0] on top, clips are cover-fitted via placeVisual.
 */
export function buildExportPlan(project: Project, height: number, textLayers: TextLayer[]): ExportPlan {
  return buildPlan(project, height, textLayers, 'black');
}

/**
 * The picture layers of a small project laid on a clear frame and kept see-through, for baking layers into one
 * clip: what shows through them stays transparent instead of black. Looks are left to the layer the result goes on.
 */
export function buildBakePlan(project: Project): ExportPlan {
  return buildPlan(project, project.height, [], 'clear');
}

function buildPlan(project: Project, height: number, textLayers: TextLayer[], ground: 'black' | 'clear'): ExportPlan {
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error('timeline is empty');
  const { width: W, height: H } = outputSize(project, height);
  const fps = project.fps;

  const inputArgs: string[] = [];
  const filters: string[] = [];
  const audioLabels: string[] = [];
  const files = new Map<string, SideFile>();
  let grades = 0;
  let inputIndex = 0;

  const sideFile = (key: string, ext: string, content: () => string | Uint8Array): string => {
    let file = files.get(key);
    if (!file) {
      file = { name: `side${files.size}.${ext}`, content: content() };
      files.set(key, file);
    }
    return file.name;
  };
  /**
   * The clip's color on the w x h (cropped) picture, in the preview's order: noise reduction, LUT, definition,
   * sharpness, blur, glow, halation, star, vignette. Detail sizes follow the dw x dh picture before the crop, like the preview's.
   * `a + k * (a - b)` is mix with weights 1 + k and -k; the vignette mask is multiplied in (darker) or screened in (lighter).
   */
  const grade = (clip: Clip, w: number, h: number, dw: number, dh: number): string => {
    const c = clip.color;
    const n = grades++;
    const detail = detailPlan(c, dw, dh);
    const against = (tag: string, k: number, filter: string) =>
      `format=gbrap,split[${tag}${n}a][${tag}${n}b];[${tag}${n}b]${filter}[${tag}${n}f];` +
      `[${tag}${n}a][${tag}${n}f]mix=weights='${num(1 + k)} ${num(-k)}':scale=1:planes=7,`;
    let out = detail.noise > 0 ? against('dn', -detail.noise, 'median=radius=1:planes=7') : '';
    if (!isLutNeutral(c)) out += `format=rgba,lut3d=file=${sideFile(`lut ${colorKey(c)}`, 'cube', () => cubeFile(c))}:interp=trilinear,`;
    if (detail.definition) out += against('dd', detail.definition.k, `gblur=sigma=${num(detail.definition.sigma)}:steps=${GBLUR_STEPS}:planes=7`);
    if (detail.sharpness) {
      const m = 2 * detail.sharpness.steps + 1;
      const k = num(detail.sharpness.k);
      out += `format=gbrap,unsharp=lx=${m}:ly=${m}:la=${k}:cx=${m}:cy=${m}:ca=${k},`;
    }
    if (detail.blur) out += `format=gbrap,gblur=sigma=${num(detail.blur.sigma)}:steps=${GBLUR_STEPS}:planes=7,`;
    /** glowBright of each channel times its tint, as lutrgb expressions: ld(0) is the eased position above the threshold. */
    const brightLut = (threshold: number, tint: [number, number, number] = [1, 1, 1]) => {
      const t = num(threshold);
      const [r, g, b] = tint.map((k) => `'st(0,clip((val/255-${t})/(1-${t}),0,1));${num(k)}*min(255,${GLOW_GAIN}*val*ld(0)*ld(0)*(3-2*ld(0)))'`);
      return `format=rgba,lutrgb=r=${r}:g=${g}:b=${b},format=gbrap`;
    };
    const screen = (o: number) =>
      `blend=c0_mode=screen:c0_opacity=${num(o)}:c1_mode=screen:c1_opacity=${num(o)}:c2_mode=screen:c2_opacity=${num(o)}:c3_mode=normal:c3_opacity=1`;
    const gblur = (sigma: number, sigmaV = sigma) =>
      `gblur=sigma=${num(sigma)}:sigmaV=${num(sigmaV)}:steps=${GBLUR_STEPS}:planes=7`;
    if (detail.glow) {
      const g = detail.glow;
      out += `format=gbrap,split[gl${n}a][gl${n}b];[gl${n}b]${brightLut(g.threshold)},${gblur(g.sigma)}[gl${n}f];[gl${n}a][gl${n}f]${screen(g.amount)},`;
    }
    const [lr, lg, lb] = LUMA.map(num);
    const luma = `colorchannelmixer=rr=${lr}:rg=${lg}:rb=${lb}:gr=${lr}:gg=${lg}:gb=${lb}:br=${lr}:bg=${lg}:bb=${lb}`;
    const times = (k: number) => {
      const e = `'min(255,${num(k)}*val)'`;
      return `format=rgba,lutrgb=r=${e}:g=${e}:b=${e},format=gbrap`;
    };
    if (detail.halation) {
      const g = detail.halation;
      out +=
        `format=gbrap,split[ha${n}a][ha${n}b];[ha${n}b]${luma},${brightLut(g.threshold, HALATION_TINT)},${gblur(g.sigma)},${times(g.gain)}[ha${n}f];` +
        `[ha${n}a][ha${n}f]${screen(g.amount)},`;
    }
    if (detail.star) {
      const s = detail.star;
      const gain = times(s.gain);
      // starBright: the picture multiplied by the eased luma position over the threshold.
      const t = num(s.threshold);
      const ease = `'st(0,clip((val/255-${t})/(1-${t}),0,1));255*ld(0)*ld(0)*(3-2*ld(0))'`;
      out +=
        `format=gbrap,split[st${n}a][st${n}b];[st${n}b]split[st${n}c][st${n}d];` +
        `[st${n}d]${luma},format=rgba,lutrgb=r=${ease}:g=${ease}:b=${ease},format=gbrap[st${n}k];` +
        `[st${n}c][st${n}k]blend=c0_mode=multiply:c1_mode=multiply:c2_mode=multiply:c3_mode=normal:c3_opacity=1,split[st${n}h][st${n}v];` +
        `[st${n}h]${gblur(s.sigma, 0)},${gain}[st${n}hf];[st${n}v]${gblur(0, s.sigma)},${gain}[st${n}vf];` +
        `[st${n}a][st${n}hf]${screen(s.amount)}[st${n}m];[st${n}m][st${n}vf]${screen(s.amount)},`;
    }
    if (c.vignette === 0) return out;
    const key = `vig ${w}x${h} ${c.vignette.toFixed(3)} ${c.vignetteRadius.toFixed(3)} ${c.vignetteSoftness.toFixed(3)}`;
    const mask = sideFile(key, 'ppm', () => vignetteMask(c, w, h));
    const mode = c.vignette > 0 ? 'multiply' : 'screen';
    return (
      `${out}format=gbrap[vg${n}];movie=${mask},format=gbrap[vm${n}];` +
      `[vg${n}][vm${n}]blend=c0_mode=${mode}:c1_mode=${mode}:c2_mode=${mode}:c3_mode=normal:c3_opacity=1,`
    );
  };

  filters.push(
    ground === 'black'
      ? `color=c=black:s=${W}x${H}:r=${fps}:d=${num(duration)}[bg0]`
      : `color=c=black@0:s=${W}x${H}:r=${fps}:d=${num(duration)},format=rgba[bg0]`,
  );
  let base = 'bg0';
  let overlayCount = 0;
  /** ':format=auto' while overlays go onto a clear canvas (a layer of its own, or a bake), so they keep its alpha. */
  const groundFormat = ground === 'clear' ? ':format=auto' : '';
  let overlayFormat = groundFormat;

  const layers = new Map(textLayers.map((l) => [l.clipId, l]));
  /** `when` narrows the clip range further (an ffmpeg expression in t); glitch frames use it to take turns. */
  const overlay = (label: string, x: string, y: string, from: number, to: number, when = '1') => {
    const out = `o${overlayCount++}`;
    filters.push(
      `[${base}][${label}]overlay=x='${x}':y='${y}':eof_action=pass${overlayFormat}:` +
        `enable='between(t,${num(from)},${num(to - 0.0001)})*(${when})'[${out}]`,
    );
    base = out;
  };

  /**
   * Mirrors drawText's backdrop effects: the text is laid on a clear full frame to get a mask, the picture so far
   * is treated, and the treated copy goes back on top through that mask, so the result is
   * (1 - a) * under + a * treated(under) like the canvas blend. Filters only run while the clip is on screen.
   */
  const backdrop = (label: string, x: string, y: string, from: number, to: number, effect: BackdropEffect) => {
    const n = overlayCount++;
    const on = `enable='between(t,${num(from)},${num(to - 0.0001)})'`;
    filters.push(`color=c=black@0:s=${W}x${H}:r=${fps}:d=${num(duration)},format=rgba[cv${n}]`);
    const masked = `[cv${n}][${label}]overlay=x='${x}':y='${y}':eof_action=pass:format=auto:${on},format=rgba`;
    filters.push(`[${base}]format=gbrp,split[b${n}][f${n}]`);
    if (effect === 'invert') {
      filters.push(`${masked},split[mc${n}][mk${n}]`);
      filters.push(`[mc${n}]format=gbrp[mg${n}]`);
      filters.push(`[f${n}][mg${n}]blend=all_mode=difference:${on}[x${n}]`);
    } else {
      filters.push(`${masked}[mk${n}]`);
      if (effect === 'mono') {
        const [r, g, b] = MONO_WEIGHTS;
        filters.push(`[f${n}]colorchannelmixer=${r}:${g}:${b}:0:${r}:${g}:${b}:0:${r}:${g}:${b}:0:${on}[x${n}]`);
      } else {
        const lift = (c: string) => `${c}='val*${num(1 - FROST_LIFT)}+${num(255 * FROST_LIFT)}'`;
        filters.push(
          `[f${n}]gblur=sigma=${num((FROST_SIGMA * W) / project.width)}:${on},lutrgb=${lift('r')}:${lift('g')}:${lift('b')}:${on}[x${n}]`,
        );
      }
    }
    filters.push(`[mk${n}]alphaextract[ma${n}]`);
    filters.push(`[x${n}][ma${n}]alphamerge[xa${n}]`);
    const out = `o${n}`;
    filters.push(`[b${n}][xa${n}]overlay=eof_action=pass:${on}[${out}]`);
    base = out;
  };

  /**
   * Mirrors drawLayer: the layer's own canvas gets its opacity, is blended with the picture under it, and the blend
   * goes back over that picture through the layer's alpha: (1 - a) * under + a * blend(under, layer), as on the canvas.
   */
  const mixOver = (under: string, layer: string, track: Track): string => {
    const n = overlayCount++;
    const opacity = layerOpacity(track);
    filters.push(`[${layer}]${opacity < 1 ? `colorchannelmixer=aa=${num(opacity)},` : ''}split[lc${n}][lm${n}]`);
    filters.push(`[lc${n}]format=gbrp[lg${n}]`);
    filters.push(`[${under}]format=gbrp,split[ub${n}][uf${n}]`);
    filters.push(`[lg${n}][uf${n}]blend=all_mode=${FFMPEG_BLEND[layerBlend(track)]}[x${n}]`);
    filters.push(`[lm${n}]alphaextract[ma${n}]`);
    filters.push(`[x${n}][ma${n}]alphamerge[xa${n}]`);
    filters.push(`[ub${n}][xa${n}]overlay=eof_action=pass[o${n}]`);
    return `o${n}`;
  };

  /**
   * Mirrors drawGroup's clipping: the layer's alpha is cut to the group's, it is mixed onto the group like any layer,
   * and the group keeps its own alpha.
   */
  const clipInto = (group: string, layer: string, track: Track): string => {
    const n = overlayCount++;
    filters.push(`[${group}]split[gc${n}][gm${n}]`);
    filters.push(`[gm${n}]alphaextract,split[ga${n}][gk${n}]`);
    filters.push(`[${layer}]split[lc${n}][lm${n}]`);
    filters.push(`[lm${n}]alphaextract[la${n}]`);
    filters.push(`[la${n}][ga${n}]blend=all_mode=multiply[mk${n}]`);
    filters.push(`[lc${n}][mk${n}]alphamerge[cut${n}]`);
    const mixed = mixOver(`gc${n}`, `cut${n}`, track);
    filters.push(`[${mixed}][gk${n}]alphamerge,format=rgba[g${n}]`);
    return `g${n}`;
  };

  /** A clear full frame for the next overlays, which keep their alpha on it. */
  const clearCanvas = (): string => {
    const n = overlayCount++;
    filters.push(`color=c=black@0:s=${W}x${H}:r=${fps}:d=${num(duration)},format=rgba[ly${n}]`);
    return `ly${n}`;
  };

  /** Lays the track's clips over `base`: pictures while the track is shown, a video clip's sound either way. */
  const layTrack = (track: Track) => {
    for (const clip of track.clips) {
      if (isTextClip(clip)) {
        if (track.hidden) continue;
        const layer = layers.get(clip.id);
        if (!layer) throw new Error(`missing rasterized text for clip ${clip.id}`);
        const dur = clipDuration(clip);
        const textInput = (path: string): string => {
          const idx = inputIndex++;
          inputArgs.push('-loop', '1', '-framerate', String(fps), '-t', num(dur), '-i', path);
          return textChain(idx, [`fps=${fps}`, 'format=rgba']);
        };
        // One frame per output frame, then the settled text held to the clip's end.
        const introInput = (intro: IntroLayer): string => {
          const idx = inputIndex++;
          inputArgs.push('-framerate', String(fps), '-start_number', '0', '-i', intro.pattern);
          return textChain(idx, ['format=rgba', `tpad=stop_mode=clone:stop_duration=${num(dur)}`, `trim=duration=${num(dur)}`]);
        };
        const textChain = (idx: number, chain: string[]): string => {
          if (clip.anim === 'pop') {
            const f = `(${POP_FROM}+${num(1 - POP_FROM)}*min(1,t/${ANIM_IN}))`;
            chain.push(
              `scale=w='max(2,trunc(iw*${f}))':h='max(2,trunc(ih*${f}))':eval=frame`,
              // Pinned so pad stays in rgba; if negotiated to yuva420p it rounds odd sizes down and fails.
              'format=rgba',
              `pad=${layer.w}:${layer.h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000:eval=frame`,
            );
          }
          if (clip.anim !== 'none' && !isIntroAnim(clip.anim)) chain.push(`fade=t=in:st=0:d=${ANIM_IN}:alpha=1`);
          if (clip.anim !== 'none') chain.push(`fade=t=out:st=${num(Math.max(0, dur - ANIM_OUT))}:d=${ANIM_OUT}:alpha=1`);
          chain.push(`setpts=PTS-STARTPTS+${num(clip.start)}/TB`);
          const label = `t${idx}`;
          filters.push(`[${idx}:v]${chain.join(',')}[${label}]`);
          return label;
        };
        const label = layer.intro ? introInput(layer.intro) : textInput(layer.path);
        const x = String(layer.intro ? layer.intro.x : layer.x);
        const rise =
          clip.anim === 'rise'
            ? `+${num((RISE_PX * W) / project.width)}*(1-min(1,(t-${num(clip.start)})/${ANIM_IN}))`
            : '';
        const y = `${layer.intro ? layer.intro.y : layer.y}${rise}`;
        const effect = backdropEffect(clip.style.effect);
        if (effect) {
          backdrop(label, x, y, clip.start, clipEnd(clip), effect);
        } else if (layer.variants.length > 0) {
          // Same slots as glitchVariant(): the plain letters outside a burst, variant n inside it, none during an intro.
          const u = `(t-${num(clip.start)}+${num(GLITCH_EPS)})`;
          const p = `mod(${u},${num(GLITCH_EVERY)})`;
          // Half a frame early so the cut lands between the last intro frame and the first settled one.
          const settled = `gte(t-${num(clip.start)},${num(((layer.intro?.count ?? 1) - 1.5) / fps)})`;
          overlay(label, x, y, clip.start, clipEnd(clip), `gte(${p},${num(GLITCH_BURST)})+not(${settled})`);
          layer.variants.forEach((path, v) => {
            const n = `mod(floor(${u}/${num(GLITCH_EVERY)})+floor(${p}/${num(GLITCH_STEP)}),${layer.variants.length})`;
            const at = `lt(${p},${num(GLITCH_BURST)})*eq(${n},${v})*${settled}`;
            overlay(textInput(path), String(layer.x), String(layer.y), clip.start, clipEnd(clip), at);
          });
        } else {
          overlay(label, x, y, clip.start, clipEnd(clip));
        }
        continue;
      }
      if (!isMediaClip(clip)) continue;
      const asset = assetById(project, clip.assetId);
      const idx = inputIndex++;
      // Dissolves widen the picture around the cut: real source frames where the file has them, held frames past its ends.
      const span = track.hidden ? { from: clip.start, to: clipEnd(clip), fadeIn: 0 } : visualSpan(track, clip);
      const pre = clip.start - span.from;
      const post = span.to - clipEnd(clip);
      let lead = 0;
      let hold = '';
      if (asset.kind === 'image') {
        inputArgs.push('-loop', '1', '-framerate', String(fps), '-t', num(span.to - span.from), '-i', asset.path);
      } else {
        lead = Math.min(pre * clip.speed, clip.in);
        const tail = Math.min(post * clip.speed, Math.max(0, asset.duration - clip.out));
        // ffmpeg's own VP8/VP9 decoders drop the alpha plane; libvpx keeps it so the clip stays see-through.
        const decoder = asset.alpha ? ['-c:v', asset.alpha === 'vp9' ? 'libvpx-vp9' : 'libvpx'] : [];
        inputArgs.push('-ss', num(clip.in - lead), '-t', num(clip.out - clip.in + lead + tail), ...decoder, '-i', asset.path);
        const holdStart = pre - lead / clip.speed;
        const holdEnd = post - tail / clip.speed;
        if (holdStart > 1e-4 || holdEnd > 1e-4) {
          hold = `tpad=start_mode=clone:start_duration=${num(holdStart)}:stop_mode=clone:stop_duration=${num(holdEnd)},`;
        }
      }
      if (!track.hidden && clip.keys && hasKeys(clip)) {
        // Keyframed: cropped and graded at source size, then scaled every frame; overlay places each frame by its
        // own time. Same geometry as placeVisual + cropBox, without their pixel rounding.
        const keys = clip.keys;
        const label = `v${idx}`;
        const cover = Math.max(W / asset.width, H / asset.height);
        const c = clip.crop;
        const keepW = 1 - c.l - c.r;
        const keepH = 1 - c.t - c.b;
        const retime = clip.speed === 1 ? '' : `setpts=(PTS-STARTPTS)/${num(clip.speed)},`;
        const fade = span.fadeIn > 0 ? `fade=t=in:st=0:d=${num(span.fadeIn)}:alpha=1,` : '';
        const even = (e: string) => `trunc((${e})/2)*2`;
        const even2 = (v: number) => Math.trunc(v / 2) * 2;
        const crop = hasCrop(c)
          ? `crop=w='${even(`iw*${num(keepW)}`)}':h='${even(`ih*${num(keepH)}`)}':x='${even(`iw*${num(c.l)}`)}':y='${even(`ih*${num(c.t)}`)}',`
          : '';
        const sIn = keyExpr(keys, 'scale', `(t-${num(pre)})`);
        const size = (px: number) => `max(2,${even(`${num(px)}*${sIn}`)})`;
        filters.push(
          `[${idx}:v]${retime}fps=${fps},${hold}${clip.flipX ? 'hflip,' : ''}${crop}${grade(clip, even2(asset.width * keepW), even2(asset.height * keepH), asset.width, asset.height)}` +
            `scale=w='${size(asset.width * cover * keepW)}':h='${size(asset.height * cover * keepH)}':eval=frame:flags=bicubic,` +
            `setsar=1,format=yuva420p,${fade}setpts=PTS-STARTPTS+${num(span.from)}/TB[${label}]`,
        );
        const u = `(t-${num(clip.start)})`;
        const s = keyExpr(keys, 'scale', u);
        const x = `${num(W / 2)}-${num(asset.width * cover)}*${s}*${num(0.5 - c.l)}+${keyExpr(keys, 'x', u)}*${W}`;
        const y = `${num(H / 2)}-${num(asset.height * cover)}*${s}*${num(0.5 - c.t)}+${keyExpr(keys, 'y', u)}*${H}`;
        overlay(label, x, y, span.from, span.to);
      } else if (!track.hidden) {
        const r = placeVisual(asset.width, asset.height, W, H, clip.transform);
        const label = `v${idx}`;
        const retime = clip.speed === 1 ? '' : `setpts=(PTS-STARTPTS)/${num(clip.speed)},`;
        const fade = span.fadeIn > 0 ? `fade=t=in:st=0:d=${num(span.fadeIn)}:alpha=1,` : '';
        const b = hasCrop(clip.crop) ? cropBox(r, clip.crop) : { x: 0, y: 0, w: r.w, h: r.h };
        const crop = hasCrop(clip.crop) ? `crop=${b.w}:${b.h}:${b.x}:${b.y},` : '';
        filters.push(
          `[${idx}:v]${retime}fps=${fps},${hold}scale=${r.w}:${r.h}:flags=bicubic,setsar=1,${clip.flipX ? 'hflip,' : ''}${crop}${grade(clip, b.w, b.h, r.w, r.h)}format=yuva420p,` +
            `${fade}setpts=PTS-STARTPTS+${num(span.from)}/TB[${label}]`,
        );
        overlay(label, String(r.x + b.x), String(r.y + b.y), span.from, span.to);
      }
      if (asset.kind === 'video' && asset.hasAudio && !track.muted) {
        audioLabels.push(pushAudio(filters, idx, clip, lead));
      }
    }
  };

  for (const { base: bottom, clipped } of layerGroups(project)) {
    if (bottom.hidden) {
      layTrack(bottom);
      for (const track of clipped) layTrack({ ...track, hidden: true });
      continue;
    }
    if (clipped.length === 0 && !mixesAsLayer(bottom)) {
      layTrack(bottom);
      continue;
    }
    const under = base;
    overlayFormat = ':format=auto';
    base = clearCanvas();
    layTrack(bottom);
    for (const track of clipped) {
      if (track.hidden) {
        layTrack(track);
        continue;
      }
      const group = base;
      base = clearCanvas();
      layTrack(track);
      base = clipInto(group, base, track);
    }
    overlayFormat = groundFormat;
    base = mixOver(under, base, bottom);
  }

  for (const track of project.tracks.filter((t) => t.kind === 'audio')) {
    for (const clip of track.clips) {
      if (!isMediaClip(clip)) continue;
      const asset = assetById(project, clip.assetId);
      const idx = inputIndex++;
      inputArgs.push('-ss', num(clip.in), '-t', num(clip.out - clip.in), '-i', asset.path);
      if (!track.muted) audioLabels.push(pushAudio(filters, idx, clip, 0));
    }
  }

  filters.push(`[${base}]format=${ground === 'black' ? 'yuv420p' : 'yuva420p'}[vout]`);
  if (audioLabels.length === 0) {
    // A bake with no sound maps no audio, so it gets no silent track either.
    if (ground === 'black') filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${num(duration)}[aout]`);
  } else {
    filters.push(
      `${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:normalize=0:` +
        `duration=longest,apad=whole_dur=${num(duration)}[aout]`,
    );
  }

  return {
    inputArgs,
    files: [...files.values()],
    filterGraph: [SWS_FLAGS, ...filters].join(';\n'),
    duration,
    width: W,
    height: H,
    fps,
    audible: audioLabels.length > 0,
  };
}

/** A baked layer: VP9 with alpha in a webm (the format paircut reads as see-through), Opus sound when there is any. */
export function bakeArgs(plan: ExportPlan, filterScriptPath: string, outPath: string): string[] {
  return [
    '-y',
    '-hide_banner',
    '-nostats',
    '-v',
    'error',
    ...plan.inputArgs,
    '-/filter_complex',
    filterScriptPath,
    '-map',
    '[vout]',
    ...(plan.audible ? ['-map', '[aout]', '-c:a', 'libopus', '-b:a', '192k'] : []),
    '-c:v',
    'libvpx-vp9',
    '-pix_fmt',
    'yuva420p',
    '-auto-alt-ref',
    '0',
    '-b:v',
    '0',
    '-crf',
    '18',
    '-deadline',
    'good',
    '-cpu-used',
    '4',
    '-row-mt',
    '1',
    '-r',
    String(plan.fps),
    '-t',
    num(plan.duration),
    outPath,
  ];
}

/**
 * Speed, volume and fades mirror audioGain() in the preview; afade's default curve is linear.
 * `lead` is source time read before `in` for a dissolve; sound keeps to the clip's own range.
 */
function pushAudio(filters: string[], idx: number, clip: Clip, lead: number): string {
  const label = `a${idx}`;
  const dur = clipDuration(clip);
  const chain = ['aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo', 'asetpts=PTS-STARTPTS'];
  chain.push(`atrim=start=${num(lead)}:duration=${num(clip.out - clip.in)}`, 'asetpts=PTS-STARTPTS');
  if (clip.speed !== 1) chain.push(`atempo=${num(clip.speed)}`);
  if (clip.volume !== 1) chain.push(`volume=${num(clip.volume)}`);
  if (clip.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${num(clip.fadeIn)}`);
  if (clip.fadeOut > 0) chain.push(`afade=t=out:st=${num(Math.max(0, dur - clip.fadeOut))}:d=${num(clip.fadeOut)}`);
  chain.push(`adelay=${Math.round(clip.start * 1000)}:all=1`);
  filters.push(`[${idx}:a]${chain.join(',')}[${label}]`);
  return label;
}

export function ffmpegArgs(plan: ExportPlan, filterScriptPath: string, outPath: string): string[] {
  return [
    '-y',
    '-hide_banner',
    '-nostats',
    '-progress',
    'pipe:1',
    ...plan.inputArgs,
    '-/filter_complex',
    filterScriptPath,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(plan.fps),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-t',
    num(plan.duration),
    '-movflags',
    '+faststart',
    outPath,
  ];
}
