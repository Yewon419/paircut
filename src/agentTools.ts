import { z } from 'zod';
import type { AgentToolResult, ToolName } from '../shared/agentOps';
import { EditOp } from '../shared/agentOps';
import type { ClipColor } from '../shared/color';
import { isNeutral, NEUTRAL_COLOR } from '../shared/color';
import type { AnyClip, Clip, Project, TextClip } from '../shared/project';
import { assetById, clipDuration, clipEnd, isMediaClip, isTextClip, normalizeProject, projectDuration } from '../shared/project';
import { allPresets, savePreset } from './colorPresets';
import { BOARD_KEY, DEFAULT_BOARD_PATH } from './components/SidePanel';
import { draftFromRows, parseBoard } from './conti';
import { compositor, pause } from './engine/player';
import { textImagesFor } from './exportTexts';
import { makeTextClip, presetById } from './presets';
import { checkRules } from './rules';
import {
  commit,
  findClip,
  frameSnap,
  mainTrackId,
  moveClip,
  overlaps,
  setClipSpeed,
  setPlayhead,
  splitClips,
  tidyTracks,
  trackKindFor,
  uid,
  updateClip,
  updateMediaClip,
  updateTextClip,
  useEditor,
  withAsset,
  withColorAll,
  withTextClip,
  withTextTracks,
  withTrack,
} from './store';

/** Preview frames for Claude: 270x480 JPEG is about 170 image tokens. */
const SHOT_W = 270;
const SHOT_H = 480;

const EditInput = z.object({ ops: z.array(EditOp).min(1) });
const ShotInput = z.object({ t: z.number().min(0).optional() });
const ExportInput = z.object({ outPath: z.string().min(1), height: z.number().int().positive().default(1920) });

