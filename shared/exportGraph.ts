import {
  ANIM_IN,
  ANIM_OUT,
  assetById,
  clipDuration,
  clipEnd,
  cropBox,
  hasCrop,
  isMediaClip,
  isTextClip,
  placeVisual,
  POP_FROM,
  projectDuration,
  RISE_PX,
  visualSpan,
} from './project';
import type { Clip, Project, Track } from './project';
import { colorKey, cubeFile, isNeutral } from './color';

/** A text clip rasterized by the renderer at export resolution, placed at its settled position. */
export interface TextLayer {
  clipId: string;
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
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
  const overlay = (label: string, x: string, y: string, from: number, to: number) => {
    const out = `o${overlayCount++}`;
    filters.push(
      `[${base}][${label}]overlay=x='${x}':y='${y}':eof_action=pass:` +
        `enable='between(t,${num(from)},${num(to - 0.0001)})'[${out}]`,
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
        const idx = inputIndex++;
        const dur = clipDuration(clip);
        inputArgs.push('-loop', '1', '-framerate', String(fps), '-t', num(dur), '-i', layer.path);
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
        const rise =
          clip.anim === 'rise'
            ? `+${num((RISE_PX * W) / project.width)}*(1-min(1,(t-${num(clip.start)})/${ANIM_IN}))`
            : '';
        overlay(label, String(layer.x), `${layer.y}${rise}`, clip.start, clipEnd(clip));
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
        inputArgs.push('-ss', num(clip.in - lead), '-t', num(clip.out - clip.in + lead + tail), '-i', asset.path);
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
