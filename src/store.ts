import { create } from 'zustand';
import type { ClipColor } from '../shared/color';
import type { AnyClip, Clip, MediaAsset, Project, TextClip, Track, TrackKind } from '../shared/project';
import {
  clipEnd,
  emptyProject,
  IDENTITY_TRANSFORM,
  isMediaClip,
  isTextClip,
  MEDIA_CLIP_DEFAULTS,
  normalizeProject,
  projectDuration,
  sourceTime,
} from '../shared/project';

const HISTORY_LIMIT = 200;

export interface EditorState {
  project: Project;
  past: Project[];
  future: Project[];
  gestureBase: Project | null;
  filePath: string | null;
  dirty: boolean;
  selectedClipId: string | null;
  playhead: number;
  playing: boolean;
  zoom: number;
  snap: boolean;
}

export const useEditor = create<EditorState>(() => ({
  project: emptyProject(),
  past: [],
  future: [],
  gestureBase: null,
  filePath: null,
  dirty: false,
  selectedClipId: null,
  playhead: 0,
  playing: false,
  zoom: 80,
  snap: true,
}));

const get = useEditor.getState;
const set = useEditor.setState;

export function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

export function commit(update: (p: Project) => Project): void {
  const { project, past } = get();
  const next = update(project);
  if (next === project) return;
  set({ project: next, past: [...past, project].slice(-HISTORY_LIMIT), future: [], dirty: true });
}

export function beginGesture(): void {
  set({ gestureBase: get().project });
}

export function updateGesture(update: (base: Project) => Project | null): void {
  const base = get().gestureBase;
  if (!base) return;
  const next = update(base);
  if (next) set({ project: next });
}

export function endGesture(): void {
  const { gestureBase, project, past } = get();
  if (!gestureBase) return;
  if (gestureBase === project) {
    set({ gestureBase: null });
    return;
  }
  set({ gestureBase: null, past: [...past, gestureBase].slice(-HISTORY_LIMIT), future: [], dirty: true });
}

export function undo(): void {
  const { past, project, future } = get();
  const prev = past.at(-1);
  if (!prev) return;
  set({ project: prev, past: past.slice(0, -1), future: [project, ...future], dirty: true });
  pruneSelection();
}

export function redo(): void {
  const { past, project, future } = get();
  const next = future[0];
  if (!next) return;
  set({ project: next, past: [...past, project], future: future.slice(1), dirty: true });
  pruneSelection();
}

function pruneSelection(): void {
  const { selectedClipId, project } = get();
  if (selectedClipId && !findClip(project, selectedClipId)) set({ selectedClipId: null });
}

export function loadProject(project: Project, filePath: string | null): void {
  set({
    project: normalizeProject(project),
    past: [],
    future: [],
    gestureBase: null,
    filePath,
    dirty: false,
    selectedClipId: null,
    playhead: 0,
    playing: false,
  });
}

export function setPlayhead(t: number): void {
  const max = projectDuration(get().project);
  set({ playhead: Math.max(0, Math.min(max, t)) });
}