const n = (x: number): string => String(Math.round(x * 100) / 100);
const q = (s: string): string => JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}…` : s);

function colorText(c: ClipColor): string {
  return (Object.keys(c) as (keyof ClipColor)[])
    .filter((k) => c[k] !== 0)
    .map((k) => `${k}=${n(c[k])}`)
    .join(',');
}

/** Short asset names (A1, A2, ...) instead of 36-character ids; edit accepts either. */
function alias(p: Project, assetId: string): string {
  return `A${p.assets.findIndex((a) => a.id === assetId) + 1}`;
}

function clipLine(p: Project, c: AnyClip): string {
  const head = `${c.id} ${n(c.start)}-${n(clipEnd(c))}`;
  if (isTextClip(c)) {
    const extra = [`${c.preset}`, q(c.text), `pos=${n(c.x)},${n(c.y)}`, `font=${c.style.font}`, `size=${c.style.size}`];
    if (c.style.tracking) extra.push(`tracking=${n(c.style.tracking)}`);
    if (c.style.shadow) extra.push(`shadow=${n(c.style.shadow)}`);
    if (c.anim !== 'none') extra.push(`anim=${c.anim}`);
    if (c.style.highlight) extra.push(`hl=${q(c.style.highlight)}`);
    return `${head} ${extra.join(' ')}`;
  }
  const asset = assetById(p, c.assetId);
  const extra = [alias(p, asset.id)];
  if (asset.kind !== 'image') extra.push(`src=${n(c.in)}-${n(c.out)}`);
  if (c.speed !== 1) extra.push(`speed=${n(c.speed)}`);
  if (c.dissolve > 0) extra.push(`dissolve=${n(c.dissolve)}`);
  if (c.volume !== 1) extra.push(`vol=${n(c.volume)}`);
  if (c.fadeIn > 0) extra.push(`fadeIn=${n(c.fadeIn)}`);
  if (c.fadeOut > 0) extra.push(`fadeOut=${n(c.fadeOut)}`);
  const tr = c.transform;
  if (tr.scale !== 1 || tr.x !== 0 || tr.y !== 0) extra.push(`scale=${n(tr.scale)} xy=${n(tr.x)},${n(tr.y)}`);
  if (!isNeutral(c.color)) extra.push(`color(${colorText(c.color)})`);
  return `${head} ${extra.join(' ')}`;
}

/** Whole editor state as compact text; defaults are omitted so Claude reads fewer tokens. */
export function stateText(): string {
  const { project: p, playhead, selectedClipId } = useEditor.getState();
  const v = p.vars;
  const lines = [
    `duration=${n(projectDuration(p))}s playhead=${n(playhead)} selected=${selectedClipId ?? '-'} fps=${p.fps}`,
    `vars uploadDate=${v.uploadDate} ddayTarget=${v.ddayTarget} salary=${v.salary} goal=${v.goal}`,
    'assets:',
    ...p.assets.map(
      (a) => `  ${alias(p, a.id)} ${a.kind} ${q(a.name)}${a.kind === 'image' ? '' : ` ${n(a.duration)}s`} ${a.width}x${a.height}`,
    ),
    'tracks (top to bottom, upper tracks draw over lower):',
  ];
  const mains = new Set(['video', 'audio', 'text'].map((k) => p.tracks.filter((t) => t.kind === k).at(-1)?.id));
  for (const t of p.tracks) {
    const flags = [t.kind, mains.has(t.id) ? 'main' : '', t.muted ? 'muted' : '', t.hidden ? 'hidden' : ''].filter(Boolean);
    lines.push(`  ${t.id} [${flags.join(' ')}]`);
    for (const c of t.clips) lines.push(`    ${clipLine(p, c)}`);
  }
  if (p.markers.length) lines.push(`markers: ${p.markers.map((m) => `${n(m.t)} ${q(m.label)}`).join('; ')}`);
  const issues = checkRules(p);
  lines.push(issues.length ? 'rule issues:' : 'rule issues: none');
  for (const i of issues) lines.push(`  ${i.rule} @${n(i.t)}${i.clipId ? ` ${i.clipId}` : ''} ${i.message}`);
  lines.push(`color presets: ${allPresets().map((x) => `${q(x.name)}(${colorText(x.color) || 'neutral'})`).join('; ')}`);
  return lines.join('\n');
}

class OpError extends Error {}

function need(p: Project, clipId: string): { trackId: string; clip: AnyClip } {
  const found = findClip(p, clipId);
  if (!found) throw new OpError(`no clip ${clipId}`);
  return { trackId: found.track.id, clip: found.clip };
}

function needMedia(p: Project, clipId: string): Clip {
  const { clip } = need(p, clipId);
  if (!isMediaClip(clip)) throw new OpError(`${clipId} is a text clip`);
  return clip;
}

function needText(p: Project, clipId: string): TextClip {
  const { clip } = need(p, clipId);
  if (!isTextClip(clip)) throw new OpError(`${clipId} is not a text clip`);
  return clip;
}

/** New timeline start and/or end; video and audio keep their source frames, images and text stretch. */
function trimmed(p: Project, clipId: string, start: number | undefined, end: number | undefined): Project {
  const { trackId, clip } = need(p, clipId);
  const s = frameSnap(start ?? clip.start, p.fps);
  const e = frameSnap(end ?? clipEnd(clip), p.fps);
  if (e - s < 1 / p.fps - 1e-6) throw new OpError(`trim ${clipId}: end must be after start`);
  const rate = isMediaClip(clip) ? clip.speed : 1;
  const asset = isMediaClip(clip) ? assetById(p, clip.assetId) : null;
  let next: AnyClip;
  if (!asset || asset.kind === 'image') {
    next = { ...clip, start: s, out: clip.in + (e - s) * rate };
  } else {
    const inPoint = clip.in + (s - clip.start) * rate;
    const out = inPoint + (e - s) * rate;
    if (inPoint < -1e-6) throw new OpError(`trim ${clipId}: source starts ${n(-inPoint / rate)}s too early`);
    if (out > asset.duration + 1e-6) throw new OpError(`trim ${clipId}: source is only ${n(asset.duration)}s long`);
    next = { ...clip, start: s, in: Math.max(0, inPoint), out: Math.min(asset.duration, out) };
  }
  const track = p.tracks.find((t) => t.id === trackId);
  if (track && overlaps(track, next.start, clipEnd(next), clipId)) throw new OpError(`trim ${clipId}: overlaps a clip`);
  return updateClip(p, clipId, () => next);
}

function presetColor(name: string): ClipColor {
  const preset = allPresets().find((x) => x.name === name);
  if (!preset) throw new OpError(`no color preset ${q(name)}; have ${allPresets().map((x) => q(x.name)).join(', ')}`);
  return preset.color;
}

async function readBoard() {
  const path = localStorage.getItem(BOARD_KEY) ?? DEFAULT_BOARD_PATH;
  return parseBoard(JSON.parse(await window.api.readTextFile(path)));
}

interface Draft {
  p: Project;
  selected: string | null;
  playhead: number | null;
  /** Side effects outside the project (preset storage), run only after every op succeeded. */
  after: (() => void)[];
}

async function applyOp(d: Draft, op: EditOp): Promise<void> {
  const p = d.p;
  switch (op.op) {
    case 'seek':
      d.playhead = op.t;
      return;
    case 'select':
      if (op.clip) need(p, op.clip);
      d.selected = op.clip;
      return;
    case 'move': {
      const { trackId } = need(p, op.clip);
      const next = moveClip(p, op.clip, op.track ?? trackId, frameSnap(op.start, p.fps));
      if (!next) throw new OpError(`move ${op.clip}: target track missing, of another kind, or occupied there`);
      d.p = next;
      return;
    }
    case 'trim':
      d.p = trimmed(p, op.clip, op.start, op.end);
      return;
    case 'split': {
      const { clip } = need(p, op.clip);
      const t = frameSnap(op.t, p.fps);
      if (t <= clip.start || t >= clipEnd(clip)) throw new OpError(`split ${op.clip}: t=${n(t)} is not inside ${n(clip.start)}-${n(clipEnd(clip))}`);
      d.p = splitClips(p, t, new Set([op.clip]));
      return;
    }
    case 'delete':
      need(p, op.clip);
      d.p = { ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== op.clip) })) };
      if (d.selected === op.clip) d.selected = null;
      return;
    case 'add_media': {
      const short = /^A(\d+)$/.exec(op.asset);
      const asset = short ? p.assets[Number(short[1]) - 1] : p.assets.find((a) => a.id === op.asset);
      if (!asset) throw new OpError(`no asset ${op.asset}`);
      const kind = trackKindFor(asset);
      if (op.track === 'new') {
        d.p = withAsset(p, asset, null, op.start ?? 0, kind === 'audio' ? p.tracks.length : 0);
        return;
      }
      const trackId = op.track ?? mainTrackId(p, kind);
      const track = p.tracks.find((t) => t.id === trackId);
      if (!track || track.kind !== kind) throw new OpError(`add_media: ${trackId} is not a ${kind} track`);
      const end = track.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
      d.p = withAsset(p, asset, trackId, op.start ?? end, 0);
      return;
    }
    case 'add_text': {
      const preset = presetById(op.preset);
      const over: Partial<TextClip> = {};
      if (op.text !== undefined) over.text = op.text;
      if (op.dur !== undefined) over.out = op.dur;
      d.p = withTextClip(p, makeTextClip(preset, uid('c'), frameSnap(op.start, p.fps), over));
      return;
    }
    case 'set_text': {
      needText(p, op.clip);
      d.p = updateTextClip(p, op.clip, (c) => ({
        ...c,
        text: op.text ?? c.text,
        x: op.x ?? c.x,
        y: op.y ?? c.y,
        anim: op.anim ?? c.anim,
        style: {
          ...c.style,
          size: op.size ?? c.style.size,
          color: op.color ?? c.style.color,
          font: op.font ?? c.style.font,
          tracking: op.tracking ?? c.style.tracking,
          shadow: op.shadow ?? c.style.shadow,
          highlight: op.highlight ?? c.style.highlight,
        },
      }));
      return;
    }
    case 'set_clip': {
      needMedia(p, op.clip);
      let next = op.speed === undefined ? p : setClipSpeed(p, op.clip, op.speed);
      const dur = clipDuration(needMedia(next, op.clip));
      for (const [k, v] of [['fadeIn', op.fadeIn], ['fadeOut', op.fadeOut]] as const) {
        if (v !== undefined && v > dur + 1e-6) throw new OpError(`set_clip ${op.clip}: ${k} ${n(v)}s is longer than the clip (${n(dur)}s)`);
      }
      next = updateMediaClip(next, op.clip, (c) => ({
        ...c,
        volume: op.volume ?? c.volume,
        dissolve: op.dissolve ?? c.dissolve,
        fadeIn: op.fadeIn ?? c.fadeIn,
        fadeOut: op.fadeOut ?? c.fadeOut,
        transform: { scale: op.scale ?? c.transform.scale, x: op.x ?? c.transform.x, y: op.y ?? c.transform.y },
      }));
      d.p = next;
      return;
    }
    case 'color': {
      const base = op.preset !== undefined ? presetColor(op.preset) : null;
      if (op.clip === 'all') {
        d.p = withColorAll(p, { ...(base ?? NEUTRAL_COLOR), ...op.values });
        return;
      }
      const clip = needMedia(p, op.clip);
      if (assetById(p, clip.assetId).kind === 'audio') throw new OpError(`color ${op.clip}: audio clips have no picture`);
      d.p = updateMediaClip(p, op.clip, (c) => ({ ...c, color: { ...(base ?? c.color), ...op.values } }));
      return;
    }
    case 'save_color_preset': {
      const color = needMedia(p, op.clip).color;
      if (allPresets().some((x) => x.builtin && x.name === op.name.trim())) throw new OpError(`${q(op.name)} is a built-in preset name`);
      d.after.push(() => savePreset(op.name, color));
      return;
    }
    case 'track': {
      if (!p.tracks.some((t) => t.id === op.track)) throw new OpError(`no track ${op.track}`);
      d.p = withTrack(p, op.track, (t) => ({ ...t, muted: op.muted ?? t.muted, hidden: op.hidden ?? t.hidden }));
      return;
    }
    case 'vars': {
      const v = p.vars;
      d.p = {
        ...p,
        vars: {
          uploadDate: op.uploadDate ?? v.uploadDate,
          ddayTarget: op.ddayTarget ?? v.ddayTarget,
          salary: op.salary ?? v.salary,
          goal: op.goal ?? v.goal,
        },
      };
      return;
    }
    case 'import_conti': {
      const board = await readBoard();
      const post = board.posts.find((x) => x.id === op.post);
      if (!post) throw new OpError(`no board post ${op.post}; have ${board.posts.map((x) => x.id).join(', ')}`);
      const draft = draftFromRows(post.rows, () => uid('c'));
      const next = withTextTracks(p, [draft.mains, draft.asides]);
      d.p = { ...next, markers: draft.markers, vars: { ...board.vars, uploadDate: post.date || p.vars.uploadDate } };
      return;
    }
  }
}

function clipIds(p: Project): Set<string> {
  return new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.id)));
}

/** Applies every op to a draft and commits once (one undo step); if any op fails nothing changes. */
export async function applyEdit(input: unknown): Promise<AgentToolResult> {
  const parsed = EditInput.safeParse(input);
  if (!parsed.success) return { text: `invalid edit input, nothing was changed: ${z.prettifyError(parsed.error)}`, isError: true };
  const { ops } = parsed.data;
  const state = useEditor.getState();
  const d: Draft = { p: state.project, selected: state.selectedClipId, playhead: null, after: [] };
  const notes: string[] = [];
  for (const [i, op] of ops.entries()) {
    const before = clipIds(d.p);
    try {
      await applyOp(d, op);
    } catch (err) {
      return { text: `op #${i} (${op.op}) failed, nothing was changed: ${(err as Error).message}`, isError: true };
    }
    const added = [...clipIds(d.p)].filter((id) => !before.has(id));
    if (added.length) notes.push(`#${i} ${op.op} -> ${added.length > 6 ? `${added.length} clips, see get_state` : added.join(' ')}`);
  }
  if (d.p !== state.project) {
    const next = tidyTracks(d.p);
    commit(() => next);
  }
  for (const run of d.after) run();
  if (d.selected !== state.selectedClipId) useEditor.setState({ selectedClipId: d.selected });
  if (d.playhead !== null) {
    pause();
    setPlayhead(d.playhead);
  }
  return { text: `ok, ${ops.length} op(s) as one undo step${notes.length ? `; new clips: ${notes.join('; ')}` : ''}` };
}

