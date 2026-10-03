// Calls a tool on the running cutdesk window through the local bridge (see electron/bridge.ts).
//   node scripts/bridge.mjs get_state
//   node scripts/bridge.mjs edit '{"ops":[{"op":"seek","t":3}]}'
//   node scripts/bridge.mjs load_project @draft.cutdesk.json   (file holding { "project": ... })
//   node scripts/bridge.mjs screenshot '{"t":3}' shot.jpg      (image tools: optional output path)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const INFO = process.env.CUTDESK_BRIDGE ?? join(process.env.APPDATA ?? '', 'cutdesk', 'bridge.json');

/** Returns { text, jpegBase64?, isError? }; throws when the app is not running or the call fails. */
export async function callBridge(name, input = {}) {
  let info;
  try {
    info = JSON.parse(readFileSync(INFO, 'utf8'));
  } catch (err) {
    throw new Error(`cutdesk bridge not found at ${INFO} (is the app running outside test mode?): ${err.message}`, { cause: err });
  }
  const res = await fetch(`http://127.0.0.1:${info.port}/tool`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${info.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, input }),
  });
  const body = await res.json();
  if (res.status !== 200) throw new Error(`bridge ${name} -> HTTP ${res.status}: ${body.text} (pid ${info.pid}, port ${info.port})`);
  return body;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [name, arg, out] = process.argv.slice(2);
  if (!name) {
    console.error('usage: node scripts/bridge.mjs <tool> [json | @file.json] [image-out.jpg]');
    process.exit(2);
  }
  const input = !arg ? {} : arg.startsWith('@') ? JSON.parse(readFileSync(arg.slice(1), 'utf8')) : JSON.parse(arg);
  const r = await callBridge(name, input);
  console.log(r.text);
  if (r.jpegBase64 && out) {
    writeFileSync(out, Buffer.from(r.jpegBase64, 'base64'));
    console.log(`image -> ${out}`);
  }
  if (r.isError) process.exit(1);
}
