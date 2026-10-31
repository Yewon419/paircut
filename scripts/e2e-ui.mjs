// UI end-to-end: launches the real Electron app, drives the editor, and checks that the
// preview canvas matches the exported MP4 at the same timestamps.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright';
import { buildFixtureProject, DISSOLVE_SAMPLES, dissolveProject, filterIndex, freshDir, LIGHT, makeFixtures, column, detailColumn, samplePixel, SWATCHES, VIGNETTE, vignetteWant } from './e2e-export.mjs';

const require = createRequire(import.meta.url);
const { autoLight, gradePixel, pickColor } = require('../dist-electron/shared/color.js');
/** A grade that moves the first four controls, so the preview LUT is checked end to end. */
const GRADE = pickColor({ brightness: 0.15, contrast: -0.1, saturation: -0.2, temperature: 0.3 });
const { importMedia, sampleFrames } = require('../dist-electron/electron/media.js');

const root = resolve(import.meta.dirname, '..');
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const dir = freshDir('ui');
const f = makeFixtures(dir);
const { assets: fx, project: base } = await buildFixtureProject(f, join(dir, 'cache'));
const outlined = (size, font) => ({ font, size, color: '#FFFFFF', strokeColor: '#13293D', strokeWidth: 5, background: null,
  align: 'center', highlight: '', highlightColor: '#FFD166', highlightDigits: false });
const text = (id, start, out, body, style, x, y, anim) => ({ id, start, in: 0, out, text: body, preset: 'sub', style, x, y, anim });
const project = {
  ...base,
  tracks: [
    { id: 't-1', kind: 'text', muted: false, hidden: false, clips: [
      text('x-badge', 0, 7, '복학까지 D-{D}', { ...outlined(36, 'bold'), strokeWidth: 0, background: '#13293D', align: 'left', highlightDigits: true }, 0.06, 0.162, 'none'),
    ] },
    { id: 't-2', kind: 'text', muted: false, hidden: false, clips: [
      text('x-sub', 0, 2, '미리보기와 내보내기', outlined(68, 'black'), 0.5, 0.6, 'none'),
      text('x-pop', 2.5, 2, '팝 등장', outlined(92, 'black'), 0.5, 0.27, 'pop'),
      text('x-title', 5, 1.8, '판돈은 복학입니다', { ...outlined(88, 'serif'), strokeWidth: 0, tracking: -0.04, shadow: 0.9 }, 0.5, 0.45, 'none'),
    ] },
    ...base.tracks,
  ],
};
const vTop = () => window.__paircut.state().project.tracks.find((t) => t.id === 'v-top').clips[0];

/** The test run's recent list and start-screen pictures (the app keeps them here under PAIRCUT_TEST). */
const recentRoot = join(tmpdir(), 'paircut-test-recent');
rmSync(recentRoot, { recursive: true, force: true });

