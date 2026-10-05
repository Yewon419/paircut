// End-to-end export check: real ffmpeg, generated fixtures, pixel and audio assertions on the output.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { runExport } = require('../dist-electron/electron/exporter.js');
const { importMedia } = require('../dist-electron/electron/media.js');
const { MEDIA_CLIP_DEFAULTS, normalizeProject } = require('../dist-electron/shared/project.js');
const { BITTEUL_COLOR, gradePixel } = require('../dist-electron/shared/color.js');

/** Stripes of the swatch fixture, top to bottom, 480px each. */
export const SWATCHES = [[70, 160, 60], [70, 50, 200], [220, 150, 110], [128, 128, 128]];

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
  ff(['-f', 'lavfi', '-i', 'color=c=0xFF00FF:s=401x121', '-frames:v', '1', f('txt.png')]);
  const hex = (c) => `0x${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  ff([...SWATCHES.flatMap((c) => ['-f', 'lavfi', '-i', `color=c=${hex(c)}:s=1080x480`]),
    '-filter_complex', '[0:v][1:v][2:v][3:v]vstack=inputs=4', '-frames:v', '1', f('swatch.png')]);
  ff(['-f', 'lavfi', '-i', 'color=c=red:s=320x568:r=30:d=2', '-f', 'lavfi', '-i', 'color=c=blue:s=320x568:r=30:d=2',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('split.mp4')]);
  // Motion graphic: see-through VP9 webm with an opaque green square in the middle.
  ff(['-f', 'lavfi', '-i', 'color=c=black@0.0:s=1080x1920:r=30:d=2,format=rgba', '-f', 'lavfi', '-i', 'color=c=0x00FF00:s=400x400:r=30:d=2,format=rgba',
    '-filter_complex', '[0][1]overlay=340:760:format=auto,format=yuva420p', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
    '-auto-alt-ref', '0', '-b:v', '1M', f('motion.webm')]);
  // A green box sliding right over red, for subject masks: it covers the frame center around t = 1 only.
  ff(['-filter_complex', "color=c=red:s=540x960:d=2:r=30[bg];color=c=0x00C000:s=200x200:d=2:r=30[b];[bg][b]overlay=x='40+t*130':y=380",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '2', f('box.mp4')]);
  return f;
}

export function samplePixel(file, t, x, y, size = 8) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file, '-frames:v', '1',
    '-vf', `crop=${size}:${size}:${x}:${y},scale=1:1:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1']);
  return [buf[0], buf[1], buf[2]];
}

function volumeOf(file, from, to) {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(from), '-to', String(to), '-i', file,
    '-af', 'volumedetect', '-vn', '-f', 'null', '-'], { encoding: 'utf8' });
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(res.stderr);
  if (!m) throw new Error(`no max_volume in: ${res.stderr}`);
  return m[1] === '-inf' ? -Infinity : Number(m[1]);
}

/**
 * Three cuts of split.mp4 (red 0-2s, blue 2-4s) with 1s dissolves into the second and third.
 * x: red 0-1.5. y: source 2.1-3.6 at 1.5-3.0, so its dissolve reads 1.6-2.1 from before its in point (red until 2.0).
 * z: source 0-1.5 at 3.0-4.5; y has no source after 4.0 and z none before 0, so those halves hold a frame.
 */
export function dissolveProject(base, split) {
  const T = { scale: 1, x: 0, y: 0 };
  const M = MEDIA_CLIP_DEFAULTS;
  return {
    ...base,
    assets: [...base.assets, split],
    markers: [],
    tracks: [
      { id: 't-1', kind: 'text', muted: false, hidden: false, clips: [] },
      { id: 'v-main', kind: 'video', muted: false, hidden: false, clips: [
        { ...M, id: 'dx', assetId: split.id, start: 0, in: 0, out: 1.5, transform: T },
        { ...M, id: 'dy', assetId: split.id, start: 1.5, in: 2.1, out: 3.6, transform: T, dissolve: 1 },
        { ...M, id: 'dz', assetId: split.id, start: 3, in: 0, out: 1.5, transform: T, dissolve: 1 },
      ] },
      { id: 'a-1', kind: 'audio', muted: false, hidden: false, clips: [] },
    ],
  };
}

