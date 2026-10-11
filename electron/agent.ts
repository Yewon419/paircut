import type { BrowserWindow } from 'electron';
import { app, ipcMain } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import type { AgentEvent, AgentModel, AgentToolName, AgentToolResult, ToolName } from '../shared/agentOps';
import { AGENT_TOOLS, EditOp } from '../shared/agentOps';

/**
 * In-app Claude. Runs the Agent SDK on the logged-in Claude Code subscription with only cutdesk's
 * own tools: no built-in tools, no settings files, no other MCP servers, so each turn stays small.
 */
const SERVER = 'cutdesk';
const RENDERER_TIMEOUT_MS = 30_000;
const EXPORT_TIMEOUT_MS = 20 * 60_000;
/** Up to 24 frames, each waiting up to 3s for video seeks. */
const SHEET_TIMEOUT_MS = 2 * 60_000;
const APP_SHOT_WIDTH = 800;

const SYSTEM_PROMPT = `You operate cutdesk, a 1080x1920 short-form video editor. Reply in Korean, briefly, as plain text without markdown.
Times are timeline seconds. Use ids from get_state; call it before editing unless you already know the state.
Put related changes into one edit call: it is one undo step and all-or-nothing.
screenshot shows the preview frame; use screenshot_app only when you need the editor UI itself.
You cannot export, save or open files. Ask the user to do those.`;

type ToolReply = {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[];
  isError?: boolean;
};

interface Pending {
  resolve: (r: AgentToolResult) => void;
  timer: NodeJS.Timeout;
}

let win: BrowserWindow | null = null;
let sessionId: string | null = null;
let running: AbortController | null = null;
let nextCall = 0;
const pending = new Map<number, Pending>();

function send(event: AgentEvent): void {
  win?.webContents.send('agent:event', event);
}

function callRenderer(name: ToolName, input: unknown, timeoutMs = RENDERER_TIMEOUT_MS): Promise<AgentToolResult> {
  const w = win;
  if (!w) return Promise.resolve({ text: 'editor window is closed', isError: true });
  const id = nextCall++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      console.error(`[agent] renderer did not answer ${name} within ${timeoutMs}ms`, input);
      resolve({ text: `${name} timed out in the editor`, isError: true });
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    w.webContents.send('agent:call', { id, name, input });
  });
}

async function appShot(): Promise<AgentToolResult> {
  if (!win) return { text: 'editor window is closed', isError: true };
  const image = await win.webContents.capturePage();
  const small = image.resize({ width: APP_SHOT_WIDTH, quality: 'good' });
  const size = small.getSize();
  return { text: `editor window ${size.width}x${size.height}`, jpegBase64: small.toJPEG(70).toString('base64') };
}

/** Runs one tool exactly as Claude would; also the e2e entry point. */
export async function callTool(name: AgentToolName, input: unknown): Promise<AgentToolResult> {
  if (name === 'screenshot_app') return appShot();
  return callRenderer(name, input);
}

/** Bridge-only tools that need the editor window; export waits for the whole render. */
export function callRendererTool(name: Exclude<ToolName, 'screenshot_app' | 'probe_media'>, input: unknown): Promise<AgentToolResult> {
  return callRenderer(name, input, name === 'export' ? EXPORT_TIMEOUT_MS : name === 'contact_sheet' ? SHEET_TIMEOUT_MS : RENDERER_TIMEOUT_MS);
}

function reply(result: AgentToolResult): ToolReply {
  const content: ToolReply['content'] = [{ type: 'text', text: result.text }];
  if (result.jpegBase64) content.push({ type: 'image', data: result.jpegBase64, mimeType: 'image/jpeg' });
  return { content, isError: result.isError };
}

