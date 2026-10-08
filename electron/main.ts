import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { AgentToolResult, ToolName } from '../shared/agentOps';
import type { ExportEvent, ExportOptions, OpenedProject, SfxEntry, TextFile, TextImage } from '../shared/api';
import { MEDIA_SCHEME } from '../shared/api';
import type { MediaAsset, Project } from '../shared/project';
import { normalizeProject } from '../shared/project';
import { callRendererTool, callTool, registerAgent } from './agent';
import { startBridge } from './bridge';
import type { RunningExport } from './exporter';
import { runBake, runExport } from './exporter';
import { makeSubjectFile } from './matte';
import { importMedia, makeSolidImage, makeStillImage } from './media';

const isTest = process.env.CUTDESK_TEST === '1';

protocol.registerSchemesAsPrivileged([
  { scheme: MEDIA_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

const CORS = { 'Access-Control-Allow-Origin': '*' };

function serveFile(request: Request): Response {
  const url = new URL(request.url);
  const path = decodeURIComponent(url.pathname.slice(1));
  if (!existsSync(path)) return new Response('not found', { status: 404 });
  const size = statSync(path).size;
  const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '');
  if (!range) {
    const body = Readable.toWeb(createReadStream(path)) as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: { ...CORS, 'Content-Type': type, 'Content-Length': String(size), 'Accept-Ranges': 'bytes' },
    });
  }
  const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
  const end = range[1] !== '' && range[2] !== '' ? Math.min(size - 1, Number(range[2])) : size - 1;
  if (start >= size || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  const body = Readable.toWeb(createReadStream(path, { start, end })) as ReadableStream;
  return new Response(body, {
    status: 206,
    headers: {
      ...CORS,
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

let win: BrowserWindow | null = null;
let currentExport: RunningExport | null = null;

function cacheDir(): string {
  const dir = join(app.getPath('userData'), 'thumbs');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#141416',
    title: 'cutdesk',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  registerAgent(win, isTest);
  void win.loadFile(join(__dirname, '..', '..', 'dist', 'index.html'));
}

interface SfxManifestItem {
  file: string;
  name: string;
  group: string;
}

/** Bundled sound effects: `sfx/sfx.json` next to the app, each file checked so a missing one fails here, not at probe. */
function listSfx(): SfxEntry[] {
  const dir = join(app.getAppPath(), 'sfx');
  const items = JSON.parse(readFileSync(join(dir, 'sfx.json'), 'utf8')) as SfxManifestItem[];
  return items.map((it) => {
    const path = join(dir, it.file);
    if (!existsSync(path)) throw new Error(`sfx file missing: ${path}`);
    return { name: it.name, group: it.group, path };
  });
}

async function probePaths(paths: string[]): Promise<MediaAsset[]> {
  const dir = cacheDir();
  const assets: MediaAsset[] = [];
  for (const p of paths) assets.push(await importMedia(p, dir));
  return assets;
}

/** A one-color image asset; the PNG lives under userData so it outlives the project folder layout. */
async function makeSolid(color: string, width: number, height: number): Promise<MediaAsset> {
  const dir = join(app.getPath('userData'), 'solids');
  mkdirSync(dir, { recursive: true });
  const path = await makeSolidImage(color, width, height, dir);
  const asset = await importMedia(path, cacheDir());
  const hex = color.toUpperCase();
  return { ...asset, name: `단색 ${hex}`, solid: hex };
}

/** A held frame of a clip's source, kept under userData beside the solids. */
async function makeStill(asset: MediaAsset, seconds: number): Promise<MediaAsset> {
  const dir = join(app.getPath('userData'), 'stills');
  mkdirSync(dir, { recursive: true });
  const path = await makeStillImage(asset.path, seconds, asset.alpha, dir);
  const still = await importMedia(path, cacheDir());
  return { ...still, name: `${asset.name} 정지 ${seconds.toFixed(2)}초` };
}

/** Local bridge dispatch: file probing runs here, everything else in the editor window. */
async function bridgeTool(name: ToolName, input: unknown): Promise<AgentToolResult> {
  if (name === 'probe_media') {
    const paths = (input as { paths?: unknown }).paths;
    if (!Array.isArray(paths) || !paths.every((x) => typeof x === 'string')) return { text: 'probe_media needs { paths: string[] }', isError: true };
    try {
      return { text: JSON.stringify(await probePaths(paths)) };
    } catch (err) {
      return { text: `probe_media failed for ${JSON.stringify(paths)}: ${(err as Error).message}`, isError: true };
    }
  }
  if (name === 'load_project' || name === 'export') return callRendererTool(name, input);
  return callTool(name, input);
}

function send(event: ExportEvent): void {
  win?.webContents.send('export:event', event);
}

function registerIpc(): void {
  ipcMain.handle('app:isTest', () => isTest);

  ipcMain.handle('media:pick', async () => {
    if (!win) return [];
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: '미디어',
          extensions: ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'mp3', 'm4a', 'aac', 'wav', 'ogg', 'png', 'jpg', 'jpeg', 'webp'],
        },
      ],
    });
    return res.canceled ? [] : res.filePaths;
  });

  ipcMain.handle('media:probe', (_e, paths: string[]): Promise<MediaAsset[]> => probePaths(paths));
  ipcMain.handle('sfx:list', (): SfxEntry[] => listSfx());
  ipcMain.handle('media:solid', (_e, color: string, width: number, height: number): Promise<MediaAsset> => makeSolid(color, width, height));
  ipcMain.handle('media:still', (_e, asset: MediaAsset, seconds: number): Promise<MediaAsset> => makeStill(asset, seconds));
  ipcMain.handle('media:subject', async (_e, asset: MediaAsset, from: number, to: number, fps: number): Promise<MediaAsset> => {
    const matteRoot = join(app.getPath('userData'), 'mattes');
    const outRoot = join(app.getPath('userData'), 'subjects');
    mkdirSync(matteRoot, { recursive: true });
    mkdirSync(outRoot, { recursive: true });
    const script = join(__dirname, '..', '..', 'tools', 'matte.py');
    try {
      const path = await makeSubjectFile(asset, from, to, fps, matteRoot, outRoot, script, (done, total) =>
        win?.webContents.send('matte:progress', { assetId: asset.id, done, total }),
      );
      const made = await importMedia(path, cacheDir());
      return { ...made, name: `피사체 ${asset.name}` };
    } catch (err) {
      console.error(`[subject] ${asset.path} [${from}, ${to}] @${fps}: ${(err as Error).message}`);
      throw err;
    }
  });

  ipcMain.handle('media:bake', async (_e, project: Project, name: string): Promise<MediaAsset> => {
    const outRoot = join(app.getPath('userData'), 'merged');
    mkdirSync(outRoot, { recursive: true });
    const key = createHash('sha1').update(JSON.stringify({ ...project, name: '' })).digest('hex');
    const out = join(outRoot, `${key}.webm`);
    try {
      if (!existsSync(out)) {
        const tmp = `${out}.part.webm`;
        await runBake(project, tmp);
        renameSync(tmp, out);
      }
      const made = await importMedia(out, cacheDir());
      return { ...made, name };
    } catch (err) {
      console.error(`[bake] ${name}: ${(err as Error).message}`);
      throw err;
    }
  });

  /** Remembers the project file last opened or saved, so the next launch can bring it back. */
  const lastProjectFile = join(app.getPath('userData'), 'last-project.json');
  const rememberProject = (path: string) => writeFileSync(lastProjectFile, JSON.stringify({ path }), 'utf8');
  const readProject = (path: string): OpenedProject => {
    const project = normalizeProject(JSON.parse(readFileSync(path, 'utf8')) as Project);
    if (project.version !== 1) throw new Error(`unsupported project version: ${String(project.version)}`);
    const missing = project.assets.filter((a) => !existsSync(a.path)).map((a) => a.path);
    return { path, project, missing };
  };

  ipcMain.handle('project:save', async (_e, project: Project, path: string | null) => {
    let target = path;
    if (!target) {
      if (!win) return null;
      const res = await dialog.showSaveDialog(win, {
        defaultPath: 'untitled.cutdesk.json',
        filters: [{ name: 'cutdesk 프로젝트', extensions: ['json'] }],
      });
      if (res.canceled || !res.filePath) return null;
      target = res.filePath;
    }
    writeFileSync(target, JSON.stringify(project, null, 2), 'utf8');
    if (!isTest) rememberProject(target);
    return target;
  });

  ipcMain.handle('project:open', async (): Promise<OpenedProject | null> => {
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'cutdesk 프로젝트', extensions: ['json'] }],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const opened = readProject(res.filePaths[0]);
    if (!isTest) rememberProject(opened.path);
    return opened;
  });

  ipcMain.handle('project:openLast', (): OpenedProject | null => {
    if (isTest || !existsSync(lastProjectFile)) return null;
    const { path } = JSON.parse(readFileSync(lastProjectFile, 'utf8')) as { path: string };
    return existsSync(path) ? readProject(path) : null;
  });

  ipcMain.handle('export:pickPath', async () => {
    if (!win) return null;
    const res = await dialog.showSaveDialog(win, {
      defaultPath: 'reel.mp4',
      filters: [{ name: 'MP4', extensions: ['mp4'] }],
    });
    return res.canceled || !res.filePath ? null : res.filePath;
  });

  ipcMain.handle('export:start', (_e, project: Project, options: ExportOptions, texts: TextImage[]) => {
    if (currentExport) throw new Error('an export is already running');
    const job = runExport(project, options.height, options.outPath, texts, (ratio) => send({ type: 'progress', ratio }));
    currentExport = job;
    void job.done.then((event) => {
      currentExport = null;
      if (event.type === 'error') console.error(`[export] ${event.message}`);
      send(event);
    });
  });

  ipcMain.handle('export:cancel', () => {
    currentExport?.cancel();
  });

  ipcMain.handle('shell:showItem', (_e, path: string) => {
    shell.showItemInFolder(path);
  });

  ipcMain.handle('file:readText', (_e, path: string) => readFileSync(path, 'utf8'));

  ipcMain.handle(
    'file:openText',
    async (_e, extensions: string[], defaultPath: string | null): Promise<TextFile | null> => {
      if (!win) return null;
      const res = await dialog.showOpenDialog(win, {
        properties: ['openFile'],
        defaultPath: defaultPath ?? undefined,
        filters: [{ name: extensions.join(', '), extensions }],
      });
      if (res.canceled || res.filePaths.length === 0) return null;
      const path = res.filePaths[0];
      return { path, content: readFileSync(path, 'utf8') };
    },
  );

  ipcMain.handle('file:saveText', async (_e, content: string, defaultName: string, extensions: string[]) => {
    if (!win) return null;
    const res = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      filters: [{ name: extensions.join(', '), extensions }],
    });
    if (res.canceled || !res.filePath) return null;
    writeFileSync(res.filePath, content, 'utf8');
    return res.filePath;
  });
}

void app.whenReady().then(() => {
  protocol.handle(MEDIA_SCHEME, serveFile);
  registerIpc();
  createWindow();
  if (!isTest) app.on('will-quit', startBridge(app.getPath('userData'), bridgeTool));
});

app.on('window-all-closed', () => {
  currentExport?.cancel();
  app.quit();
});
