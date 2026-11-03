import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ImportStage } from '../shared/api';
import type { MediaAsset, MediaKind } from '../shared/project';
import { IMAGE_DEFAULT_DURATION } from '../shared/project';

const run = promisify(execFile);

export const FFMPEG = process.env.PAIRCUT_FFMPEG ?? 'ffmpeg';
export const FFPROBE = process.env.PAIRCUT_FFPROBE ?? 'ffprobe';

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

/**
 * Runs ffmpeg with `-progress pipe:1` and reports out_time / duration (0..1) as it goes. Errors carry the args and
 * the tail of stderr like runTool. Reports every 0.1s (ffmpeg's default is 0.5s), so a pass of under a second still
 * shows steps in between.
 */
function runFfmpegProgress(args: string[], duration: number, onRatio: (ratio: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const full = ['-progress', 'pipe:1', '-stats_period', '0.1', '-nostats', ...args];
    const child = spawn(FFMPEG, full, { windowsHide: true });
    let stdoutBuf = '';
    let stderrTail = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdoutBuf += chunk;
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) onRatio(Math.min(1, Number(m[1]) / 1e6 / duration));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    });
    child.on('error', (err) => reject(new Error(`${FFMPEG} could not start (${full.join(' ')}): ${err.message}`, { cause: err })));
    child.on('close', (code) => {
      if (code === 0) {
        onRatio(1);
        resolve();
      } else reject(new Error(`${FFMPEG} failed with code ${code} (${full.join(' ')}): ${stderrTail}`));
    });
  });
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

/**
 * The clip's filmstrip: `frames` small frames spread over its length, side by side in one JPEG. The frames are
 * written first (one output, so ffmpeg's out_time follows the source and gives the ratio), then tiled.
 */
export async function makeFilmstrip(
  path: string,
  duration: number,
  cacheDir: string,
  onRatio: (ratio: number) => void,
): Promise<string> {
  const frames = Math.min(THUMB_FRAMES_MAX, Math.max(4, Math.ceil(duration)));
  const out = join(cacheDir, `${cacheKey(path, `strip${frames}`)}.jpg`);
  if (existsSync(out)) return out;
  const work = mkdtempSync(join(tmpdir(), 'paircut-strip-'));
  try {
    const pattern = join(work, '%03d.png');
    await runFfmpegProgress(['-y', '-v', 'error', '-i', path, '-vf', `fps=${frames}/${duration.toFixed(3)},scale=-2:72`, pattern], duration, onRatio);
    await runTool(FFMPEG, ['-y', '-v', 'error', '-i', pattern, '-vf', `tile=${frames}x1`, '-frames:v', '1', '-q:v', '5', out]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return out;
}

/** Waveform pixels per second of source, near the timeline's default zoom so short and long files look alike. */
const WAVE_PX_PER_SEC = 100;
/** Widest waveform PNG; Chromium was checked to draw a 112k-wide strip as a clip background. */
const WAVE_WIDTH_MAX = 120_000;

export async function makeWaveform(path: string, duration: number, cacheDir: string): Promise<string> {
  const width = Math.min(WAVE_WIDTH_MAX, Math.max(1, Math.ceil(duration * WAVE_PX_PER_SEC)));
  const out = join(cacheDir, `${cacheKey(path, `wave${width}`)}.png`);
  if (existsSync(out)) return out;
  // Peak, not the default average: averaging a column's samples flattens the drawn amplitude.
  await runTool(FFMPEG, [
    '-y',
    '-v',
    'error',
    '-i',
    path,
    '-filter_complex',
    `aformat=channel_layouts=mono,showwavespic=s=${width}x96:colors=0x9fd0f0:filter=peak`,
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

/**
 * One frame of a video as a PNG, `seconds` into the source. Alpha webm is decoded with libvpx so the still keeps
 * its transparency.
 */
export async function makeStillImage(path: string, seconds: number, alpha: 'vp8' | 'vp9' | undefined, dir: string): Promise<string> {
  if (!(Number.isFinite(seconds) && seconds >= 0)) throw new Error(`still time must be >= 0 seconds, got ${seconds}`);
  const ms = Math.round(seconds * 1000);
  const out = join(dir, `${cacheKey(path, `still${ms}`)}.png`);
  if (existsSync(out)) return out;
  const decoder = alpha ? ['-c:v', alpha === 'vp9' ? 'libvpx-vp9' : 'libvpx'] : [];
  await runTool(FFMPEG, ['-y', '-v', 'error', '-ss', (ms / 1000).toFixed(3), ...decoder, '-i', path, '-frames:v', '1', out]);
  if (!existsSync(out)) throw new Error(`ffmpeg wrote no frame at ${seconds}s of ${path}`);
  return out;
}

/** Side of the square each sampled frame is shrunk to for color statistics. */
const SAMPLE_SIDE = 64;

/** rgb24 pixels of the frames at `times` (seconds), each shrunk to SAMPLE_SIDE x SAMPLE_SIDE, one after another. */
export async function sampleFrames(path: string, times: number[], alpha: 'vp8' | 'vp9' | undefined): Promise<Uint8Array> {
  const decoder = alpha ? ['-c:v', alpha === 'vp9' ? 'libvpx-vp9' : 'libvpx'] : [];
  const frames = await Promise.all(
    times.map(async (t) => {
      const args = ['-v', 'error', '-ss', t.toFixed(3), ...decoder, '-i', path, '-frames:v', '1',
        '-vf', `scale=${SAMPLE_SIDE}:${SAMPLE_SIDE}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'];
      try {
        const { stdout } = await run(FFMPEG, args, { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
        return stdout;
      } catch (err) {
        const e = err as { stderr?: Buffer; message: string };
        throw new Error(`${FFMPEG} failed (${args.join(' ')}): ${e.stderr?.toString() ?? e.message}`, { cause: err });
      }
    }),
  );
  const out = Buffer.concat(frames);
  if (out.length === 0) throw new Error(`ffmpeg sampled no frames of ${path} at ${times.join(', ')}s`);
  return new Uint8Array(out);
}

export async function importMedia(path: string, cacheDir: string): Promise<MediaAsset> {
  return importMediaTracked(path, cacheDir, () => undefined);
}

/** importMedia that reports each step: 'probe' at the start, then 'thumb' with the filmstrip ratio or 'wave'. */
export async function importMediaTracked(
  path: string,
  cacheDir: string,
  onStep: (stage: ImportStage, ratio: number) => void,
): Promise<MediaAsset> {
  onStep('probe', 0);
  const base = await probe(path);
  let thumbPath: string | null = null;
  let wavePath: string | null = null;
  if (base.kind === 'video') {
    onStep('thumb', 0);
    thumbPath = await makeFilmstrip(path, base.duration, cacheDir, (ratio) => onStep('thumb', ratio));
  }
  if (base.kind === 'image') thumbPath = path;
  if (base.kind === 'audio') {
    onStep('wave', 0);
    wavePath = await makeWaveform(path, base.duration, cacheDir);
  }
  return { ...base, thumbPath, wavePath };
}
