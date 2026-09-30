// UI end-to-end: launches the real Electron app, drives the editor, and checks that the
// preview canvas matches the exported MP4 at the same timestamps.
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
const { project } = await buildFixtureProject(f, join(dir, 'cache'));

const app = await _electron.launch({ args: ['.'], cwd: root, env: { ...process.env, CUTDESK_TEST: '1' } });
try {
  const win = await app.firstWindow();
  await win.waitForFunction(() => '__cutdesk' in window, null, { timeout: 15000 });
  await win.evaluate((p) => window.__cutdesk.load(p), project);

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
        void window.api.startExport(window.__cutdesk.state().project, { outPath, height: 1920 });
      }),
    out,
  );
  check('export via IPC finished', true);

  const readCanvas = (p) =>
    win.evaluate(
      ({ x, y }) => {
        const c = document.querySelector('[data-testid="preview-canvas"]');
        const d = c.getContext('2d').getImageData(Math.floor(x / 2), Math.floor(y / 2), 4, 4).data;
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        const n = d.length / 4;
        return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
      },
      { x: p.x, y: p.y },
    );

  const probes = [
    { t: 0.5, x: 540, y: 960 },
    { t: 0.5, x: 8, y: 1200 },
    { t: 1.5, x: 540, y: 960 },
    { t: 1.5, x: 120, y: 300 },
    { t: 4.0, x: 8, y: 8 },
    { t: 6.0, x: 540, y: 400 },
    { t: 6.0, x: 8, y: 1900 },
  ];
  for (const p of probes) {
    await win.evaluate((t) => window.__cutdesk.seek(t), p.t);
    const t0 = Date.now();
    let prev = null;
    let last = null;
    while (Date.now() - t0 < 5000) {
      await win.waitForTimeout(100);
      const cur = await readCanvas(p);
      if (last && cur.join() === last.join() && cur.some((v) => v > 0)) {
        prev = cur;
        break;
      }
      last = cur;
    }
    prev ??= last;
    console.log(`      settled after ${Date.now() - t0}ms`);
    const exp = samplePixel(out, p.t, p.x, p.y);
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
  const movedStart = await win.evaluate(() => window.__cutdesk.state().project.tracks[0].clips[0].start);
  check('drag moves overlay clip by 2s', Math.abs(movedStart - 3) < 0.05, `start ${movedStart}`);

  const box2 = await topClip.boundingBox();
  await win.mouse.move(box2.x + box2.width - 3, box2.y + box2.height / 2);
  await win.mouse.down();
  await win.mouse.move(box2.x + box2.width - 3 + zoom, box2.y + box2.height / 2, { steps: 8 });
  await win.mouse.up();
  const trimmed = await win.evaluate(() => {
    const c = window.__cutdesk.state().project.tracks[0].clips[0];
    return c.out - c.in;
  });
  check('right handle extends image clip by 1s', Math.abs(trimmed - 2) < 0.05, `duration ${trimmed}`);

  await win.evaluate(() => window.__cutdesk.seek(3.5));
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
