// UI end-to-end: launches the real Electron app, drives the editor, and checks that the
// preview canvas matches the exported MP4 at the same timestamps.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { _electron } from 'playwright';
import { buildFixtureProject, freshDir, makeFixtures, samplePixel } from './e2e-export.mjs';

const root = resolve(import.meta.dirname, '..');
let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

const dir = freshDir('ui');
const f = makeFixtures(dir);
const { project: base } = await buildFixtureProject(f, join(dir, 'cache'));
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
  const out = join(dir, 'out.mp4');
  await win.evaluate(
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
    out,
  );
  check('export via IPC finished', true);
  const layers = Object.fromEntries((await win.evaluate(() => window.__cutdesk.texts(1920))).map((l) => [l.clipId, l]));
  const badge = layers['x-badge'];
  const sub = layers['x-sub'];
  const pop = layers['x-pop'];
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
