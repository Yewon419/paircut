import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExportEvent } from '../shared/api';
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
  onProgress: (ratio: number) => void,
): RunningExport {
  const plan = buildExportPlan(project, height);
  const workDir = mkdtempSync(join(tmpdir(), 'cutdesk-'));
  const scriptPath = join(workDir, 'graph.txt');
  writeFileSync(scriptPath, plan.filterGraph, 'utf8');
  const args = ffmpegArgs(plan, scriptPath, outPath);

  const child = spawn(FFMPEG, args, { windowsHide: true });
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
