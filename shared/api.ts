import type { MediaAsset, Project } from './project';

export interface ExportOptions {
  outPath: string;
  height: number;
}

export type ExportEvent =
  | { type: 'progress'; ratio: number }
  | { type: 'done'; outPath: string }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

export interface OpenedProject {
  path: string;
  project: Project;
  missing: string[];
}

export interface CutdeskApi {
  isTest(): Promise<boolean>;
  pickMedia(): Promise<string[]>;
  probeMedia(paths: string[]): Promise<MediaAsset[]>;
  pathForFile(file: File): string;
  mediaUrl(path: string): string;
  saveProject(project: Project, path: string | null): Promise<string | null>;
  openProject(): Promise<OpenedProject | null>;
  pickExportPath(): Promise<string | null>;
  startExport(project: Project, options: ExportOptions): Promise<void>;
  cancelExport(): Promise<void>;
  onExportEvent(listener: (event: ExportEvent) => void): () => void;
  showInFolder(path: string): Promise<void>;
}

export const MEDIA_SCHEME = 'media';
