import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExportEvent, TextImage } from '../shared/api';
import { buildExportPlan, ffmpegArgs } from '../shared/exportGraph';
import type { Project } from '../shared/project';
import { FFMPEG } from './media';

export interface RunningExport {
  cancel(): void;
  done: Promise<ExportEvent>;
}

export function runExport(
  project: Project,
  height: number,
  outPath: string,
  texts: TextImage[],
  onProgress: (ratio: number) => void,
): RunningExport {
  const workDir = mkdtempSync(join(tmpdir(), 'cutdesk-'));
  const layers = texts.map((t, i) => {
    const path = join(workDir, `text${i}.png`);
    writeFileSync(path, Buffer.from(t.pngBase64, 'base64'));
    const variants = t.variants.map((v, j) => {
      const vp = join(workDir, `text${i}v${j}.png`);
      writeFileSync(vp, Buffer.from(v, 'base64'));
      return vp;
    });
    t.intro?.frames.forEach((f, j) => writeFileSync(join(workDir, `text${i}f${String(j).padStart(4, '0')}.png`), Buffer.from(f, 'base64')));
    const intro = t.intro ? { pattern: join(workDir, `text${i}f%04d.png`), count: t.intro.frames.length, x: t.intro.x, y: t.intro.y } : null;
    return { clipId: t.clipId, path, x: t.x, y: t.y, w: t.w, h: t.h, variants, intro };
  });
  let plan;
  try {
    plan = buildExportPlan(project, height, layers);
  } catch (err) {
    rmSync(workDir, { recursive: true, force: true });
    throw err;
  }
  for (const lut of plan.luts) writeFileSync(join(workDir, lut.name), lut.content, 'utf8');
  const scriptPath = join(workDir, 'graph.txt');
  writeFileSync(scriptPath, plan.filterGraph, 'utf8');
  const args = ffmpegArgs(plan, scriptPath, outPath);

  const child = spawn(FFMPEG, args, { windowsHide: true, cwd: workDir });
  let cancelled = false;
  let stderrTail = '';
  let stdoutBuf = '';

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdoutBuf += chunk;
    const lines = stdoutBuf.split(/\r?\n/);
    stdoutBuf = lines.pop() ?? '';
    for (const line of lines) {
      const m = /^out_time_us=(\d+)/.exec(line);
      if (m) onProgress(Math.min(1, Number(m[1]) / 1e6 / plan.duration));
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });

  const done = new Promise<ExportEvent>((resolve) => {
    child.on('error', (err) => {
      rmSync(workDir, { recursive: true, force: true });
      resolve({ type: 'error', message: `ffmpeg could not start (${FFMPEG}): ${err.message}` });
    });
    child.on('close', (code) => {
      rmSync(workDir, { recursive: true, force: true });
      if (cancelled) resolve({ type: 'cancelled' });
      else if (code === 0) resolve({ type: 'done', outPath });
      else
        resolve({
          type: 'error',
          message: `ffmpeg exited with ${code}\nfilter graph:\n${plan.filterGraph}\n\nstderr:\n${stderrTail}`,
        });
    });
  });

  return {
    cancel() {
      cancelled = true;
      child.kill();
    },
    done,
  };
}
