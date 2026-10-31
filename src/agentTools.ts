import { z } from 'zod';
import type { AgentToolResult, ToolName } from '../shared/agentOps';
import { EditOp } from '../shared/agentOps';
import type { ClipColor } from '../shared/color';
import { FILTERS, isNeutral, NEUTRAL_COLOR } from '../shared/color';
import type { AnyClip, Clip, Project, TextClip } from '../shared/project';
import type { TextSpan } from '../shared/project';
import {
  ASPECT_IDS,
  assetById,
  canClip,
  clipDuration,
  clipEnd,
  CROP_MAX,
  emptyProject,
  hasCrop,
  isMediaClip,
  isTextClip,
  layerBlend,
  layerOpacity,
  normalizeProject,
  projectDuration,
  spanIndex,
  validCustomFont,
  withAspect,
} from '../shared/project';
import { allPresets, savePreset } from './colorPresets';
import { compositor, pause } from './engine/player';
import { fontInstalled } from './engine/text';
import { textImagesFor } from './exportTexts';
import { saveThumb } from './projectThumb';
import { BASIC_TEXT, makeTextClip } from './presets';
import {
  commit,
  findClip,
  frameSnap,
  loadProject,
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
  withTrack,
} from './store';

/** Preview frames for Claude: 270x480 JPEG is about 170 image tokens. */
const SHOT_W = 270;
const SHOT_H = 480;

const EditInput = z.object({ ops: z.array(EditOp).min(1) });
const ShotInput = z.object({ t: z.number().min(0).optional() });
const ExportInput = z.object({ outPath: z.string().min(1), height: z.number().int().positive().optional() });
const NewProjectInput = z.object({ path: z.string().min(1).optional(), discard: z.boolean().default(false), aspect: z.enum(ASPECT_IDS).default('9:16') });
const SaveProjectInput = z.object({ path: z.string().min(1).optional() });
const SHEET_MAX = 24;
const SheetInput = z
  .object({
    times: z.array(z.number().min(0)).min(1).optional(),
    from: z.number().min(0).optional(),
    to: z.number().min(0).optional(),
    step: z.number().positive().optional(),
    cols: z.number().int().min(1).max(8).default(4),
    cellW: z.number().int().min(90).max(540).default(270),
  })
  .refine((v) => (v.times !== undefined) !== (v.step !== undefined), 'give either times or from/to/step');

const n = (x: number): string => String(Math.round(x * 100) / 100);
const q = (s: string): string => JSON.stringify(s.length > 40 ? `${s.slice(0, 40)}…` : s);

function colorText(c: ClipColor): string {
  return (Object.keys(c) as (keyof ClipColor)[])
    .filter((k) => c[k] !== 0)
    .map((k) => (k === 'filter' ? `filter=${FILTERS[c.filter - 1]?.name ?? c.filter}` : `${k}=${n(c[k])}`))
    .join(',');
}

type ColorValues = NonNullable<Extract<EditOp, { op: 'color' }>['values']>;

/** `values` over `base`, the filter name turned into its index; a new filter starts at full strength like the inspector. */
function withValues(base: ClipColor, values: ColorValues): ClipColor {
  const { filter, ...rest } = values;
  const next = { ...base, ...rest };
  if (filter === undefined) return next;
  const index = filter === 'none' ? 0 : FILTERS.findIndex((f) => f.name === filter) + 1;
  if (index === 0) return { ...next, filter: 0, filterAmount: 0 };
  return { ...next, filter: index, filterAmount: rest.filterAmount ?? (base.filter === 0 ? 1 : base.filterAmount) };
}

function spanText(sp: TextSpan, found: boolean): string {
  const parts = [`${q(sp.match)}#${sp.nth}`];
  if (sp.color) parts.push(`color=${sp.color}`);
  if (sp.font) parts.push(`font=${sp.font}`);
  if (sp.scale !== undefined) parts.push(`scale=${n(sp.scale)}`);
  if (sp.rotate !== undefined) parts.push(`rot=${n(sp.rotate)}`);
  if (sp.dx !== undefined || sp.dy !== undefined) parts.push(`dxy=${n(sp.dx ?? 0)},${n(sp.dy ?? 0)}`);
  return `span(${parts.join(' ')}${found ? '' : ' MISSING, text no longer contains it'})`;
}