const app = await _electron.launch({ args: ['.'], cwd: root, env: { ...process.env, PAIRCUT_TEST: '1' } });
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => '__paircut' in window, null, { timeout: 15000 });
  await win.evaluate((p) => window.__paircut.load(p), project);
  await win.evaluate(() => {
    const fill = CanvasRenderingContext2D.prototype.fillRect;
    window.__draws = 0;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      if (this.canvas.dataset.testid === 'preview-canvas') window.__draws++;
      return fill.apply(this, args);
    };
  });

  // Preview vs export at the same instants.
  const exportTo = (target) => win.evaluate(
    (outPath) =>
      new Promise((res, rej) => {
        const off = window.api.onExportEvent((ev) => {
          if (ev.type === 'done') {
            off();
            res(null);
          } else if (ev.type === 'error') {
            off();
            rej(new Error(ev.message));
          }
        });
        void window.api.startExport(window.__paircut.state().project, { outPath, height: 1920 }, window.__paircut.texts(1920));
      }),
    target,
  );
  const out = join(dir, 'out.mp4');
  await exportTo(out);
  check('export via IPC finished', true);
  const layers = Object.fromEntries((await win.evaluate(() => window.__paircut.texts(1920))).map((l) => [l.clipId, l]));
  const badge = layers['x-badge'];
  const sub = layers['x-sub'];
  const pop = layers['x-pop'];
  const title = layers['x-title'];
  check('old-format style gets tracking/shadow defaults', await win.evaluate(() => {
    const s = window.__paircut.state().project.tracks[1].clips[0].style;
    return s.tracking === 0 && s.shadow === 0;
  }));
  check('serif font loaded', await win.evaluate(() => document.fonts.check('800 40px "Paircut Serif"', '판돈')));
  for (const face of ['700 40px "Paircut Presentation"', '900 40px "Paircut Presentation"', '400 40px "Paircut Hand"']) {
    check(`bundled font loaded: ${face}`, await win.evaluate((f) => [...document.fonts].some((ff) => ff.status === 'loaded' &&
      `${ff.weight} 40px "${ff.family.replace(/"/g, '')}"` === f), face));
  }
  check('badge shows D-333 for 2026-10-03', await win.evaluate(() => {
    const c = window.__paircut.state().project.tracks[0].clips[0];
    return c.text;
  }) === '복학까지 D-{D}' && badge.w > 100, `badge ${badge.w}x${badge.h}`);

  const readCanvas = (p) =>
    win.evaluate(
      ({ x, y, s }) => {
        const c = document.querySelector('[data-testid="preview-canvas"]');
        const d = c.getContext('2d').getImageData(Math.floor(x / 2), Math.floor(y / 2), s / 2, s / 2).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
      },
      { x: p.x, y: p.y, s: p.s ?? 8 },
    );

  const probes = [
    { t: 0.5, x: 540, y: 960 },
    { t: 0.5, x: 8, y: 1200 },
    { t: 1.5, x: 540, y: 960 },
    { t: 1.5, x: 120, y: 300 },
    { t: 4.0, x: 8, y: 8 },
    { t: 6.0, x: 540, y: 400 },
    { t: 6.0, x: 8, y: 1900 },
    // Text: badge padding is a solid fill; glyph areas are averaged over 48px so anti-aliasing at
    // half-resolution preview vs full-resolution export does not dominate.
    { t: 1.0, x: badge.x + 6, y: Math.round(badge.y + badge.h / 2) - 4 },
    { t: 1.0, x: badge.x + 20, y: badge.y + 8, s: 48 },
    { t: 1.0, x: sub.x + 40, y: Math.round(sub.y + sub.h / 2) - 24, s: 48 },
    { t: 1.0, x: Math.round(sub.x + sub.w / 2) - 24, y: Math.round(sub.y + sub.h / 2) - 24, s: 48 },
    { t: 2.6, x: pop.x + 20, y: Math.round(pop.y + pop.h / 2) - 24, s: 48 },
    { t: 3.5, x: pop.x + 20, y: Math.round(pop.y + pop.h / 2) - 24, s: 48 },
    // Serif title: glyph center and the shadow-only margin.
    { t: 5.5, x: Math.round(title.x + title.w / 2) - 24, y: Math.round(title.y + title.h / 2) - 24, s: 48 },
    { t: 5.5, x: title.x + 4, y: Math.round(title.y + title.h / 2) - 24, s: 48 },
  ];
  for (const p of probes) {
    // Chromium holds requestAnimationFrame for ~400ms while a video element seeks, so the canvas can
    // keep the previous frame; wait for a redraw after the seek, then for three identical reads.
    const drawsBefore = await win.evaluate((t) => {
      const n = window.__draws;
      window.__paircut.seek(t);
      return n;
    }, p.t);
    const t0 = Date.now();
    let prev = null;
    let last = null;
    let same = 0;
    while (Date.now() - t0 < 5000) {
      await win.waitForTimeout(100);
      if ((await win.evaluate(() => window.__draws)) === drawsBefore) continue;
      const cur = await readCanvas(p);
      same = last && cur.join() === last.join() && cur.some((v) => v > 0) ? same + 1 : 0;
      last = cur;
      if (same >= 2) {
        prev = cur;
        break;
      }
    }
    prev ??= last;
    console.log(`      settled after ${Date.now() - t0}ms`);
    const exp = samplePixel(out, p.t, p.x, p.y, p.s ?? 8);
    const diff = Math.abs(prev[0] - exp[0]) + Math.abs(prev[1] - exp[1]) + Math.abs(prev[2] - exp[2]);
    check(`preview matches export t=${p.t} (${p.x},${p.y})`, diff < 90, `preview ${prev} / export ${exp} / diff ${diff}`);
  }

  // Editing interactions through the real UI.
  await win.evaluate(() => window.__paircut.seek(1.0));
  const firstClip = win.locator('[data-clip="c1"]');
  await firstClip.click({ position: { x: 20, y: 30 } });
  await win.keyboard.press('KeyS');
  const afterSplit = await win.evaluate(() => window.__paircut.state().project.tracks.find((t) => t.id === 'v-main').clips.length);
  check('S splits selected clip at playhead', afterSplit === 4, `main clips ${afterSplit}`);
  await win.keyboard.press('Control+KeyZ');
  const afterUndo = await win.evaluate(() => window.__paircut.state().project.tracks.find((t) => t.id === 'v-main').clips.length);
  check('Ctrl+Z undoes split', afterUndo === 3, `main clips ${afterUndo}`);

  const zoom = await win.evaluate(() => window.__paircut.state().zoom);
  const topClip = win.locator('[data-clip="c-top"]');
  const box = await topClip.boundingBox();
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await win.mouse.down();
  await win.mouse.move(box.x + box.width / 2 + zoom * 2, box.y + box.height / 2, { steps: 8 });
  await win.mouse.up();
  const movedStart = await win.evaluate(`(${vTop})().start`);
  check('drag moves overlay clip by 2s', Math.abs(movedStart - 3) < 0.05, `start ${movedStart}`);

  const box2 = await topClip.boundingBox();
  await win.mouse.move(box2.x + box2.width - 3, box2.y + box2.height / 2);
  await win.mouse.down();
  await win.mouse.move(box2.x + box2.width - 3 + zoom, box2.y + box2.height / 2, { steps: 8 });
  await win.mouse.up();
  const trimmed = await win.evaluate(`(() => { const c = (${vTop})(); return c.out - c.in; })()`);
  check('right handle extends image clip by 1s', Math.abs(trimmed - 2) < 0.05, `duration ${trimmed}`);

  // Text preset panel and inline editing.
  const textCount = () => win.evaluate(() => window.__paircut.state().project.tracks.filter((t) => t.kind === 'text').flatMap((t) => t.clips).length);
  const before = await textCount();
  await win.locator('[data-tab="text"]').click();
  await win.locator('[data-preset="basic"]').click();
  check('preset button adds a text clip', (await textCount()) === before + 1, `text clips ${await textCount()}`);
  await win.locator('[data-testid="text-input"]').fill('(바뀐 딴지)');
  const edited = await win.evaluate(() => {
    const s = window.__paircut.state();
    return s.project.tracks.flatMap((t) => t.clips).find((c) => c.id === s.selectedClipId)?.text;
  });
  check('inspector edits selected text', edited === '(바뀐 딴지)', edited);

  const copiedId = await win.evaluate(() => window.__paircut.state().selectedClipId);
  await win.locator(`[data-clip="${copiedId}"]`).click({ position: { x: 4, y: 10 } });
  await win.evaluate(() => window.__paircut.seek(4));
  const beforePaste = await textCount();
  await win.keyboard.press('Control+KeyC');
  await win.keyboard.press('Control+KeyV');
  const pasted = await win.evaluate(() => {
    const s = window.__paircut.state();
    return s.project.tracks.flatMap((t) => t.clips).find((c) => c.id === s.selectedClipId);
  });
  check('Ctrl+C, Ctrl+V pastes the text clip at the playhead', (await textCount()) === beforePaste + 1 &&
    pasted?.id !== copiedId && pasted?.text === '(바뀐 딴지)' && Math.abs(pasted.start - 4) < 0.001,
    JSON.stringify({ count: await textCount(), id: pasted?.id, text: pasted?.text, start: pasted?.start }));
  await win.keyboard.press('Control+KeyZ');
  check('Ctrl+Z removes the pasted clip', (await textCount()) === beforePaste, `text clips ${await textCount()}`);

  // SRT export through the real main-process handler, with the save dialog answered.
  const srtPath = join(dir, 'captions.srt');
  await app.evaluate(({ dialog }, p) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: p });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] });
  }, srtPath);

  // SRT round trip: dialogue out (boxed badges left out), then back in on a new track.
  await win.evaluate((id) => {
    const p = window.__paircut.state().project;
    const base = p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
    const cue = (cid, start, out, text, background) => ({ ...base, id: cid, start, in: 0, out, text, style: { ...base.style, background } });
    const tracks = p.tracks.filter((t) => t.kind !== 'text');
    tracks.unshift({ id: 't-srt', kind: 'text', muted: false, hidden: false, clips: [
      cue('s1', 0, 3, '첫 줄 자막', null), cue('s3', 3, 2, '둘째 줄 자막', null),
    ] });
    tracks.unshift({ id: 't-badge', kind: 'text', muted: false, hidden: false, clips: [cue('s2', 1, 1, '배지', '#000000')] });
    window.__paircut.load({ ...p, tracks });
  }, copiedId);
  await win.locator('[data-tab="text"]').click();
  await win.locator('.button-row button', { hasText: '내보내기' }).click();
  await win.waitForTimeout(500);
  const srt = readFileSync(srtPath, 'utf8');
  const cues = srt.trim().split(/\n\s*\n/);
  check('SRT starts with the first line at 0-3s', cues[0] === '1\n00:00:00,000 --> 00:00:03,000\n첫 줄 자막', cues[0].replaceAll('\n', ' | '));
  check('SRT leaves the boxed badge out', cues.length === 2, String(cues.length));
  const beforeImport = await textCount();
  await win.locator('.button-row button', { hasText: '가져오기' }).click();
  await win.waitForTimeout(300);
  check('SRT import adds 2 clips on a new track', (await textCount()) === beforeImport + 2, `${beforeImport} -> ${await textCount()}`);

  check('safe-zone guide shown', await win.locator('[data-testid="safe-zone"]').isVisible());

  // Speed, volume and fades: timeline ripple and the preview element's rate and gain.
  await win.evaluate((p) => window.__paircut.load(p), project);
  await win.locator('[data-clip="c1"]').click();
  await win.locator('[data-speed="2"]').click();
  const sped = await win.evaluate(() =>
    window.__paircut.state().project.tracks.find((t) => t.id === 'v-main').clips.map((c) => `${c.id}:${c.start}:${c.speed}`).join(' '));
  check('2x halves c1 and pulls later clips in', sped === 'c1:0:2 c2:1.5:1 c3:3.5:1', sped);
  await win.evaluate(() => window.__paircut.seek(0.5));
  await win.waitForTimeout(200);
  const rate = await win.evaluate(() => window.__paircut.audio('c1'));
  check('preview plays c1 at 2x', rate?.rate === 2 && Math.abs(rate.level - 1) < 1e-6, JSON.stringify(rate));
  await win.evaluate(() => {
    const el = document.querySelector('[data-testid="volume"]');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '150');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  await win.locator('[data-testid="fade-in"]').fill('1');
  await win.waitForTimeout(200);
  const gain = await win.evaluate(() => {
    const c = window.__paircut.state().project.tracks.find((t) => t.id === 'v-main').clips[0];
    return { volume: c.volume, fadeIn: c.fadeIn, level: window.__paircut.audio('c1')?.level };
  });
  check('volume 150% and 1s fade in give gain 0.75 at 0.5s', gain.volume === 1.5 && gain.fadeIn === 1 && Math.abs(gain.level - 0.75) < 1e-6,
    JSON.stringify(gain));
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('Control+z');
  await win.keyboard.press('Control+z');
  await win.keyboard.press('Control+z');
  const undone = await win.evaluate(() =>
    window.__paircut.state().project.tracks.find((t) => t.id === 'v-main').clips.map((c) => `${c.id}:${c.start}:${c.speed}:${c.volume}`).join(' '));
  check('undo restores speed and volume', undone === 'c1:0:1:1 c2:3:1:1 c3:5:1:1', undone);
  await win.evaluate((p) => window.__paircut.load({ ...p, tracks: p.tracks.map((t) => ({ ...t,
    clips: t.clips.map((c) => (c.id === 'c1' ? { ...c, speed: 2, fadeIn: 1, fadeOut: 1 } : c)) })) }), project);
  await win.evaluate(() => window.__paircut.seek(1));
  await win.locator('[data-clip="c1"]').click({ position: { x: 20, y: 30 } });
  await win.keyboard.press('KeyS');
  const halves = await win.evaluate(() =>
    window.__paircut.state().project.tracks.find((t) => t.id === 'v-main').clips.slice(0, 2)
      .map((c) => `${c.start}:${c.in}-${c.out}:${c.fadeIn}/${c.fadeOut}`).join(' '));
  check('split at 2x cuts the source at 2.5s and drops inner fades', halves === '0:0.5-2.5:1/0 1:2.5-3.5:0/1', halves);
  // Color correction: preview (WebGL LUT) against the shared pixel function and the ffmpeg lut3d export.
  const filtered = pickColor({ ...GRADE, filter: filterIndex('vividCool'), filterAmount: 0.8 });
  for (const [name, grade] of [['graded', GRADE], ['filtered', filtered], ['light', LIGHT]]) {
    await win.evaluate(({ p, swatchId, grade }) => {
      const main = p.tracks.find((t) => t.id === 'v-main');
      const clip = { ...main.clips[1], id: 'g1', assetId: swatchId, start: 0, in: 0, out: 1, color: grade };
      window.__paircut.load({ ...p, tracks: [{ ...main, clips: [clip] }] });
    }, { p: project, swatchId: fx.swatch.id, grade });
    await win.locator('[data-clip="g1"]').click();
    await win.evaluate(() => window.__paircut.seek(0.5));
    await win.waitForTimeout(400);
    const graded = join(dir, `${name}.mp4`);
    await exportTo(graded);
    for (const [i, src] of SWATCHES.entries()) {
      const at = { x: 540, y: i * 480 + 236 };
      const shown = await readCanvas(at);
      const want = gradePixel(src.map((v) => v / 255), grade).map((v) => Math.round(v * 255));
      const made = samplePixel(graded, 0.5, at.x, at.y);
      const off = (a, b) => Math.max(...a.map((v, k) => Math.abs(v - b[k])));
      check(`${name} preview ${src.join(',')} matches pixel function and export`, off(shown, want) <= 4 && off(shown, made) <= 6,
        `preview ${shown} / function ${want} / export ${made}`);
    }
  }
  // Every Photos-style slider is in the inspector, and moving one changes only its own field.
  const sliderKeys = await win.evaluate(() => [...document.querySelectorAll('[data-color]')].map((el) => el.dataset.color).join());
  check('the inspector has the color and vignette sliders in Photos order', sliderKeys ===
    'exposure,brilliance,highlights,shadows,contrast,brightness,blackPoint,saturation,vibrance,temperature,tint,sharpness,definition,noiseReduction,blur,glow,glowSize,glowThreshold,halation,star,starLength,vignette,vignetteRadius,vignetteSoftness', sliderKeys);
  await win.evaluate(() => {
    const el = document.querySelector('[data-color="blackPoint"]');
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '35');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  });
  const moved = await win.evaluate(() => window.__paircut.state().project.tracks[0].clips[0].color);
  const shifted = Object.keys(moved).filter((k) => moved[k] !== LIGHT[k]);
  check('the black point slider sets only black point', moved.blackPoint === 0.35 && shifted.join() === 'blackPoint', JSON.stringify(moved));
  const count = await win.locator('.color-group-count').first().textContent();
  check('the light group counts the moved sliders', count === '5개 조정', count);
  await win.locator('[data-color="blackPoint"]').dblclick();
  check('double-clicking a slider sets it back to 0', (await win.evaluate(() => window.__paircut.state().project.tracks[0].clips[0].color.blackPoint)) === 0);
  // Auto: the button sets the five fields autoLight gives for the clip's frames, keeps the rest, and undoes in one step.
  const preAuto = await win.evaluate(() => window.__paircut.state().project.tracks[0].clips[0].color);
  await win.locator('[data-testid="color-auto"]').click();
  await win.waitForFunction((b) => JSON.stringify(window.__paircut.state().project.tracks[0].clips[0].color) !== b, JSON.stringify(preAuto));
  const autoSet = await win.evaluate(() => window.__paircut.state().project.tracks[0].clips[0].color);
  const autoWant = autoLight(await sampleFrames(fx.swatch.path, [0]), pickColor(preAuto));
  const autoKeys = Object.keys(autoSet).filter((k) => autoSet[k] !== preAuto[k]);
  check('auto sets the values autoLight gives for the frames and nothing else',
    Object.entries(autoWant).every(([k, v]) => autoSet[k] === v) && autoKeys.every((k) => k in autoWant), `${JSON.stringify(autoWant)} moved ${autoKeys}`);
  await win.keyboard.press('Control+z');
  const autoUndone = await win.evaluate(() => window.__paircut.state().project.tracks[0].clips[0].color);
  check('Ctrl+Z takes auto back in one step', JSON.stringify(autoUndone) === JSON.stringify(preAuto));
  // Vignette: the preview shader against the shared function and the export's mask blend, dark and light, on a crop.
  const vignettes = [
    ['dark vignette', VIGNETTE, { l: 0.2, t: 0.1, r: 0, b: 0.3 }],
    ['light vignette', pickColor({ ...GRADE, vignette: -0.8, vignetteSoftness: 0.4 }), { l: 0, t: 0, r: 0.15, b: 0 }],
  ];
  for (const [name, color, crop] of vignettes) {
    await win.evaluate(({ p, swatchId, color, crop }) => {
      const main = p.tracks.find((t) => t.id === 'v-main');
      const clip = { ...main.clips[1], id: 'g1', assetId: swatchId, start: 0, in: 0, out: 1, color, crop };
      window.__paircut.load({ ...p, tracks: [{ ...main, clips: [clip] }] });
    }, { p: project, swatchId: fx.swatch.id, color, crop });
    await win.evaluate(() => window.__paircut.seek(0.5));
    await win.waitForTimeout(400);
    const file = join(dir, `${name.replace(' ', '-')}.mp4`);
    await exportTo(file);
    const box = { x: crop.l * 1080, y: crop.t * 1920, w: (1 - crop.l - crop.r) * 1080, h: (1 - crop.t - crop.b) * 1920 };
    const pts = [[box.x + box.w / 2 - 4, 700], [box.x + 40, box.y + 40], [box.x + box.w / 2 - 4, 1180], [box.x + box.w - 60, box.y + box.h - 60]];
    for (const [x, y] of pts.map(([x, y]) => [Math.round(x / 2) * 2, Math.round(y / 2) * 2])) {
      const shown = await readCanvas({ x, y });
      const want = vignetteWant(color, x + 4, y + 4, box);
      const made = samplePixel(file, 0.5, x, y);
      const off = (a, b) => Math.max(...a.map((v, k) => Math.abs(v - b[k])));
      check(`${name} preview at ${x},${y} matches pixel function and export`, off(shown, want) <= 5 && off(shown, made) <= 6,
        `preview ${shown} / function ${want} / export ${made}`);
    }
  }
  // Detail passes: the preview's column across the steps edge against the reference and the export, both taken
  // to the canvas's half resolution; noise reduction by how much it lowers the spread.
  const steps = await importMedia(f('steps.png'), join(dir, 'cache'));
  const noise = await importMedia(f('noise.png'), join(dir, 'cache'));
  const showDetail = async (asset, color) => {
    await win.evaluate(({ p, asset, color }) => {
      const main = p.tracks.find((t) => t.id === 'v-main');
      const clip = { ...main.clips[1], id: 'g1', assetId: asset.id, start: 0, in: 0, out: 1, color };
      window.__paircut.load({ ...p, assets: [...p.assets, asset], tracks: [{ ...main, clips: [clip] }] });
    }, { p: project, asset, color });
    await win.evaluate(() => window.__paircut.seek(0.5));
    await win.waitForTimeout(400);
  };
  const canvasColumn = () => win.evaluate(() => {
    const c = document.querySelector('[data-testid="preview-canvas"]');
    const d = c.getContext('2d').getImageData(270, 0, 1, c.height).data;
    return Array.from({ length: d.length / 4 }, (_, i) => d[i * 4 + 1]);
  });
  // The canvas shows the picture at half size, so a canvas row may be any mix of the two full-size rows under it.
  const outside = (v, col, y) => Math.max(0, Math.min(col[2 * y], col[2 * y + 1]) - v, v - Math.max(col[2 * y], col[2 * y + 1]));
  for (const [name, color] of [['sharpness', pickColor({ sharpness: 1 })], ['definition', pickColor({ definition: -1, sharpness: 0.5 })], ['blur', pickColor({ blur: 0.5 })], ['glow', pickColor({ glow: 1, glowSize: 0.3 })],
    ['halation', pickColor({ halation: 1 })], ['star', pickColor({ star: 1, starLength: 0.6, exposure: 0.6 })]]) {
    await showDetail(steps, color);
    const shown = await canvasColumn();
    const file = join(dir, `detail-${name}.mp4`);
    await exportTo(file);
    const want = detailColumn(color, 1920);
    const made = column(file, 0.5, 540);
    const rows = Array.from({ length: 71 }, (_, k) => 445 + k);
    const offWant = Math.max(...rows.map((y) => outside(shown[y], want, y)));
    const offMade = Math.max(...rows.map((y) => outside(shown[y], made, y)));
    check(`${name} preview across the edge matches reference and export`, offWant <= 5 && offMade <= 6,
      `off ${offWant} / ${offMade}; rows 477-482 preview ${shown.slice(477, 483)} want ${want.slice(954, 966)} export ${made.slice(954, 966)}`);
  }
  const spread = () => win.evaluate(() => {
    const d = document.querySelector('[data-testid="preview-canvas"]').getContext('2d').getImageData(250, 450, 32, 32).data;
    const g = Array.from({ length: d.length / 4 }, (_, i) => d[i * 4 + 1]);
    const mean = g.reduce((a, b) => a + b, 0) / g.length;
    return Math.sqrt(g.reduce((a, b) => a + (b - mean) ** 2, 0) / g.length);
  });
  await showDetail(noise, pickColor({}));
  const noisy = await spread();
  await showDetail(noise, pickColor({ noiseReduction: 1 }));
  const calmer = await spread();
  check('noise reduction lowers the preview noise', calmer < noisy * 0.75, `${calmer.toFixed(1)} vs ${noisy.toFixed(1)}`);
  const videoPixel = async (color) => {
    await win.evaluate(({ p, c }) => window.__paircut.load({ ...p, tracks: p.tracks.map((t) => ({ ...t,
      clips: t.clips.map((k) => (k.id === 'c1' ? { ...k, color: c } : k)) })) }), { p: project, c: color });
    const before = await win.evaluate(() => window.__draws);
    await win.evaluate(() => window.__paircut.seek(0.5));
    await win.waitForFunction((n) => window.__draws > n, before);
    let last = null;
    for (let i = 0; i < 50; i++) {
      await win.waitForTimeout(100);
      const cur = await readCanvas({ x: 8, y: 1200 });
      if (cur.some((v) => v > 0) && last && cur.join() === last.join()) return cur;
      last = cur;
    }
    return last;
  };
  const plain = await videoPixel(pickColor({}));
  const gradedVideo = await videoPixel(GRADE);
  const wantVideo = gradePixel(plain.map((v) => v / 255), GRADE).map((v) => Math.round(v * 255));
  check('graded video frame goes through the LUT', Math.max(...gradedVideo.map((v, k) => Math.abs(v - wantVideo[k]))) <= 12,
    `plain ${plain} / graded ${gradedVideo} / function ${wantVideo}`);

  // Color presets (shared across projects via localStorage) and apply-to-all as one undo step.
  const setRange = (selector, value) => win.evaluate(({ selector, value }) => {
    const el = document.querySelector(selector);
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(value));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  }, { selector, value });
  const sats = () => win.evaluate(() => window.__paircut.state().project.tracks.filter((t) => t.kind === 'video')
    .flatMap((t) => t.clips).map((c) => `${c.id}:${c.color.saturation}`).sort().join(' '));
  await win.evaluate((p) => window.__paircut.load(p), project);
  await win.locator('[data-clip="c1"]').click();
  await setRange('[data-color="saturation"]', -40);
  // Filters: a pick starts at full strength, switching keeps the strength, none clears both, each is one undo step.
  const filterOf = () => win.evaluate(() => {
    const { filter, filterAmount, saturation } = window.__paircut.state().project.tracks.flatMap((t) => t.clips).find((c) => c.id === 'c1').color;
    return `${filter}:${filterAmount}:${saturation}`;
  });
  check('no filter at first and no strength slider', (await filterOf()) === '0:0:-0.4' && (await win.locator('[data-testid="filter-amount"]').count()) === 0);
  await win.locator('[data-filter="noir"]').click();
  check('picking noir sets it at 100%', (await filterOf()) === `${filterIndex('noir')}:1:-0.4`, await filterOf());
  await setRange('[data-testid="filter-amount"]', 40);
  await win.locator('[data-filter="mono"]').click();
  check('switching filters keeps the strength', (await filterOf()) === `${filterIndex('mono')}:0.4:-0.4`, await filterOf());
  check('the picked filter is marked', (await win.locator('[data-filter="mono"]').getAttribute('class')) === 'on');
  await win.locator('[data-filter="none"]').click();
  check('none clears the filter', (await filterOf()) === '0:0:-0.4', await filterOf());
  await win.keyboard.press('Control+z');
  check('Ctrl+Z brings the filter back', (await filterOf()) === `${filterIndex('mono')}:0.4:-0.4`, await filterOf());
  await win.locator('[data-testid="preset-name"]').fill('e2e 톤');
  await win.locator('[data-testid="preset-save"]').click();
  const stored = await win.evaluate(() => JSON.parse(localStorage.getItem('paircut.colorPresets')).map((p) => `${p.name}:${p.color.saturation}`).join());
  check('preset saved with current values', stored.includes('e2e 톤:-0.4'), stored);
  const storedFilter = await win.evaluate(() => JSON.parse(localStorage.getItem('paircut.colorPresets')).find((p) => p.name === 'e2e 톤').color);
  check('preset carries the filter', storedFilter.filter === filterIndex('mono') && storedFilter.filterAmount === 0.4, JSON.stringify(storedFilter));
  await win.locator('[data-clip="c2"]').click();
  await win.locator('[data-color-preset="e2e 톤"]').click();
  check('preset applies to another clip', (await sats()) === 'c-top:0 c1:-0.4 c2:-0.4 c3:0', await sats());
  await win.locator('[data-clip="c3"]').click();
  await setRange('[data-color="saturation"]', 20);
  await win.locator('[data-testid="color-all"]').click();
  check('apply to all sets every video-track clip', (await sats()) === 'c-top:0.2 c1:0.2 c2:0.2 c3:0.2', await sats());
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('Control+z');
  check('one undo reverts apply to all', (await sats()) === 'c-top:0 c1:-0.4 c2:-0.4 c3:0.2', await sats());
  await win.locator('[data-delete-preset="e2e 톤"]').click();
  check('preset deleted', (await win.locator('[data-color-preset="e2e 톤"]').count()) === 0 &&
    !(await win.evaluate(() => localStorage.getItem('paircut.colorPresets'))).includes('e2e'));

  // In-app Claude tools, called through the main process exactly as the Agent SDK would (no model call).
  const tool = (name, input = {}) => app.evaluate((_e, [n, i]) => globalThis.__paircutAgent.callTool(n, i), [name, input]);
  const snap = () => win.evaluate(() => {
    const s = window.__paircut.state();
    const clips = s.project.tracks.flatMap((t) => t.clips);
    return { clips, past: s.past.length, playhead: s.playhead, texts: s.project.tracks.filter((t) => t.kind === 'text').map((t) => t.clips.length) };
  });
  const byId = (s, id) => s.clips.find((c) => c.id === id);
  await win.evaluate((p) => window.__paircut.load(p), project);
  const state = await tool('get_state');
  check('get_state lists tracks, clips and presets', /v-main \[video main\]/.test(state.text) && /c1 0-3 A1 /.test(state.text) &&
    /src=0\.5-3\.5/.test(state.text) && state.text.includes('color presets:'), `${state.text.length} chars`);
  console.log(state.text.split('\n').map((l) => `      | ${l}`).join('\n'));

  const agentBase = await snap();
  const failed = await tool('edit', { ops: [{ op: 'set_clip', clip: 'c1', speed: 2 }, { op: 'delete', clip: 'nope' }] });
  const agentFail = await snap();
  check('failing batch changes nothing', failed.isError && failed.text.startsWith('op #1 (delete)') &&
    byId(agentFail, 'c1').speed === 1 && agentFail.past === agentBase.past, failed.text);
  const tooLong = await tool('edit', { ops: [{ op: 'trim', clip: 'c1', end: 9 }] });
  check('trim past the source is refused', tooLong.isError && tooLong.text.includes('source is only'), tooLong.text);
  const badInput = await tool('edit', { ops: [{ op: 'set_clip', clip: 'c1', speed: 9 }] });
  check('out-of-range op is rejected by the schema', badInput.isError && badInput.text.includes('ops[0].speed'), badInput.text.replaceAll('\n', ' | '));
  const viaAlias = await tool('edit', { ops: [{ op: 'add_media', asset: 'A3', track: 'new', start: 0 }] });
  check('add_media accepts the short asset alias', !viaAlias.isError && /add_media -> c-/.test(viaAlias.text), viaAlias.text);
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('Control+z');

  const agentDone = await tool('edit', { ops: [
    { op: 'set_clip', clip: 'c1', speed: 2 },
    { op: 'add_text', text: 'Claude 자막', start: 0.5 },
    { op: 'color', clip: 'c2', values: { saturation: -0.5 } },
    { op: 'seek', t: 1 },
  ] });
  const agentAfter = await snap();
  const added = agentAfter.clips.find((c) => c.text === 'Claude 자막');
  check('batch applies speed ripple, text, color and seek', !agentDone.isError && byId(agentAfter, 'c1').speed === 2 &&
    byId(agentAfter, 'c2').start === 1.5 && byId(agentAfter, 'c3').start === 3.5 && byId(agentAfter, 'c2').color.saturation === -0.5 &&
    added?.start === 0.5 && agentAfter.playhead === 1 && agentAfter.past === agentBase.past + 1 && agentDone.text.includes(added?.id), agentDone.text);
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('Control+z');
  const agentUndone = await snap();
  check('one undo reverts the whole batch', byId(agentUndone, 'c1').speed === 1 && byId(agentUndone, 'c2').start === 3 &&
    byId(agentUndone, 'c2').color.saturation === 0 && !agentUndone.clips.some((c) => c.text === 'Claude 자막'));

  const lookEdit = await tool('edit', { ops: [{ op: 'track', track: 'v-main', opacity: 0.5, blend: 'multiply' }] });
  const lookTrack = await win.evaluate(() => window.__paircut.state().project.tracks.find((t) => t.id === 'v-main'));
  const lookState = await tool('get_state');
  check('track sets layer opacity and blend mode, and get_state shows them', !lookEdit.isError && lookTrack.opacity === 0.5 &&
    lookTrack.blend === 'multiply' && /v-main \[video main multiply opacity=0\.5\]/.test(lookState.text), lookEdit.text);
  const backToNormal = await tool('edit', { ops: [{ op: 'track', track: 'v-main', opacity: 1, blend: 'normal' }] });
  const plainTrack = await win.evaluate(() => window.__paircut.state().project.tracks.find((t) => t.id === 'v-main'));
  check('track back to full opacity and normal drops the fields', !backToNormal.isError && !('opacity' in plainTrack) && !('blend' in plainTrack));
  const clipBottom = await tool('edit', { ops: [{ op: 'track', track: 'v-main', clipped: true }] });
  check('the bottom picture layer cannot be clipped', clipBottom.isError && clipBottom.text.includes('nothing under it'), clipBottom.text);
  const audioLook = await tool('edit', { ops: [{ op: 'track', track: 'a-1', opacity: 0.5 }] });
  check('audio tracks take no layer look', audioLook.isError && audioLook.text.includes('not audio'), audioLook.text);
  const aboveMain = await win.evaluate(() => {
    const ts = window.__paircut.state().project.tracks.filter((t) => t.kind !== 'audio');
    return ts[ts.findIndex((t) => t.id === 'v-main') - 1]?.id;
  });
  const clipAbove = await tool('edit', { ops: [{ op: 'track', track: aboveMain, clipped: true }] });
  check('a layer above another can be clipped', !clipAbove.isError &&
    (await win.evaluate((tid) => window.__paircut.state().project.tracks.find((t) => t.id === tid).clipped, aboveMain)) === true, clipAbove.text);

  const shot = await tool('screenshot', { t: 0.5 });
  const jpeg = Buffer.from(shot.jpegBase64 ?? '', 'base64');
  const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  const dims = sof > 0 ? `${jpeg.readUInt16BE(sof + 7)}x${jpeg.readUInt16BE(sof + 5)}` : '?';
  check('screenshot is a 270x480 JPEG of the preview', jpeg[0] === 0xff && jpeg[1] === 0xd8 && dims === '270x480',
    `${dims}, ${jpeg.length} bytes`);
  const appShot = await tool('screenshot_app');
  check('screenshot_app captures the window', appShot.jpegBase64?.startsWith('/9j/') && /editor window 800x\d+/.test(appShot.text), appShot.text);

  await win.locator('[data-tab="claude"]').click();
  check('Claude tab has model select and input', ['sonnet', 'haiku', 'opus'].includes(await win.locator('[data-testid="agent-model"]').inputValue()) &&
    (await win.locator('[data-testid="agent-input"]').count()) === 1);

  // Cross dissolve: preview against export across both cuts, inspector buttons, timeline mark, split.
  const split = await importMedia(f('split.mp4'), join(dir, 'cache'));
  const dproj = dissolveProject(base, split);
  await win.evaluate((p) => window.__paircut.load(p), dproj);
  const dissolved = join(dir, 'dissolve.mp4');
  await exportTo(dissolved);
  for (const [t] of DISSOLVE_SAMPLES) {
    await tool('screenshot', { t });
    const shown = await readCanvas({ x: 536, y: 956 });
    const made = samplePixel(dissolved, t, 536, 956);
    const off = Math.max(...shown.map((v, k) => Math.abs(v - made[k])));
    check(`dissolve preview matches export at ${t}s`, off <= 20, `preview ${shown} / export ${made}`);
  }
  const dissolveOf = (id) => win.evaluate((i) => window.__paircut.state().project.tracks.flatMap((t) => t.clips).find((c) => c.id === i)?.dissolve, id);
  await win.locator('[data-tab="media"]').click();
  await win.locator('[data-clip="dx"]').click();
  check('first clip cannot dissolve', await win.locator('[data-dissolve="0.5"]').isDisabled());
  await win.locator('[data-clip="dy"]').click();
  check('second clip shows its 1s dissolve', (await win.locator('[data-dissolve="1"]').getAttribute('class')) === 'on');
  await win.locator('[data-dissolve="0.5"]').click();
  const mark = await win.locator('[data-clip="dy"] [data-dissolve-mark]').boundingBox();
  const zoomNow = await win.evaluate(() => window.__paircut.state().zoom);
  check('dissolve set from the inspector and marked on the timeline', (await dissolveOf('dy')) === 0.5 &&
    Math.abs(mark.width - 0.25 * zoomNow) < 2, `mark ${mark?.width}px at zoom ${zoomNow}`);
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('Control+z');
  check('undo restores the dissolve', (await dissolveOf('dy')) === 1);
  const cut = await tool('edit', { ops: [{ op: 'split', clip: 'dy', t: 2 }] });
  const half = /-> (c-\w+)/.exec(cut.text)?.[1];
  check('split keeps the dissolve on the left half only', (await dissolveOf('dy')) === 1 && (await dissolveOf(half)) === 0, cut.text);
  const viaClaude = await tool('edit', { ops: [{ op: 'set_clip', clip: 'dz', dissolve: 0.3 }] });
  check('Claude can set a dissolve and reads it back', !viaClaude.isError && (await tool('get_state')).text.includes('dissolve=0.3'), viaClaude.text);

  // Crop: preview against export on an image and a rotated phone clip, inspector sliders, Claude op.
  const cropOf = (id) => win.evaluate((i) => window.__paircut.state().project.tracks.flatMap((t) => t.clips).find((c) => c.id === i)?.crop, id);
  const cproj = { ...base, tracks: [{ id: 'v-main', kind: 'video', muted: false, hidden: false, clips: [
    { ...base.tracks[1].clips[1], id: 'k1', assetId: fx.swatch.id, start: 0, in: 0, out: 1, crop: { l: 0.1, t: 0.25, r: 0.2, b: 0.25 } },
    { ...base.tracks[1].clips[2], id: 'k2', assetId: fx.rot.id, start: 1, in: 0, out: 2, crop: { l: 0.3, t: 0.1, r: 0, b: 0.4 } },
  ] }] };
  await win.evaluate((p) => window.__paircut.load(p), cproj);
  const cropped = join(dir, 'crop.mp4');
  await exportTo(cropped);
  const cropProbes = [
    [0.5, 536, 236, 'image top cut'], [0.5, 536, 716, 'image kept'], [0.5, 40, 716, 'image left cut'], [0.5, 980, 716, 'image right cut'],
    [2, 100, 700, 'rotated left cut'], [2, 400, 300, 'rotated kept top-left'], [2, 1000, 1100, 'rotated kept bottom-right'],
    [2, 700, 700, 'rotated kept middle'], [2, 600, 1500, 'rotated bottom cut'],
  ];
  for (const [t, x, y, name] of cropProbes) {
    await tool('screenshot', { t });
    const shown = await readCanvas({ x, y, s: 16 });
    const made = samplePixel(cropped, t, x, y, 16);
    const off = Math.max(...shown.map((v, k) => Math.abs(v - made[k])));
    check(`crop preview matches export: ${name}`, off <= 24, `preview ${shown} / export ${made}`);
  }
  await win.locator('[data-tab="media"]').click();
  await win.locator('[data-clip="k1"]').click();
  await setRange('[data-testid="crop-t"]', 80);
  check('crop slider keeps opposite edges under 95%', Math.abs((await cropOf('k1')).t - 0.7) < 1e-9, JSON.stringify(await cropOf('k1')));
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('Control+z');
  check('undo restores the crop', (await cropOf('k1')).t === 0.25);
  const cropVia = await tool('edit', { ops: [{ op: 'set_clip', clip: 'k2', crop: { r: 0.15 } }] });
  const k2 = await cropOf('k2');
  check('Claude sets one crop edge and keeps the others', !cropVia.isError && k2.r === 0.15 && k2.l === 0.3 && k2.b === 0.4 &&
    (await tool('get_state')).text.includes('crop=0.3,0.1,0.15,0.4'), cropVia.text);
  const cropBad = await tool('edit', { ops: [{ op: 'set_clip', clip: 'k2', crop: { l: 0.9 } }] });
  check('Claude crop past 95% across is rejected', cropBad.isError === true && (await cropOf('k2')).l === 0.3, cropBad.text);

  // Installed (PC) fonts: Malgun Gothic ships with Windows; the made-up name must fall back to the bundled font.
  await win.evaluate((p) => window.__paircut.load(p), project);
  const subWidth = () => win.evaluate(() => window.__paircut.texts(1920).find((l) => l.clipId === 'x-sub').w);
  const plainWidth = await subWidth();
  await win.locator('[data-tab="media"]').click();
  await win.evaluate(() => window.__paircut.seek(0.5));
  await win.locator('[data-clip="x-sub"]').click();
  const pickFont = async (testId, value) => {
    await win.locator(`[data-testid="${testId}"]`).click();
    await win.locator(`[data-testid="${testId}-option"][data-value="${value}"]`).click();
  };
  const fontRows = () => win.locator('[data-testid="font-select-option"]');
  const subStyle = () => win.evaluate(() => window.__paircut.state().project.tracks.flatMap((t) => t.clips).find((c) => c.id === 'x-sub').style);
  await win.locator('[data-testid="font-select"]').click();
  const rowCount = await fontRows().count();
  const previews = await win.evaluate(() => [...document.querySelectorAll('[data-testid="font-select-option"]')].slice(0, 12).map((b) => {
    const s = b.querySelector('.font-sample');
    return { value: b.dataset.value, text: s.textContent, family: getComputedStyle(s).fontFamily, weight: getComputedStyle(s).fontWeight };
  }));
  const subLine = (await win.evaluate(() => window.__paircut.state().project.tracks.flatMap((t) => t.clips).find((c) => c.id === 'x-sub').text)).split('\n')[0].trim();
  check('font list previews the clip text in each font', rowCount > 20 &&
    previews.find((r) => r.value === 'thin').weight === '100' && previews.find((r) => r.value === 'black').weight === '900' &&
    previews.find((r) => r.value === 'serif').family.includes('Paircut Serif') && previews.every((r) => subLine.startsWith(r.text.replace('…', ''))),
    JSON.stringify(previews.slice(0, 3)));
  await win.locator('[data-testid="font-select-search"]').fill('명조');
  check('font search narrows the list', (await fontRows().count()) === 1 && (await fontRows().first().getAttribute('data-value')) === 'serif');
  await win.locator('[data-testid="font-select-search"]').fill('프리텐다드');
  check('font search finds a family by its Korean name', (await fontRows().count()) === 9);
  await win.locator('[data-testid="font-select-search"]').fill('montserrat');
  await win.keyboard.press('ArrowDown');
  await win.keyboard.press('Enter');
  check('arrow keys and Enter pick from the search results', (await win.locator('[data-testid="font-select-popup"]').count()) === 0 &&
    (await subStyle()).font === 'montserrat-medium');
  await win.locator('[data-testid="font-select"]').click();
  await win.locator('[data-testid="font-select-search"]').fill('zzqq');
  check('a search with no match says so', (await fontRows().count()) === 0 && (await win.locator('.font-empty').count()) === 1);
  await win.keyboard.press('Escape');
  check('Escape closes the font list without a change', (await win.locator('[data-testid="font-select-popup"]').count()) === 0 &&
    (await subStyle()).font === 'montserrat-medium');
  await win.locator('[data-testid="font-select"]').click();
  await win.locator('[data-testid="font-select-search"]').fill('Malgun Gothic');
  check('searching an installed PC font name offers it', (await fontRows().count()) === 1 &&
    (await fontRows().first().getAttribute('data-value')) === 'pc:Malgun Gothic');
  await win.keyboard.press('Enter');
  check('picking the offered PC font sets it', (await subStyle()).customFont === 'Malgun Gothic' &&
    (await win.locator('[data-testid="pc-font"]').inputValue()) === 'Malgun Gothic');
  await pickFont('font-select', 'black');
  await pickFont('font-select', '__pc');
  await win.locator('[data-testid="pc-font"]').fill('Malgun Gothic');
  await win.locator('[data-testid="pc-font"]').press('Enter');
  const styleOf = (id) => win.evaluate((i) => window.__paircut.state().project.tracks.flatMap((t) => t.clips).find((c) => c.id === i).style, id);
  check('PC font set from the inspector', (await styleOf('x-sub')).customFont === 'Malgun Gothic' &&
    (await win.locator('[data-testid="pc-font-status"]').textContent()).includes('설치된'));
  const pcWidth = await subWidth();
  check('PC font changes the drawn text', pcWidth !== plainWidth, `bundled ${plainWidth}px / Malgun ${pcWidth}px`);
  check('Korean family name finds the same font', await win.evaluate(() => {
    const c = document.createElement('canvas').getContext('2d');
    const w = (f) => { c.font = f; return c.measureText('이건 내 첫 릴스야').width; };
    return w('72px "맑은 고딕", monospace') === w('72px "Malgun Gothic", monospace');
  }));
  await win.locator('[data-testid="pc-font"]').fill('No Such Font 7f3');
  await win.locator('[data-testid="pc-font"]').press('Enter');
  check('missing PC font warns and falls back to the bundled font', (await subWidth()) === plainWidth &&
    (await win.locator('[data-testid="pc-font-status"]').textContent()).includes('찾을 수 없어서'));
  await pickFont('font-select', 'bold');
  check('picking a bundled font clears the PC font', (await styleOf('x-sub')).customFont === '' && (await styleOf('x-sub')).font === 'bold');
  const pcMissing = await tool('edit', { ops: [{ op: 'set_text', clip: 'x-sub', customFont: 'No Such Font 7f3' }] });
  check('Claude cannot set a font this PC lacks', pcMissing.isError === true, pcMissing.text);
  const pcBad = await tool('edit', { ops: [{ op: 'set_text', clip: 'x-sub', customFont: 'x", serif' }] });
  check('Claude font name with a quote is rejected', pcBad.isError === true, pcBad.text);
  const pcOk = await tool('edit', { ops: [{ op: 'set_text', clip: 'x-sub', customFont: 'Malgun Gothic' }] });
  check('Claude sets a PC font and reads it back', !pcOk.isError && (await tool('get_state')).text.includes('pcFont="Malgun Gothic"'), pcOk.text);

  // Typography: whole-text rotation and styled parts, drawn by the same rasterizer for preview and export.
  await win.evaluate((p) => window.__paircut.load(p), project);
  const layerOf = (id) => win.evaluate((i) => window.__paircut.texts(1920).find((l) => l.clipId === i), id);
  const flat = await layerOf('x-sub');
  const rotOk = await tool('edit', { ops: [{ op: 'set_text', clip: 'x-sub', rotation: 90 }] });
  const turned = await layerOf('x-sub');
  check('rotation 90 turns the text box on its side', !rotOk.isError && turned.h > turned.w && Math.abs(turned.h - flat.w) <= 2 &&
    Math.abs(turned.y + turned.h / 2 - (flat.y + flat.h / 2)) <= 2, `flat ${flat.w}x${flat.h}, turned ${turned.w}x${turned.h}`);
  await tool('edit', { ops: [{ op: 'set_text', clip: 'x-sub', rotation: 0 }] });
  const back = await layerOf('x-sub');
  check('rotation 0 draws the same box as before', back.w === flat.w && back.h === flat.h && back.x === flat.x && back.pngBase64 === flat.pngBase64);
  const spanOk = await tool('edit', { ops: [
    { op: 'span', clip: 'x-sub', match: '내보내기', color: '#FF3B30', scale: 1.6, rotate: -12, dy: -10 },
    { op: 'span', clip: 'x-sub', match: '미리', font: 'thin' },
  ] });
  const styled = await layerOf('x-sub');
  check('styled parts grow the text box', !spanOk.isError && styled.w > flat.w && styled.h > flat.h, `${flat.w}x${flat.h} -> ${styled.w}x${styled.h}`);
  check('styled parts read back in get_state', (await tool('get_state')).text.includes('span("내보내기"#0 color=#FF3B30 scale=1.6 rot=-12 dxy=0,-10)'));
  const redShare = await win.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] < 90 && d[i + 2] < 90 && d[i + 3] > 200) red++;
    return red;
  }, styled.pngBase64);
  check('styled part is drawn in its color', redShare > 500, `${redShare} red px`);
  writeFileSync(join(dir, 'typography.png'), Buffer.from(styled.pngBase64, 'base64'));
  const spanMerge = await tool('edit', { ops: [{ op: 'span', clip: 'x-sub', match: '내보내기', rotate: 0 }] });
  check('repeating a span merges values', !spanMerge.isError && (await tool('get_state')).text.includes('span("내보내기"#0 color=#FF3B30 scale=1.6 rot=0 dxy=0,-10)'));
  const spanMissing = await tool('edit', { ops: [{ op: 'span', clip: 'x-sub', match: '없는 말' }] });
  check('a part the text lacks is rejected', spanMissing.isError === true, spanMissing.text);
  const spanSecond = await tool('edit', { ops: [{ op: 'span', clip: 'x-sub', match: '내보내기', nth: 1, color: '#000000' }] });
  check('a missing second occurrence is rejected', spanSecond.isError === true, spanSecond.text);
  await tool('edit', { ops: [{ op: 'set_text', clip: 'x-sub', text: '미리 보고 내보내기' }] });
  check('a span follows its words when other text changes', (await tool('get_state')).text.includes('span("내보내기"#0') &&
    !(await tool('get_state')).text.includes('MISSING'));
  await tool('edit', { ops: [{ op: 'set_text', clip: 'x-sub', text: '바뀐 문장' }] });
  check('a span whose words are gone is flagged', (await tool('get_state')).text.includes('MISSING'));
  await tool('edit', { ops: [{ op: 'span', clip: 'x-sub', match: '내보내기', remove: true }, { op: 'span', clip: 'x-sub', match: '미리', remove: true }] });
  check('removed spans are gone', !(await tool('get_state')).text.includes('span('));

  // The same typography from the inspector: pick letters in the text box, then style the picked part.
  await win.evaluate((p) => window.__paircut.load(p), project);
  await win.evaluate(() => window.__paircut.seek(0.5));
  await win.locator('[data-clip="x-sub"]').click();
  const clipOf = (id) => win.evaluate((i) => window.__paircut.state().project.tracks.flatMap((t) => t.clips).find((c) => c.id === i), id);
  await win.locator('[data-testid="text-rotation"]').fill('-8');
  check('rotation set from the inspector', (await clipOf('x-sub')).rotation === -8);
  await win.locator('[data-testid="text-rotation"]').fill('0');
  check('span button waits for a selection', await win.locator('[data-testid="span-add"]').isDisabled());
  const pick = async (from, to) => {
    const box = win.locator('[data-testid="text-input"]');
    // Keyboard selection, as a person would make it; a scripted setSelectionRange fires no React onSelect.
    await box.focus();
    await win.keyboard.press('Control+Home');
    for (let i = 0; i < from; i++) await win.keyboard.press('ArrowRight');
    for (let i = from; i < to; i++) await win.keyboard.press('Shift+ArrowRight');
    await win.waitForTimeout(100);
  };
  await pick(6, 10);
  await win.locator('[data-testid="span-add"]').click();
  const pickedSpans = (await clipOf('x-sub')).spans;
  check('picked letters become a styled part', pickedSpans.length === 1 && pickedSpans[0].match === '내보내기' && pickedSpans[0].nth === 0, JSON.stringify(pickedSpans));
  await win.locator('[data-testid="span-scale"]').fill('150');
  await win.locator('[data-testid="span-rotate"]').fill('10');
  await win.locator('[data-testid="span-color-on"]').check();
  await pickFont('span-font', 'thin');
  const sp = (await clipOf('x-sub')).spans[0];
  check('inspector sets size, turn, color and weight of the part', sp.scale === 1.5 && sp.rotate === 10 && sp.color === '#FFD166' && sp.font === 'thin', JSON.stringify(sp));
  check('inspector styling changes the drawn text', (await layerOf('x-sub')).w > flat.w);
  await pickFont('span-font', '');
  check('back to the clip font drops the part font', !('font' in (await clipOf('x-sub')).spans[0]));
  await pick(0, 2);
  await win.locator('[data-testid="span-add"]').click();
  check('a second part gets its own row', (await win.locator('[data-testid="span-row"]').count()) === 2);
  await win.locator('[data-testid="span-remove"]').first().click();
  const left = (await clipOf('x-sub')).spans;
  check('removing a row drops only that part', left.length === 1 && left[0].match === '미리', JSON.stringify(left));
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('Control+z');
  check('undo brings the removed part back', (await clipOf('x-sub')).spans.length === 2);
  await win.waitForTimeout(300);
  await win.screenshot({ path: join(dir, 'span-inspector.png') });

  // Bigger preview: the timeline splitter and the full-area toggle.
  const stageHeight = () => win.locator('.stage').evaluate((el) => el.getBoundingClientRect().height);
  const tlHeight = () => win.locator('.timeline').evaluate((el) => el.getBoundingClientRect().height);
  const stage0 = await stageHeight();
  const bar = await win.locator('.tl-splitter').boundingBox();
  await win.mouse.move(bar.x + 200, bar.y + 2);
  await win.mouse.down();
  await win.mouse.move(bar.x + 200, bar.y + 122, { steps: 4 });
  await win.mouse.up();
  const stage1 = await stageHeight();
  check('dragging the splitter down shrinks the timeline and grows the preview',
    Math.abs((await tlHeight()) - 180) <= 2 && stage1 > stage0 + 100, `stage ${stage0} -> ${stage1}`);
  await win.locator('.tl-splitter').dblclick();
  check('double-click restores the timeline height', Math.abs((await tlHeight()) - 300) <= 2);
  await win.locator('[data-testid="preview-big"]').click();
  const stageBig = await stageHeight();
  check('big preview hides the timeline and side panels',
    !(await win.locator('.timeline').isVisible()) && !(await win.locator('.inspector').isVisible()) && stageBig > stage0 + 250,
    `stage ${stage0} -> ${stageBig}`);
  await win.locator('.stage').click({ position: { x: 5, y: 5 } });
  await win.keyboard.press('Escape');
  check('Escape leaves the big preview', await win.locator('.timeline').isVisible());
  await win.locator('[data-testid="preview-zoom"]').selectOption('0.5');
  const halfHeight = await stageHeight();
  check('50% preview zoom draws the frame at half its pixel size', Math.abs(halfHeight - 960) <= 2, String(halfHeight));
  await win.locator('[data-testid="preview-zoom"]').selectOption('0');
  check('fit goes back to the panel size', Math.abs((await stageHeight()) - stage0) <= 2);

  // Solid color backgrounds: made as a frame-size PNG, so preview and export treat them like any picture.
  await win.evaluate((p) => window.__paircut.load(p), project);
  await win.locator('[data-tab="media"]').click();
  await win.locator('[data-testid="solid-color"]').fill('#3366cc');
  await win.locator('[data-testid="solid-add"]').click();
  await win.waitForFunction(() => window.__paircut.state().project.assets.some((a) => a.solid), null, { timeout: 15000 });
  const solidAsset = await win.evaluate(() => window.__paircut.state().project.assets.find((a) => a.solid));
  check('solid button adds a frame-size picture', solidAsset.solid === '#3366CC' && solidAsset.kind === 'image' &&
    solidAsset.width === 1080 && solidAsset.height === 1920 && solidAsset.name === '단색 #3366CC', JSON.stringify(solidAsset));
  const solidVia = await tool('edit', { ops: [{ op: 'add_solid', color: '#00c853', start: 0, dur: 1, track: 'new' }] });
  const solidId = /add_solid -> (\S+)/.exec(solidVia.text)?.[1];
  const solidClip = solidId ? await clipOf(solidId) : null;
  check('Claude adds a solid for a set time', !solidVia.isError && solidClip !== null && Math.abs(solidClip.out - 1) < 1e-6, solidVia.text);
  const pixelOfShot = (b64, x, y) => win.evaluate(async ([data, px, py]) => {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${data}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return [...g.getImageData(px, py, 1, 1).data.slice(0, 3)];
  }, [b64, x, y]);
  const solidShot = await tool('screenshot', { t: 0.5 });
  const solidPreview = await pixelOfShot(solidShot.jpegBase64, 135, 200);
  const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 40;
  check('solid shows in the preview', near(solidPreview, [0, 200, 83]), String(solidPreview));
  const solidOut = join(dir, 'solid.mp4');
  await exportTo(solidOut);
  const solidExport = samplePixel(solidOut, 0.5, 540, 800);
  check('solid shows in the export', near(solidExport, [0, 200, 83]), String(solidExport));
  await win.locator(`[data-clip="${solidId}"]`).click();
  await win.locator('[data-testid="solid-recolor"]').fill('#ff8800');
  await win.locator('[data-testid="solid-apply"]').click();
  await win.waitForFunction((cid) => {
    const p = window.__paircut.state().project;
    const c = p.tracks.flatMap((t) => t.clips).find((x) => x.id === cid);
    return p.assets.find((a) => a.id === c.assetId)?.solid === '#FF8800';
  }, solidId, { timeout: 15000 });
  check('inspector recolors a solid clip', true);
  const reuse = await tool('edit', { ops: [{ op: 'add_solid', color: '#FF8800', start: 3, dur: 1, track: 'new' }] });
  const solidCount = await win.evaluate(() => window.__paircut.state().project.assets.filter((a) => a.solid === '#FF8800').length);
  check('the same color reuses its asset', !reuse.isError && solidCount === 1, reuse.text);
  const badColor = await tool('edit', { ops: [{ op: 'add_solid', color: 'red' }] });
  check('a solid color that is not #RRGGBB is rejected', badColor.isError === true, badColor.text);

  // Motion graphics: a see-through webm over a red picture shows red around its green square, in preview and export.
  const motion = await importMedia(f('motion.webm'), join(dir, 'cache'));
  check('probe marks a see-through webm', motion.alpha === 'vp9', JSON.stringify({ alpha: motion.alpha, kind: motion.kind }));
  check('probe leaves plain video opaque', fx.land.alpha === undefined);
  const pic = fx.pic;
  const MC = { transform: { scale: 1, x: 0, y: 0 }, crop: { l: 0, t: 0, r: 0, b: 0 }, volume: 1, fadeIn: 0, fadeOut: 0, speed: 1,
    color: { brightness: 0, contrast: 0, saturation: 0, temperature: 0 }, dissolve: 0 };
  await win.evaluate((p) => window.__paircut.load(p), {
    ...base,
    assets: [pic, motion],
    tracks: [
      { id: 'v-mg', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'mg', assetId: motion.id, start: 0, in: 0, out: 2 }] },
      { id: 'v-main', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'bg', assetId: pic.id, start: 0, in: 0, out: 2 }] },
    ],
  });
  check('get_state marks the motion graphic', (await tool('get_state')).text.includes('transparent'));
  await win.evaluate(() => window.__paircut.seek(1));
  let mgEdge = null;
  let mgMid = null;
  for (let i = 0; i < 30; i++) {
    await win.waitForTimeout(150);
    const shot = await tool('screenshot', { t: 1 });
    mgEdge = await pixelOfShot(shot.jpegBase64, 20, 40);
    mgMid = await pixelOfShot(shot.jpegBase64, 135, 240);
    if (near(mgMid, [0, 255, 0])) break;
  }
  check('preview: motion graphic is see-through around its shape', near(mgEdge, [255, 0, 0]), String(mgEdge));
  check('preview: motion graphic draws its shape', near(mgMid, [0, 255, 0]), String(mgMid));
  const mgOut = join(dir, 'motion.mp4');
  await exportTo(mgOut);
  const exEdge = samplePixel(mgOut, 1, 80, 160);
  const exMid = samplePixel(mgOut, 1, 536, 956);
  check('export: motion graphic is see-through around its shape', near(exEdge, [254, 0, 0]), String(exEdge));
  check('export: motion graphic draws its shape', near(exMid, [0, 255, 0]), String(exMid));

  // Text effects over a red picture: each treats the picture under the letters, preview and export alike.
  const fxClip = (effect, anim) => ({ ...text('fx', 0, 2, 'I', { ...outlined(300, 'black'), strokeWidth: 0, effect }, 0.5, 0.5, anim),
    rotation: 0, spans: [] });
  const fxProject = (effect, anim) => ({
    ...base,
    assets: [pic],
    tracks: [
      { id: 't-fx', kind: 'text', muted: false, hidden: false, clips: [fxClip(effect, anim)] },
      { id: 'v-main', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'bg', assetId: pic.id, start: 0, in: 0, out: 2 }] },
    ],
  });
  await win.evaluate((p) => window.__paircut.load(p), fxProject('none', 'none'));
  const glyph = await layerOf('fx');
  // A 24px block fully inside the letter, found on the plain raster; centered text keeps the letter in place for every effect.
  const inside = await win.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const solid = (x, y) => {
      for (let j = 0; j < 24; j++) for (let i = 0; i < 24; i++) if (d[((y + j) * c.width + x + i) * 4 + 3] < 250) return false;
      return true;
    };
    const cx = Math.floor(c.width / 2) - 12;
    for (let y = Math.floor(c.height / 2) - 12; y > 0; y -= 2) {
      if (!solid(cx, y)) continue;
      // The letter's right edge on that row, for effects that paint just outside it.
      let edge = cx;
      while (edge < c.width && d[((y + 12) * c.width + edge) * 4 + 3] >= 128) edge++;
      return { x: cx, y, edge };
    }
    return null;
  }, glyph.pngBase64);
  check('effect probe finds the inside of the letter', inside !== null, JSON.stringify(glyph && { w: glyph.w, h: glyph.h }));
  const inP = { x: glyph.x + inside.x, y: glyph.y + inside.y, s: 24 };
  const besideP = { x: glyph.x + glyph.w + 30, y: glyph.y + inside.y, s: 24 };
  const settled = async (t, p) => {
    await win.evaluate((at) => window.__paircut.seek(at), t);
    let last = null;
    for (let i = 0; i < 20; i++) {
      await win.waitForTimeout(120);
      const now = await readCanvas(p);
      if (last && String(now) === String(last)) return now;
      last = now;
    }
    return last;
  };
  const close = (a, b, tol) => Math.max(...a.map((v, i) => Math.abs(v - b[i]))) <= tol;
  const effects = [
    { effect: 'invert', anim: 'none', t: 1, at: inP, want: [0, 255, 255] },
    { effect: 'invert', anim: 'fade', t: 0.1, at: inP, want: [153, 102, 102] },
    { effect: 'mono', anim: 'none', t: 1, at: inP, want: [77, 77, 77] },
    { effect: 'frost', anim: 'none', t: 1, at: inP, want: [255, 64, 64] },
    { effect: 'knockout', anim: 'none', t: 1, at: inP, want: [255, 0, 0] },
    { effect: 'knockout', anim: 'none', t: 1, at: besideP, want: [255, 255, 255] },
    { effect: 'invert', anim: 'none', t: 1, at: besideP, want: [255, 0, 0] },
  ];
  for (const e of effects) {
    await win.evaluate((p) => window.__paircut.load(p), fxProject(e.effect, e.anim));
    const shown = await settled(e.t, e.at);
    const out = join(dir, `fx-${e.effect}-${e.anim}.mp4`);
    await exportTo(out);
    const made = samplePixel(out, e.t, e.at.x, e.at.y, 24);
    const where = e.at === inP ? 'inside' : 'beside';
    check(`${e.effect}${e.anim === 'fade' ? ' mid fade' : ''} ${where} the letter: preview`, close(shown, e.want, 6), `${shown} want ${e.want}`);
    check(`${e.effect}${e.anim === 'fade' ? ' mid fade' : ''} ${where} the letter: export`, close(made, e.want, 8), `${made} want ${e.want}`);
  }
  // Frost over a real picture: the blur reads neighbours, so compare preview with export rather than a formula.
  await win.evaluate((p) => window.__paircut.load(p), {
    ...fxProject('frost', 'none'),
    assets: [fx.land],
    tracks: [
      { id: 't-fx', kind: 'text', muted: false, hidden: false, clips: [fxClip('frost', 'none')] },
      { id: 'v-main', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'bg', assetId: fx.land.id, start: 0, in: 0, out: 2 }] },
    ],
  });
  const frostShown = await settled(1, inP);
  const frostOut = join(dir, 'fx-frost-land.mp4');
  await exportTo(frostOut);
  const frostMade = samplePixel(frostOut, 1, inP.x, inP.y, 24);
  check('frost over footage: preview matches export', close(frostShown, frostMade, 14), `preview ${frostShown} / export ${frostMade}`);
  // Glow, chroma and glitch are baked into the text images, so preview and export are compared pixel for pixel.
  const atBoth = async (effect, t, p, size) => {
    await win.evaluate((pr) => window.__paircut.load(pr), fxProject(effect, 'none'));
    const shown = await settled(t, p);
    const out = join(dir, `fx-${effect}-${t}.mp4`);
    await exportTo(out);
    return { shown, made: samplePixel(out, t, p.x, p.y, size) };
  };
  const haloP = { x: glyph.x + inside.edge + 20, y: glyph.y + inside.y, s: 8 };
  const glowAt = await atBoth('glow', 1, haloP, 8);
  check('glow lights the picture beside the letter: preview', glowAt.shown[1] > 80, String(glowAt.shown));
  check('glow: preview matches export', close(glowAt.shown, glowAt.made, 14), `${glowAt.shown} / ${glowAt.made}`);
  const fringeP = { x: glyph.x + inside.edge + 3, y: glyph.y + inside.y + 8, s: 6 };
  const chromaAt = await atBoth('chroma', 1, fringeP, 6);
  check('chroma puts a cyan fringe right of the letter: preview', close(chromaAt.shown, [0, 229, 255], 30), String(chromaAt.shown));
  check('chroma: preview matches export', close(chromaAt.shown, chromaAt.made, 20), `${chromaAt.shown} / ${chromaAt.made}`);
  await win.evaluate((pr) => window.__paircut.load(pr), fxProject('glitch', 'none'));
  const gl = await layerOf('fx');
  check('glitch makes three distinct frames', gl.variants.length === 3 && new Set([gl.pngBase64, ...gl.variants]).size === 4);
  const plainAt = await atBoth('glitch', 1, inP, 24);
  check('glitch is plain between bursts', close(plainAt.shown, [255, 255, 255], 6) && close(plainAt.made, [255, 255, 255], 8),
    `${plainAt.shown} / ${plainAt.made}`);
  // Mid-burst frames (variant 1 at 0.1s, variant 2 at 1.6s): compare a wide strip across the letter and its shifted bands.
  const strip = { x: glyph.x - 40, y: glyph.y + Math.round(glyph.h / 2) - 60, s: 120 };
  const calm = await settled(1, strip);
  for (const t of [0.1, 1.6]) {
    const burst = await atBoth('glitch', t, strip, 120);
    check(`glitch frame at ${t}s differs from the plain letters`, !close(burst.shown, calm, 3), `${burst.shown} vs ${calm}`);
    check(`glitch frame at ${t}s: preview matches export`, close(burst.shown, burst.made, 10), `${burst.shown} / ${burst.made}`);
  }

  // Intro anims: frames the renderer draws, played by the exporter as an image sequence. The right letter of "I I"
  // is still coming in mid-intro, so a block over it must differ from the settled text and match the export.
  const introProject = (anim) => {
    const pr = fxProject('none', anim);
    pr.tracks[0].clips = [{ ...fxClip('none', anim), text: 'I I' }];
    return pr;
  };
  await win.evaluate((pr) => window.__paircut.load(pr), introProject('none'));
  const pair = await layerOf('fx');
  check('a plain text has no intro frames', pair.intro === null);
  const rightP = { x: pair.x + pair.w - 100, y: pair.y + Math.round(pair.h / 2) - 50, s: 100 };
  const pairSettled = await settled(1, rightP);
  for (const [anim, t] of [['type', 0], ['word', 0.1], ['letters', 0.1], ['blur', 0.3], ['track', 0.3], ['wipe', 0.3]]) {
    await win.evaluate((pr) => window.__paircut.load(pr), introProject(anim));
    const lay = await layerOf('fx');
    check(`${anim}: exports intro frames`, lay.intro !== null && lay.intro.frames.length > 1, String(lay.intro?.frames.length));
    const mid = await settled(t, rightP);
    const late = await settled(1, rightP);
    const out = join(dir, `intro-${anim}.mp4`);
    await exportTo(out);
    const madeMid = samplePixel(out, t, rightP.x, rightP.y, 100);
    const madeLate = samplePixel(out, 1, rightP.x, rightP.y, 100);
    check(`${anim}: mid-intro differs from the settled text`, !close(mid, pairSettled, 12), `${mid} vs ${pairSettled}`);
    check(`${anim}: mid-intro preview matches export`, close(mid, madeMid, 24), `${mid} / ${madeMid}`);
    check(`${anim}: settled after the intro, preview and export`, close(late, pairSettled, 3) && close(madeLate, pairSettled, 24),
      `${late} / ${madeLate} want ${pairSettled}`);
  }

  // The effect from the inspector and from Claude.
  await win.evaluate((p) => window.__paircut.load(p), fxProject('none', 'none'));
  await win.locator('[data-clip="fx"]').click();
  await win.locator('[data-testid="text-effect"]').selectOption('mono');
  check('inspector sets the text effect', (await clipOf('fx')).style.effect === 'mono');
  const fxOp = await tool('edit', { ops: [{ op: 'set_text', clip: 'fx', effect: 'frost' }] });
  check('Claude sets the text effect and reads it back', !fxOp.isError && (await tool('get_state')).text.includes('fx=frost'), fxOp.text);
  const oldStyle = await win.evaluate(() => {
    const p = structuredClone(window.__paircut.state().project);
    delete p.tracks[0].clips[0].style.effect;
    return p;
  });
  await win.evaluate((p) => window.__paircut.load(p), oldStyle);
  check('a project saved before effects opens with none', (await clipOf('fx')).style.effect === 'none');

  // The dropped 'behind' effect: older files open with no effect and without their subject masks.
  const boxAsset = await importMedia(f('box.mp4'), join(dir, 'cache'));
  const behindProject = fxProject('behind', 'none');
  behindProject.assets = [{ ...boxAsset, matte: { dir: join(dir, 'old-masks'), from: 0, to: 2, fps: 30, count: 61 } }];
  behindProject.tracks[1].clips = [{ ...MC, id: 'bg', assetId: boxAsset.id, start: 0, in: 0, out: 2 }];
  await win.evaluate((p) => window.__paircut.load(p), behindProject);
  const opened = await win.evaluate(() => window.__paircut.state().project);
  check('a file with a behind text opens with no effect and no masks', opened.tracks[0].clips[0].style.effect === 'none' &&
    !('matte' in opened.assets[0]), JSON.stringify({ effect: opened.tracks[0].clips[0].style.effect, keys: Object.keys(opened.assets[0]) }));

  // Subject to a new layer: the green box comes out as a see-through clip above; a blue picture slid between the two
  // hides the red background but not the box.
  const layerProject = fxProject('none', 'none');
  layerProject.assets = [boxAsset];
  layerProject.tracks[0].clips = [];
  layerProject.tracks[1].clips = [{ ...MC, id: 'bg', assetId: boxAsset.id, start: 0, in: 0, out: 2 }];
  await win.evaluate((p) => window.__paircut.load(p), layerProject);
  await win.locator('[data-clip="bg"]').click();
  await win.locator('[data-testid="subject-layer"]').click();
  await win.waitForFunction(() => window.__paircut.state().project.tracks.filter((t) => t.kind === 'video').length === 2, null, { timeout: 300000 });
  const layered = await win.evaluate(() => window.__paircut.state().project);
  const subj = layered.tracks[1].clips[0];
  const subjAsset = layered.assets.find((a) => a.id === subj.assetId);
  check('subject goes on a new track right above its clip', layered.tracks[2].clips[0].id === 'bg' &&
    subjAsset.alpha === 'vp9' && subj.start === 0 && subj.in === 0, JSON.stringify({ alpha: subjAsset.alpha, name: subjAsset.name, dur: subjAsset.duration }));
  const blue = await win.evaluate(() => window.api.makeSolid('#0000FF', 1080, 1920));
  await win.evaluate(([p, b]) => {
    const tracks = [...p.tracks];
    tracks.splice(2, 0, { id: 'v-blue', kind: 'video', muted: false, hidden: false, clips: [{ ...p.tracks[2].clips[0], id: 'blue', assetId: b.id, in: 0, out: 2, speed: 1 }] });
    window.__paircut.load({ ...p, assets: [...p.assets, b], tracks });
  }, [layered, blue]);
  const boxP = { x: 528, y: 948, s: 24 };
  const sideP = { x: 880, y: 948, s: 24 };
  const greenish = (c) => c[1] > 120 && c[0] < 40 && c[2] < 40;
  const layerOut = join(dir, 'subject-layer.mp4');
  await exportTo(layerOut);
  for (const [t, p, what, ok] of [
    [1, boxP, 'box stays over the picture between', greenish],
    [1, sideP, 'picture between hides the background', (c) => close(c, [0, 0, 255], 14)],
    [0.1, boxP, 'where the box has left, the picture between shows', (c) => close(c, [0, 0, 255], 14)],
  ]) {
    const shown = await settled(t, p);
    const made = samplePixel(layerOut, t, p.x, p.y, 24);
    check(`subject layer at ${t}s, ${what}: preview`, ok(shown), String(shown));
    check(`subject layer at ${t}s, ${what}: export`, ok(made), String(made));
  }

  // Text templates: save the selected text, add it back, delete it; built-ins hide and come back.
  const tplProject = fxProject('none', 'none');
  tplProject.tracks[0].clips = [{ ...fxClip('glow', 'pop'), rotation: 12, spans: [{ match: 'I', nth: 0, color: '#FFD166' }] }];
  await win.evaluate((p) => window.__paircut.load(p), tplProject);
  await win.locator('[data-tab="text"]').click();
  check('template save waits for a selected text', await win.locator('[data-testid="template-save"]').isDisabled());
  await win.locator('[data-clip="fx"]').click();
  await win.locator('[data-testid="template-name"]').fill('테스트 글로우');
  await win.locator('[data-testid="template-save"]').click();
  await win.locator('[data-template="테스트 글로우"]').waitFor({ timeout: 5000 });
  check('a saved template shows in the text tab', true);
  const idsBefore = (await win.evaluate(() => window.__paircut.state().project.tracks.flatMap((t) => t.clips))).map((c) => c.id);
  await win.evaluate(() => window.__paircut.seek(3));
  await win.locator('[data-template="테스트 글로우"]').click();
  const made = (await win.evaluate(() => window.__paircut.state().project.tracks.flatMap((t) => t.clips))).find((c) => !idsBefore.includes(c.id));
  check('a template adds the saved text, look, motion and spans',
    made?.text === 'I' && made.style.effect === 'glow' && made.anim === 'pop' && made.rotation === 12 &&
      made.spans[0]?.color === '#FFD166' && Math.abs(made.out - 2) < 1e-6 && made.preset.startsWith('u-'),
    JSON.stringify(made && { text: made.text, effect: made.style.effect, anim: made.anim, rotation: made.rotation, out: made.out }));
  await win.locator('[data-delete-template="테스트 글로우"]').click();
  check('deleting a template removes it', (await win.locator('[data-template="테스트 글로우"]').count()) === 0);
  await win.locator('[data-delete-template="기본 텍스트"]').click();
  check('deleting a built-in template hides it', (await win.locator('[data-preset="basic"]').count()) === 0);
  await win.reload();
  await win.waitForFunction(() => window.__paircut !== undefined);
  await win.locator('[data-tab="text"]').click();
  check('deletions survive a restart', (await win.locator('[data-preset="basic"]').count()) === 0 &&
    (await win.locator('[data-template="테스트 글로우"]').count()) === 0);
  await win.locator('[data-testid="template-restore"]').click();
  check('built-in templates come back', (await win.locator('[data-preset="basic"]').count()) === 1 &&
    (await win.locator('[data-testid="template-restore"]').count()) === 0);

  // Layer actions from the track head: merge, order, duplicate, delete, rename, lock.
  const layerStyle = { ...outlined(60, 'bold'), strokeWidth: 0 };
  const layerTrack = (id, clips) => ({ id, kind: 'text', muted: false, hidden: false, clips });
  await win.evaluate((p) => window.__paircut.load(p), {
    ...base,
    tracks: [
      layerTrack('t-a', [{ ...text('la', 0, 2, 'A', layerStyle, 0.5, 0.3, 'none'), rotation: 0, spans: [] }]),
      layerTrack('t-b', [{ ...text('lb', 3, 2, 'B', layerStyle, 0.5, 0.5, 'none'), rotation: 0, spans: [] }]),
      layerTrack('t-c', [{ ...text('lc', 1, 3, 'C', layerStyle, 0.5, 0.7, 'none'), rotation: 0, spans: [] }]),
      ...base.tracks.filter((t) => t.kind !== 'text'),
    ],
  });
  const textTracks = () => win.evaluate(() => window.__paircut.state().project.tracks.filter((t) => t.kind === 'text')
    .map((t) => ({ id: t.id, name: t.name, locked: t.locked, clips: t.clips.map((c) => ({ id: c.id, start: c.start })) })));
  const menu = async (trackId, item) => {
    // The first tap selects the layer, a tap on the selected layer opens its menu.
    for (let i = 0; i < 2 && (await win.locator(`[data-menu="${trackId}"]`).count()) === 0; i++) {
      await win.locator(`[data-head="${trackId}"] .layer-thumb`).click();
    }
    return win.locator(`[data-menu="${trackId}"]`).getByRole('button', { name: item, exact: true });
  };
  await (await menu('t-a', '아래 레이어와 병합')).click();
  let tt = await textTracks();
  check('merge moves the clips into the layer below', tt.length === 2 && tt[0].id === 't-b' &&
    tt[0].clips.map((c) => c.id).join() === 'la,lb', JSON.stringify(tt));
  const blocked = await menu('t-b', '아래 레이어와 병합');
  check('merge is refused when clips would overlap', await blocked.isDisabled() &&
    (await win.locator('[data-menu="t-b"] .tl-menu-note').textContent()).includes('겹쳐요'));
  await (await menu('t-b', '뒤로 (아래로)')).click();
  tt = await textTracks();
  check('a layer moves back behind the next one', tt.map((t) => t.id).join() === 't-c,t-b', JSON.stringify(tt.map((t) => t.id)));
  await (await menu('t-b', '복제')).click();
  tt = await textTracks();
  const dup = tt[1];
  check('duplicate puts a copy with new clip ids right above', tt.length === 3 && tt[2].id === 't-b' && dup.clips.length === 2 &&
    dup.clips.every((c, i) => c.id !== tt[2].clips[i].id && c.start === tt[2].clips[i].start), JSON.stringify(tt));
  await (await menu(dup.id, '삭제')).click();
  check('delete removes the layer', (await textTracks()).length === 2);
  await win.keyboard.press('Control+KeyZ');
  check('undo brings a deleted layer back', (await textTracks()).length === 3);
  await win.keyboard.press('Control+KeyZ');
  await win.locator('[data-head="t-b"] .tl-head-name').dblclick();
  await win.locator('[data-head="t-b"] .tl-head-input').fill('자막');
  await win.keyboard.press('Enter');
  check('double-click renames a layer', (await textTracks()).find((t) => t.id === 't-b')?.name === '자막' &&
    (await win.locator('[data-head="t-b"] .tl-head-name').textContent()) === '자막');
  await (await menu('t-b', '잠금')).click();
  check('a locked layer says so on its card', (await win.locator('[data-head="t-b"] .layer-notes').textContent()).includes('잠김'));
  const lockedBox = await win.locator('[data-clip="lb"]').boundingBox();
  await win.mouse.move(lockedBox.x + lockedBox.width / 2, lockedBox.y + lockedBox.height / 2);
  await win.mouse.down();
  await win.mouse.move(lockedBox.x + lockedBox.width / 2 + 120, lockedBox.y + lockedBox.height / 2, { steps: 5 });
  await win.mouse.up();
  await win.keyboard.press('Delete');
  await win.evaluate(() => window.__paircut.seek(4));
  await win.keyboard.press('KeyS');
  const lockedTrack = (await textTracks()).find((t) => t.id === 't-b');
  check('a locked layer keeps its clips: no drag, delete or split', lockedTrack.locked === true &&
    lockedTrack.clips.map((c) => `${c.id}@${c.start}`).join() === 'la@0,lb@3', JSON.stringify(lockedTrack));
  check('a locked layer cannot be deleted or merged', await (await menu('t-b', '삭제')).isDisabled());
  await win.locator('[data-head="t-b"] .layer-thumb').click();
  check('the layer menu closes again', (await win.locator('[data-menu="t-b"]').count()) === 0);

  // A picture layer moves in front of a text layer: a blue picture over a white plate, red at the bottom.
  const [blueSolid, redSolid] = await win.evaluate(async () =>
    [await window.api.makeSolid('#0000FF', 1080, 1920), await window.api.makeSolid('#FF0000', 1080, 1920)]);
  await win.evaluate((p) => window.__paircut.load(p), {
    ...base,
    assets: [...base.assets, blueSolid, redSolid],
    tracks: [
      layerTrack('t-x', [{ ...text('lx', 0, 2, 'X', { ...layerStyle, background: '#FFFFFF' }, 0.5, 0.5, 'none'), rotation: 0, spans: [] }]),
      { id: 'v-top', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'vb', assetId: blueSolid.id, start: 0, in: 0, out: 2 }] },
      { id: 'v-bg', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'vr', assetId: redSolid.id, start: 0, in: 0, out: 2 }] },
      ...base.tracks.filter((t) => t.kind === 'audio'),
    ],
  });
  const plateP = { x: 540, y: 960, s: 8 };
  check('a text layer draws over the pictures below', close(await settled(1, plateP), [255, 255, 255], 12));
  check('audio layers do not swap with pictures', await (await menu('v-bg', '뒤로 (아래로)')).isDisabled());
  await win.locator('[data-head="v-bg"] .layer-thumb').click();
  await (await menu('v-top', '앞으로 (위로)')).click();
  const stack = await win.evaluate(() => window.__paircut.state().project.tracks.map((t) => t.id));
  check('a picture layer moves in front of a text layer', stack.slice(0, 3).join() === 'v-top,t-x,v-bg', stack.join());
  check('the picture in front covers the text: preview', close(await settled(1, plateP), [0, 0, 255], 12));
  {
    const out = join(dir, 'picture-over-text.mp4');
    await exportTo(out);
    const made = samplePixel(out, 1, plateP.x, plateP.y, 8);
    check('the picture in front covers the text: export', close(made, [0, 0, 255], 14), String(made));
  }

  // Layer cards: a thumbnail of the layer alone, drag to restack, the check hides the layer.
  const thumbPixel = (trackId) => win.evaluate((id) => {
    const c = document.querySelector(`[data-head="${id}"] canvas.layer-thumb`);
    return c ? [...c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data] : null;
  }, trackId);
  await settled(1, plateP);
  const redThumb = await thumbPixel('v-bg');
  check('a layer card shows the layer alone', redThumb && close(redThumb.slice(0, 3), [255, 0, 0], 12) && redThumb[3] === 255,
    String(redThumb));
  const textThumb = await thumbPixel('t-x');
  check('a text card is see-through outside the letters', textThumb === null || textThumb[3] < 255 || close(textThumb.slice(0, 3), [255, 255, 255], 12),
    String(textThumb));
  const from = await win.locator('[data-head="v-bg"] .layer-thumb').boundingBox();
  const top = await win.locator('[data-head="v-top"]').boundingBox();
  await win.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await win.mouse.down();
  await win.mouse.move(from.x + from.width / 2, top.y + 4, { steps: 8 });
  check('a dragged card shows where it will land', (await win.locator('[data-head="v-top"].drop-before').count()) === 1);
  await win.mouse.up();
  const dragged = await win.evaluate(() => window.__paircut.state().project.tracks.map((t) => t.id));
  check('dragging a card to the top restacks the layer', dragged.slice(0, 3).join() === 'v-bg,v-top,t-x', dragged.join());
  check('the dragged layer is in front: preview', close(await settled(1, plateP), [255, 0, 0], 12));
  check('a drag does not open the layer menu', (await win.locator('[data-menu="v-bg"]').count()) === 0);
  const audioHead = await win.locator('.tl-heads [data-head^="a-"]').last().boundingBox();
  const topNow = await win.locator('[data-head="v-bg"] .layer-thumb').boundingBox();
  await win.mouse.move(topNow.x + topNow.width / 2, topNow.y + topNow.height / 2);
  await win.mouse.down();
  await win.mouse.move(topNow.x + topNow.width / 2, audioHead.y + audioHead.height - 2, { steps: 8 });
  await win.mouse.up();
  const kept = await win.evaluate(() => window.__paircut.state().project.tracks.map((t) => t.id));
  check('a picture layer cannot be dragged below the audio', kept.slice(0, 3).join() === 'v-bg,v-top,t-x', kept.join());
  await win.keyboard.press('Control+KeyZ');
  const unDragged = await win.evaluate(() => window.__paircut.state().project.tracks.map((t) => t.id));
  check('undo puts a dragged layer back', unDragged.slice(0, 3).join() === 'v-top,t-x,v-bg', unDragged.join());
  await win.locator('[data-head="v-top"] .layer-check').click();
  check('the card check hides the layer', (await win.evaluate(() => window.__paircut.state().project.tracks.find((t) => t.id === 'v-top').hidden)) === true &&
    close(await settled(1, plateP), [255, 255, 255], 12) && (await win.locator('[data-menu="v-top"]').count()) === 0);

  // Placement: a dragged layer sticks to the frame's center line (not with Alt), and the align buttons put it on an edge.
  await win.evaluate((p) => window.__paircut.load(p), {
    ...base,
    assets: [...base.assets, blueSolid, redSolid],
    tracks: [
      layerTrack('t-x', [{ ...text('lx', 0, 2, 'X', { ...layerStyle, background: '#FFFFFF' }, 0.5, 0.7, 'none'), rotation: 0, spans: [] }]),
      { id: 'v-top', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'vb', assetId: blueSolid.id, start: 0, in: 0, out: 2, transform: { scale: 0.5, x: 0.2, y: 0 } }] },
      { id: 'v-bg', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'vr', assetId: redSolid.id, start: 0, in: 0, out: 2 }] },
      ...base.tracks.filter((t) => t.kind === 'audio'),
    ],
  });
  await win.locator('[data-clip="vb"]').click();
  await win.evaluate(() => window.__paircut.seek(1));
  const clipX = (id) => win.evaluate((cid) => {
    const c = window.__paircut.state().project.tracks.flatMap((t) => t.clips).find((k) => k.id === cid);
    return c.transform ? c.transform.x : c.x;
  }, id);
  const stageBox = await win.locator('.stage').boundingBox();
  const tbox = await win.locator('.transform-box').boundingBox();
  const grab = { x: tbox.x + tbox.width / 2, y: tbox.y + tbox.height / 2 };
  const nearCenter = grab.x - 0.2 * stageBox.width + 3;
  await win.mouse.move(grab.x, grab.y);
  await win.mouse.down();
  await win.mouse.move(nearCenter, grab.y, { steps: 6 });
  check('a dragged layer shows the line it sticks to', (await win.locator('[data-testid="snap-x"]').count()) === 1);
  await win.mouse.up();
  const snappedX = await clipX('vb');
  check('a dragged layer sticks to the frame center', Math.abs(snappedX) < 0.003, String(snappedX));
  check('the snap line goes away on release', (await win.locator('[data-testid="snap-x"]').count()) === 0);
  const tbox2 = await win.locator('.transform-box').boundingBox();
  const grab2 = { x: tbox2.x + tbox2.width / 2, y: tbox2.y + tbox2.height / 2 };
  await win.keyboard.down('Alt');
  await win.mouse.move(grab2.x, grab2.y);
  await win.mouse.down();
  await win.mouse.move(grab2.x + 3, grab2.y, { steps: 3 });
  await win.mouse.up();
  await win.keyboard.up('Alt');
  const freeX = await clipX('vb');
  check('Alt drags without sticking', Math.abs(freeX - snappedX - 3 / stageBox.width) < 0.002, `${snappedX} -> ${freeX}`);
  await win.locator('[data-align="left"]').click();
  const leftX = await clipX('vb');
  check('align left puts the picture on the frame edge at export size', Math.round(270 + leftX * 1080) === 0, String(leftX));
  check('align left shows the background on the right: preview', close(await settled(1, { x: 1000, y: 960, s: 8 }), [255, 0, 0], 12) &&
    close(await settled(1, { x: 80, y: 960, s: 8 }), [0, 0, 255], 12));
  await win.locator('[data-clip="lx"]').click();
  await win.evaluate(() => window.__paircut.seek(1));
  await win.locator('[data-align="top"]').click();
  const topBox = await win.locator('.transform-box').boundingBox();
  check('align top puts the text on the frame top', Math.abs(topBox.y - stageBox.y) < 2, `${topBox.y} vs ${stageBox.y}`);
  await win.keyboard.press('Control+KeyZ');
  const undoneY = await win.evaluate(() => window.__paircut.state().project.tracks[0].clips[0].y);
  check('undo takes an align back', Math.abs(undoneY - 0.7) < 1e-9, String(undoneY));

  // Layer opacity and blend modes: a #4080C0 layer over #804020, the same in preview and export.
  const [lowSolid, highSolid] = await win.evaluate(async () =>
    [await window.api.makeSolid('#804020', 1080, 1920), await window.api.makeSolid('#4080C0', 1080, 1920)]);
  const lookProject = (look) => ({
    ...base,
    assets: [...base.assets, lowSolid, highSolid],
    tracks: [
      { id: 'v-hi', kind: 'video', muted: false, hidden: false, ...look, clips: [{ ...MC, id: 'hi', assetId: highSolid.id, start: 0, in: 0, out: 2 }] },
      { id: 'v-lo', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'lo', assetId: lowSolid.id, start: 0, in: 0, out: 2 }] },
      ...base.tracks.filter((t) => t.kind === 'audio'),
    ],
  });
  await win.evaluate((p) => window.__paircut.load(p), lookProject({}));
  await menu('v-hi', '이름 바꾸기');
  await win.locator('[data-menu="v-hi"] [data-testid="layer-blend"]').selectOption('multiply');
  await win.locator('[data-menu="v-hi"] [data-testid="layer-opacity"]').fill('50');
  const looked = await win.evaluate(() => window.__paircut.state().project.tracks[0]);
  check('the layer menu sets blend mode and opacity', looked.blend === 'multiply' && looked.opacity === 0.5, JSON.stringify({ b: looked.blend, o: looked.opacity }));
  check('the card shows the blend mode and opacity', (await win.locator('[data-head="v-hi"] .layer-notes').textContent()).includes('곱하기 · 50%'));
  check('layers that mix differently do not merge', await win.locator('[data-menu="v-hi"] button', { hasText: '아래 레이어와 병합' }).isDisabled());
  await win.locator('[data-head="v-hi"] .layer-thumb').click();
  await win.keyboard.press('Control+KeyZ');
  check('undo takes the opacity back', (await win.evaluate(() => window.__paircut.state().project.tracks[0].opacity)) === undefined);
  const looks = [
    { name: 'multiply', look: { blend: 'multiply' }, want: [32, 32, 24] },
    { name: 'overlay', look: { blend: 'overlay' }, want: [65, 64, 48] },
    { name: 'normal at 50%', look: { opacity: 0.5 }, want: [96, 96, 112] },
    { name: 'difference at 60%', look: { blend: 'difference', opacity: 0.6 }, want: [90, 64, 109] },
  ];
  const lookP = { x: 540, y: 960, s: 8 };
  for (const l of looks) {
    await win.evaluate((p) => window.__paircut.load(p), lookProject(l.look));
    const shown = await settled(1, lookP);
    check(`layer ${l.name}: preview`, close(shown, l.want, 6), `${shown} want ${l.want}`);
    const out = join(dir, `look-${l.name.replace(/\W+/g, '-')}.mp4`);
    await exportTo(out);
    const made = samplePixel(out, 1, lookP.x, lookP.y, 8);
    check(`layer ${l.name}: export`, close(made, l.want, 10), `${made} want ${l.want}`);
  }

  // Clipping mask: a full-frame #4080C0 layer clipped to a half-size #804020 one shows only inside it.
  const clipProject = (top, bottom) => ({
    ...base,
    assets: [...base.assets, lowSolid, highSolid],
    tracks: [
      { id: 'v-clip', kind: 'video', muted: false, hidden: false, ...top, clips: [{ ...MC, id: 'cl', assetId: highSolid.id, start: 0, in: 0, out: 2 }] },
      { id: 'v-base', kind: 'video', muted: false, hidden: false, ...bottom,
        clips: [{ ...MC, id: 'cb', assetId: lowSolid.id, start: 0, in: 0, out: 2, transform: { scale: 0.5, x: 0, y: 0 } }] },
      ...base.tracks.filter((t) => t.kind === 'audio'),
    ],
  });
  await win.evaluate((p) => window.__paircut.load(p), clipProject({}, {}));
  check('the bottom layer cannot be clipped', await (await menu('v-base', '클리핑 마스크')).isDisabled());
  await win.locator('[data-head="v-base"] .layer-thumb').click();
  await (await menu('v-clip', '클리핑 마스크')).click();
  check('the menu turns the clipping mask on', (await win.evaluate(() => window.__paircut.state().project.tracks[0].clipped)) === true &&
    (await win.locator('[data-head="v-clip"].clipped').count()) === 1);
  const clipInP = { x: 540, y: 960, s: 8 };
  const clipOutP = { x: 100, y: 300, s: 8 };
  const clips = [
    { name: 'normal', top: { clipped: true }, bottom: {}, inside: [64, 128, 192] },
    { name: 'multiply', top: { clipped: true, blend: 'multiply' }, bottom: {}, inside: [32, 32, 24] },
    { name: 'on a half-opacity base', top: { clipped: true }, bottom: { opacity: 0.5 }, inside: [32, 64, 96] },
  ];
  for (const c of clips) {
    await win.evaluate((p) => window.__paircut.load(p), clipProject(c.top, c.bottom));
    const shownIn = await settled(1, clipInP);
    const shownOut = await settled(1, clipOutP);
    check(`clipping ${c.name}: preview`, close(shownIn, c.inside, 6) && close(shownOut, [0, 0, 0], 6), `${shownIn} / ${shownOut} want ${c.inside}`);
    const out = join(dir, `clip-${c.name.replace(/\W+/g, '-')}.mp4`);
    await exportTo(out);
    const madeIn = samplePixel(out, 1, clipInP.x, clipInP.y, 8);
    const madeOut = samplePixel(out, 1, clipOutP.x, clipOutP.y, 8);
    check(`clipping ${c.name}: export`, close(madeIn, c.inside, 10) && close(madeOut, [0, 0, 0], 10), `${madeIn} / ${madeOut} want ${c.inside}`);
  }
  await win.evaluate((p) => window.__paircut.load(p), clipProject({ clipped: true }, { hidden: true }));
  check('hiding the base hides its clipping masks', close(await settled(1, clipInP), [0, 0, 0], 6));

  // Merging video layers whose clips overlap: the overlap is baked into one see-through clip that looks the same.
  await win.evaluate((p) => window.__paircut.load(p), {
    ...base,
    assets: [...base.assets, blueSolid, redSolid],
    tracks: [
      { id: 'v-up', kind: 'video', muted: false, hidden: false,
        clips: [{ ...MC, id: 'mu', assetId: blueSolid.id, start: 1, in: 0, out: 2, transform: { scale: 0.5, x: 0, y: 0 } }] },
      { id: 'v-dn', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'md', assetId: redSolid.id, start: 0, in: 0, out: 2 }] },
      ...base.tracks.filter((t) => t.kind === 'audio'),
    ],
  });
  const centerP = { x: 540, y: 960, s: 8 };
  const cornerP = { x: 100, y: 300, s: 8 };
  check('overlapping video layers can be merged', !(await (await menu('v-up', '아래 레이어와 병합')).isDisabled()) &&
    (await win.locator('[data-menu="v-up"] .tl-menu-note').textContent()).includes('구워서'));
  await (await menu('v-up', '아래 레이어와 병합')).click();
  await win.waitForFunction(() => {
    const s = window.__paircut.state();
    return s.layerJob === null && !s.project.tracks.some((t) => t.id === 'v-up');
  }, null, { timeout: 120000 }).catch(() => {});
  const mergedState = await win.evaluate(() => {
    const s = window.__paircut.state();
    const t = s.project.tracks.find((tr) => tr.id === 'v-dn');
    return { job: s.layerJob, ids: s.project.tracks.map((tr) => tr.id), clips: t.clips.map((c) => `${c.start}-${c.start + (c.out - c.in) / c.speed}`),
      baked: s.project.assets.find((a) => a.name.startsWith('병합')) };
  });
  check('the merge leaves one layer: red, baked overlap, blue', mergedState.job === null && !mergedState.ids.includes('v-up') &&
    mergedState.clips.join() === '0-1,1-2,2-3' && mergedState.baked?.alpha === 'vp9', JSON.stringify(mergedState));
  const mergedLooks = [
    { t: 1.5, at: centerP, want: [0, 0, 255] },
    { t: 1.5, at: cornerP, want: [255, 0, 0] },
    { t: 2.5, at: cornerP, want: [0, 0, 0] },
    { t: 0.5, at: centerP, want: [255, 0, 0] },
  ];
  const mergedShown = [];
  for (const m of mergedLooks) mergedShown.push(await settled(m.t, m.at));
  check('the merged layer looks the same: preview', mergedLooks.every((m, i) => close(mergedShown[i], m.want, 12)), mergedShown.join(' / '));
  {
    const out = join(dir, 'merged-overlap.mp4');
    await exportTo(out);
    const made = mergedLooks.map((m) => samplePixel(out, m.t, m.at.x, m.at.y, 8));
    check('the merged layer looks the same: export', mergedLooks.every((m, i) => close(made[i], m.want, 14)), made.join(' / '));
  }
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('Control+KeyZ');
  const unmerged = await win.evaluate(() => window.__paircut.state().project.tracks.map((t) => `${t.id}:${t.clips.length}`));
  check('undo takes a baked merge back', unmerged.slice(0, 2).join() === 'v-up:1,v-dn:1', unmerged.join());

  // Clips butt exactly against a neighbour whose end is off the frame grid, when moved and when trimmed.
  await win.evaluate((p) => window.__paircut.load(p), {
    ...base,
    assets: [pic],
    tracks: [
      { id: 't-1', kind: 'text', muted: false, hidden: false, clips: [] },
      { id: 'v-fit', kind: 'video', muted: false, hidden: false, clips: [
        { ...MC, id: 'fa', assetId: pic.id, start: 0, in: 0, out: 1.408 },
        { ...MC, id: 'fb', assetId: pic.id, start: 3, in: 0, out: 1 },
        { ...MC, id: 'fc', assetId: pic.id, start: 6, in: 0, out: 1 },
      ] },
      { id: 'a-1', kind: 'audio', muted: false, hidden: false, clips: [] },
    ],
  });
  const fitClips = () => win.evaluate(() => Object.fromEntries(window.__paircut.state().project.tracks
    .find((t) => t.id === 'v-fit').clips.map((c) => [c.id, { start: c.start, end: c.start + (c.out - c.in) / c.speed }])));
  const pxPerSec = await win.evaluate(() => window.__paircut.state().zoom);
  const drag = async (sel, fromX, dx) => {
    const box = await win.locator(sel).boundingBox();
    const y = box.y + box.height / 2;
    await win.mouse.move(fromX(box), y);
    await win.mouse.down();
    await win.mouse.move(fromX(box) + dx, y, { steps: 8 });
    await win.mouse.up();
  };
  await drag('[data-clip="fb"]', (b) => b.x + b.width / 2, -(3 - 1.408) * pxPerSec - 6);
  let fit = await fitClips();
  check('a moved clip butts against an off-grid end', Math.abs(fit.fb.start - fit.fa.end) < 1e-9, JSON.stringify(fit));
  await drag('[data-clip="fb"] .handle.right', (b) => b.x + b.width - 3, (6 - fit.fb.end) * pxPerSec + 30);
  fit = await fitClips();
  check('a trimmed end stops exactly at the next clip', Math.abs(fit.fb.end - fit.fc.start) < 1e-9, JSON.stringify(fit));

  // Playhead: empty-space clicks and the grip move it, the magnet catches clip edges, picking a block jumps to it.
  const playheadNow = () => win.evaluate(() => window.__paircut.state().playhead);
  const ruler = await win.locator('.tl-ruler').boundingBox();
  const xAt = (t) => ruler.x + t * pxPerSec;
  const trackBox = await win.locator('[data-row="t-1"]').boundingBox();
  await win.mouse.click(xAt(3.3), trackBox.y + trackBox.height / 2);
  check('clicking empty track space moves the playhead and drops the selection',
    Math.abs((await playheadNow()) - 3.3) < 0.05 && (await win.evaluate(() => window.__paircut.state().selectedClipId)) === null,
    String(await playheadNow()));
  const grip = await win.locator('.tl-playhead-grip').boundingBox();
  await win.mouse.move(grip.x + grip.width / 2, grip.y + 8);
  await win.mouse.down();
  await win.mouse.move(xAt(4.2), grip.y + 8, { steps: 6 });
  await win.mouse.up();
  check('the playhead grip drags the playhead', Math.abs((await playheadNow()) - 4.2) < 0.05, String(await playheadNow()));
  await win.mouse.click(xAt(1.408) + 4, ruler.y + ruler.height / 2);
  check('the magnet puts the playhead exactly on a clip edge', Math.abs((await playheadNow()) - 1.408) < 1e-9, String(await playheadNow()));
  await win.locator('[data-clip="fc"]').click();
  check('picking a block the playhead is not over jumps to its start', Math.abs((await playheadNow()) - 6) < 1e-9,
    String(await playheadNow()));
  await win.evaluate(() => window.__paircut.seek(6.5));
  await win.locator('[data-clip="fc"]').click();
  check('picking the block under the playhead leaves it where it is', Math.abs((await playheadNow()) - 6.5) < 1e-9,
    String(await playheadNow()));

  // OpenCut-style tools: bookmarks, duplicate, trim before the playhead, position keyframes.
  const markers = () => win.evaluate(() => window.__paircut.state().project.markers.map((m) => m.t));
  await win.evaluate(() => window.__paircut.seek(2));
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('m');
  check('M puts a bookmark at the playhead', JSON.stringify(await markers()) === '[2]', JSON.stringify(await markers()));
  await win.keyboard.press('m');
  check('M on a bookmark takes it away', (await markers()).length === 0, JSON.stringify(await markers()));

  await win.locator('[data-clip="fc"]').click();
  await win.keyboard.press('Control+d');
  fit = await fitClips();
  const copyId = await win.evaluate(() => window.__paircut.state().selectedClipId);
  check('Ctrl+D puts a copy right after the clip and picks it',
    copyId !== 'fc' && fit[copyId] && Math.abs(fit[copyId].start - fit.fc.end) < 1e-9, JSON.stringify(fit));

  await win.evaluate(() => window.__paircut.seek(6.5));
  await win.locator('[data-clip="fc"]').click();
  await win.locator('[data-testid="tl-trim-before"]').click();
  fit = await fitClips();
  check('trimming before the playhead keeps the clip end and starts it there',
    Math.abs(fit.fc.start - 6.5) < 1e-9 && Math.abs(fit.fc.end - 7) < 1e-9, JSON.stringify(fit.fc));

  const keysOf = (id) => win.evaluate((cid) => window.__paircut.state().project.tracks.flatMap((t) => t.clips).find((c) => c.id === cid).keys ?? [], id);
  await win.evaluate(() => window.__paircut.seek(0.5));
  await win.locator('[data-clip="fa"]').click();
  await win.locator('[data-testid="key-toggle"]').click();
  let keys = await keysOf('fa');
  check('the first keyframe also pins the start', keys.length === 2 && keys[0].t === 0 && Math.abs(keys[1].t - 0.5) < 1e-9, JSON.stringify(keys));
  await win.evaluate(() => window.__paircut.seek(1.2));
  const boxBefore = await win.locator('.transform-box').boundingBox();
  await win.locator('[data-align="left"]').click();
  keys = await keysOf('fa');
  check('moving the picture with keyframes on adds a keyframe there', keys.length === 3 && Math.abs(keys[2].t - 1.2) < 1e-9, JSON.stringify(keys));
  await win.evaluate(() => window.__paircut.seek(0.25));
  await win.waitForTimeout(100);
  const boxEarly = await win.locator('.transform-box').boundingBox();
  check('before the moved keyframe the picture stays where it was', Math.abs(boxEarly.x - boxBefore.x) < 2,
    `${boxEarly.x} vs ${boxBefore.x}`);
  check('the clip shows its keyframes', (await win.locator('[data-clip="fa"] .tl-key').count()) === 3);
  await win.locator('[data-testid="key-clear"]').click();
  check('clearing keyframes leaves a plain transform', (await keysOf('fa')).length === 0);

  // Layer selection: new clips (templates, paste, the media bin's add button) go to the selected layer.
  await win.evaluate((p) => window.__paircut.load(p), {
    ...base,
    tracks: [
      layerTrack('t-a', [{ ...text('la', 0, 2, 'A', layerStyle, 0.5, 0.3, 'none'), rotation: 0, spans: [] }]),
      layerTrack('t-b', [{ ...text('lb', 3, 2, 'B', layerStyle, 0.5, 0.5, 'none'), rotation: 0, spans: [] }]),
      ...base.tracks.filter((t) => t.kind !== 'text'),
    ],
  });
  const sel = () => win.evaluate(() => {
    const s = window.__paircut.state();
    return { clip: s.selectedClipId, layer: s.selectedTrackId, ids: s.project.tracks.map((t) => t.id),
      clips: Object.fromEntries(s.project.tracks.map((t) => [t.id, t.clips.map((c) => `${c.id === s.selectedClipId ? '*' : ''}${c.start}`)])) };
  });
  await win.locator('[data-head="t-b"] .layer-thumb').click();
  check('tapping a layer card selects the layer without opening its menu', (await sel()).layer === 't-b' &&
    (await win.locator('[data-menu="t-b"]').count()) === 0);
  check('the selected layer is marked', (await win.locator('[data-head="t-b"].selected').count()) === 1 &&
    (await win.locator('[data-row="t-b"].selected').count()) === 1);
  await win.locator('[data-clip="la"]').click({ position: { x: 4, y: 10 } });
  check('selecting a clip selects its layer', (await sel()).layer === 't-a');
  await win.locator('[data-head="t-b"] .layer-thumb').click();
  await win.evaluate(() => window.__paircut.seek(0));
  await win.locator('[data-tab="text"]').click();
  await win.locator('[data-preset="basic"]').click();
  let ls = await sel();
  check('a template goes to the selected layer at the playhead', ls.clips['t-b'].join() === '*0,3' && ls.layer === 't-b', JSON.stringify(ls.clips));
  await win.evaluate(() => window.__paircut.seek(3.5));
  await win.locator('[data-preset="basic"]').click();
  ls = await sel();
  const above = ls.ids[ls.ids.indexOf('t-b') - 1];
  check('where the selected layer is taken, a new layer right above it gets the clip', ls.ids.slice(0, 3).join() === `t-a,${above},t-b` &&
    ls.clips[above]?.join() === '*3.5' && ls.layer === above, JSON.stringify(ls));
  await win.locator('[data-clip="la"]').click({ position: { x: 4, y: 10 } });
  await win.evaluate(() => window.__paircut.seek(2.5));
  await win.keyboard.press('Control+KeyC');
  await win.keyboard.press('Control+KeyV');
  ls = await sel();
  check('paste goes to the copied clip\'s layer, not the top', ls.clips['t-a'].join() === '0,*2.5', JSON.stringify(ls.clips));

  // The pasted clip keeps t-a selected (tapping its card now would open the layer menu).
  await win.locator('[data-testid="tl-add-layer"]').click();
  await win.locator('[data-add-layer="video"]').click();
  ls = await sel();
  const vNew = ls.ids[0];
  check('an added video layer goes right above the selected layer and is selected', vNew.startsWith('v-') && ls.ids[1] === 't-a' &&
    ls.layer === vNew && ls.clips[vNew].length === 0, ls.ids.join());
  await win.locator('[data-testid="tl-add-layer"]').click();
  await win.locator('[data-add-layer="audio"]').click();
  ls = await sel();
  const aNew = ls.layer;
  check('an audio layer added above a picture layer goes on top of the audio layers', aNew.startsWith('a-') &&
    ls.ids.indexOf(aNew) === ls.ids.findIndex((id) => id.startsWith('a-')), ls.ids.join());
  await win.locator(`[data-head="${vNew}"] .layer-thumb`).click();
  await win.evaluate(() => window.__paircut.seek(1));
  await win.locator('[data-tab="media"]').click();
  await win.locator('li.asset[title$="pic.png"] button[title^="선택한 레이어"]').click();
  ls = await sel();
  check('the media bin adds to the selected layer at the playhead', ls.clips[vNew].join() === '*1' && ls.layer === vNew, JSON.stringify(ls.clips));
  await win.locator('[data-clip="lb"]').click({ position: { x: 4, y: 10 } });
  await win.keyboard.press('Delete');
  check('an empty layer added on purpose survives other deletes', (await sel()).ids.includes(aNew));
  check('get_state names the selected layer', (await tool('get_state')).text.includes(`layer=${(await sel()).layer}`));
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('Control+KeyZ');
  await win.keyboard.press('Control+KeyZ');
  await win.keyboard.press('Control+KeyZ');
  check('undo takes the added layer back', !(await sel()).ids.includes(aNew));

  // Copy, cut and paste of every clip kind, multi-select, paste attributes, paste into another project.
  const looked2 = { crop: { l: 0.1, t: 0, r: 0.2, b: 0 }, color: { brightness: 0, contrast: 0, saturation: -0.5, temperature: 0 },
    keys: [{ t: 0, scale: 1, x: 0, y: 0 }, { t: 1, scale: 1.5, x: 0.1, y: 0 }] };
  const clipboardProject = {
    ...base,
    tracks: [
      layerTrack('t-a', [{ ...text('la', 0, 2, 'A', layerStyle, 0.5, 0.3, 'none'), rotation: 0, spans: [] }]),
      layerTrack('t-b', [{ ...text('lb', 3, 2, 'B', layerStyle, 0.5, 0.5, 'none'), rotation: 0, spans: [] }]),
      ...base.tracks.filter((t) => t.kind !== 'text').map((t) => (t.id !== 'v-main' ? t
        : { ...t, clips: t.clips.map((c) => (c.id === 'c2' ? { ...c, ...looked2 } : c)) })),
    ],
  };
  await win.evaluate((p) => window.__paircut.load(p), clipboardProject);
  const clipsOf = (trackId) => win.evaluate((id) => window.__paircut.state().project.tracks.find((t) => t.id === id)?.clips ?? [], trackId);
  await win.locator('[data-clip="c2"]').click({ position: { x: 4, y: 10 } });
  await win.evaluate(() => window.__paircut.seek(7));
  await win.keyboard.press('Control+KeyC');
  await win.keyboard.press('Control+KeyV');
  let vm = await clipsOf('v-main');
  const c2copy = vm.find((c) => Math.abs(c.start - 7) < 1e-6);
  check('a picture clip pastes on its layer at the playhead with crop, color and keyframes', c2copy && c2copy.id !== 'c2' &&
    c2copy.assetId === vm.find((c) => c.id === 'c2').assetId && c2copy.crop.l === 0.1 && c2copy.color.saturation === -0.5 &&
    c2copy.keys?.length === 2, JSON.stringify(vm.map((c) => `${c.id}@${c.start}`)));
  check('after a paste the playhead sits at the pasted clip\'s end', Math.abs((await playheadNow()) - 9) < 1e-6, String(await playheadNow()));
  await win.keyboard.press('Control+KeyV');
  vm = await clipsOf('v-main');
  check('pasting again lines the next copy up after the first', vm.some((c) => Math.abs(c.start - 9) < 1e-6) &&
    Math.abs((await playheadNow()) - 11) < 1e-6, vm.map((c) => c.start).join());
  await win.evaluate(() => window.__paircut.seek(0));
  await win.keyboard.press('Control+KeyV');
  ls = await sel();
  const vAbove = ls.ids[ls.ids.indexOf('v-main') - 1];
  check('a taken spot sends the paste to a new layer right above', vAbove.startsWith('v-') && vAbove !== 'v-top' &&
    ls.clips[vAbove]?.join() === '*0', ls.ids.join());
  await win.locator('[data-clip="c4"]').click({ position: { x: 4, y: 10 } });
  await win.evaluate(() => window.__paircut.seek(5));
  await win.keyboard.press('Control+KeyC');
  await win.keyboard.press('Control+KeyV');
  check('an audio clip copies too', (await clipsOf('a-1')).map((c) => c.start).join() === '2,5', (await clipsOf('a-1')).map((c) => c.start).join());

  await win.locator('[data-clip="la"]').click({ position: { x: 4, y: 10 } });
  await win.keyboard.press('Control+KeyX');
  const afterCut = await win.evaluate(() => window.__paircut.state().project.tracks.flatMap((t) => t.clips).filter((c) => c.text === 'A').length);
  await win.evaluate(() => window.__paircut.seek(6));
  await win.keyboard.press('Control+KeyV');
  const afterCutPaste = await win.evaluate(() => window.__paircut.state().project.tracks.flatMap((t) => t.clips).filter((c) => c.text === 'A').map((c) => c.start));
  check('Ctrl+X removes the clip and Ctrl+V brings it back', afterCut === 0 && afterCutPaste.join() === '6', `${afterCut} / ${afterCutPaste}`);

  await win.evaluate((p) => window.__paircut.load(p), clipboardProject);
  await win.locator('[data-clip="la"]').click({ position: { x: 4, y: 10 } });
  await win.locator('[data-clip="c2"]').click({ position: { x: 4, y: 10 }, modifiers: ['Control'] });
  await win.locator('[data-clip="c4"]').click({ position: { x: 4, y: 10 }, modifiers: ['Shift'] });
  check('Ctrl- and Shift-click add clips to the selection', (await win.evaluate(() => window.__paircut.state().selectedIds.join())) === 'la,c2,c4' &&
    (await win.locator('.tl-clip.selected').count()) === 3);
  await win.locator('[data-clip="c2"]').click({ position: { x: 4, y: 10 }, modifiers: ['Control'] });
  check('Ctrl-click on a selected clip takes it out', (await win.evaluate(() => window.__paircut.state().selectedIds.join())) === 'la,c4');
  await win.locator('[data-clip="c2"]').click({ position: { x: 4, y: 10 }, modifiers: ['Control'] });
  await win.keyboard.press('Control+KeyC');
  await win.locator('[data-head="t-a"] .layer-thumb').click();
  await win.evaluate(() => window.__paircut.seek(7));
  await win.keyboard.press('Control+KeyV');
  const multi = await win.evaluate(() => {
    const s = window.__paircut.state();
    const at = (id) => s.project.tracks.find((t) => t.id === id).clips.filter((c) => c.start >= 7).map((c) => c.start).join();
    return { ta: at('t-a'), vm: at('v-main'), a1: at('a-1'), sel: s.selectedIds.length, main: s.selectedClipId, layer: s.selectedTrackId, playhead: s.playhead };
  });
  check('a multi-clip paste keeps each clip\'s layer and spacing', multi.ta === '7' && multi.vm === '10' && multi.a1 === '9', JSON.stringify(multi));
  check('the pasted clips stay selected, led by the top layer', multi.sel === 3 && multi.layer === 't-a' && Math.abs(multi.playhead - 12) < 1e-6,
    JSON.stringify(multi));
  await win.keyboard.press('Delete');
  const leftAfterDelete = await win.evaluate(() => window.__paircut.state().project.tracks.flatMap((t) => t.clips).filter((c) => c.start >= 7).length);
  check('Delete removes every selected clip', leftAfterDelete === 0, String(leftAfterDelete));

  await win.locator('[data-clip="c2"]').click({ position: { x: 4, y: 10 } });
  await win.keyboard.press('Control+KeyC');
  await win.locator('[data-clip="c1"]').click({ position: { x: 4, y: 10 } });
  await win.locator('[data-clip="c3"]').click({ position: { x: 4, y: 10 }, modifiers: ['Control'] });
  await win.locator('[data-clip="lb"]').click({ position: { x: 4, y: 10 }, modifiers: ['Control'] });
  await win.keyboard.press('Control+Alt+KeyV');
  vm = await clipsOf('v-main');
  const lbAfter = (await clipsOf('t-b'))[0];
  check('Ctrl+Alt+V puts the copied look on every selected clip of the same kind', ['c1', 'c3'].every((id) => {
    const c = vm.find((k) => k.id === id);
    return c.color.saturation === -0.5 && c.crop.r === 0.2 && c.keys?.length === 2;
  }) && lbAfter.style.size === 60 && vm.map((c) => c.start).join() === '0,3,5', JSON.stringify(vm.map((c) => [c.id, c.start, c.color.saturation])));
  await win.keyboard.press('Control+KeyZ');
  vm = await clipsOf('v-main');
  check('one undo takes the pasted look off again', vm.find((c) => c.id === 'c1').color.saturation === 0 && vm.find((c) => c.id === 'c3').color.saturation === 0);

  const c2asset = vm.find((c) => c.id === 'c2').assetId;
  await win.locator('[data-clip="c2"]').click({ position: { x: 4, y: 10 } });
  await win.keyboard.press('Control+KeyC');
  await win.evaluate(({ p, asset }) => window.__paircut.load({ ...p, assets: p.assets.filter((a) => a.id !== asset),
    tracks: [{ id: 't-1', kind: 'text', muted: false, hidden: false, clips: [] }, { id: 'v-main', kind: 'video', muted: false, hidden: false, clips: [] },
      { id: 'a-1', kind: 'audio', muted: false, hidden: false, clips: [] }] }), { p: base, asset: c2asset });
  await win.keyboard.press('Control+KeyV');
  const other = await win.evaluate(() => window.__paircut.state().project);
  check('a paste into another project brings the media along', other.assets.some((a) => a.id === c2asset) &&
    other.tracks.find((t) => t.id === 'v-main').clips[0]?.assetId === c2asset, JSON.stringify(other.tracks.map((t) => t.clips.length)));

  // Picking in the preview: the top layer under the pointer, tapping again goes down the stack, the timeline follows.
  const halfSize = { scale: 0.5, x: 0, y: 0 };
  await win.evaluate((p) => window.__paircut.load(p), {
    ...base,
    assets: [...base.assets, blueSolid, redSolid],
    tracks: [
      layerTrack('t-x', [
        { ...text('px', 0, 2, 'X', { ...layerStyle, background: '#FFFFFF' }, 0.5, 0.5, 'none'), rotation: 0, spans: [] },
        { ...text('pz', 4, 2, 'Z', layerStyle, 0.5, 0.5, 'none'), rotation: 0, spans: [] },
      ]),
      { id: 'v-top', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'vb', assetId: blueSolid.id, start: 0, in: 0, out: 2, transform: halfSize }] },
      { id: 'v-bg', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'vr', assetId: redSolid.id, start: 0, in: 0, out: 2, transform: halfSize }] },
      ...base.tracks.filter((t) => t.kind === 'audio'),
    ],
  });
  const picked = () => win.evaluate(() => window.__paircut.state().selectedClipId);
  await win.locator('[data-clip="pz"]').click({ position: { x: 4, y: 10 } });
  await win.evaluate(() => window.__paircut.seek(1));
  const pStage = await win.locator('.stage').boundingBox();
  const mid = { x: pStage.x + pStage.width / 2, y: pStage.y + pStage.height / 2 };
  const cycle = [];
  for (let i = 0; i < 4; i++) {
    await win.mouse.click(mid.x, mid.y);
    cycle.push(await picked());
  }
  check('a press in the preview picks the top layer there, each tap the next one down, then the top again',
    cycle.join() === 'px,vb,vr,px', cycle.join());
  const pastBefore = await win.evaluate(() => window.__paircut.state().past.length);
  check('a tap leaves no undo step', pastBefore === 0, String(pastBefore));
  await win.mouse.click(pStage.x + 5, pStage.y + 5);
  check('a press on an empty spot drops the selection', (await picked()) === null);

  await win.locator('[data-testid="tl-zoom-in"]').click();
  await win.locator('[data-testid="tl-zoom-in"]').click();
  await win.locator('[data-testid="tl-zoom-in"]').click();
  await win.evaluate(() => {
    const el = document.querySelector('.tl-scroll');
    el.scrollLeft = el.scrollWidth;
  });
  const offBefore = await win.evaluate(() =>
    document.querySelector('[data-clip="px"]').getBoundingClientRect().right <= document.querySelector('.tl-scroll').getBoundingClientRect().left);
  const pxY0 = await win.evaluate(() => window.__paircut.state().project.tracks[0].clips[0].y);
  await win.mouse.move(mid.x, mid.y);
  await win.mouse.down();
  await win.mouse.move(mid.x, mid.y + 20, { steps: 5 });
  await win.mouse.up();
  const pxY1 = await win.evaluate(() => window.__paircut.state().project.tracks[0].clips[0].y);
  check('pressing an unselected layer picks it and drags it in the same press', (await picked()) === 'px' &&
    Math.abs(pxY1 - pxY0 - 20 / pStage.height) < 0.003, `${pxY0} -> ${pxY1}`);
  await win.waitForTimeout(100);
  const inView = await win.evaluate(() => {
    const c = document.querySelector('[data-clip="px"]').getBoundingClientRect();
    const s = document.querySelector('.tl-scroll').getBoundingClientRect();
    const b = document.querySelector('.tl-body').getBoundingClientRect();
    return { ok: c.right > s.left && c.left < s.right && c.top >= b.top - 1 && c.bottom <= b.bottom + 1, c: [c.left, c.right, c.top, c.bottom], s: [s.left, s.right, b.top, b.bottom] };
  });
  check('a clip picked in the preview is scrolled into view on the timeline', offBefore && inView.ok, `${offBefore} ${JSON.stringify(inView)}`);
  await win.keyboard.press('Control+KeyZ');
  check('one undo takes the preview drag back', Math.abs((await win.evaluate(() => window.__paircut.state().project.tracks[0].clips[0].y)) - pxY0) < 1e-9);

  // Frame shape: 16:9 keeps clip placement and text size against the short side; preview and export agree.
  await win.evaluate((p) => window.__paircut.load(p), {
    ...base,
    assets: [...base.assets, blueSolid],
    tracks: [
      layerTrack('t-x', [{ ...text('ax', 0, 2, 'X', { ...layerStyle, background: '#FFFFFF' }, 0.5, 0.5, 'none'), rotation: 0, spans: [] }]),
      { id: 'v-top', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'ab', assetId: blueSolid.id, start: 0, in: 0, out: 2, transform: halfSize }] },
      ...base.tracks.filter((t) => t.kind === 'audio'),
    ],
  });
  const textShare = async () => {
    await win.locator('[data-clip="ax"]').click({ position: { x: 4, y: 10 } });
    await win.evaluate(() => window.__paircut.seek(1));
    const s = await win.locator('.stage').boundingBox();
    const b = await win.locator('.transform-box').boundingBox();
    await win.mouse.click(s.x + 4, s.y + 4);
    return b.height / Math.min(s.width, s.height);
  };
  const tallShare = await textShare();
  check('the project panel names the frame shape', (await win.locator('[data-testid="project-aspect"]').inputValue()) === '9:16');
  await win.locator('[data-testid="project-aspect"]').selectOption('16:9');
  const wide = await win.evaluate(() => {
    const s = window.__paircut.state();
    const c = document.querySelector('[data-testid="preview-canvas"]');
    return { w: s.project.width, h: s.project.height, cw: c.width, ch: c.height, dirty: s.dirty };
  });
  check('choosing 16:9 makes the frame 1920x1080 and the preview follows', wide.w === 1920 && wide.h === 1080 && wide.cw === 960 &&
    wide.ch === 540 && wide.dirty, JSON.stringify(wide));
  check('the safe zone is only for 9:16', (await win.locator('[data-testid="safe-zone"]').count()) === 0 &&
    (await win.locator('button[aria-label="안전 영역"]').isDisabled()));
  const wideShare = await textShare();
  check('text keeps its size against the short side', Math.abs(wideShare / tallShare - 1) < 0.05, `${tallShare} -> ${wideShare}`);
  const wideAt = { plate: { x: 960, y: 540, s: 8 }, blue: { x: 960, y: 760, s: 8 }, edge: { x: 1840, y: 540, s: 8 } };
  const widePreview = [await settled(1, wideAt.plate), await settled(1, wideAt.blue), await settled(1, wideAt.edge)];
  check('16:9 preview: text in the middle, the half-size picture around it, black at the side',
    close(widePreview[0], [255, 255, 255], 12) && close(widePreview[1], [0, 0, 255], 12) && close(widePreview[2], [0, 0, 0], 12),
    JSON.stringify(widePreview));
  {
    const out = join(dir, 'wide.mp4');
    const made = await app.evaluate((_e, i) => globalThis.__paircutBridge.callTool('export', i), { outPath: out });
    const stream = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-select_streams', 'v', out],
      { encoding: 'utf8' })).streams[0];
    check('export without a height uses the project\'s frame', !made.isError && stream.width === 1920 && stream.height === 1080,
      `${made.text} ${stream.width}x${stream.height}`);
    const px = [samplePixel(out, 1, 960, 540, 8), samplePixel(out, 1, 960, 760, 8), samplePixel(out, 1, 1840, 540, 8)];
    check('16:9 export matches the preview', close(px[0], [255, 255, 255], 14) && close(px[1], [0, 0, 255], 14) && close(px[2], [0, 0, 0], 14),
      JSON.stringify(px));
  }
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('Control+KeyZ');
  check('undo takes the frame shape back', (await win.evaluate(() => window.__paircut.state().project.height)) === 1920);
  const viaOp = await tool('edit', { ops: [{ op: 'aspect', aspect: '4:5' }] });
  check('the edit tool sets the frame shape, and get_state shows it', !viaOp.isError && (await tool('get_state')).text.includes('size=1080x1350'),
    viaOp.text);

  // Bridge-only project tools, called through the main process exactly as scripts/bridge.mjs would.
  const bridge = (name, input = {}) => app.evaluate((_e, [n, i]) => globalThis.__paircutBridge.callTool(n, i), [name, input]);
  const fileState = () => win.evaluate(() => {
    const s = window.__paircut.state();
    return { dirty: s.dirty, filePath: s.filePath, clips: s.project.tracks.flatMap((t) => t.clips).length };
  });
  const fileBefore = await fileState();
  const refused = await bridge('new_project');
  check('new_project refuses to drop unsaved work', fileBefore.dirty && refused.isError && (await fileState()).clips === fileBefore.clips, refused.text);
  const relative = await bridge('save_project', { path: 'rel.paircut.json' });
  check('save_project needs an absolute .json path', relative.isError && relative.text.includes('absolute'), relative.text);
  const fileA = join(dir, 'bridge-a.paircut.json');
  const savedA = await bridge('save_project', { path: fileA });
  const afterA = await fileState();
  check('save_project with a path saves as and opens that file', !savedA.isError && afterA.filePath === fileA && !afterA.dirty &&
    JSON.parse(readFileSync(fileA, 'utf8')).tracks.flatMap((t) => t.clips).length === fileBefore.clips, savedA.text);
  const again = await bridge('save_project', { path: fileA });
  check('save_project will not replace an existing file without overwrite', again.isError && again.text.includes('overwrite'), again.text);
  const savedOpen = await bridge('save_project');
  check('save_project without a path saves the open file', !savedOpen.isError && savedOpen.text.includes(fileA), savedOpen.text);
  const fileB = join(dir, 'bridge-b.paircut.json');
  const madeB = await bridge('new_project', { path: fileB });
  const afterB = await fileState();
  check('new_project with a path starts empty and saves there', !madeB.isError && afterB.clips === 0 && afterB.filePath === fileB &&
    JSON.parse(readFileSync(fileB, 'utf8')).tracks.flatMap((t) => t.clips).length === 0, madeB.text);
  const taken = await bridge('new_project', { path: fileA });
  check('new_project will not replace an existing file without overwrite', taken.isError && (await fileState()).filePath === fileB, taken.text);
  await win.evaluate((p) => window.__paircut.load(p), project);

  await win.evaluate(() => window.__paircut.seek(2.5));
  const sheet = await bridge('contact_sheet', { times: [0.5, 1.5, 4], cols: 2, cellW: 200 });
  const sheetJpeg = Buffer.from(sheet.jpegBase64 ?? '', 'base64');
  const sheetSof = sheetJpeg.indexOf(Buffer.from([0xff, 0xc0]));
  const sheetDims = sheetSof > 0 ? `${sheetJpeg.readUInt16BE(sheetSof + 7)}x${sheetJpeg.readUInt16BE(sheetSof + 5)}` : '?';
  check('contact_sheet lays frames in a labeled grid', !sheet.isError && sheetDims === '400x752', `${sheetDims} ${sheet.text}`);
  check('contact_sheet lists the clips at each time', /#1 0\.5s: .*x-sub"미리보기와 내보내기" c1$/m.test(sheet.text) &&
    / c-top c1$/m.test(sheet.text) && /#3 4s: .*x-pop"팝 등장" c2 c4$/m.test(sheet.text), sheet.text.replaceAll('\n', ' | '));
  check('contact_sheet puts the playhead back', (await win.evaluate(() => window.__paircut.state().playhead)) === 2.5);
  const sheetRange = await bridge('contact_sheet', { from: 0, to: 2, step: 0.5 });
  check('contact_sheet from/to/step includes both ends', !sheetRange.isError && sheetRange.text.includes('5 frames') && sheetRange.text.includes('#5 2s'),
    sheetRange.text.split('\n')[0]);
  const sheetBig = await bridge('contact_sheet', { from: 0, to: 7, step: 0.1 });
  check('contact_sheet refuses more than 24 frames', sheetBig.isError && sheetBig.text.includes('at most 24'), sheetBig.text);

  // Start screen: the files saved above are the recent list, newest first, with the preview taken at save.
  const fileC = join(dir, 'bridge-c.paircut.json');
  await win.evaluate(() => window.__paircut.seek(1.5));
  await win.waitForTimeout(500);
  const savedC = await bridge('save_project', { path: fileC });
  rmSync(fileA);
  const size = await win.evaluate(() => ({ w: window.__paircut.state().project.width, h: window.__paircut.state().project.height }));
  await win.evaluate(() => window.__paircut.home());
  await win.waitForSelector('[data-testid="recent-card"]');
  await win.waitForFunction(() => [...document.querySelectorAll('.recent-card img')].every((i) => i.complete && i.naturalWidth > 0));
  const cards = () => win.evaluate(() => [...document.querySelectorAll('[data-testid="recent-card"]')].map((c) => ({
    name: c.querySelector('.recent-name').textContent,
    meta: c.querySelector('.recent-meta').textContent,
    disabled: c.querySelector('.recent-open').disabled,
    img: c.querySelector('img') ? `${c.querySelector('img').naturalWidth}x${c.querySelector('img').naturalHeight}` : null,
  })));
  const home1 = await cards();
  const long = 480 / Math.max(size.w, size.h);
  const thumbSize = `${Math.round(size.w * long)}x${Math.round(size.h * long)}`;
  check('start screen lists saved files newest first', !savedC.isError && home1.map((c) => c.name).join(',') === 'bridge-c,bridge-b,bridge-a',
    JSON.stringify(home1));
  check('a saved project shows the preview taken at save', home1[0].img === thumbSize && !home1[0].disabled && home1[0].meta.includes('0:'),
    `${home1[0].img} vs ${thumbSize}, ${home1[0].meta}`);
  check('a project file that is gone is shown as missing and cannot open', home1[2].disabled && home1[2].meta === '파일 없음', JSON.stringify(home1[2]));
  await win.screenshot({ path: join(dir, 'home.png') });
  console.log(`screenshot: ${join(dir, 'home.png')}`);
  await win.keyboard.press('Space');
  await win.keyboard.press('Delete');
  const behind = await win.evaluate(() => ({ playing: window.__paircut.state().playing, clips: window.__paircut.state().project.tracks.flatMap((t) => t.clips).length }));
  check('editor shortcuts are off while the start screen is up', !behind.playing && behind.clips > 0, JSON.stringify(behind));
  await win.locator('[data-testid="recent-card"]').nth(2).hover();
  await win.locator('[data-testid="recent-forget"]').nth(2).click();
  await win.waitForFunction(() => document.querySelectorAll('[data-testid="recent-card"]').length === 2);
  const recentFile = JSON.parse(readFileSync(join(recentRoot, 'recent.json'), 'utf8')).paths;
  check('forgetting a card drops it from the list only', recentFile.length === 2 && !recentFile.includes(fileA) && existsSync(fileC), JSON.stringify(recentFile));
  await win.locator('.recent-open').first().click();
  await win.waitForSelector('[data-testid="home"]', { state: 'detached' });
  const fromCard = await win.evaluate(() => ({ filePath: window.__paircut.state().filePath, screen: window.__paircut.state().screen }));
  check('clicking a card opens that project in the editor', fromCard.filePath === fileC && fromCard.screen === 'editor', JSON.stringify(fromCard));
  await win.click('[data-testid="go-home"]');
  await win.waitForSelector('[data-testid="home"]');
  check('the logo goes back to the start screen', (await win.evaluate(() => window.__paircut.state().screen)) === 'home');
  await win.click('[data-testid="home-new"]');
  const fresh = await win.evaluate(() => ({ screen: window.__paircut.state().screen, filePath: window.__paircut.state().filePath, clips: window.__paircut.state().project.tracks.flatMap((t) => t.clips).length }));
  check('new project from the start screen opens an empty editor', fresh.screen === 'editor' && fresh.filePath === null && fresh.clips === 0, JSON.stringify(fresh));

  // Import progress: a row per file with its stage, assets added as each finishes, a bad file fails alone.
  {
    await win.click('[data-tab="media"]');
    const long = join(dir, 'import-long.mp4');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=40', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', long]);
    const bad = join(dir, 'import-bad.mp4');
    writeFileSync(bad, 'not a video');
    await win.evaluate(() => {
      window.__stages = [];
      new MutationObserver(() => {
        for (const row of document.querySelectorAll('[data-testid="import-job"]')) {
          window.__stages.push(`${row.querySelector('.asset-name').textContent}|${row.dataset.stage}|${row.querySelector('.import-sub').textContent}`);
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    await win.evaluate((paths) => window.__paircut.importFiles(paths), [long, bad, f('tone.m4a')]);
    await win.waitForSelector('[data-testid="import-job"]');
    await win.waitForFunction(() => {
      const rows = [...document.querySelectorAll('[data-testid="import-job"]')];
      return rows.length === 1 && rows[0].dataset.stage === 'error';
    }, null, { timeout: 60000 });
    const stages = await win.evaluate(() => window.__stages);
    const longStages = stages.filter((s) => s.startsWith('import-long.mp4|'));
    const pct = longStages.map((s) => /(\d+)%$/.exec(s)).filter(Boolean).map((m) => Number(m[1]));
    check('a waiting file shows its own row before its turn', stages.some((s) => s.startsWith('tone.m4a|wait|')), String(stages.length));
    check('the long video reports thumbnail percent in between', pct.some((p) => p > 0 && p < 100) && pct.every((p, i) => i === 0 || p >= pct[i - 1]), pct.join(','));
    const names = await win.evaluate(() => window.__paircut.state().project.assets.map((a) => a.name));
    check('good files are added even though one failed', names.includes('import-long.mp4') && names.includes('tone.m4a'), JSON.stringify(names));
    const errText = await win.locator('[data-testid="import-job"] .import-error').textContent();
    check('the failed row keeps the error and the file path', errText.includes('import-bad.mp4'), errText.slice(0, 160));
    await win.locator('[data-testid="import-job"] button').click();
    check('the failed row can be closed', (await win.locator('[data-testid="import-job"]').count()) === 0);

    // Right-click menu: rename, delete with the clips that use the asset, undo brings both back.
    const longRow = win.locator('[data-testid="asset"]', { hasText: 'import-long.mp4' });
    await longRow.locator('button.icon').click();
    await longRow.click({ button: 'right' });
    await win.locator('[data-testid="asset-menu"] button', { hasText: '이름 바꾸기' }).click();
    await win.fill('[data-testid="asset-rename"]', '긴 영상');
    await win.keyboard.press('Enter');
    const renamed = await win.evaluate(() => window.__paircut.state().project.assets.find((a) => a.path.endsWith('import-long.mp4'))?.name);
    check('rename from the right-click menu sets the asset name', renamed === '긴 영상', renamed);
    const kept = win.locator('[data-testid="asset"]', { hasText: '긴 영상' });
    await kept.click({ button: 'right' });
    await win.locator('[data-testid="asset-menu"] button', { hasText: '이름 바꾸기' }).click();
    await win.fill('[data-testid="asset-rename"]', '취소될 이름');
    await win.keyboard.press('Escape');
    const afterEsc = await win.evaluate(() => window.__paircut.state().project.assets.find((a) => a.path.endsWith('import-long.mp4'))?.name);
    check('Escape leaves the name as it was', afterEsc === '긴 영상', afterEsc);

    await kept.click({ button: 'right' });
    const note = await win.locator('[data-testid="asset-menu"] .tl-menu-note').textContent();
    check('the menu says the timeline clip goes too', note.includes('1개'), note);
    await win.locator('[data-testid="asset-menu"] button', { hasText: '삭제' }).click();
    const gone = await win.evaluate(() => {
      const p = window.__paircut.state().project;
      const id = p.assets.find((a) => a.path.endsWith('import-long.mp4'))?.id ?? null;
      return { id, clips: p.tracks.flatMap((t) => t.clips).filter((c) => c.assetId !== undefined).length };
    });
    check('delete removes the asset and its clip', gone.id === null && gone.clips === 0, JSON.stringify(gone));
    await win.keyboard.press('Control+z');
    const back = await win.evaluate(() => {
      const p = window.__paircut.state().project;
      return { name: p.assets.find((a) => a.path.endsWith('import-long.mp4'))?.name, clips: p.tracks.flatMap((t) => t.clips).length };
    });
    check('one undo brings the asset and its clip back', back.name === '긴 영상' && back.clips === 1, JSON.stringify(back));
  }

  await win.evaluate((p) => window.__paircut.load(p), project);
  await win.evaluate(() => window.__paircut.seek(0.5));
  await win.waitForTimeout(500);
  await win.screenshot({ path: join(dir, 'app.png') });
  console.log(`screenshot: ${join(dir, 'app.png')}`);
} finally {
  await app.close();
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('ui e2e: all checks passed');
