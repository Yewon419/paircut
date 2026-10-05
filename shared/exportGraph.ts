import {
  ANIM_IN,
  ANIM_OUT,
  assetById,
  backdropEffect,
  behindOverlap,
  behindSubjects,
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
  isMediaClip,
  isTextClip,
  matteIndex,
  matteNeeds,
  MONO_WEIGHTS,
  placeVisual,
  POP_FROM,
  projectDuration,
  RISE_PX,
  sourceTime,
  visualSpan,
} from './project';
import type { BackdropEffect, Clip, Project, TextClip, Track } from './project';
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
}

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
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error('timeline is empty');
  const { width: W, height: H } = outputSize(project, height);
  const fps = project.fps;
  const missing = matteNeeds(project);
  if (missing.length > 0) {
    const list = missing.map((m) => `${assetById(project, m.assetId).name} ${num(m.from)}-${num(m.to)}s`).join(', ');
    throw new Error(`subject masks are missing for text set to behind (${list}); cut them in the inspector first`);
  }

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

  filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${num(duration)}[bg0]`);
  let base = 'bg0';
  let overlayCount = 0;

  const layers = new Map(textLayers.map((l) => [l.clipId, l]));
  /** `when` narrows the clip range further (an ffmpeg expression in t); glitch frames use it to take turns. */
  const overlay = (label: string, x: string, y: string, from: number, to: number, when = '1') => {
    const out = `o${overlayCount++}`;
    filters.push(
      `[${base}][${label}]overlay=x='${x}':y='${y}':eof_action=pass:` +
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
   * Mirrors drawSubjects(): `under` is the picture before the letters went on; it goes back over them through the
   * subject clips' matte frames, laid where those clips are placed, on a clear full frame.
   */
  const subjects = (text: TextClip, under: string) => {
    const n = overlayCount++;
    filters.push(`color=c=black@0:s=${W}x${H}:r=${fps}:d=${num(duration)},format=rgba[sm${n}]`);
    let mask = `sm${n}`;
    behindSubjects(project, text).forEach((clip, j) => {
      const asset = assetById(project, clip.assetId);
      const matte = asset.matte;
      if (!matte) throw new Error(`no subject masks on ${asset.path}`);
      const span = behindOverlap(text, clip);
      const len = span.to - span.from;
      const idx = inputIndex++;
      const pattern = `${matte.dir}/m%05d.png`;
      if (asset.kind === 'image') {
        inputArgs.push('-loop', '1', '-framerate', String(fps), '-t', num(len), '-i', pattern.replace('%05d', '00000'));
      } else {
        const first = matteIndex(matte, sourceTime(clip, span.from));
        inputArgs.push('-framerate', String(fps), '-start_number', String(first), '-i', pattern);
      }
      const r = placeVisual(asset.width, asset.height, W, H, clip.transform);
      const b = hasCrop(clip.crop) ? cropBox(r, clip.crop) : { x: 0, y: 0, w: r.w, h: r.h };
      const crop = hasCrop(clip.crop) ? `crop=${b.w}:${b.h}:${b.x}:${b.y},` : '';
      const retime = clip.speed === 1 || asset.kind === 'image' ? '' : `setpts=(PTS-STARTPTS)/${num(clip.speed)},`;
      filters.push(
        `[${idx}:v]${retime}fps=${fps},trim=duration=${num(len)},scale=${r.w}:${r.h}:flags=bicubic,format=rgba,${crop}` +
          `setpts=PTS-STARTPTS+${num(span.from)}/TB[mt${n}_${j}]`,
      );
      const next = `sm${n}_${j}`;
      filters.push(
        `[${mask}][mt${n}_${j}]overlay=x=${r.x + b.x}:y=${r.y + b.y}:eof_action=pass:format=auto:` +
          `enable='between(t,${num(span.from)},${num(span.to - 0.0001)})',format=rgba[${next}]`,
      );
      mask = next;
    });
    filters.push(`[${mask}]alphaextract[sa${n}]`);
    filters.push(`[${under}]format=rgba[su${n}]`);
    filters.push(`[su${n}][sa${n}]alphamerge[sx${n}]`);
    const out = `o${n}`;
    filters.push(
      `[${base}][sx${n}]overlay=eof_action=pass:enable='between(t,${num(text.start)},${num(clipEnd(text) - 0.0001)})'[${out}]`,
    );
    base = out;
  };

  const visualTracks = project.tracks.filter((t: Track) => t.kind !== 'audio');
  for (let ti = visualTracks.length - 1; ti >= 0; ti--) {
    const track = visualTracks[ti];
    for (const clip of track.clips) {
      if (isTextClip(clip)) {
        if (track.hidden) continue;
        const layer = layers.get(clip.id);
        if (!layer) throw new Error(`missing rasterized text for clip ${clip.id}`);
        const dur = clipDuration(clip);
        const textInput = (path: string): string => {
          const idx = inputIndex++;
          inputArgs.push('-loop', '1', '-framerate', String(fps), '-t', num(dur), '-i', path);
          const chain = [`fps=${fps}`, 'format=rgba'];
          if (clip.anim === 'pop') {
            const f = `(${POP_FROM}+${num(1 - POP_FROM)}*min(1,t/${ANIM_IN}))`;
            chain.push(
              `scale=w='max(2,trunc(iw*${f}))':h='max(2,trunc(ih*${f}))':eval=frame`,
              // Pinned so pad stays in rgba; if negotiated to yuva420p it rounds odd sizes down and fails.
              'format=rgba',
              `pad=${layer.w}:${layer.h}:(ow-iw)/2:(oh-ih)/2:color=0x00000000:eval=frame`,
            );
          }
          if (clip.anim !== 'none') {
            chain.push(
              `fade=t=in:st=0:d=${ANIM_IN}:alpha=1`,
              `fade=t=out:st=${num(Math.max(0, dur - ANIM_OUT))}:d=${ANIM_OUT}:alpha=1`,
            );
          }
          chain.push(`setpts=PTS-STARTPTS+${num(clip.start)}/TB`);
          const label = `t${idx}`;
          filters.push(`[${idx}:v]${chain.join(',')}[${label}]`);
          return label;
        };
        const label = textInput(layer.path);
        const x = String(layer.x);
        const rise =
          clip.anim === 'rise'
            ? `+${num((RISE_PX * W) / project.width)}*(1-min(1,(t-${num(clip.start)})/${ANIM_IN}))`
            : '';
        const y = `${layer.y}${rise}`;
        const effect = backdropEffect(clip.style.effect);
        const behind = clip.style.effect === 'behind' && behindSubjects(project, clip).length > 0;
        let under = '';
        if (behind) {
          under = `u${overlayCount++}`;
          filters.push(`[${base}]split[${under}a][${under}]`);
          base = `${under}a`;
        }
        if (effect) {
          backdrop(label, x, y, clip.start, clipEnd(clip), effect);
        } else if (layer.variants.length > 0) {
          // Same slots as glitchVariant(): the plain letters outside a burst, variant n inside it.
          const u = `(t-${num(clip.start)}+${num(GLITCH_EPS)})`;
          const p = `mod(${u},${num(GLITCH_EVERY)})`;
          overlay(label, x, y, clip.start, clipEnd(clip), `gte(${p},${num(GLITCH_BURST)})`);
          layer.variants.forEach((path, v) => {
            const n = `mod(floor(${u}/${num(GLITCH_EVERY)})+floor(${p}/${num(GLITCH_STEP)}),${layer.variants.length})`;
            overlay(textInput(path), x, y, clip.start, clipEnd(clip), `lt(${p},${num(GLITCH_BURST)})*eq(${n},${v})`);
          });
        } else {
          overlay(label, x, y, clip.start, clipEnd(clip));
        }
        if (behind) subjects(clip, under);
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

  filters.push(`[${base}]format=yuv420p[vout]`);
  if (audioLabels.length === 0) {
    filters.push(`anullsrc=r=48000:cl=stereo,atrim=duration=${num(duration)}[aout]`);
  } else {
    filters.push(
      `${audioLabels.map((l) => `[${l}]`).join('')}amix=inputs=${audioLabels.length}:normalize=0:` +
        `duration=longest,apad=whole_dur=${num(duration)}[aout]`,
    );
  }

  return { inputArgs, luts: [...luts.values()], filterGraph: filters.join(';\n'), duration, width: W, height: H, fps };
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
