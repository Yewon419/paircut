import type { AgentEvent, AgentModel, AgentToolResult, ToolName } from './agentOps';
import type { MediaAsset, Project } from './project';

export interface ExportOptions {
  outPath: string;
  height: number;
}

/** A text clip rendered by the renderer at export size (PNG, base64 without data: prefix). */
export interface TextImage {
  clipId: string;
  pngBase64: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Glitch frames as PNG base64, same size and place as the main image. */
  variants: string[];
  /** Intro anim frames, one per output frame from the clip start, then the settled text; all in one shared box. */
  intro: TextIntro | null;
}

export interface TextIntro {
  frames: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 'probe' reads the file; 'thumb' draws a video's filmstrip (`ratio` 0..1); 'wave' draws an audio waveform. */
export type ImportStage = 'probe' | 'thumb' | 'wave';

export interface ImportProgress {
  jobId: string;
  stage: ImportStage;
  ratio: number;
}

export interface MatteProgress {
  assetId: string;
  done: number;
  total: number;
}

export interface TextFile {
  path: string;
  content: string;
}

export type ExportEvent =
  | { type: 'progress'; ratio: number }
  | { type: 'done'; outPath: string }
  | { type: 'error'; message: string }
  | { type: 'cancelled' };

/** One bundled sound effect from `sfx/sfx.json`; `path` is absolute so it probes like any media file. */
export interface SfxEntry {
  name: string;
  group: string;
  path: string;
}

export interface OpenedProject {
  path: string;
  project: Project;
  missing: string[];
}

/** A start-screen card: a recently opened or saved project file and what could be read from it. */
export interface RecentProject {
  path: string;
  /** `missing`: the file is gone; `unreadable`: it exists but did not parse as a project (see `problem`). */
  status: 'ok' | 'missing' | 'unreadable';
  problem: string | null;
  /** File modified time (ms since epoch), null when missing. */
  modifiedAt: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  /** JPEG of the preview taken at the last save, null until the project is saved once. */
  thumbPath: string | null;
  thumbAt: number | null;
}

export interface PaircutApi {
  isTest(): Promise<boolean>;
  pickMedia(): Promise<string[]>;
  probeMedia(paths: string[]): Promise<MediaAsset[]>;
  /** Probes one file and makes its thumbnail, sending ImportProgress for `jobId` along the way. */
  importMedia(jobId: string, path: string): Promise<MediaAsset>;
  onImportProgress(listener: (p: ImportProgress) => void): () => void;
  /** The sound effects shipped in the app's `sfx` folder, in manifest order. */
  listSfx(): Promise<SfxEntry[]>;
  /** Makes (or reuses) a one-color PNG of the given size and probes it as an image asset. */
  makeSolid(color: string, width: number, height: number): Promise<MediaAsset>;
  /** A PNG of the frame shown at `seconds` into the asset, probed as an image asset (made once, then reused). */
  makeStill(asset: MediaAsset, seconds: number): Promise<MediaAsset>;
  /** rgb24 pixels of a few small frames from the asset's source seconds [from, to] (one frame of an image), for auto color. */
  sampleFrames(asset: MediaAsset, from: number, to: number): Promise<Uint8Array>;
  /** Cuts subject masks for the asset's source seconds [from, to] with rembg (CPU, about 0.5 s a frame). */
  onMatteProgress(listener: (p: MatteProgress) => void): () => void;
  /** A new asset with only the subject of [from, to] left opaque (alpha webm, or PNG for a still). */
  makeSubject(asset: MediaAsset, from: number, to: number, fps: number): Promise<MediaAsset>;
  /** Bakes the picture layers of a small project into one see-through clip (VP9 alpha webm), named `name`. */
  bakeLayers(project: Project, name: string): Promise<MediaAsset>;
  pathForFile(file: File): string;
  mediaUrl(path: string): string;
  saveProject(project: Project, path: string | null): Promise<string | null>;
  openProject(): Promise<OpenedProject | null>;
  /** Recently opened or saved project files, newest first. */
  listRecentProjects(): Promise<RecentProject[]>;
  /** Opens a project file without a dialog and moves it to the top of the recent list. */
  openProjectFile(path: string): Promise<OpenedProject>;
  /** Drops a file from the recent list (the file itself is left alone). */
  forgetRecentProject(path: string): Promise<void>;
  /** Stores the start-screen picture for a saved project file. */
  saveProjectThumb(path: string, jpegBase64: string): Promise<void>;
  pickExportPath(): Promise<string | null>;
  startExport(project: Project, options: ExportOptions, texts: TextImage[]): Promise<void>;
  cancelExport(): Promise<void>;
  onExportEvent(listener: (event: ExportEvent) => void): () => void;
  showInFolder(path: string): Promise<void>;
  /** Read-only: the operations board is owned by another tool and never written from here. */
  readTextFile(path: string): Promise<string>;
  openTextFile(extensions: string[], defaultPath: string | null): Promise<TextFile | null>;
  saveTextFile(content: string, defaultName: string, extensions: string[]): Promise<string | null>;
  /** Sends one chat message to the in-app Claude; replies stream through onAgentEvent. */
  agentAsk(prompt: string, model: AgentModel): Promise<void>;
  agentStop(): Promise<void>;
  /** Forgets the conversation so the next message starts a new session. */
  agentReset(): Promise<void>;
  onAgentEvent(listener: (event: AgentEvent) => void): () => void;
  /** Serves tool calls that need the editor state: the in-app Claude's and the local bridge's. */
  onAgentCall(handler: (name: ToolName, input: unknown) => Promise<AgentToolResult>): () => void;
}

export const MEDIA_SCHEME = 'media';
