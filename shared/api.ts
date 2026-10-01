import type { AgentEvent, AgentModel, AgentToolName, AgentToolResult } from './agentOps';
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
  /** Serves Claude's tool calls that need the editor state (get_state, edit, screenshot). */
  onAgentCall(handler: (name: AgentToolName, input: unknown) => Promise<AgentToolResult>): () => void;
}

export const MEDIA_SCHEME = 'media';