export function frameSnap(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

export function findClip(project: Project, clipId: string): { track: Track; clip: AnyClip } | null {
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

export function overlaps(track: Track, start: number, end: number, ignoreId: string | null): boolean {
  const eps = 1e-6;
  return track.clips.some((c) => c.id !== ignoreId && start < clipEnd(c) - eps && end > c.start + eps);
}

function sortClips(clips: AnyClip[]): AnyClip[] {
  return [...clips].sort((a, b) => a.start - b.start);
}

export function withTrack(project: Project, trackId: string, update: (t: Track) => Track): Project {
  return { ...project, tracks: project.tracks.map((t) => (t.id === trackId ? update(t) : t)) };
}

/** Removes empty tracks, but always keeps one text, one video and one audio track. */
export function tidyTracks(project: Project): Project {
  const keep = (kind: TrackKind): Track | undefined => project.tracks.filter((t) => t.kind === kind).at(-1);
  const kept = new Set([keep('text'), keep('video'), keep('audio')]);
  const tracks = project.tracks.filter((t) => t.clips.length > 0 || kept.has(t));
  return tracks.length === project.tracks.length ? project : { ...project, tracks };
}

export function mainTrackId(project: Project, kind: TrackKind): string {
  const track = project.tracks.filter((t) => t.kind === kind).at(-1);
  if (!track) throw new Error(`no ${kind} track`);
  return track.id;
}

export function trackKindFor(asset: MediaAsset): TrackKind {
  return asset.kind === 'audio' ? 'audio' : 'video';
}

export function makeClip(asset: MediaAsset, start: number): Clip {
  return {
    id: uid('c'),
    assetId: asset.id,
    start,
    in: 0,
    out: asset.duration,
    transform: { ...IDENTITY_TRANSFORM },
    ...MEDIA_CLIP_DEFAULTS,
  };
}

export function addAssets(assets: MediaAsset[]): void {
  commit((p) => ({ ...p, assets: [...p.assets, ...assets] }));
}

export function appendToMain(asset: MediaAsset): void {
  commit((p) => {
    const trackId = mainTrackId(p, trackKindFor(asset));
    return withTrack(p, trackId, (t) => {
      const end = t.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
      return { ...t, clips: sortClips([...t.clips, makeClip(asset, end)]) };
    });
  });
}

/** Places a clip on a track, or on a new track inserted at `newTrackIndex` when trackId is null. */
export function placeAsset(asset: MediaAsset, trackId: string | null, start: number, newTrackIndex: number): void {
  commit((p) => withAsset(p, asset, trackId, start, newTrackIndex));
}

export function withAsset(p: Project, asset: MediaAsset, trackId: string | null, start: number, newTrackIndex: number): Project {
  const clip = makeClip(asset, Math.max(0, frameSnap(start, p.fps)));
  const kind = trackKindFor(asset);
  const target = trackId ? p.tracks.find((t) => t.id === trackId) : undefined;
  if (target && target.kind === kind) {
    if (overlaps(target, clip.start, clipEnd(clip), null)) {
      const end = target.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0);
      clip.start = end;
    }
    return withTrack(p, target.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) }));
  }
  const track: Track = { id: uid(kind[0]), kind, muted: false, hidden: false, clips: [clip] };
  const tracks = [...p.tracks];
  tracks.splice(clampTrackInsert(p, kind, newTrackIndex), 0, track);
  return { ...p, tracks };
}

const KIND_ORDER: Record<TrackKind, number> = { text: 0, video: 1, audio: 2 };

/** Tracks stay grouped top to bottom as text, video, audio; clamps an insert index into its group. */
function clampTrackInsert(p: Project, kind: TrackKind, index: number): number {
  const order = KIND_ORDER[kind];
  const first = p.tracks.findIndex((t) => KIND_ORDER[t.kind] >= order);
  const groupStart = first === -1 ? p.tracks.length : first;
  const after = p.tracks.findIndex((t) => KIND_ORDER[t.kind] > order);
  const groupEnd = after === -1 ? p.tracks.length : after;
  return Math.max(groupStart, Math.min(groupEnd, index));
}

export function moveClip(base: Project, clipId: string, toTrackId: string, start: number): Project | null {
  const found = findClip(base, clipId);
  if (!found) return null;
  const target = base.tracks.find((t) => t.id === toTrackId);
  if (!target || target.kind !== found.track.kind) return null;
  const moved = { ...found.clip, start: Math.max(0, start) };
  if (overlaps(target, moved.start, clipEnd(moved), clipId)) return null;
  const tracks = base.tracks.map((t) => {
    let clips = t.clips.filter((c) => c.id !== clipId);
    if (t.id === toTrackId) clips = sortClips([...clips, moved]);
    return clips === t.clips ? t : { ...t, clips };
  });
  return { ...base, tracks };
}

export function moveClipToNewTrack(base: Project, clipId: string, start: number, index: number): Project | null {
  const found = findClip(base, clipId);
  if (!found) return null;
  const kind = found.track.kind;
  const track: Track = { id: uid(kind[0]), kind, muted: false, hidden: false, clips: [] };
  const tracks = [...base.tracks];
  tracks.splice(clampTrackInsert(base, kind, index), 0, track);
  return moveClip({ ...base, tracks }, clipId, track.id, start);
}

export function updateClip(base: Project, clipId: string, update: (c: AnyClip) => AnyClip): Project {
  return {
    ...base,
    tracks: base.tracks.map((t) =>
      t.clips.some((c) => c.id === clipId)
        ? { ...t, clips: sortClips(t.clips.map((c) => (c.id === clipId ? update(c) : c))) }
        : t,
    ),
  };
}

export function updateMediaClip(base: Project, clipId: string, update: (c: Clip) => Clip): Project {
  return updateClip(base, clipId, (c) => (isMediaClip(c) ? update(c) : c));
}