/** Expected center color at t for dissolveProject: [red weight, blue weight]. */
export const DISSOLVE_SAMPLES = [
  [0.5, 1, 0],
  [1.25, 1, 0],
  [1.5, 0.5, 0.5],
  [1.75, 0.25, 0.75],
  [2.25, 0, 1],
  [3.0, 0.5, 0.5],
  [3.75, 1, 0],
];

async function checkDissolve(f, base, dir) {
  const split = await importMedia(f('split.mp4'), join(dir, 'cache'));
  const out = join(dir, 'dissolve.mp4');
  const result = await runExport(dissolveProject(base, split), 1920, out, [], () => {}).done;
  check('dissolve export finished', result.type === 'done', result.type === 'error' ? result.message : result.type);
  if (result.type !== 'done') return;
  const dur = Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', out],
    { encoding: 'utf8' })).format.duration);
  check('dissolves keep the timeline length (4.5s)', Math.abs(dur - 4.5) < 0.1, String(dur));
  const red = samplePixel(out, 0.5, 536, 956);
  const blue = samplePixel(out, 2.25, 536, 956);
  for (const [t, wr, wb] of DISSOLVE_SAMPLES) {
    const got = samplePixel(out, t, 536, 956);
    const want = red.map((r, i) => Math.round(r * wr + blue[i] * wb));
    const off = Math.max(...got.map((v, i) => Math.abs(v - want[i])));
    check(`dissolve at ${t}s is ${Math.round(wb * 100)}% blue`, off <= 15, `got ${got} want ${want}`);
  }
}

const STYLE = { font: 'black', size: 68, color: '#FFFFFF', strokeColor: '#13293D', strokeWidth: 5, background: null,
  align: 'center', highlight: '', highlightColor: '#FFD166', highlightDigits: false };

function textClip(id, start, anim) {
  return { id, start, in: 0, out: 1.5, text: id, preset: 'sub', style: STYLE, x: 0.5, y: 0.5, anim };
}

/** The ffmpeg side of text: pop (scale + pad per frame), fade (alpha), rise (overlay y), hidden tracks. */
async function checkTextLayers(f, base, dir) {
  const png = readFileSync(f('txt.png')).toString('base64');
  const layer = (clipId, y) => ({ clipId, pngBase64: png, x: 340, y, w: 401, h: 121, variants: [] });
  const project = {
    ...base,
    tracks: [
      { id: 't-hidden', kind: 'text', muted: false, hidden: true, clips: [{ ...textClip('th', 0, 'none'), out: 7 }] },
      { id: 't-1', kind: 'text', muted: false, hidden: false, clips: [
        textClip('tp', 0.5, 'pop'), textClip('tf', 2.5, 'fade'), textClip('tr', 4.5, 'rise'),
      ] },
      ...base.tracks,
    ],
  };
  const out = join(dir, 'text.mp4');
  const result = await runExport(project, 1920, out, [layer('tp', 300), layer('tf', 700), layer('tr', 1100)], () => {}).done;
  check('text export finished', result.type === 'done', result.type === 'error' ? result.message : result.type);
  if (result.type !== 'done') return;
  const magenta = (p) => p[0] > 200 && p[1] < 70 && p[2] > 200;
  const probe = (name, t, x, y, want) => {
    const p = samplePixel(out, t, x, y);
    check(name, magenta(p) === want, p.join(','));
  };
  probe('pop: center visible while settling', 0.72, 536, 356, true);
  probe('pop: corner empty while scaled down', 0.54, 342, 302, false);
  probe('pop: corner filled once settled', 1.5, 342, 302, true);
  probe('pop: gone after clip end', 2.2, 536, 356, false);
  probe('fade: faint at start', 2.54, 536, 756, false);
  probe('fade: opaque mid clip', 3.3, 536, 756, true);
  probe('rise: top edge empty while below target', 4.54, 536, 1102, false);
  probe('rise: top edge filled once settled', 5.5, 536, 1102, true);
  probe('hidden text track not rendered', 1.0, 536, 1000, false);
}

