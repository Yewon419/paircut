import { create } from 'zustand';
import type { ImportProgress } from '../shared/api';
import { addAssets, uid } from './store';

/** A file on its way into the media bin; it leaves the list once its asset is added, or stays with the error. */
export interface ImportJob {
  id: string;
  path: string;
  name: string;
  stage: 'wait' | 'probe' | 'thumb' | 'wave' | 'error';
  ratio: number;
  error: string | null;
}

export const useImports = create<{ jobs: ImportJob[] }>(() => ({ jobs: [] }));

const set = useImports.setState;
let running = false;
let unsubscribe: (() => void) | null = null;

function patch(id: string, update: Partial<ImportJob>): void {
  set((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...update } : j)) }));
}

function onProgress(p: ImportProgress): void {
  patch(p.jobId, { stage: p.stage, ratio: p.ratio });
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Imports the waiting files one at a time; each asset is added as soon as it is ready, a failure only stops its own row. */
async function drain(): Promise<void> {
  if (running) return;
  running = true;
  unsubscribe ??= window.api.onImportProgress(onProgress);
  try {
    for (;;) {
      const job = useImports.getState().jobs.find((j) => j.stage === 'wait');
      if (!job) break;
      patch(job.id, { stage: 'probe', ratio: 0 });
      try {
        const asset = await window.api.importMedia(job.id, job.path);
        addAssets([asset]);
        set((s) => ({ jobs: s.jobs.filter((j) => j.id !== job.id) }));
      } catch (err) {
        const message = (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
        patch(job.id, { stage: 'error', error: message });
      }
    }
  } finally {
    running = false;
  }
}

export function queueImports(paths: string[]): void {
  if (paths.length === 0) return;
  const added = paths.map((path): ImportJob => ({ id: uid('imp'), path, name: baseName(path), stage: 'wait', ratio: 0, error: null }));
  set((s) => ({ jobs: [...s.jobs, ...added] }));
  void drain();
}

export function dismissImport(id: string): void {
  set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id || j.stage !== 'error') }));
}
