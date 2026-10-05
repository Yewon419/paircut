import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MediaAsset, Matte } from '../shared/project';
import { FFMPEG } from './media';

export const PYTHON = process.env.CUTDESK_PYTHON ?? 'python';
/** u2net measured 0.48 s per 1080x1920 frame on this machine's CPU, isnet-general-use 1.06 s. */
const MODEL = 'u2net';
/** Masks are cut at this longest side; the model itself works at 320 px, so more only costs disk. */
const MATTE_SIDE = 960;

function runLogged(cmd: string, args: string[], onLine: (line: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stderr = '';
    let buf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      lines.forEach(onLine);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', (err) => reject(new Error(`${cmd} could not start: ${err.message}`, { cause: err })));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}:\n${stderr}`));
    });
  });
}

/**
 * Cuts subject masks for asset source seconds [from, to] at fps into a folder under `root`, reusing a finished one.
 * Video frames are pulled with ffmpeg (fps filter from `from`), so frame n matches the source at from + n / fps.
 */
export async function makeMatte(
  asset: MediaAsset,
  from: number,
  to: number,
  fps: number,
  root: string,
  script: string,
  onProgress: (done: number, total: number) => void,
): Promise<Matte> {
  if (asset.kind === 'audio') throw new Error(`no picture to cut a subject from: ${asset.path}`);
  const st = statSync(asset.path);
  const key = createHash('sha1')
    .update(`${asset.path}|${st.size}|${st.mtimeMs}|${from.toFixed(4)}|${to.toFixed(4)}|${fps}|${MODEL}`)
    .digest('hex');
  const dir = join(root, key);
  const doneFile = join(dir, 'done.json');
  if (existsSync(doneFile)) {
    const { count } = JSON.parse(readFileSync(doneFile, 'utf8')) as { count: number };
    return { dir, from, to, fps, count };
  }
  const frames = join(root, `${key}-frames`);
  rmSync(frames, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(frames, { recursive: true });
  const scale = `scale='if(gte(iw,ih),min(${MATTE_SIDE},iw),-2)':'if(gte(iw,ih),-2,min(${MATTE_SIDE},ih))'`;
  const pick =
    asset.kind === 'image'
      ? ['-i', asset.path, '-frames:v', '1', '-vf', scale]
      : ['-ss', from.toFixed(4), '-i', asset.path, '-t', (to - from + 1 / fps).toFixed(4), '-vf', `fps=${fps},${scale}`];
  try {
    await runLogged(FFMPEG, ['-y', '-v', 'error', ...pick, '-start_number', '0', join(frames, 'f%05d.png')], () => {});
    const total = asset.kind === 'image' ? 1 : Math.round((to - from) * fps) + 1;
    onProgress(0, total);
    let count = 0;
    await runLogged(PYTHON, [script, frames, dir, MODEL], (line) => {
      const m = /^(\d+)\/(\d+)$/.exec(line.trim());
      if (!m) return;
      count = Number(m[2]);
      onProgress(Number(m[1]), count);
    });
    if (count === 0) throw new Error(`matte script finished without frames for ${asset.path} [${from}, ${to}]`);
    writeFileSync(doneFile, JSON.stringify({ count }), 'utf8');
    return { dir, from, to, fps, count };
  } finally {
    rmSync(frames, { recursive: true, force: true });
  }
}
