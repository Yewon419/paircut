// End-to-end export check: real ffmpeg, generated fixtures, pixel and audio assertions on the output.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { runExport } = require('../dist-electron/electron/exporter.js');
const { importMedia } = require('../dist-electron/electron/media.js');

const root = resolve(import.meta.dirname, '..');

export function freshDir(name) {
  const dir = join(root, '.e2e', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'cache'), { recursive: true });
  return dir;
}

function ff(args) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
}

export function makeFixtures(target) {
  const f = (n) => join(target, n);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=440:d=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', f('land.mp4')]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('flat.mp4')]);
  ff(['-display_rotation:v:0', '90', '-i', f('flat.mp4'), '-c', 'copy', f('rot.mp4')]);
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=800x800', '-frames:v', '1', f('pic.png')]);
  ff(['-f', 'lavfi', '-i', 'sine=f=880:d=3', '-c:a', 'aac', f('tone.m4a')]);
  return f;
}

export function samplePixel(file, t, x, y) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `crop=8:8:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  return [buf[0], buf[1], buf[2]];
}

function volumeOf(file, from, to) {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(from), '-to', String(to), '-i', file,
    '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(res.stderr);
  if (!m) throw new Error(`no max_volume in: ${res.stderr}`);
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

export async function buildFixtureProject(f, cacheDir) {
  const land = await importMedia(f('land.mp4'), cacheDir);
  const rot = await importMedia(f('rot.mp4'), cacheDir);
  const pic = await importMedia(f('pic.png'), cacheDir);
  const tone = await importMedia(f('tone.m4a'), cacheDir);
  const T = { scale: 1, x: 0, y: 0 };
  return {
    assets: { land, rot, pic, tone },
    project: {
      version: 1, width: 1080, height: 1920, fps: 30,
      assets: [land, rot, pic, tone],
      tracks: [
        { id: 'v-top', kind: 'video', muted: false, hidden: false, clips: [
          { id: 'c-top', assetId: pic.id, start: 1, in: 0, out: 1, transform: { scale: 0.3, x: 0, y: 0 } },
        ] },
        { id: 'v-main', kind: 'video', muted: false, hidden: false, clips: [
          { id: 'c1', assetId: land.id, start: 0, in: 0.5, out: 3.5, transform: T },
          { id: 'c2', assetId: pic.id, start: 3, in: 0, out: 2, transform: T },
          { id: 'c3', assetId: rot.id, start: 5, in: 0, out: 2, transform: T },
        ] },
        { id: 'a-1', kind: 'audio', muted: false, hidden: false, clips: [
          { id: 'c4', assetId: tone.id, start: 2, in: 0, out: 3, transform: T },
        ] },
      ],
    },
  };
}

async function main() {
  const dir = freshDir('export');
  const f = makeFixtures(dir);
  const { assets, project } = await buildFixtureProject(f, join(dir, 'cache'));
  check('rotated phone clip reads as portrait', assets.rot.width === 1080 && assets.rot.height === 1920,
    `${assets.rot.width}x${assets.rot.height}`);
  check('filmstrip created', Boolean(assets.land.thumbPath));
  check('waveform created', Boolean(assets.tone.wavePath));

  const out = join(dir, 'out.mp4');
  const job = runExport(project, 1920, out, () => {});
  const result = await job.done;
  check('export finished', result.type === 'done', result.type === 'error' ? result.message : result.type);
  if (result.type !== 'done') process.exit(1);

  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format',
    '-show_streams', out], { encoding: 'utf8' }));
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  check('1080x1920 h264', v.width === 1080 && v.height === 1920 && v.codec_name === 'h264', `${v.width}x${v.height} ${v.codec_name}`);
  check('aac audio', a?.codec_name === 'aac');
  const dur = Number(info.format.duration);
  check('duration 7s', Math.abs(dur - 7) < 0.1, String(dur));

  const notBlack = (p) => p[0] + p[1] + p[2] > 60;
  const isRed = (p) => p[0] > 180 && p[1] < 70 && p[2] < 70;
  check('landscape clip fills frame edge (no letterbox)', notBlack(samplePixel(out, 0.5, 4, 1200)), samplePixel(out, 0.5, 4, 1200).join(','));
  check('overlay image centered at 1.5s', isRed(samplePixel(out, 1.5, 536, 956)), samplePixel(out, 1.5, 536, 956).join(','));
  check('overlay gone at 2.5s', !isRed(samplePixel(out, 2.5, 536, 956)), samplePixel(out, 2.5, 536, 956).join(','));
  check('image clip fills frame at 4s', isRed(samplePixel(out, 4, 4, 4)), samplePixel(out, 4, 4, 4).join(','));
  check('rotated clip fills corner at 6s', notBlack(samplePixel(out, 6, 4, 1900)), samplePixel(out, 6, 4, 1900).join(','));

  check('clip audio present 0-1s', volumeOf(out, 0.2, 0.8) > -30, `${volumeOf(out, 0.2, 0.8)} dB`);
  check('audio track present 3.5-4.5s', volumeOf(out, 3.6, 4.4) > -30, `${volumeOf(out, 3.6, 4.4)} dB`);
  check('silent after 5.2s', volumeOf(out, 5.3, 6.8) < -60, `${volumeOf(out, 5.3, 6.8)} dB`);

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('export e2e: all checks passed');
}

if (process.argv[1] === import.meta.filename) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
