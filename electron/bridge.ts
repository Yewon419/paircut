import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { AgentToolResult, ToolName } from '../shared/agentOps';
import { AGENT_TOOLS, BRIDGE_TOOLS } from '../shared/agentOps';

/**
 * Local bridge: lets Claude Code on this machine use the editor tools on the open window, so both
 * people see the same timeline and every edit is one undo step. Listens on 127.0.0.1 only, on a
 * random port, and needs a per-launch token. Port and token go to <userData>/bridge.json.
 */
const MAX_BODY = 50 * 1024 * 1024;
const TOOLS = new Set<string>([...AGENT_TOOLS, ...BRIDGE_TOOLS]);

export interface BridgeInfo {
  port: number;
  token: string;
  pid: number;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error(`body over ${MAX_BODY} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, body: AgentToolResult): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function tokenOk(header: string | undefined, token: string): boolean {
  const got = Buffer.from(header ?? '');
  const want = Buffer.from(`Bearer ${token}`);
  return got.length === want.length && timingSafeEqual(got, want);
}

export function startBridge(dir: string, run: (name: ToolName, input: unknown) => Promise<AgentToolResult>): () => void {
  const token = randomBytes(24).toString('hex');
  const file = join(dir, 'bridge.json');
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || req.url !== '/tool') return reply(res, 404, { text: 'POST /tool only', isError: true });
      if (!tokenOk(req.headers.authorization, token)) return reply(res, 401, { text: 'bad token', isError: true });
      let call: { name?: unknown; input?: unknown };
      try {
        call = JSON.parse(await readBody(req)) as { name?: unknown; input?: unknown };
      } catch (err) {
        return reply(res, 400, { text: `bad request body: ${(err as Error).message}`, isError: true });
      }
      if (typeof call.name !== 'string' || !TOOLS.has(call.name)) {
        return reply(res, 400, { text: `unknown tool ${String(call.name)}; have ${[...TOOLS].join(', ')}`, isError: true });
      }
      const name = call.name as ToolName;
      console.log(`[bridge] ${name}`);
      const result = await run(name, call.input ?? {});
      if (result.isError) console.error(`[bridge] ${name} failed: ${result.text}`);
      reply(res, 200, result);
    })().catch((err: unknown) => {
      console.error('[bridge] request failed', err);
      if (!res.headersSent) reply(res, 500, { text: (err as Error).message, isError: true });
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address() as AddressInfo;
    const info: BridgeInfo = { port, token, pid: process.pid };
    writeFileSync(file, JSON.stringify(info), { encoding: 'utf8', mode: 0o600 });
    console.log(`[bridge] listening on 127.0.0.1:${port}`);
  });
  server.on('error', (err) => console.error('[bridge] server error', err));
  return () => {
    server.close();
    // Another cutdesk started later may own the file now; only remove our own.
    try {
      if ((JSON.parse(readFileSync(file, 'utf8')) as BridgeInfo).token === token) rmSync(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[bridge] could not clean up', file, err);
    }
  };
}