/** Preview frame at t (default: playhead), without selection handles. */
export async function screenshot(input: unknown): Promise<AgentToolResult> {
  const { t } = ShotInput.parse(input);
  if (t !== undefined) {
    pause();
    setPlayhead(t);
  }
  const { project, playhead } = useEditor.getState();
  compositor.sync(project, playhead, false);
  await compositor.settled(project, playhead);
  const jpegBase64 = compositor.snapshot(project, playhead, SHOT_W, SHOT_H);
  return { text: `preview at ${n(playhead)}s (${SHOT_W}x${SHOT_H})`, jpegBase64 };
}

/** Bridge: replaces the whole project as one undo step, keeping the open file path. */
function loadProjectTool(input: unknown): AgentToolResult {
  const project = (input as { project?: Project }).project;
  if (!project || project.version !== 1 || !Array.isArray(project.tracks) || !Array.isArray(project.assets)) {
    return { text: 'load_project needs { project } with version 1, tracks and assets; nothing was changed', isError: true };
  }
  const ids = new Set(project.assets.map((a) => a.id));
  const orphan = project.tracks.flatMap((t) => t.clips).find((c) => isMediaClip(c) && !ids.has(c.assetId));
  if (orphan) return { text: `load_project: clip ${orphan.id} uses a missing asset; nothing was changed`, isError: true };
  const next = normalizeProject(project);
  commit(() => next);
  useEditor.setState({ selectedClipId: null });
  return { text: `ok, project replaced as one undo step (${n(projectDuration(next))}s)` };
}

