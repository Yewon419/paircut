import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { MediaAsset, MediaKind } from '../shared/project';
import { IMAGE_DEFAULT_DURATION } from '../shared/project';

const run = promisify(execFile);

export const FFMPEG = process.env.CUTDESK_FFMPEG ?? 'ffmpeg';
export const FFPROBE = process.env.CUTDESK_FFPROBE ?? 'ffprobe';

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif']);

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  disposition?: { attached_pic?: number };
  tags?: { rotate?: string; alpha_mode?: string; ALPHA_MODE?: string };
  side_data_list?: { rotation?: number }[];
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

async function runTool(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run(cmd, args, { maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    throw new Error(`${cmd} failed (${args.join(' ')}): ${e.stderr ?? e.message}`, { cause: err });
  }
}

function rotationOf(stream: ProbeStream): number {
  const fromSide = stream.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation;
  const raw = fromSide ?? Number(stream.tags?.rotate ?? 0);
  return ((Math.round(raw) % 360) + 360) % 360;
}

/** VP8/VP9 webm with an alpha channel; it is stored beside the picture and only libvpx decodes it. */
function alphaCodec(stream: ProbeStream): 'vp8' | 'vp9' | null {
  const flagged = (stream.tags?.alpha_mode ?? stream.tags?.ALPHA_MODE) === '1';
  if (!flagged) return null;
  if (stream.codec_name === 'vp8' || stream.codec_name === 'vp9') return stream.codec_name;
  return null;
}

export async function probe(path: string): Promise<Omit<MediaAsset, 'thumbPath' | 'wavePath'>> {
  if (!existsSync(path)) throw new Error(`file not found: ${path}`);
  const out = await runTool(FFPROBE, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    path,
  ]);
  const info = JSON.parse(out) as ProbeResult;
  const streams = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const isImage = IMAGE_EXT.has(extname(path).toLowerCase());

  let kind: MediaKind;
  if (isImage && video) kind = 'image';
  else if (video) kind = 'video';
  else if (audio) kind = 'audio';
  else throw new Error(`no usable video or audio stream: ${path}`);

  let width = video?.width ?? 0;
  let height = video?.height ?? 0;
  if (video && (rotationOf(video) === 90 || rotationOf(video) === 270)) {
    [width, height] = [height, width];
  }
  const duration = kind === 'image' ? IMAGE_DEFAULT_DURATION : Number(info.format?.duration ?? video?.duration ?? 0);
  if (!(duration > 0)) throw new Error(`could not read duration: ${path}`);
  if (kind !== 'audio' && !(width > 0 && height > 0)) throw new Error(`could not read frame size: ${path}`);

  const asset: Omit<MediaAsset, 'thumbPath' | 'wavePath'> = {
    id: randomUUID(),
    path,
    name: basename(path),
    kind,
    duration,
    width,
    height,
    hasAudio: kind === 'video' && audio !== undefined,
  };
  const alpha = kind === 'video' && video ? alphaCodec(video) : null;
  if (alpha) asset.alpha = alpha;
  return asset;
}

function cacheKey(path: string, suffix: string): string {
  const st = statSync(path);
  return createHash('sha1').update(`${path}|${st.size}|${st.mtimeMs}|${suffix}`).digest('hex');
}

export const THUMB_FRAMES_MAX = 60;

export async function makeFilmstrip(path: string, duration: number, cacheDir: string): Promise<string> {
  const frames = Math.min(THUMB_FRAMES_MAX, Math.max(4, Math.ceil(duration)));
  const out = join(cacheDir, `${cacheKey(path, `strip${frames}`)}.jpg`);
  if (existsSync(out)) return out;
  await runTool(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-i',
    path,
    '-vf',
    `fps=${frames}/${duration.toFixed(3)},scale=-2:72,tile=${frames}x1`,
    '-frames:v',
    '1',
    '-q:v',
    '5',
    out,
  ]);
  return out;
}

export async function makeWaveform(path: string, cacheDir: string): Promise<string> {
  const out = join(cacheDir, `${cacheKey(path, 'wave')}.png`);
  if (existsSync(out)) return out;
  await runTool(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-i',
    path,
    '-filter_complex',
    'aformat=channel_layouts=mono,showwavespic=s=2400x96:colors=0x9fd0f0',
    '-frames:v',
    '1',
    out,
  ]);
  return out;
}

/** A one-color PNG of the given size, reused when the same color and size were made before. */
export async function makeSolidImage(color: string, width: number, height: number, dir: string): Promise<string> {
  const m = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (!m) throw new Error(`solid color must be #RRGGBB, got ${JSON.stringify(color)}`);
  if (!(Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0)) {
    throw new Error(`solid size must be positive integers, got ${width}x${height}`);
  }
  const hex = m[1].toUpperCase();
  const out = join(dir, `solid-${hex}-${width}x${height}.png`);
  if (existsSync(out)) return out;
  await runTool(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=${width}x${height}`, '-frames:v', '1', out]);
  return out;
}

export async function importMedia(path: string, cacheDir: string): Promise<MediaAsset> {
  const base = await probe(path);
  let thumbPath: string | null = null;
  let wavePath: string | null = null;
  if (base.kind === 'video') thumbPath = await makeFilmstrip(path, base.duration, cacheDir);
  if (base.kind === 'image') thumbPath = path;
  if (base.kind === 'audio') wavePath = await makeWaveform(path, cacheDir);
  return { ...base, thumbPath, wavePath };
}
