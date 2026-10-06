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
import type { BackdropEffect, BlendMode, Clip, Project, Track } from './project';
import { colorKey, cubeFile, isNeutral } from './color';

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

/** A .cube file the exporter writes next to the filter script; ffmpeg runs with that folder as cwd. */
export interface LutFile {
  name: string;
  content: string;
}

export interface ExportPlan {
  inputArgs: string[];
  luts: LutFile[];
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

function num(n: number): string {
  return n.toFixed(4).replace(/\.?0+$/, '') || '0';
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
  const luts = new Map<string, LutFile>();
  let inputIndex = 0;

  const grade = (clip: Clip): string => {
    if (isNeutral(clip.color)) return '';
    const key = colorKey(clip.color);
    let lut = luts.get(key);
    if (!lut) {
      lut = { name: `lut${luts.size}.cube`, content: cubeFile(clip.color) };
      luts.set(key, lut);
    }
    return `format=rgba,lut3d=file=${lut.name}:interp=trilinear,`;
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
      if (!track.hidden) {
        const r = placeVisual(asset.width, asset.height, W, H, clip.transform);
        const label = `v${idx}`;
        const retime = clip.speed === 1 ? '' : `setpts=(PTS-STARTPTS)/${num(clip.speed)},`;
        const fade = span.fadeIn > 0 ? `fade=t=in:st=0:d=${num(span.fadeIn)}:alpha=1,` : '';
        const b = hasCrop(clip.crop) ? cropBox(r, clip.crop) : { x: 0, y: 0, w: r.w, h: r.h };
        const crop = hasCrop(clip.crop) ? `crop=${b.w}:${b.h}:${b.x}:${b.y},` : '';
        filters.push(
          `[${idx}:v]${retime}fps=${fps},${hold}scale=${r.w}:${r.h}:flags=bicubic,setsar=1,${crop}${grade(clip)}format=yuva420p,` +
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
    luts: [...luts.values()],
    filterGraph: filters.join(';\n'),
    duration,
    width: W,
    height: H,
    fps,
    audible: audioLabels.length > 0,
  };
}

/** A baked layer: VP9 with alpha in a webm (the format cutdesk reads as see-through), Opus sound when there is any. */
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