/** Changes playback speed over the same source range; later clips on the track shift so nothing overlaps or gaps. */
export function setClipSpeed(base: Project, clipId: string, speed: number): Project {
  const found = findClip(base, clipId);
  if (!found || !isMediaClip(found.clip)) return base;
  const old = found.clip;
  const oldEnd = clipEnd(old);
  const next = { ...old, speed };
  const delta = clipEnd(next) - oldEnd;
  return withTrack(base, found.track.id, (t) => ({
    ...t,
    clips: t.clips.map((c) => {
      if (c.id === clipId) return next;
      return c.start >= oldEnd - 1e-6 ? { ...c, start: c.start + delta } : c;
    }),
  }));
}

/** Gives every clip on video tracks (video and image) the same color, as one undo step. */
export function applyColorToAll(color: ClipColor): void {
  commit((p) => withColorAll(p, color));
}

export function withColorAll(p: Project, color: ClipColor): Project {
  return {
    ...p,
    tracks: p.tracks.map((t) =>
      t.kind === 'video' ? { ...t, clips: t.clips.map((c) => (isMediaClip(c) ? { ...c, color: { ...color } } : c)) } : t,
    ),
  };
}

export function updateTextClip(base: Project, clipId: string, update: (c: TextClip) => TextClip): Project {
  return updateClip(base, clipId, (c) => (isTextClip(c) ? update(c) : c));
}

export function splitAtPlayhead(): void {
  const { project, playhead, selectedClipId } = get();
  const t = frameSnap(playhead, project.fps);
  const minLen = 1 / project.fps;
  const inside = (c: AnyClip) => t > c.start + minLen / 2 && t < clipEnd(c) - minLen / 2;
  const selected = selectedClipId ? findClip(project, selectedClipId) : null;
  const targets = new Set<string>();
  if (selected && inside(selected.clip)) targets.add(selected.clip.id);
  else for (const track of project.tracks) for (const c of track.clips) if (inside(c)) targets.add(c.id);
  if (targets.size === 0) return;
  commit((p) => splitClips(p, t, targets));
}

/** Cuts the given clips at timeline time t; inner fades of media clips are dropped and the cut is hard. */
export function splitClips(p: Project, t: number, targets: Set<string>): Project {
  return {
    ...p,
    tracks: p.tracks.map((track) => ({
      ...track,
      clips: track.clips.flatMap((c) => {
        if (!targets.has(c.id)) return [c];
        if (isTextClip(c)) {
          return [
            { ...c, out: t - c.start },
            { ...c, id: uid('c'), start: t, in: 0, out: clipEnd(c) - t },
          ];
        }
        const cut = sourceTime(c, t);
        return [
          { ...c, out: cut, fadeOut: 0 },
          { ...c, id: uid('c'), start: t, in: cut, fadeIn: 0, dissolve: 0 },
        ];
      }),
    })),
  };
}

export function deleteSelected(): void {
  const { selectedClipId } = get();
  if (!selectedClipId) return;
  commit((p) => tidyTracks({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== selectedClipId) })) }));
  set({ selectedClipId: null });
}

export function toggleTrack(trackId: string, key: 'muted' | 'hidden'): void {
  commit((p) => withTrack(p, trackId, (t) => ({ ...t, [key]: !t[key] })));
}

function newTextTrack(clips: AnyClip[]): Track {
  return { id: uid('t'), kind: 'text', muted: false, hidden: false, clips };
}

/** Adds a text clip at the playhead on the first text track with room, else on a new top text track. */
export function addTextClip(clip: TextClip): void {
  commit((p) => withTextClip(p, clip));
  set({ selectedClipId: clip.id });
}

export function withTextClip(p: Project, clip: TextClip): Project {
  const room = p.tracks.find((t) => t.kind === 'text' && !overlaps(t, clip.start, clipEnd(clip), null));
  if (room) return withTrack(p, room.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) }));
  return { ...p, tracks: [newTextTrack([clip]), ...p.tracks] };
}

/** Puts each group of text clips on its own new text track, above existing tracks. */
export function addTextTracks(groups: TextClip[][], update: (p: Project) => Project = (p) => p): void {
  commit((p) => tidyTracks(update(withTextTracks(p, groups))));
}

export function withTextTracks(p: Project, groups: TextClip[][]): Project {
  const fresh = groups.filter((g) => g.length > 0).map((g) => newTextTrack(sortClips(g)));
  return { ...p, tracks: [...fresh, ...p.tracks] };
}

export function setVars(patch: Partial<Project['vars']>): void {
  commit((p) => ({ ...p, vars: { ...p.vars, ...patch } }));
}