/** Short asset names (A1, A2, ...) instead of 36-character ids; edit accepts either. */
function alias(p: Project, assetId: string): string {
  return `A${p.assets.findIndex((a) => a.id === assetId) + 1}`;
}

function clipLine(p: Project, c: AnyClip): string {
  const head = `${c.id} ${n(c.start)}-${n(clipEnd(c))}`;
  if (isTextClip(c)) {
    const extra = [`${c.preset}`, q(c.text), `pos=${n(c.x)},${n(c.y)}`, `font=${c.style.font}`, `size=${c.style.size}`];
    if (c.style.customFont) {
      extra.push(`pcFont=${q(c.style.customFont)}${fontInstalled(c.style.customFont) ? '' : '(MISSING, drawn in font)'}`);
    }
    if (c.style.tracking) extra.push(`tracking=${n(c.style.tracking)}`);
    if (c.style.shadow) extra.push(`shadow=${n(c.style.shadow)}`);
    if (c.style.effect !== 'none') extra.push(`fx=${c.style.effect}`);
    if (c.anim !== 'none') extra.push(`anim=${c.anim}`);
    if (c.style.highlight) extra.push(`hl=${q(c.style.highlight)}`);
    if (c.rotation) extra.push(`rot=${n(c.rotation)}`);
    for (const sp of c.spans) extra.push(spanText(sp, spanIndex(c.text, sp.match, sp.nth) !== -1));
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
  if (c.keys?.length) extra.push(`keys=${c.keys.map((k) => `${n(k.t)}:${n(k.scale)}@${n(k.x)},${n(k.y)}`).join('/')} (keyframes override scale/xy)`);
  if (hasCrop(c.crop)) extra.push(`crop=${n(c.crop.l)},${n(c.crop.t)},${n(c.crop.r)},${n(c.crop.b)}`);
  if (!isNeutral(c.color)) extra.push(`color(${colorText(c.color)})`);
  return `${head} ${extra.join(' ')}`;
}

/** Whole editor state as compact text; defaults are omitted so Claude reads fewer tokens. */
export function stateText(): string {
  const { project: p, playhead, selectedClipId, selectedTrackId } = useEditor.getState();
  const lines = [
    `duration=${n(projectDuration(p))}s playhead=${n(playhead)} selected=${selectedClipId ?? '-'} layer=${selectedTrackId ?? '-'} fps=${p.fps} size=${p.width}x${p.height}`,
    'assets:',
    ...p.assets.map(
      (a) =>
        `  ${alias(p, a.id)} ${a.kind} ${q(a.name)}${a.kind === 'image' ? '' : ` ${n(a.duration)}s`} ${a.width}x${a.height}` +
        `${a.alpha ? ' transparent' : ''}`,
    ),
    'tracks (top to bottom, upper tracks draw over lower):',
  ];
  const mains = new Set(['video', 'audio', 'text'].map((k) => p.tracks.filter((t) => t.kind === k).at(-1)?.id));
  for (const t of p.tracks) {
    const flags = [
      t.kind,
      mains.has(t.id) ? 'main' : '',
      t.muted ? 'muted' : '',
      t.hidden ? 'hidden' : '',
      layerBlend(t) !== 'normal' ? layerBlend(t) : '',
      layerOpacity(t) < 1 ? `opacity=${n(layerOpacity(t))}` : '',
      t.clipped ? 'clipped' : '',
    ].filter(Boolean);
    lines.push(`  ${t.id} [${flags.join(' ')}]`);
    for (const c of t.clips) lines.push(`    ${clipLine(p, c)}`);
  }
  if (p.markers.length) lines.push(`markers: ${p.markers.map((m) => `${n(m.t)} ${q(m.label)}`).join('; ')}`);
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
    case 'add_solid': {
      const made = await window.api.makeSolid(op.color, p.width, p.height);
      const known = p.assets.find((a) => a.path === made.path);
      const asset = known ?? made;
      const withIt = known ? p : { ...p, assets: [...p.assets, made] };
      const before = clipIds(withIt);
      let next: Project;
      if (op.track === 'new') {
        next = withAsset(withIt, asset, null, op.start ?? 0, 0);
      } else {
        const trackId = op.track ?? mainTrackId(withIt, 'video');
        const track = withIt.tracks.find((t) => t.id === trackId);
        if (!track || track.kind !== 'video') throw new OpError(`add_solid: ${trackId} is not a video track`);
        const end = track.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
        next = withAsset(withIt, asset, trackId, op.start ?? end, 0);
      }
      const added = [...clipIds(next)].find((cid) => !before.has(cid));
      if (!added) throw new OpError('add_solid: clip was not placed');
      d.p = op.dur === undefined ? next : trimmed(next, added, undefined, needMedia(next, added).start + op.dur);
      return;
    }
    case 'add_text': {
      const over: Partial<TextClip> = {};
      if (op.text !== undefined) over.text = op.text;
      if (op.dur !== undefined) over.out = op.dur;
      d.p = withTextClip(p, makeTextClip(BASIC_TEXT, uid('c'), frameSnap(op.start, p.fps), over));
      return;
    }
    case 'set_text': {
      needText(p, op.clip);
      if (op.customFont) {
        if (!validCustomFont(op.customFont)) throw new OpError(`set_text ${op.clip}: font name ${q(op.customFont)} has characters a font name cannot have`);
        if (!fontInstalled(op.customFont)) throw new OpError(`set_text ${op.clip}: font ${q(op.customFont)} is not installed on this PC`);
      }
      d.p = updateTextClip(p, op.clip, (c) => ({
        ...c,
        text: op.text ?? c.text,
        x: op.x ?? c.x,
        y: op.y ?? c.y,
        anim: op.anim ?? c.anim,
        rotation: op.rotation ?? c.rotation,
        style: {
          ...c.style,
          size: op.size ?? c.style.size,
          color: op.color ?? c.style.color,
          font: op.font ?? c.style.font,
          customFont: op.customFont ?? c.style.customFont,
          tracking: op.tracking ?? c.style.tracking,
          shadow: op.shadow ?? c.style.shadow,
          highlight: op.highlight ?? c.style.highlight,
          effect: op.effect ?? c.style.effect,
        },
      }));
      return;
    }
    case 'span': {
      const clip = needText(p, op.clip);
      const key = (sp: TextSpan) => sp.match === op.match && sp.nth === op.nth;
      if (op.remove) {
        if (!clip.spans.some(key)) throw new OpError(`span ${op.clip}: no styled part ${q(op.match)}#${op.nth}`);
        d.p = updateTextClip(p, op.clip, (c) => ({ ...c, spans: c.spans.filter((sp) => !key(sp)) }));
        return;
      }
      if (spanIndex(clip.text, op.match, op.nth) === -1) {
        throw new OpError(`span ${op.clip}: occurrence #${op.nth} of ${q(op.match)} is not in the text`);
      }
      const prev = clip.spans.find(key) ?? { match: op.match, nth: op.nth };
      const next: TextSpan = { ...prev };
      if (op.color !== undefined) next.color = op.color;
      if (op.font !== undefined) next.font = op.font;
      if (op.scale !== undefined) next.scale = op.scale;
      if (op.rotate !== undefined) next.rotate = op.rotate;
      if (op.dx !== undefined) next.dx = op.dx;
      if (op.dy !== undefined) next.dy = op.dy;
      d.p = updateTextClip(p, op.clip, (c) => ({
        ...c,
        spans: c.spans.some(key) ? c.spans.map((sp) => (key(sp) ? next : sp)) : [...c.spans, next],
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
      const target = needMedia(next, op.clip);
      const crop = { ...target.crop, ...op.crop };
      if (op.crop !== undefined) {
        if (assetById(next, target.assetId).kind === 'audio') throw new OpError(`set_clip ${op.clip}: audio clips have no picture to crop`);
        for (const [k, v] of Object.entries(crop)) {
          if (v < 0 || v > CROP_MAX) throw new OpError(`set_clip ${op.clip}: crop.${k} ${n(v)} is outside 0-${CROP_MAX}`);
        }
        if (crop.l + crop.r > CROP_MAX || crop.t + crop.b > CROP_MAX) {
          throw new OpError(`set_clip ${op.clip}: crop l+r and t+b must each be at most ${CROP_MAX} (got ${n(crop.l + crop.r)}, ${n(crop.t + crop.b)})`);
        }
      }
      next = updateMediaClip(next, op.clip, (c) => ({
        ...c,
        crop,
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
        d.p = withColorAll(p, withValues(base ?? NEUTRAL_COLOR, op.values ?? {}));
        return;
      }
      const clip = needMedia(p, op.clip);
      if (assetById(p, clip.assetId).kind === 'audio') throw new OpError(`color ${op.clip}: audio clips have no picture`);
      d.p = updateMediaClip(p, op.clip, (c) => ({ ...c, color: withValues(base ?? c.color, op.values ?? {}) }));
      return;
    }
    case 'save_color_preset': {
      const color = needMedia(p, op.clip).color;
      d.after.push(() => savePreset(op.name, color));
      return;
    }
    case 'track': {
      const track = p.tracks.find((t) => t.id === op.track);
      if (!track) throw new OpError(`no track ${op.track}`);
      const look = op.opacity !== undefined || op.blend !== undefined || op.clipped !== undefined;
      if (look && track.kind === 'audio') throw new OpError('opacity, blend and clipped are for picture layers, not audio');
      if (op.clipped && !canClip(p, op.track)) throw new OpError(`${op.track} is the bottom picture layer; there is nothing under it to clip to`);
      d.p = withTrack(p, op.track, (t) => {
        const next = { ...t, muted: op.muted ?? t.muted, hidden: op.hidden ?? t.hidden };
        const opacity = op.opacity ?? next.opacity ?? 1;
        const blend = op.blend ?? next.blend ?? 'normal';
        const clipped = op.clipped ?? next.clipped ?? false;
        delete next.opacity;
        delete next.blend;
        delete next.clipped;
        return {
          ...next,
          ...(opacity < 1 ? { opacity } : {}),
          ...(blend !== 'normal' ? { blend } : {}),
          ...(clipped ? { clipped } : {}),
        };
      });
      return;
    }
    case 'aspect':
      d.p = withAspect(p, op.aspect);
      return;
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
    const next = tidyTracks(state.project, d.p);
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

/** Clip ids on screen (or heard) at t, top track first, with a short text for text clips. */
function activeAt(project: Project, t: number): string {
  const ids = project.tracks
    .filter((tr) => !tr.hidden)
    .flatMap((tr) => tr.clips.filter((c) => c.start <= t && t < clipEnd(c)))
    .map((c) => (isTextClip(c) ? `${c.id}${q(c.text.replaceAll('\n', ' ').slice(0, 16))}` : c.id));
  return ids.length ? ids.join(' ') : '(empty)';
}

/**
 * Bridge: several preview frames in one grid JPEG, each labeled with its time and the clips on screen. For checking
 * timing and motion without exporting; frames come from the same compositor as the preview and screenshot.
 */
async function contactSheetTool(input: unknown): Promise<AgentToolResult> {
  const { times: given, from = 0, to, step, cols, cellW } = SheetInput.parse(input);
  const { project, playhead: before } = useEditor.getState();
  const end = to ?? projectDuration(project);
  const times = given ?? Array.from({ length: Math.floor((end - from) / (step ?? 1) + 1e-6) + 1 }, (_, i) => from + i * (step ?? 1));
  if (times.length > SHEET_MAX) {
    return { text: `contact_sheet: ${times.length} frames asked, at most ${SHEET_MAX}; widen step or narrow from/to`, isError: true };
  }
  const cellH = Math.round((cellW * project.height) / project.width);
  const LABEL = 20;
  const rows = Math.ceil(times.length / Math.min(cols, times.length));
  const used = Math.min(cols, times.length);
  const sheet = document.createElement('canvas');
  sheet.width = used * cellW;
  sheet.height = rows * (cellH + LABEL);
  const ctx = sheet.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, 0, sheet.width, sheet.height);
  ctx.font = '13px sans-serif';
  ctx.textBaseline = 'middle';
  const lines: string[] = [];
  pause();
  try {
    for (const [i, t] of times.entries()) {
      setPlayhead(t);
      compositor.sync(project, t, false);
      await compositor.settled(project, t);
      const x = (i % used) * cellW;
      const y = Math.floor(i / used) * (cellH + LABEL);
      ctx.drawImage(compositor.frame(project, t), x, y, cellW, cellH);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(`#${i + 1} ${n(t)}s`, x + 6, y + cellH + LABEL / 2, cellW - 12);
      lines.push(`#${i + 1} ${n(t)}s: ${activeAt(project, t)}`);
    }
  } finally {
    setPlayhead(before);
  }
  const jpegBase64 = sheet.toDataURL('image/jpeg', 0.8).replace(/^data:image\/jpeg;base64,/, '');
  return { text: `contact sheet ${sheet.width}x${sheet.height}, ${times.length} frames\n${lines.join('\n')}`, jpegBase64 };
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
  useEditor.setState({ selectedClipId: null, screen: 'editor' });
  return { text: `ok, project replaced as one undo step (${n(projectDuration(next))}s)` };
}

/** Bridge: renders the current project to outPath and resolves when the file is written. */
async function exportTool(input: unknown): Promise<AgentToolResult> {
  const parsed = ExportInput.parse(input);
  const project = useEditor.getState().project;
  const height = parsed.height ?? project.height;
  const outPath = parsed.outPath;
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

/** Writes the current project to path and makes it the open file. */
async function saveTo(path: string): Promise<string> {
  const saved = await window.api.saveProject(useEditor.getState().project, path);
  if (!saved) throw new Error(`saving to ${path} returned no path`);
  useEditor.setState({ filePath: saved, dirty: false });
  await saveThumb(saved);
  return saved;
}

/** Bridge: starts an empty project; refuses to drop unsaved work unless discard is set. */
async function newProjectTool(input: unknown): Promise<AgentToolResult> {
  const { path, discard, aspect } = NewProjectInput.parse(input);
  if (useEditor.getState().dirty && !discard) {
    return { text: 'new_project: the open project has unsaved changes; save_project first or pass discard:true. Nothing was changed', isError: true };
  }
  pause();
  loadProject(withAspect(emptyProject(), aspect), null);
  if (!path) return { text: `ok, new empty ${aspect} project (no file yet; save_project with a path names it)` };
  return { text: `ok, new empty ${aspect} project saved as ${await saveTo(path)}` };
}

/** Bridge: saves to the open file, or to path (save as) without a dialog. */
async function saveProjectTool(input: unknown): Promise<AgentToolResult> {
  const { path } = SaveProjectInput.parse(input);
  const target = path ?? useEditor.getState().filePath;
  if (!target) return { text: 'save_project: this project has no file yet; pass { path }. Nothing was saved', isError: true };
  return { text: `ok, saved ${await saveTo(target)}` };
}

export async function runAgentTool(name: ToolName, input: unknown): Promise<AgentToolResult> {
  try {
    if (name === 'get_state') return { text: stateText() };
    if (name === 'edit') return await applyEdit(input);
    if (name === 'screenshot') return await screenshot(input);
    if (name === 'load_project') return loadProjectTool(input);
    if (name === 'export') return await exportTool(input);
    if (name === 'new_project') return await newProjectTool(input);
    if (name === 'save_project') return await saveProjectTool(input);
    if (name === 'contact_sheet') return await contactSheetTool(input);
    return { text: `${name} is handled by the main process`, isError: true };
  } catch (err) {
    console.error(`[agent] ${name} failed`, err);
    return { text: `${name} failed: ${(err as Error).message}`, isError: true };
  }
}