/** Bridge: renders the current project to outPath and resolves when the file is written. */
async function exportTool(input: unknown): Promise<AgentToolResult> {
  const { outPath, height } = ExportInput.parse(input);
  const project = useEditor.getState().project;
  const done = await new Promise<string>((resolve, reject) => {
    const off = window.api.onExportEvent((ev) => {
      if (ev.type === 'done') {
        off();
        resolve(ev.outPath);
      } else if (ev.type === 'error' || ev.type === 'cancelled') {
        off();
        reject(new Error(ev.type === 'error' ? ev.message : 'export cancelled'));
      }
    });
    window.api.startExport(project, { outPath, height }, textImagesFor(project, height)).catch((err: unknown) => {
      off();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
  return { text: `exported ${done} (${n(projectDuration(project))}s, height ${height})` };
}

export async function runAgentTool(name: ToolName, input: unknown): Promise<AgentToolResult> {
  try {
    if (name === 'get_state') return { text: stateText() };
    if (name === 'edit') return await applyEdit(input);
    if (name === 'screenshot') return await screenshot(input);
    if (name === 'load_project') return loadProjectTool(input);
    if (name === 'export') return await exportTool(input);
    return { text: `${name} is handled by the main process`, isError: true };
  } catch (err) {
    console.error(`[agent] ${name} failed`, err);
    return { text: `${name} failed: ${(err as Error).message}`, isError: true };
  }
}