function detail(input: unknown): string {
  const s = JSON.stringify(input) ?? '';
  return s === '{}' ? '' : s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

async function buildServer() {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk');
  const run = (name: AgentToolName) => async (args: unknown) => reply(await callTool(name, args));
  return createSdkMcpServer({
    name: SERVER,
    version: '1',
    alwaysLoad: true,
    tools: [
      tool('get_state', 'Editor state as compact text: assets, tracks top to bottom with clips (id start-end ...), playhead, color presets. Default values are omitted.', {}, run('get_state')),
      tool(
        'edit',
        'Apply ops in order as one undo step. If any op fails nothing changes and the error names the op. Returns ids of clips the ops created.',
        { ops: z.array(EditOp).min(1) },
        run('edit'),
      ),
      tool(
        'screenshot',
        'Preview frame as a 270x480 JPEG, at t seconds or at the playhead. Moves the playhead to t.',
        { t: z.number().min(0).optional() },
        run('screenshot'),
      ),
      tool('screenshot_app', `Whole editor window, ${APP_SHOT_WIDTH}px wide JPEG. Costs more tokens than screenshot.`, {}, run('screenshot_app')),
    ],
  });
}

function onMessage(msg: SDKMessage): void {
  if (msg.type === 'system' && msg.subtype === 'init') {
    sessionId = msg.session_id;
    return;
  }
  if (msg.type === 'assistant') {
    for (const block of msg.message.content) {
      if (block.type === 'text' && block.text.trim()) send({ type: 'text', text: block.text });
      if (block.type === 'tool_use') send({ type: 'tool', name: block.name.replace(`mcp__${SERVER}__`, ''), detail: detail(block.input) });
    }
    return;
  }
  if (msg.type !== 'result') return;
  sessionId = msg.session_id;
  if (msg.subtype !== 'success') {
    const message = `${msg.subtype}: ${msg.errors.join('; ')}`;
    console.error(`[agent] ${message}`);
    send({ type: 'error', message });
    return;
  }
  const u = msg.usage;
  send({
    type: 'done',
    sessionId: msg.session_id,
    seconds: msg.duration_ms / 1000,
    inputTokens: u.input_tokens + u.cache_creation_input_tokens,
    cachedTokens: u.cache_read_input_tokens,
    outputTokens: u.output_tokens,
  });
}

async function ask(prompt: string, model: AgentModel): Promise<void> {
  const abort = new AbortController();
  running = abort;
  try {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const cwd = join(app.getPath('userData'), 'agent');
    mkdirSync(cwd, { recursive: true });
    const q = query({
      prompt,
      options: {
        model,
        systemPrompt: SYSTEM_PROMPT,
        tools: [],
        mcpServers: { [SERVER]: await buildServer() },
        strictMcpConfig: true,
        settingSources: [],
        allowedTools: AGENT_TOOLS.map((t) => `mcp__${SERVER}__${t}`),
        permissionMode: 'dontAsk',
        resume: sessionId ?? undefined,
        cwd,
        abortController: abort,
        stderr: (line) => console.error(`[agent stderr] ${line}`),
      },
    });
    for await (const msg of q) onMessage(msg);
  } catch (err) {
    if (abort.signal.aborted) send({ type: 'error', message: '중지됨' });
    else {
      console.error('[agent] query failed', { model, resume: sessionId }, err);
      send({ type: 'error', message: (err as Error).message });
    }
  } finally {
    running = null;
  }
}

export function registerAgent(window: BrowserWindow, isTest: boolean): void {
  win = window;
  window.on('closed', () => {
    running?.abort();
    win = null;
  });
  ipcMain.on('agent:reply', (_e, id: number, result: AgentToolResult) => {
    const p = pending.get(id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(id);
    p.resolve(result);
  });
  ipcMain.handle('agent:ask', (_e, prompt: string, model: AgentModel) => {
    if (running) throw new Error('Claude is still working on the previous message');
    void ask(prompt, model);
  });
  ipcMain.handle('agent:stop', () => {
    running?.abort();
  });
  ipcMain.handle('agent:reset', () => {
    running?.abort();
    sessionId = null;
  });
  if (isTest) (globalThis as { __cutdeskAgent?: object }).__cutdeskAgent = { callTool };
}