/** Speed (setpts + atempo), clip volume and fades. refDb is the same tone at volume 1. */
async function checkSpeedAndAudio(f, base, assets, dir, refDb) {
  const split = await importMedia(f('split.mp4'), join(dir, 'cache'));
  const T = { scale: 1, x: 0, y: 0 };
  const M = MEDIA_CLIP_DEFAULTS;
  const project = {
    ...base,
    assets: [...base.assets, split],
    tracks: [
      { id: 'v-main', kind: 'video', muted: false, hidden: false, clips: [
        { ...M, id: 's1', assetId: split.id, start: 0, in: 0, out: 4, transform: T, speed: 2 },
        { ...M, id: 's2', assetId: assets.pic.id, start: 2, in: 0, out: 2, transform: T },
      ] },
      { id: 'a-1', kind: 'audio', muted: false, hidden: false, clips: [
        { ...M, id: 's3', assetId: assets.tone.id, start: 0, in: 0, out: 2, transform: T, speed: 0.5, volume: 0.5, fadeIn: 1, fadeOut: 1 },
      ] },
    ],
  };
  const out = join(dir, 'speed.mp4');
  const result = await runExport(project, 1920, out, [], () => {}).done;
  check('speed export finished', result.type === 'done', result.type === 'error' ? result.message : result.type);
  if (result.type !== 'done') return;
  const dur = Number(JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', out],
    { encoding: 'utf8' })).format.duration);
  check('2x video and 0.5x audio give 4s', Math.abs(dur - 4) < 0.1, String(dur));
  const red = samplePixel(out, 0.5, 536, 956);
  const blue = samplePixel(out, 1.5, 536, 956);
  check('2x: source red half at 0.5s', red[0] > 180 && red[2] < 70, red.join(','));
  check('2x: source blue half already at 1.5s', blue[2] > 180 && blue[0] < 70, blue.join(','));
  const steady = volumeOf(out, 1.2, 2.8);
  check('0.5x audio still playing at 3.2s', volumeOf(out, 3.2, 3.4) > -40, `${volumeOf(out, 3.2, 3.4)} dB`);
  check('volume 50% is about -6 dB', Math.abs(steady - (refDb - 6.02)) < 1.5, `${steady} vs ref ${refDb}`);
  check('fade in starts quiet', volumeOf(out, 0, 0.1) < steady - 12, `${volumeOf(out, 0, 0.1)} dB`);
  check('fade out ends quiet', volumeOf(out, 3.9, 4.0) < steady - 12, `${volumeOf(out, 3.9, 4.0)} dB`);
}

/** Color correction through ffmpeg lut3d matches the shared pixel function. */
async function checkColor(base, swatch, dir) {
  const T = { scale: 1, x: 0, y: 0 };
  const clip = { id: 'g1', assetId: swatch.id, start: 0, in: 0, out: 1, transform: T, ...MEDIA_CLIP_DEFAULTS };
  const project = {
    ...base,
    tracks: [{ id: 'v-main', kind: 'video', muted: false, hidden: false, clips: [
      { ...clip, color: BITTEUL_COLOR },
      { ...clip, id: 'g2', start: 1, color: { brightness: 0, contrast: 0, saturation: -1, temperature: 0, look: 0 } },
    ] }],
  };
  const out = join(dir, 'color.mp4');
  const result = await runExport(project, 1920, out, [], () => {}).done;
  check('color export finished', result.type === 'done', result.type === 'error' ? result.message : result.type);
  if (result.type !== 'done') return;
  SWATCHES.forEach((src, i) => {
    const want = gradePixel(src.map((v) => v / 255), BITTEUL_COLOR).map((v) => Math.round(v * 255));
    const got = samplePixel(out, 0.5, 536, i * 480 + 236);
    const off = Math.max(...got.map((v, k) => Math.abs(v - want[k])));
    check(`bitteul look on ${src.join(',')}`, off <= 6, `got ${got.join(',')} want ${want.join(',')}`);
  });
  const gray = samplePixel(out, 1.5, 536, 480 + 236);
  check('saturation -100% gives gray', Math.max(...gray) - Math.min(...gray) <= 4, gray.join(','));
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
  const swatch = await importMedia(f('swatch.png'), cacheDir);
  const T = { scale: 1, x: 0, y: 0 };
  return {
    assets: { land, rot, pic, tone, swatch },
    project: normalizeProject({
      version: 1, width: 1080, height: 1920, fps: 30,
      assets: [land, rot, pic, tone, swatch],
      vars: { uploadDate: '2026-10-03', ddayTarget: '2027-09-01', salary: 0, goal: 2236300 },
      markers: [],
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
    }),
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
  const job = runExport(project, 1920, out, [], () => {});
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

  await checkTextLayers(f, project, dir);
  await checkSpeedAndAudio(f, project, assets, dir, volumeOf(out, 3.6, 4.4));
  await checkColor(project, assets.swatch, dir);
  await checkDissolve(f, project, dir);

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
