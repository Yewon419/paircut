import { assetById, clipDuration, clipEnd, placeVisual, projectDuration } from './project';
import type { Project } from './project';

export interface ExportPlan {
  inputArgs: string[];
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
export function buildExportPlan(project: Project, height: number): ExportPlan {
  const duration = projectDuration(project);
  if (duration <= 0) throw new Error('timeline is empty');
  const { width: W, height: H } = outputSize(project, height);
  const fps = project.fps;

  const inputArgs: string[] = [];
  const filters: string[] = [];
  const audioLabels: string[] = [];
  let inputIndex = 0;

  filters.push(`color=c=black:s=${W}x${H}:r=${fps}:d=${num(duration)}[bg0]`);
  let base = 'bg0';
  let overlayCount = 0;

  const videoTracks = project.tracks.filter((t) => t.kind === 'video');
  for (let ti = videoTracks.length - 1; ti >= 0; ti--) {
    const track = videoTracks[ti];
    for (const clip of track.clips) {
      const asset = assetById(project, clip.assetId);
      const dur = clipDuration(clip);
      const idx = inputIndex++;
      if (asset.kind === 'image') {
        inputArgs.push('-loop', '1', '-framerate', String(fps), '-t', num(dur), '-i', asset.path);
      } else {
        inputArgs.push('-ss', num(clip.in), '-t', num(dur), '-i', asset.path);
      }
      if (!track.hidden) {
        const r = placeVisual(asset.width, asset.height, W, H, clip.transform);
        const label = `v${idx}`;
        filters.push(
          `[${idx}:v]fps=${fps},scale=${r.w}:${r.h}:flags=bicubic,setsar=1,format=yuva420p,` +
            `setpts=PTS-STARTPTS+${num(clip.start)}/TB[${label}]`,
        );
        const out = `o${overlayCount++}`;
        filters.push(
          `[${base}][${label}]overlay=x=${r.x}:y=${r.y}:eof_action=pass:` +
            `enable='between(t,${num(clip.start)},${num(clipEnd(clip) - 0.0001)})'[${out}]`,
        );
        base = out;
      }
      if (asset.kind === 'video' && asset.hasAudio && !track.muted) {
        audioLabels.push(pushAudio(filters, idx, clip.start));
      }
    }
  }

  for (const track of project.tracks.filter((t) => t.kind === 'audio')) {
    for (const clip of track.clips) {
      const asset = assetById(project, clip.assetId);
      const idx = inputIndex++;
      inputArgs.push('-ss', num(clip.in), '-t', num(clipDuration(clip)), '-i', asset.path);
      if (!track.muted) audioLabels.push(pushAudio(filters, idx, clip.start));
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

  return { inputArgs, filterGraph: filters.join(';\n'), duration, width: W, height: H, fps };
}

function pushAudio(filters: string[], idx: number, start: number): string {
  const label = `a${idx}`;
  const delayMs = Math.round(start * 1000);
  filters.push(
    `[${idx}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
      `asetpts=PTS-STARTPTS,adelay=${delayMs}:all=1[${label}]`,
  );
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
