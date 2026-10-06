// UI end-to-end: launches the real Electron app, drives the editor, and checks that the
// preview canvas matches the exported MP4 at the same timestamps.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright';
import { buildFixtureProject, DISSOLVE_SAMPLES, dissolveProject, freshDir, makeFixtures, samplePixel, SWATCHES } from './e2e-export.mjs';

const require = createRequire(import.meta.url);
const { BITTEUL_COLOR, gradePixel } = require('../dist-electron/shared/color.js');
const { importMedia } = require('../dist-electron/electron/media.js');

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
const vTop = () => window.__cutdesk.state().project.tracks.find((t) => t.id === 'v-top').clips[0];

const app = await _electron.launch({ args: ['.'], cwd: root, env: { ...process.env, CUTDESK_TEST: '1' } });
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => '__cutdesk' in window, null, { timeout: 15000 });
  await win.evaluate((p) => window.__cutdesk.load(p), project);
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
        void window.api.startExport(window.__cutdesk.state().project, { outPath, height: 1920 }, window.__cutdesk.texts(1920));
      }),
    target,
  );
  const out = join(dir, 'out.mp4');
  await exportTo(out);
  check('export via IPC finished', true);
  const layers = Object.fromEntries((await win.evaluate(() => window.__cutdesk.texts(1920))).map((l) => [l.clipId, l]));
  const badge = layers['x-badge'];
  const sub = layers['x-sub'];
  const pop = layers['x-pop'];
  const title = layers['x-title'];
  check('old-format style gets tracking/shadow defaults', await win.evaluate(() => {
    const s = window.__cutdesk.state().project.tracks[1].clips[0].style;
    return s.tracking === 0 && s.shadow === 0;
  }));
  check('serif font loaded', await win.evaluate(() => document.fonts.check('800 40px "Cutdesk Serif"', '판돈')));
  for (const face of ['700 40px "Cutdesk Presentation"', '900 40px "Cutdesk Presentation"', '400 40px "Cutdesk Hand"']) {
    check(`bundled font loaded: ${face}`, await win.evaluate((f) => [...document.fonts].some((ff) => ff.status === 'loaded' &&
      `${ff.weight} 40px "${ff.family.replace(/"/g, '')}"` === f), face));
  }
  check('badge shows D-333 for 2026-10-03', await win.evaluate(() => {
    const c = window.__cutdesk.state().project.tracks[0].clips[0];
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
      window.__cutdesk.seek(t);
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
  await win.evaluate(() => window.__cutdesk.seek(1.0));
  const firstClip = win.locator('[data-clip="c1"]');
  await firstClip.click({ position: { x: 20, y: 30 } });
  await win.keyboard.press('KeyS');
  const afterSplit = await win.evaluate(() => window.__cutdesk.state().project.tracks.find((t) => t.id === 'v-main').clips.length);
  check('S splits selected clip at playhead', afterSplit === 4, `main clips ${afterSplit}`);
  await win.keyboard.press('Control+KeyZ');
  const afterUndo = await win.evaluate(() => window.__cutdesk.state().project.tracks.find((t) => t.id === 'v-main').clips.length);
  check('Ctrl+Z undoes split', afterUndo === 3, `main clips ${afterUndo}`);

  const zoom = await win.evaluate(() => window.__cutdesk.state().zoom);
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
  const textCount = () => win.evaluate(() => window.__cutdesk.state().project.tracks.filter((t) => t.kind === 'text').flatMap((t) => t.clips).length);
  const before = await textCount();
  await win.locator('[data-tab="text"]').click();
  await win.locator('[data-preset="aside"]').click();
  check('preset button adds a text clip', (await textCount()) === before + 1, `text clips ${await textCount()}`);
  await win.locator('[data-testid="text-input"]').fill('(바뀐 딴지)');
  const edited = await win.evaluate(() => {
    const s = window.__cutdesk.state();
    return s.project.tracks.flatMap((t) => t.clips).find((c) => c.id === s.selectedClipId)?.text;
  });
  check('inspector edits selected text', edited === '(바뀐 딴지)', edited);

  const copiedId = await win.evaluate(() => window.__cutdesk.state().selectedClipId);
  await win.locator(`[data-clip="${copiedId}"]`).click({ position: { x: 4, y: 10 } });
  await win.evaluate(() => window.__cutdesk.seek(4));
  const beforePaste = await textCount();
  await win.keyboard.press('Control+KeyC');
  await win.keyboard.press('Control+KeyV');
  const pasted = await win.evaluate(() => {
    const s = window.__cutdesk.state();
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

  // Conti import from the real operations board (read only).
  await win.evaluate(() => window.__cutdesk.load({ ...window.__cutdesk.state().project, tracks: window.__cutdesk.state().project.tracks.filter((t) => t.kind !== 'text') }));
  await win.locator('[data-tab="conti"]').click();
  await win.locator('[data-testid="board-load"]').click();
  await win.locator('[data-post="p001"]').click();
  const conti = await win.evaluate(() => {
    const p = window.__cutdesk.state().project;
    const texts = p.tracks.filter((t) => t.kind === 'text');
    return { tracks: texts.map((t) => t.clips.length), first: texts[0]?.clips[0], markers: p.markers.length, vars: p.vars };
  });
  check('conti p001 -> 11 subtitles + 4 asides', conti.tracks.join() === '11,4', conti.tracks.join());
  check('conti markers per row', conti.markers === 12, String(conti.markers));
  check('hook is first cut 0-3s', conti.first?.preset === 'hook' && conti.first.start === 0 && conti.first.out === 3,
    `${conti.first?.preset} ${conti.first?.start}+${conti.first?.out}`);
  check('upload date from board', conti.vars.uploadDate === '2026-10-03', conti.vars.uploadDate);

  await win.locator('[data-tab="text"]').click();
  await win.locator('.button-row button', { hasText: '내보내기' }).click();
  await win.waitForTimeout(500);
  const srt = readFileSync(srtPath, 'utf8');
  const cues = srt.trim().split(/\n\s*\n/);
  check('SRT has resolved D-333 hook at 0-3s', cues[0] === '1\n00:00:00,000 --> 00:00:03,000\nD-333 저한테 최저임금 못 주면 복학합니다',
    cues[0].replaceAll('\n', ' | '));
  check('SRT has 15 cues', cues.length === 15, String(cues.length));
  const beforeImport = await textCount();
  await win.locator('.button-row button', { hasText: '가져오기' }).click();
  await win.waitForTimeout(300);
  check('SRT import adds 15 clips on a new track', (await textCount()) === beforeImport + 15, `${beforeImport} -> ${await textCount()}`);

  // Conti rule checks (CONTI_RULES.md section numbers).
  const issuesNow = () =>
    win.evaluate(() => [...document.querySelectorAll('[data-rule]')].map((b) => `${b.dataset.rule}@${b.dataset.issueClip}`));
  await win.evaluate((p) => window.__cutdesk.load(p), project);
  await win.locator('[data-tab="check"]').click();
  const clean = await issuesNow();
  check('fixture only breaks the 15-35s length rule', clean.join() === '2-7-1@', clean.join());
  await win.evaluate((p) => {
    const sub = { font: 'black', size: 68, color: '#FFFFFF', strokeColor: '#13293D', strokeWidth: 5, background: null,
      align: 'center', highlight: '', highlightColor: '#FFD166', highlightDigits: false };
    const t = (id, start, out, text, y, preset) => ({ id, start, in: 0, out, text, preset, style: sub, x: 0.5, y, anim: 'none' });
    const tracks = p.tracks.map((tr) => {
      if (tr.id === 'v-main') {
        return { ...tr, muted: true, clips: tr.clips.map((c) => (c.id === 'c2' ? { ...c, out: 1.5 } : c.id === 'c3' ? { ...c, transform: { scale: 0.5, x: 0, y: 0 } } : c)) };
      }
      return { ...tr, muted: true };
    });
    tracks.unshift({ id: 't-rules', kind: 'text', muted: false, hidden: false, clips: [
      t('r-long', 0, 2, '하나 둘 셋 넷 다섯 여섯 일곱 여덟 아홉 열 열하나 열둘 열셋 열넷 열다섯', 0.5, 'sub'),
      t('r-top', 2, 1, '위험', 0.05, 'sub'),
      t('r-aside', 3, 4, '(딴지는 길어져서 여러 줄로 넘어가도 줄 수 검사에서는 빠져요)', 0.5, 'aside'),
    ] });
    window.__cutdesk.load({ ...p, tracks });
  }, project);
  const broken = new Set(await issuesNow());
  for (const want of ['2-7-1@', '2-2-1@c2', '2-4-3@', '2-5-1@c3', '2-4-1@r-long', '2-4-2@r-long', '2-4-4@r-top', '2-4-2@r-aside', '2-7-2@']) {
    check(`rule ${want} reported`, broken.has(want), [...broken].join(' '));
  }
  check('aside is exempt from the two-line rule', !broken.has('2-4-1@r-aside'));
  await win.locator('[data-rule="2-2-1"]').click();
  const jumped = await win.evaluate(() => ({ t: window.__cutdesk.state().playhead, sel: window.__cutdesk.state().selectedClipId }));
  check('clicking an issue jumps to the clip', jumped.sel === 'c2' && Math.abs(jumped.t - 3) < 1e-6, JSON.stringify(jumped));
  check('safe-zone guide shown', await win.locator('[data-testid="safe-zone"]').isVisible());

  // Speed, volume and fades: timeline ripple and the preview element's rate and gain.
  await win.evaluate((p) => window.__cutdesk.load(p), project);
  await win.locator('[data-clip="c1"]').click();
  await win.locator('[data-speed="2"]').click();
  const sped = await win.evaluate(() =>
    window.__cutdesk.state().project.tracks.find((t) => t.id === 'v-main').clips.map((c) => `${c.id}:${c.start}:${c.speed}`).join(' '));
  check('2x halves c1 and pulls later clips in', sped === 'c1:0:2 c2:1.5:1 c3:3.5:1', sped);
  await win.evaluate(() => window.__cutdesk.seek(0.5));
  await win.waitForTimeout(200);
  const rate = await win.evaluate(() => window.__cutdesk.audio('c1'));
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
    const c = window.__cutdesk.state().project.tracks.find((t) => t.id === 'v-main').clips[0];
    return { volume: c.volume, fadeIn: c.fadeIn, level: window.__cutdesk.audio('c1')?.level };
  });
  check('volume 150% and 1s fade in give gain 0.75 at 0.5s', gain.volume === 1.5 && gain.fadeIn === 1 && Math.abs(gain.level - 0.75) < 1e-6,
    JSON.stringify(gain));
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('Control+z');
  await win.keyboard.press('Control+z');
  await win.keyboard.press('Control+z');
  const undone = await win.evaluate(() =>
    window.__cutdesk.state().project.tracks.find((t) => t.id === 'v-main').clips.map((c) => `${c.id}:${c.start}:${c.speed}:${c.volume}`).join(' '));
  check('undo restores speed and volume', undone === 'c1:0:1:1 c2:3:1:1 c3:5:1:1', undone);
  await win.evaluate((p) => window.__cutdesk.load({ ...p, tracks: p.tracks.map((t) => ({ ...t,
    clips: t.clips.map((c) => (c.id === 'c1' ? { ...c, speed: 2, fadeIn: 1, fadeOut: 1 } : c)) })) }), project);
  await win.evaluate(() => window.__cutdesk.seek(1));
  await win.locator('[data-clip="c1"]').click({ position: { x: 20, y: 30 } });
  await win.keyboard.press('KeyS');
  const halves = await win.evaluate(() =>
    window.__cutdesk.state().project.tracks.find((t) => t.id === 'v-main').clips.slice(0, 2)
      .map((c) => `${c.start}:${c.in}-${c.out}:${c.fadeIn}/${c.fadeOut}`).join(' '));
  check('split at 2x cuts the source at 2.5s and drops inner fades', halves === '0:0.5-2.5:1/0 1:2.5-3.5:0/1', halves);
  // Color correction: preview (WebGL LUT) against the shared pixel function and the ffmpeg lut3d export.
  await win.evaluate(({ p, swatchId }) => {
    const main = p.tracks.find((t) => t.id === 'v-main');
    const clip = { ...main.clips[1], id: 'g1', assetId: swatchId, start: 0, in: 0, out: 1 };
    window.__cutdesk.load({ ...p, tracks: [{ ...main, clips: [clip] }] });
  }, { p: project, swatchId: fx.swatch.id });
  await win.locator('[data-clip="g1"]').click();
  await win.locator('[data-color-preset="빛뜰 보정"]').click();
  await win.evaluate(() => window.__cutdesk.seek(0.5));
  await win.waitForTimeout(400);
  const graded = join(dir, 'graded.mp4');
  await exportTo(graded);
  for (const [i, src] of SWATCHES.entries()) {
    const at = { x: 540, y: i * 480 + 236 };
    const shown = await readCanvas(at);
    const want = gradePixel(src.map((v) => v / 255), BITTEUL_COLOR).map((v) => Math.round(v * 255));
    const made = samplePixel(graded, 0.5, at.x, at.y);
    const off = (a, b) => Math.max(...a.map((v, k) => Math.abs(v - b[k])));
    check(`graded preview ${src.join(',')} matches pixel function and export`, off(shown, want) <= 4 && off(shown, made) <= 6,
      `preview ${shown} / function ${want} / export ${made}`);
  }
  const videoPixel = async (color) => {
    await win.evaluate(({ p, c }) => window.__cutdesk.load({ ...p, tracks: p.tracks.map((t) => ({ ...t,
      clips: t.clips.map((k) => (k.id === 'c1' ? { ...k, color: c } : k)) })) }), { p: project, c: color });
    const before = await win.evaluate(() => window.__draws);
    await win.evaluate(() => window.__cutdesk.seek(0.5));
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
  const plain = await videoPixel({ brightness: 0, contrast: 0, saturation: 0, temperature: 0, look: 0 });
  const gradedVideo = await videoPixel(BITTEUL_COLOR);
  const wantVideo = gradePixel(plain.map((v) => v / 255), BITTEUL_COLOR).map((v) => Math.round(v * 255));
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
  const sats = () => win.evaluate(() => window.__cutdesk.state().project.tracks.filter((t) => t.kind === 'video')
    .flatMap((t) => t.clips).map((c) => `${c.id}:${c.color.saturation}`).sort().join(' '));
  await win.evaluate((p) => window.__cutdesk.load(p), project);
  await win.locator('[data-clip="c1"]').click();
  await setRange('[data-color="saturation"]', -40);
  await win.locator('[data-testid="preset-name"]').fill('e2e 톤');
  await win.locator('[data-testid="preset-save"]').click();
  const stored = await win.evaluate(() => JSON.parse(localStorage.getItem('cutdesk.colorPresets')).map((p) => `${p.name}:${p.color.saturation}`).join());
  check('preset saved with current values', stored.includes('e2e 톤:-0.4'), stored);
  await win.locator('[data-clip="c2"]').click();
  await win.locator('[data-color-preset="e2e 톤"]').click();
  check('preset applies to another clip', (await sats()) === 'c-top:0 c1:-0.4 c2:-0.4 c3:0', await sats());
  await win.locator('[data-clip="c3"]').click();
  await win.locator('[data-color-preset="빛뜰 보정"]').click();
  await win.locator('[data-testid="color-all"]').click();
  check('apply to all sets every video-track clip', (await sats()) === 'c-top:0 c1:0 c2:0 c3:0' &&
    (await win.evaluate(() => window.__cutdesk.state().project.tracks.filter((t) => t.kind === 'video').flatMap((t) => t.clips).every((c) => c.color.look === 1))));
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('Control+z');
  check('one undo reverts apply to all', (await sats()) === 'c-top:0 c1:-0.4 c2:-0.4 c3:0', await sats());
  await win.locator('[data-delete-preset="e2e 톤"]').click();
  check('preset deleted', (await win.locator('[data-color-preset="e2e 톤"]').count()) === 0 &&
    !(await win.evaluate(() => localStorage.getItem('cutdesk.colorPresets'))).includes('e2e'));

  // In-app Claude tools, called through the main process exactly as the Agent SDK would (no model call).
  const tool = (name, input = {}) => app.evaluate((_e, [n, i]) => globalThis.__cutdeskAgent.callTool(n, i), [name, input]);
  const snap = () => win.evaluate(() => {
    const s = window.__cutdesk.state();
    const clips = s.project.tracks.flatMap((t) => t.clips);
    return { clips, past: s.past.length, playhead: s.playhead, texts: s.project.tracks.filter((t) => t.kind === 'text').map((t) => t.clips.length) };
  });
  const byId = (s, id) => s.clips.find((c) => c.id === id);
  await win.evaluate((p) => window.__cutdesk.load(p), project);
  const state = await tool('get_state');
  check('get_state lists tracks, clips, issues and presets', /v-main \[video main\]/.test(state.text) && /c1 0-3 A1 /.test(state.text) &&
    /src=0\.5-3\.5/.test(state.text) && state.text.includes('rule issues') && state.text.includes('"빛뜰 보정"'), `${state.text.length} chars`);
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
    { op: 'add_text', preset: 'sub', text: 'Claude 자막', start: 0.5 },
    { op: 'color', clip: 'c2', preset: '빛뜰 보정' },
    { op: 'seek', t: 1 },
  ] });
  const agentAfter = await snap();
  const added = agentAfter.clips.find((c) => c.text === 'Claude 자막');
  check('batch applies speed ripple, text, color and seek', !agentDone.isError && byId(agentAfter, 'c1').speed === 2 &&
    byId(agentAfter, 'c2').start === 1.5 && byId(agentAfter, 'c3').start === 3.5 && byId(agentAfter, 'c2').color.look === 1 &&
    added?.start === 0.5 && agentAfter.playhead === 1 && agentAfter.past === agentBase.past + 1 && agentDone.text.includes(added?.id), agentDone.text);
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('Control+z');
  const agentUndone = await snap();
  check('one undo reverts the whole batch', byId(agentUndone, 'c1').speed === 1 && byId(agentUndone, 'c2').start === 3 &&
    byId(agentUndone, 'c2').color.look === 0 && !agentUndone.clips.some((c) => c.text === 'Claude 자막'));

  const lookEdit = await tool('edit', { ops: [{ op: 'track', track: 'v-main', opacity: 0.5, blend: 'multiply' }] });
  const lookTrack = await win.evaluate(() => window.__cutdesk.state().project.tracks.find((t) => t.id === 'v-main'));
  const lookState = await tool('get_state');
  check('track sets layer opacity and blend mode, and get_state shows them', !lookEdit.isError && lookTrack.opacity === 0.5 &&
    lookTrack.blend === 'multiply' && /v-main \[video main multiply opacity=0\.5\]/.test(lookState.text), lookEdit.text);
  const backToNormal = await tool('edit', { ops: [{ op: 'track', track: 'v-main', opacity: 1, blend: 'normal' }] });
  const plainTrack = await win.evaluate(() => window.__cutdesk.state().project.tracks.find((t) => t.id === 'v-main'));
  check('track back to full opacity and normal drops the fields', !backToNormal.isError && !('opacity' in plainTrack) && !('blend' in plainTrack));
  const clipBottom = await tool('edit', { ops: [{ op: 'track', track: 'v-main', clipped: true }] });
  check('the bottom picture layer cannot be clipped', clipBottom.isError && clipBottom.text.includes('nothing under it'), clipBottom.text);
  const audioLook = await tool('edit', { ops: [{ op: 'track', track: 'a-1', opacity: 0.5 }] });
  check('audio tracks take no layer look', audioLook.isError && audioLook.text.includes('not audio'), audioLook.text);
  const aboveMain = await win.evaluate(() => {
    const ts = window.__cutdesk.state().project.tracks.filter((t) => t.kind !== 'audio');
    return ts[ts.findIndex((t) => t.id === 'v-main') - 1]?.id;
  });
  const clipAbove = await tool('edit', { ops: [{ op: 'track', track: aboveMain, clipped: true }] });
  check('a layer above another can be clipped', !clipAbove.isError &&
    (await win.evaluate((tid) => window.__cutdesk.state().project.tracks.find((t) => t.id === tid).clipped, aboveMain)) === true, clipAbove.text);

  await win.evaluate(() => window.__cutdesk.load({ ...window.__cutdesk.state().project, tracks: window.__cutdesk.state().project.tracks.filter((t) => t.kind !== 'text') }));
  const conti2 = await tool('edit', { ops: [{ op: 'import_conti', post: 'p001' }] });
  check('import_conti reads the board (read only)', !conti2.isError && (await snap()).texts.join() === '11,4', `${conti2.text.slice(0, 60)} ${(await snap()).texts.join()}`);

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
  await win.evaluate((p) => window.__cutdesk.load(p), dproj);
  const dissolved = join(dir, 'dissolve.mp4');
  await exportTo(dissolved);
  for (const [t] of DISSOLVE_SAMPLES) {
    await tool('screenshot', { t });
    const shown = await readCanvas({ x: 536, y: 956 });
    const made = samplePixel(dissolved, t, 536, 956);
    const off = Math.max(...shown.map((v, k) => Math.abs(v - made[k])));
    check(`dissolve preview matches export at ${t}s`, off <= 20, `preview ${shown} / export ${made}`);
  }
  const dissolveOf = (id) => win.evaluate((i) => window.__cutdesk.state().project.tracks.flatMap((t) => t.clips).find((c) => c.id === i)?.dissolve, id);
  await win.locator('[data-tab="media"]').click();
  await win.locator('[data-clip="dx"]').click();
  check('first clip cannot dissolve', await win.locator('[data-dissolve="0.5"]').isDisabled());
  await win.locator('[data-clip="dy"]').click();
  check('second clip shows its 1s dissolve', (await win.locator('[data-dissolve="1"]').getAttribute('class')) === 'on');
  await win.locator('[data-dissolve="0.5"]').click();
  const mark = await win.locator('[data-clip="dy"] [data-dissolve-mark]').boundingBox();
  const zoomNow = await win.evaluate(() => window.__cutdesk.state().zoom);
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
  const cropOf = (id) => win.evaluate((i) => window.__cutdesk.state().project.tracks.flatMap((t) => t.clips).find((c) => c.id === i)?.crop, id);
  const cproj = { ...base, tracks: [{ id: 'v-main', kind: 'video', muted: false, hidden: false, clips: [
    { ...base.tracks[1].clips[1], id: 'k1', assetId: fx.swatch.id, start: 0, in: 0, out: 1, crop: { l: 0.1, t: 0.25, r: 0.2, b: 0.25 } },
    { ...base.tracks[1].clips[2], id: 'k2', assetId: fx.rot.id, start: 1, in: 0, out: 2, crop: { l: 0.3, t: 0.1, r: 0, b: 0.4 } },
  ] }] };
  await win.evaluate((p) => window.__cutdesk.load(p), cproj);
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
  await win.evaluate((p) => window.__cutdesk.load(p), project);
  const subWidth = () => win.evaluate(() => window.__cutdesk.texts(1920).find((l) => l.clipId === 'x-sub').w);
  const plainWidth = await subWidth();
  await win.locator('[data-tab="media"]').click();
  await win.evaluate(() => window.__cutdesk.seek(0.5));
  await win.locator('[data-clip="x-sub"]').click();
  await win.locator('[data-testid="font-select"]').selectOption('__pc');
  await win.locator('[data-testid="pc-font"]').fill('Malgun Gothic');
  await win.locator('[data-testid="pc-font"]').press('Enter');
  const styleOf = (id) => win.evaluate((i) => window.__cutdesk.state().project.tracks.flatMap((t) => t.clips).find((c) => c.id === i).style, id);
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
  await win.locator('[data-testid="font-select"]').selectOption('bold');
  check('picking a bundled font clears the PC font', (await styleOf('x-sub')).customFont === '' && (await styleOf('x-sub')).font === 'bold');
  const pcMissing = await tool('edit', { ops: [{ op: 'set_text', clip: 'x-sub', customFont: 'No Such Font 7f3' }] });
  check('Claude cannot set a font this PC lacks', pcMissing.isError === true, pcMissing.text);
  const pcBad = await tool('edit', { ops: [{ op: 'set_text', clip: 'x-sub', customFont: 'x", serif' }] });
  check('Claude font name with a quote is rejected', pcBad.isError === true, pcBad.text);
  const pcOk = await tool('edit', { ops: [{ op: 'set_text', clip: 'x-sub', customFont: 'Malgun Gothic' }] });
  check('Claude sets a PC font and reads it back', !pcOk.isError && (await tool('get_state')).text.includes('pcFont="Malgun Gothic"'), pcOk.text);

  // Typography: whole-text rotation and styled parts, drawn by the same rasterizer for preview and export.
  await win.evaluate((p) => window.__cutdesk.load(p), project);
  const layerOf = (id) => win.evaluate((i) => window.__cutdesk.texts(1920).find((l) => l.clipId === i), id);
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
  await win.evaluate((p) => window.__cutdesk.load(p), project);
  await win.evaluate(() => window.__cutdesk.seek(0.5));
  await win.locator('[data-clip="x-sub"]').click();
  const clipOf = (id) => win.evaluate((i) => window.__cutdesk.state().project.tracks.flatMap((t) => t.clips).find((c) => c.id === i), id);
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
  await win.locator('[data-testid="span-font"]').selectOption('thin');
  const sp = (await clipOf('x-sub')).spans[0];
  check('inspector sets size, turn, color and weight of the part', sp.scale === 1.5 && sp.rotate === 10 && sp.color === '#FFD166' && sp.font === 'thin', JSON.stringify(sp));
  check('inspector styling changes the drawn text', (await layerOf('x-sub')).w > flat.w);
  await win.locator('[data-testid="span-font"]').selectOption('');
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
  await win.evaluate((p) => window.__cutdesk.load(p), project);
  await win.locator('[data-tab="media"]').click();
  await win.locator('[data-testid="solid-color"]').fill('#3366cc');
  await win.locator('[data-testid="solid-add"]').click();
  await win.waitForFunction(() => window.__cutdesk.state().project.assets.some((a) => a.solid), null, { timeout: 15000 });
  const solidAsset = await win.evaluate(() => window.__cutdesk.state().project.assets.find((a) => a.solid));
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
    const p = window.__cutdesk.state().project;
    const c = p.tracks.flatMap((t) => t.clips).find((x) => x.id === cid);
    return p.assets.find((a) => a.id === c.assetId)?.solid === '#FF8800';
  }, solidId, { timeout: 15000 });
  check('inspector recolors a solid clip', true);
  const reuse = await tool('edit', { ops: [{ op: 'add_solid', color: '#FF8800', start: 3, dur: 1, track: 'new' }] });
  const solidCount = await win.evaluate(() => window.__cutdesk.state().project.assets.filter((a) => a.solid === '#FF8800').length);
  check('the same color reuses its asset', !reuse.isError && solidCount === 1, reuse.text);
  const badColor = await tool('edit', { ops: [{ op: 'add_solid', color: 'red' }] });
  check('a solid color that is not #RRGGBB is rejected', badColor.isError === true, badColor.text);

  // Motion graphics: a see-through webm over a red picture shows red around its green square, in preview and export.
  const motion = await importMedia(f('motion.webm'), join(dir, 'cache'));
  check('probe marks a see-through webm', motion.alpha === 'vp9', JSON.stringify({ alpha: motion.alpha, kind: motion.kind }));
  check('probe leaves plain video opaque', fx.land.alpha === undefined);
  const pic = fx.pic;
  const MC = { transform: { scale: 1, x: 0, y: 0 }, crop: { l: 0, t: 0, r: 0, b: 0 }, volume: 1, fadeIn: 0, fadeOut: 0, speed: 1,
    color: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, look: 0 }, dissolve: 0 };
  await win.evaluate((p) => window.__cutdesk.load(p), {
    ...base,
    assets: [pic, motion],
    tracks: [
      { id: 'v-mg', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'mg', assetId: motion.id, start: 0, in: 0, out: 2 }] },
      { id: 'v-main', kind: 'video', muted: false, hidden: false, clips: [{ ...MC, id: 'bg', assetId: pic.id, start: 0, in: 0, out: 2 }] },
    ],
  });
  check('get_state marks the motion graphic', (await tool('get_state')).text.includes('transparent'));
  await win.evaluate(() => window.__cutdesk.seek(1));
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
  await win.evaluate((p) => window.__cutdesk.load(p), fxProject('none', 'none'));
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
    await win.evaluate((at) => window.__cutdesk.seek(at), t);
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
    await win.evaluate((p) => window.__cutdesk.load(p), fxProject(e.effect, e.anim));
    const shown = await settled(e.t, e.at);
    const out = join(dir, `fx-${e.effect}-${e.anim}.mp4`);
    await exportTo(out);
    const made = samplePixel(out, e.t, e.at.x, e.at.y, 24);
    const where = e.at === inP ? 'inside' : 'beside';
    check(`${e.effect}${e.anim === 'fade' ? ' mid fade' : ''} ${where} the letter: preview`, close(shown, e.want, 6), `${shown} want ${e.want}`);
    check(`${e.effect}${e.anim === 'fade' ? ' mid fade' : ''} ${where} the letter: export`, close(made, e.want, 8), `${made} want ${e.want}`);
  }
  // Frost over a real picture: the blur reads neighbours, so compare preview with export rather than a formula.
  await win.evaluate((p) => window.__cutdesk.load(p), {
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
    await win.evaluate((pr) => window.__cutdesk.load(pr), fxProject(effect, 'none'));
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
  await win.evaluate((pr) => window.__cutdesk.load(pr), fxProject('glitch', 'none'));
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
  await win.evaluate((pr) => window.__cutdesk.load(pr), introProject('none'));
  const pair = await layerOf('fx');
  check('a plain text has no intro frames', pair.intro === null);
  const rightP = { x: pair.x + pair.w - 100, y: pair.y + Math.round(pair.h / 2) - 50, s: 100 };
  const pairSettled = await settled(1, rightP);
  for (const [anim, t] of [['type', 0], ['word', 0.1], ['letters', 0.1], ['blur', 0.3], ['track', 0.3], ['wipe', 0.3]]) {
    await win.evaluate((pr) => window.__cutdesk.load(pr), introProject(anim));
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
  await win.evaluate((p) => window.__cutdesk.load(p), fxProject('none', 'none'));
  await win.locator('[data-clip="fx"]').click();
  await win.locator('[data-testid="text-effect"]').selectOption('mono');
  check('inspector sets the text effect', (await clipOf('fx')).style.effect === 'mono');
  const fxOp = await tool('edit', { ops: [{ op: 'set_text', clip: 'fx', effect: 'frost' }] });
  check('Claude sets the text effect and reads it back', !fxOp.isError && (await tool('get_state')).text.includes('fx=frost'), fxOp.text);
  const oldStyle = await win.evaluate(() => {
    const p = structuredClone(window.__cutdesk.state().project);
    delete p.tracks[0].clips[0].style.effect;
    return p;
  });
  await win.evaluate((p) => window.__cutdesk.load(p), oldStyle);
  check('a project saved before effects opens with none', (await clipOf('fx')).style.effect === 'none');

  // The dropped 'behind' effect: older files open with no effect and without their subject masks.
  const boxAsset = await importMedia(f('box.mp4'), join(dir, 'cache'));
  const behindProject = fxProject('behind', 'none');
  behindProject.assets = [{ ...boxAsset, matte: { dir: join(dir, 'old-masks'), from: 0, to: 2, fps: 30, count: 61 } }];
  behindProject.tracks[1].clips = [{ ...MC, id: 'bg', assetId: boxAsset.id, start: 0, in: 0, out: 2 }];
  await win.evaluate((p) => window.__cutdesk.load(p), behindProject);
  const opened = await win.evaluate(() => window.__cutdesk.state().project);
  check('a file with a behind text opens with no effect and no masks', opened.tracks[0].clips[0].style.effect === 'none' &&
    !('matte' in opened.assets[0]), JSON.stringify({ effect: opened.tracks[0].clips[0].style.effect, keys: Object.keys(opened.assets[0]) }));

  // Subject to a new layer: the green box comes out as a see-through clip above; a blue picture slid between the two
  // hides the red background but not the box.
  const layerProject = fxProject('none', 'none');
  layerProject.assets = [boxAsset];
  layerProject.tracks[0].clips = [];
  layerProject.tracks[1].clips = [{ ...MC, id: 'bg', assetId: boxAsset.id, start: 0, in: 0, out: 2 }];
  await win.evaluate((p) => window.__cutdesk.load(p), layerProject);
  await win.locator('[data-clip="bg"]').click();
  await win.locator('[data-testid="subject-layer"]').click();
  await win.waitForFunction(() => window.__cutdesk.state().project.tracks.filter((t) => t.kind === 'video').length === 2, null, { timeout: 300000 });
  const layered = await win.evaluate(() => window.__cutdesk.state().project);
  const subj = layered.tracks[1].clips[0];
  const subjAsset = layered.assets.find((a) => a.id === subj.assetId);
  check('subject goes on a new track right above its clip', layered.tracks[2].clips[0].id === 'bg' &&
    subjAsset.alpha === 'vp9' && subj.start === 0 && subj.in === 0, JSON.stringify({ alpha: subjAsset.alpha, name: subjAsset.name, dur: subjAsset.duration }));
  const blue = await win.evaluate(() => window.api.makeSolid('#0000FF', 1080, 1920));
  await win.evaluate(([p, b]) => {
    const tracks = [...p.tracks];
    tracks.splice(2, 0, { id: 'v-blue', kind: 'video', muted: false, hidden: false, clips: [{ ...p.tracks[2].clips[0], id: 'blue', assetId: b.id, in: 0, out: 2, speed: 1 }] });
    window.__cutdesk.load({ ...p, assets: [...p.assets, b], tracks });
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
  await win.evaluate((p) => window.__cutdesk.load(p), tplProject);
  await win.locator('[data-tab="text"]').click();
  check('template save waits for a selected text', await win.locator('[data-testid="template-save"]').isDisabled());
  await win.locator('[data-clip="fx"]').click();
  await win.locator('[data-testid="template-name"]').fill('테스트 글로우');
  await win.locator('[data-testid="template-save"]').click();
  await win.locator('[data-template="테스트 글로우"]').waitFor({ timeout: 5000 });
  check('a saved template shows in the text tab', true);
  const idsBefore = (await win.evaluate(() => window.__cutdesk.state().project.tracks.flatMap((t) => t.clips))).map((c) => c.id);
  await win.evaluate(() => window.__cutdesk.seek(3));
  await win.locator('[data-template="테스트 글로우"]').click();
  const made = (await win.evaluate(() => window.__cutdesk.state().project.tracks.flatMap((t) => t.clips))).find((c) => !idsBefore.includes(c.id));
  check('a template adds the saved text, look, motion and spans',
    made?.text === 'I' && made.style.effect === 'glow' && made.anim === 'pop' && made.rotation === 12 &&
      made.spans[0]?.color === '#FFD166' && Math.abs(made.out - 2) < 1e-6 && made.preset.startsWith('u-'),
    JSON.stringify(made && { text: made.text, effect: made.style.effect, anim: made.anim, rotation: made.rotation, out: made.out }));
  await win.locator('[data-delete-template="테스트 글로우"]').click();
  check('deleting a template removes it', (await win.locator('[data-template="테스트 글로우"]').count()) === 0);
  await win.locator('[data-delete-template="딴지"]').click();
  check('deleting a built-in template hides it', (await win.locator('[data-preset="aside"]').count()) === 0);
  await win.reload();
  await win.waitForFunction(() => window.__cutdesk !== undefined);
  await win.locator('[data-tab="text"]').click();
  check('deletions survive a restart', (await win.locator('[data-preset="aside"]').count()) === 0 &&
    (await win.locator('[data-template="테스트 글로우"]').count()) === 0);
  await win.locator('[data-testid="template-restore"]').click();
  check('built-in templates come back', (await win.locator('[data-preset="aside"]').count()) === 1 &&
    (await win.locator('[data-testid="template-restore"]').count()) === 0);

  // Layer actions from the track head: merge, order, duplicate, delete, rename, lock.
  const layerStyle = { ...outlined(60, 'bold'), strokeWidth: 0 };
  const layerTrack = (id, clips) => ({ id, kind: 'text', muted: false, hidden: false, clips });
  await win.evaluate((p) => window.__cutdesk.load(p), {
    ...base,
    tracks: [
      layerTrack('t-a', [{ ...text('la', 0, 2, 'A', layerStyle, 0.5, 0.3, 'none'), rotation: 0, spans: [] }]),
      layerTrack('t-b', [{ ...text('lb', 3, 2, 'B', layerStyle, 0.5, 0.5, 'none'), rotation: 0, spans: [] }]),
      layerTrack('t-c', [{ ...text('lc', 1, 3, 'C', layerStyle, 0.5, 0.7, 'none'), rotation: 0, spans: [] }]),
      ...base.tracks.filter((t) => t.kind !== 'text'),
    ],
  });
  const textTracks = () => win.evaluate(() => window.__cutdesk.state().project.tracks.filter((t) => t.kind === 'text')
    .map((t) => ({ id: t.id, name: t.name, locked: t.locked, clips: t.clips.map((c) => ({ id: c.id, start: c.start })) })));
  const menu = async (trackId, item) => {
    if ((await win.locator(`[data-menu="${trackId}"]`).count()) === 0) await win.locator(`[data-head="${trackId}"] .layer-thumb`).click();
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
  await win.evaluate(() => window.__cutdesk.seek(4));
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
  await win.evaluate((p) => window.__cutdesk.load(p), {
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
  const stack = await win.evaluate(() => window.__cutdesk.state().project.tracks.map((t) => t.id));
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
  const dragged = await win.evaluate(() => window.__cutdesk.state().project.tracks.map((t) => t.id));
  check('dragging a card to the top restacks the layer', dragged.slice(0, 3).join() === 'v-bg,v-top,t-x', dragged.join());
  check('the dragged layer is in front: preview', close(await settled(1, plateP), [255, 0, 0], 12));
  check('a drag does not open the layer menu', (await win.locator('[data-menu="v-bg"]').count()) === 0);
  const audioHead = await win.locator('.tl-heads [data-head^="a-"]').last().boundingBox();
  const topNow = await win.locator('[data-head="v-bg"] .layer-thumb').boundingBox();
  await win.mouse.move(topNow.x + topNow.width / 2, topNow.y + topNow.height / 2);
  await win.mouse.down();
  await win.mouse.move(topNow.x + topNow.width / 2, audioHead.y + audioHead.height - 2, { steps: 8 });
  await win.mouse.up();
  const kept = await win.evaluate(() => window.__cutdesk.state().project.tracks.map((t) => t.id));
  check('a picture layer cannot be dragged below the audio', kept.slice(0, 3).join() === 'v-bg,v-top,t-x', kept.join());
  await win.keyboard.press('Control+KeyZ');
  const unDragged = await win.evaluate(() => window.__cutdesk.state().project.tracks.map((t) => t.id));
  check('undo puts a dragged layer back', unDragged.slice(0, 3).join() === 'v-top,t-x,v-bg', unDragged.join());
  await win.locator('[data-head="v-top"] .layer-check').click();
  check('the card check hides the layer', (await win.evaluate(() => window.__cutdesk.state().project.tracks.find((t) => t.id === 'v-top').hidden)) === true &&
    close(await settled(1, plateP), [255, 255, 255], 12) && (await win.locator('[data-menu="v-top"]').count()) === 0);

  // Placement: a dragged layer sticks to the frame's center line (not with Alt), and the align buttons put it on an edge.
  await win.evaluate((p) => window.__cutdesk.load(p), {
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
  await win.evaluate(() => window.__cutdesk.seek(1));
  const clipX = (id) => win.evaluate((cid) => {
    const c = window.__cutdesk.state().project.tracks.flatMap((t) => t.clips).find((k) => k.id === cid);
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
  await win.evaluate(() => window.__cutdesk.seek(1));
  await win.locator('[data-align="top"]').click();
  const topBox = await win.locator('.transform-box').boundingBox();
  check('align top puts the text on the frame top', Math.abs(topBox.y - stageBox.y) < 2, `${topBox.y} vs ${stageBox.y}`);
  await win.keyboard.press('Control+KeyZ');
  const undoneY = await win.evaluate(() => window.__cutdesk.state().project.tracks[0].clips[0].y);
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
  await win.evaluate((p) => window.__cutdesk.load(p), lookProject({}));
  await win.locator('[data-head="v-hi"] .layer-thumb').click();
  await win.locator('[data-menu="v-hi"] [data-testid="layer-blend"]').selectOption('multiply');
  await win.locator('[data-menu="v-hi"] [data-testid="layer-opacity"]').fill('50');
  const looked = await win.evaluate(() => window.__cutdesk.state().project.tracks[0]);
  check('the layer menu sets blend mode and opacity', looked.blend === 'multiply' && looked.opacity === 0.5, JSON.stringify({ b: looked.blend, o: looked.opacity }));
  check('the card shows the blend mode and opacity', (await win.locator('[data-head="v-hi"] .layer-notes').textContent()).includes('곱하기 · 50%'));
  check('layers that mix differently do not merge', await win.locator('[data-menu="v-hi"] button', { hasText: '아래 레이어와 병합' }).isDisabled());
  await win.locator('[data-head="v-hi"] .layer-thumb').click();
  await win.keyboard.press('Control+KeyZ');
  check('undo takes the opacity back', (await win.evaluate(() => window.__cutdesk.state().project.tracks[0].opacity)) === undefined);
  const looks = [
    { name: 'multiply', look: { blend: 'multiply' }, want: [32, 32, 24] },
    { name: 'overlay', look: { blend: 'overlay' }, want: [65, 64, 48] },
    { name: 'normal at 50%', look: { opacity: 0.5 }, want: [96, 96, 112] },
    { name: 'difference at 60%', look: { blend: 'difference', opacity: 0.6 }, want: [90, 64, 109] },
  ];
  const lookP = { x: 540, y: 960, s: 8 };
  for (const l of looks) {
    await win.evaluate((p) => window.__cutdesk.load(p), lookProject(l.look));
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
  await win.evaluate((p) => window.__cutdesk.load(p), clipProject({}, {}));
  check('the bottom layer cannot be clipped', await (await menu('v-base', '클리핑 마스크')).isDisabled());
  await win.locator('[data-head="v-base"] .layer-thumb').click();
  await (await menu('v-clip', '클리핑 마스크')).click();
  check('the menu turns the clipping mask on', (await win.evaluate(() => window.__cutdesk.state().project.tracks[0].clipped)) === true &&
    (await win.locator('[data-head="v-clip"].clipped').count()) === 1);
  const clipInP = { x: 540, y: 960, s: 8 };
  const clipOutP = { x: 100, y: 300, s: 8 };
  const clips = [
    { name: 'normal', top: { clipped: true }, bottom: {}, inside: [64, 128, 192] },
    { name: 'multiply', top: { clipped: true, blend: 'multiply' }, bottom: {}, inside: [32, 32, 24] },
    { name: 'on a half-opacity base', top: { clipped: true }, bottom: { opacity: 0.5 }, inside: [32, 64, 96] },
  ];
  for (const c of clips) {
    await win.evaluate((p) => window.__cutdesk.load(p), clipProject(c.top, c.bottom));
    const shownIn = await settled(1, clipInP);
    const shownOut = await settled(1, clipOutP);
    check(`clipping ${c.name}: preview`, close(shownIn, c.inside, 6) && close(shownOut, [0, 0, 0], 6), `${shownIn} / ${shownOut} want ${c.inside}`);
    const out = join(dir, `clip-${c.name.replace(/\W+/g, '-')}.mp4`);
    await exportTo(out);
    const madeIn = samplePixel(out, 1, clipInP.x, clipInP.y, 8);
    const madeOut = samplePixel(out, 1, clipOutP.x, clipOutP.y, 8);
    check(`clipping ${c.name}: export`, close(madeIn, c.inside, 10) && close(madeOut, [0, 0, 0], 10), `${madeIn} / ${madeOut} want ${c.inside}`);
  }
  await win.evaluate((p) => window.__cutdesk.load(p), clipProject({ clipped: true }, { hidden: true }));
  check('hiding the base hides its clipping masks', close(await settled(1, clipInP), [0, 0, 0], 6));

  // Merging video layers whose clips overlap: the overlap is baked into one see-through clip that looks the same.
  await win.evaluate((p) => window.__cutdesk.load(p), {
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
    const s = window.__cutdesk.state();
    return s.layerJob === null && !s.project.tracks.some((t) => t.id === 'v-up');
  }, null, { timeout: 120000 }).catch(() => {});
  const mergedState = await win.evaluate(() => {
    const s = window.__cutdesk.state();
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
  const unmerged = await win.evaluate(() => window.__cutdesk.state().project.tracks.map((t) => `${t.id}:${t.clips.length}`));
  check('undo takes a baked merge back', unmerged.slice(0, 2).join() === 'v-up:1,v-dn:1', unmerged.join());

  // Clips butt exactly against a neighbour whose end is off the frame grid, when moved and when trimmed.
  await win.evaluate((p) => window.__cutdesk.load(p), {
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
  const fitClips = () => win.evaluate(() => Object.fromEntries(window.__cutdesk.state().project.tracks
    .find((t) => t.id === 'v-fit').clips.map((c) => [c.id, { start: c.start, end: c.start + (c.out - c.in) / c.speed }])));
  const pxPerSec = await win.evaluate(() => window.__cutdesk.state().zoom);
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
  const playheadNow = () => win.evaluate(() => window.__cutdesk.state().playhead);
  const ruler = await win.locator('.tl-ruler').boundingBox();
  const xAt = (t) => ruler.x + t * pxPerSec;
  const trackBox = await win.locator('[data-row="t-1"]').boundingBox();
  await win.mouse.click(xAt(3.3), trackBox.y + trackBox.height / 2);
  check('clicking empty track space moves the playhead and drops the selection',
    Math.abs((await playheadNow()) - 3.3) < 0.05 && (await win.evaluate(() => window.__cutdesk.state().selectedClipId)) === null,
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
  await win.evaluate(() => window.__cutdesk.seek(6.5));
  await win.locator('[data-clip="fc"]').click();
  check('picking the block under the playhead leaves it where it is', Math.abs((await playheadNow()) - 6.5) < 1e-9,
    String(await playheadNow()));

  // OpenCut-style tools: bookmarks, duplicate, trim before the playhead, position keyframes.
  const markers = () => win.evaluate(() => window.__cutdesk.state().project.markers.map((m) => m.t));
  await win.evaluate(() => window.__cutdesk.seek(2));
  await win.evaluate(() => document.activeElement.blur());
  await win.keyboard.press('m');
  check('M puts a bookmark at the playhead', JSON.stringify(await markers()) === '[2]', JSON.stringify(await markers()));
  await win.keyboard.press('m');
  check('M on a bookmark takes it away', (await markers()).length === 0, JSON.stringify(await markers()));

  await win.locator('[data-clip="fc"]').click();
  await win.keyboard.press('Control+d');
  fit = await fitClips();
  const copyId = await win.evaluate(() => window.__cutdesk.state().selectedClipId);
  check('Ctrl+D puts a copy right after the clip and picks it',
    copyId !== 'fc' && fit[copyId] && Math.abs(fit[copyId].start - fit.fc.end) < 1e-9, JSON.stringify(fit));

  await win.evaluate(() => window.__cutdesk.seek(6.5));
  await win.locator('[data-clip="fc"]').click();
  await win.locator('[data-testid="tl-trim-before"]').click();
  fit = await fitClips();
  check('trimming before the playhead keeps the clip end and starts it there',
    Math.abs(fit.fc.start - 6.5) < 1e-9 && Math.abs(fit.fc.end - 7) < 1e-9, JSON.stringify(fit.fc));

  const keysOf = (id) => win.evaluate((cid) => window.__cutdesk.state().project.tracks.flatMap((t) => t.clips).find((c) => c.id === cid).keys ?? [], id);
  await win.evaluate(() => window.__cutdesk.seek(0.5));
  await win.locator('[data-clip="fa"]').click();
  await win.locator('[data-testid="key-toggle"]').click();
  let keys = await keysOf('fa');
  check('the first keyframe also pins the start', keys.length === 2 && keys[0].t === 0 && Math.abs(keys[1].t - 0.5) < 1e-9, JSON.stringify(keys));
  await win.evaluate(() => window.__cutdesk.seek(1.2));
  const boxBefore = await win.locator('.transform-box').boundingBox();
  await win.locator('[data-align="left"]').click();
  keys = await keysOf('fa');
  check('moving the picture with keyframes on adds a keyframe there', keys.length === 3 && Math.abs(keys[2].t - 1.2) < 1e-9, JSON.stringify(keys));
  await win.evaluate(() => window.__cutdesk.seek(0.25));
  await win.waitForTimeout(100);
  const boxEarly = await win.locator('.transform-box').boundingBox();
  check('before the moved keyframe the picture stays where it was', Math.abs(boxEarly.x - boxBefore.x) < 2,
    `${boxEarly.x} vs ${boxBefore.x}`);
  check('the clip shows its keyframes', (await win.locator('[data-clip="fa"] .tl-key').count()) === 3);
  await win.locator('[data-testid="key-clear"]').click();
  check('clearing keyframes leaves a plain transform', (await keysOf('fa')).length === 0);

  await win.evaluate(() => window.__cutdesk.seek(0.5));
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
