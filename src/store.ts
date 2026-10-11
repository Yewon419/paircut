import { create } from 'zustand';
import type { ClipColor } from '../shared/color';
import type { AnyClip, Clip, ClipTransform, KeyEase, MediaAsset, Project, TextClip, Track, TrackKind } from '../shared/project';
import {
  clipDuration,
  clipEnd,
  emptyProject,
  IDENTITY_TRANSFORM,
  isMediaClip,
  isTextClip,
  MEDIA_CLIP_DEFAULTS,
  normalizeProject,
  projectDuration,
  shiftKeys,
  sourceTime,
  transformAt,
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
  /** The layer new clips go to (paste, text templates, the media bin's add button); follows the selected clip. */
  selectedTrackId: string | null;
  playhead: number;
  playing: boolean;
  zoom: number;
  snap: boolean;
  /** A video layer being merged down while its overlap with the layer below bakes, or why that merge failed. */
  layerJob: { trackId: string; error: string | null } | null;
}

export const useEditor = create<EditorState>(() => ({
  project: emptyProject(),
  past: [],
  future: [],
  gestureBase: null,
  filePath: null,
  dirty: false,
  selectedClipId: null,
  selectedTrackId: null,
  playhead: 0,
  playing: false,
  zoom: 80,
  snap: true,
  layerJob: null,
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
  const { selectedClipId, selectedTrackId, project } = get();
  if (selectedClipId && !findClip(project, selectedClipId)) set({ selectedClipId: null });
  if (selectedTrackId && !project.tracks.some((t) => t.id === selectedTrackId)) set({ selectedTrackId: null });
}

// Selecting a clip selects its layer, also after the clip moves to another layer.
useEditor.subscribe((s) => {
  if (!s.selectedClipId) return;
  const found = findClip(s.project, s.selectedClipId);
  if (found && found.track.id !== s.selectedTrackId) set({ selectedTrackId: found.track.id });
});

export function selectTrack(trackId: string): void {
  set({ selectedTrackId: trackId, selectedClipId: null });
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
    selectedTrackId: null,
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

/**
 * Removes the tracks an edit emptied, but always keeps one text, one video and one audio track. Layers that were
 * already empty (added on purpose to put clips on) stay.
 */
export function tidyTracks(before: Project, project: Project): Project {
  const had = new Set(before.tracks.filter((t) => t.clips.length > 0).map((t) => t.id));
  const keep = (kind: TrackKind): Track | undefined => project.tracks.filter((t) => t.kind === kind).at(-1);
  const kept = new Set([keep('text'), keep('video'), keep('audio')]);
  const tracks = project.tracks.filter((t) => t.clips.length > 0 || !had.has(t.id) || kept.has(t));
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
  if (target && target.kind === kind && !target.locked) {
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

/**
 * Clamps a new track's insert index: text tracks go among the text tracks, video tracks from the topmost video track
 * down, audio below every picture track. Picture tracks moved in front of each other (moveTrack) stay where they are.
 */
function clampTrackInsert(p: Project, kind: TrackKind, index: number): number {
  const len = p.tracks.length;
  const at = (k: TrackKind) => p.tracks.findIndex((t) => t.kind === k);
  const firstAudio = at('audio') === -1 ? len : at('audio');
  const clamp = (lo: number, hi: number) => Math.max(lo, Math.min(hi, index));
  if (kind === 'audio') return clamp(firstAudio, len);
  const lastText = p.tracks.map((t) => t.kind).lastIndexOf('text');
  if (kind === 'text') {
    const firstPicture = p.tracks.findIndex((t) => t.kind !== 'text');
    return clamp(0, lastText !== -1 ? lastText + 1 : firstPicture === -1 ? len : firstPicture);
  }
  return clamp(at('video') !== -1 ? at('video') : lastText + 1, firstAudio);
}

/**
 * Where a new layer of `kind` goes: right above the selected layer when it is on the same side of the picture/audio
 * split, else at the edge of that split; with no layer selected, where a dropped clip's new track would go.
 */
export function layerInsertIndex(p: Project, kind: TrackKind, selectedId: string | null): number {
  const i = selectedId ? p.tracks.findIndex((t) => t.id === selectedId) : -1;
  if (i === -1) return clampTrackInsert(p, kind, 0);
  const firstAudio = p.tracks.findIndex((t) => t.kind === 'audio');
  const split = firstAudio === -1 ? p.tracks.length : firstAudio;
  if (kind === 'audio') return i >= split ? i : split;
  return i < split ? i : split;
}

/** Adds an empty layer above the selected one and selects it. */
export function addLayer(kind: TrackKind): void {
  const track: Track = { id: uid(kind[0]), kind, muted: false, hidden: false, clips: [] };
  commit((p) => {
    const tracks = [...p.tracks];
    tracks.splice(layerInsertIndex(p, kind, get().selectedTrackId), 0, track);
    return { ...p, tracks };
  });
  set({ selectedTrackId: track.id, selectedClipId: null });
}

/**
 * Puts a new clip on the selected layer at its start; when that spot is taken, or the layer is locked or of another
 * kind, on a new layer right above it. Null when no layer is selected, so callers keep their usual place.
 */
export function withClipOnLayer(p: Project, clip: AnyClip, kind: TrackKind, layerId: string | null): Project | null {
  const layer = layerId ? p.tracks.find((t) => t.id === layerId) : undefined;
  if (!layer) return null;
  if (layer.kind === kind && !layer.locked && !overlaps(layer, clip.start, clipEnd(clip), null)) {
    return withTrack(p, layer.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) }));
  }
  const track: Track = { id: uid(kind[0]), kind, muted: false, hidden: false, clips: [clip] };
  const tracks = [...p.tracks];
  tracks.splice(layerInsertIndex(p, kind, layer.id), 0, track);
  return { ...p, tracks };
}

/** The media bin's add button: at the playhead on the selected layer, else at the end of the main track. */
export function addAssetToTimeline(asset: MediaAsset): void {
  const { project, playhead, selectedTrackId } = get();
  const clip = makeClip(asset, frameSnap(playhead, project.fps));
  const placed = withClipOnLayer(project, clip, trackKindFor(asset), selectedTrackId);
  if (!placed) {
    appendToMain(asset);
    return;
  }
  commit(() => placed);
  set({ selectedClipId: clip.id });
}

export function moveClip(base: Project, clipId: string, toTrackId: string, start: number): Project | null {
  const found = findClip(base, clipId);
  if (!found || found.track.locked) return null;
  const target = base.tracks.find((t) => t.id === toTrackId);
  if (!target || target.kind !== found.track.kind || target.locked) return null;
  const moved = { ...found.clip, start: Math.max(0, start) };
  if (overlaps(target, moved.start, clipEnd(moved), clipId)) return null;
  const tracks = base.tracks.map((t) => {
    let clips = t.clips.filter((c) => c.id !== clipId);
    if (t.id === toTrackId) clips = sortClips([...clips, moved]);
    return clips === t.clips ? t : { ...t, clips };
  });
  return { ...base, tracks };
}

/**
 * The start nearest to `start` where a clip of `length` fits on the track: where asked, or butted exactly against a
 * neighbour no further than one clip length away. Neighbour edges are often off the frame grid (trimmed or sped-up
 * media), so rounding to frames alone would leave a gap or a sliver of overlap.
 */
export function fitStart(track: Track, clipId: string, start: number, length: number): number | null {
  const wanted = Math.max(0, start);
  const others = track.clips.filter((c) => c.id !== clipId);
  const fits = [wanted, ...others.flatMap((c) => [clipEnd(c), c.start - length])].filter(
    (s) => s >= 0 && Math.abs(s - wanted) <= length && !overlaps(track, s, s + length, clipId),
  );
  if (fits.length === 0) return null;
  return fits.reduce((best, s) => (Math.abs(s - wanted) < Math.abs(best - wanted) ? s : best));
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

/**
 * Adds the cut-out subject of a clip on a new track right above it, at the same time, place, crop, speed and grade,
 * so other pictures can go between the two.
 */
export function withSubjectLayer(base: Project, clipId: string, subject: MediaAsset): Project {
  const found = findClip(base, clipId);
  if (!found || !isMediaClip(found.clip)) throw new Error(`no media clip ${clipId}`);
  const c = found.clip;
  const still = subject.kind === 'image';
  const clip: Clip = { ...c, id: uid('c'), assetId: subject.id, in: still ? c.in : 0, out: still ? c.out : c.out - c.in, dissolve: 0 };
  const track: Track = { id: uid('v'), kind: 'video', muted: false, hidden: false, clips: [clip] };
  const tracks = [...base.tracks];
  tracks.splice(base.tracks.indexOf(found.track), 0, track);
  return { ...base, assets: [...base.assets, subject], tracks };
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
  const { t, targets } = clipsUnderPlayhead();
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
          shiftKeys({ ...c, id: uid('c'), start: t, in: cut, fadeIn: 0, dissolve: 0 }, c.start - t),
        ];
      }),
    })),
  };
}

/** Clips cut by a playhead edit: the selected one when the playhead is inside it, else every unlocked clip there. */
function clipsUnderPlayhead(): { t: number; targets: Set<string> } {
  const { project, playhead, selectedClipId } = get();
  const t = frameSnap(playhead, project.fps);
  const minLen = 1 / project.fps;
  const inside = (c: AnyClip) => t > c.start + minLen / 2 && t < clipEnd(c) - minLen / 2;
  const selected = selectedClipId ? findClip(project, selectedClipId) : null;
  const targets = new Set<string>();
  if (selected && inside(selected.clip)) {
    if (!selected.track.locked) targets.add(selected.clip.id);
  } else {
    for (const track of project.tracks) if (!track.locked) for (const c of track.clips) if (inside(c)) targets.add(c.id);
  }
  return { t, targets };
}

/** Drops the part of the clips before the playhead (keep: 'right') or after it (keep: 'left'); nothing moves. */
export function trimAtPlayhead(keep: 'left' | 'right'): void {
  const { t, targets } = clipsUnderPlayhead();
  if (targets.size === 0) return;
  commit((p) => trimClips(p, t, targets, keep));
}

export function trimClips(p: Project, t: number, targets: Set<string>, keep: 'left' | 'right'): Project {
  return {
    ...p,
    tracks: p.tracks.map((track) => ({
      ...track,
      clips: track.clips.map((c) => {
        if (!targets.has(c.id)) return c;
        if (keep === 'left') {
          if (isTextClip(c)) return { ...c, out: c.in + (t - c.start) };
          return { ...c, out: sourceTime(c, t), fadeOut: 0 };
        }
        if (isTextClip(c)) return { ...c, start: t, out: c.out - (t - c.start) };
        return shiftKeys({ ...c, start: t, in: sourceTime(c, t), fadeIn: 0, dissolve: 0 }, c.start - t);
      }),
    })),
  };
}

/**
 * Copies the selected clip right after itself on the same layer when there is room, else onto a new layer just
 * above at the same time. The copy becomes the selection.
 */
export function duplicateSelected(): void {
  const { project, selectedClipId } = get();
  const found = selectedClipId ? findClip(project, selectedClipId) : null;
  if (!found) return;
  const copy: AnyClip = { ...found.clip, id: uid('c'), start: clipEnd(found.clip) };
  if (isMediaClip(copy)) copy.dissolve = 0;
  commit((p) => withDuplicate(p, found.track.id, copy));
  set({ selectedClipId: copy.id });
}

export function withDuplicate(p: Project, trackId: string, copy: AnyClip): Project {
  const track = p.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error(`no track ${trackId}`);
  if (!track.locked && !overlaps(track, copy.start, clipEnd(copy), null)) {
    return withTrack(p, trackId, (t) => ({ ...t, clips: sortClips([...t.clips, copy]) }));
  }
  const length = clipDuration(copy);
  const above: AnyClip = { ...copy, start: copy.start - length };
  const added: Track = { id: uid(track.kind[0]), kind: track.kind, muted: false, hidden: false, clips: [above] };
  const tracks = [...p.tracks];
  tracks.splice(p.tracks.indexOf(track), 0, added);
  return { ...p, tracks };
}

/** Adds a bookmark at the playhead, or removes the one already there (within half a frame). */
export function toggleMarker(): void {
  const { project, playhead } = get();
  const t = frameSnap(playhead, project.fps);
  const near = project.markers.find((m) => Math.abs(m.t - t) < 0.5 / project.fps);
  if (near) {
    commit((p) => ({ ...p, markers: p.markers.filter((m) => m !== near) }));
    return;
  }
  const label = String(project.markers.length + 1);
  commit((p) => ({ ...p, markers: [...p.markers, { t, label }].sort((a, b) => a.t - b.t) }));
}

/**
 * Holds the picture of the selected media clip at the playhead: a still of that frame, one second long, on a new
 * layer right above, placed, cropped and graded like the clip.
 */
export async function freezeFrame(): Promise<void> {
  const { project, playhead, selectedClipId } = get();
  const found = selectedClipId ? findClip(project, selectedClipId) : null;
  if (!found || !isMediaClip(found.clip) || found.track.kind !== 'video') throw new Error('영상 레이어의 클립을 고르세요.');
  const clip = found.clip;
  const t = frameSnap(playhead, project.fps);
  if (t < clip.start || t >= clipEnd(clip)) throw new Error('재생 헤드가 고른 클립 위에 있어야 해요.');
  const asset = project.assets.find((a) => a.id === clip.assetId);
  if (!asset) throw new Error(`asset not found: ${clip.assetId}`);
  const still = asset.kind === 'image' ? asset : await window.api.makeStill(asset, Math.min(asset.duration, sourceTime(clip, t)));
  const held: Clip = { ...clip, id: uid('c'), assetId: still.id, start: t, in: 0, out: 1, speed: 1, dissolve: 0, fadeIn: 0, fadeOut: 0 };
  commit((p) => {
    const at = p.tracks.findIndex((tr) => tr.id === found.track.id);
    if (at === -1) return p;
    const track: Track = { id: uid('v'), kind: 'video', muted: false, hidden: false, clips: [held] };
    const tracks = [...p.tracks];
    tracks.splice(at, 0, track);
    const assets = p.assets.some((a) => a.id === still.id) ? p.assets : [...p.assets, still];
    return { ...p, assets, tracks };
  });
  set({ selectedClipId: held.id });
}

/** Index of the keyframe within half a frame of `local`, or -1. */
export function keyIndexAt(clip: Clip, local: number, fps: number): number {
  return clip.keys?.findIndex((k) => Math.abs(k.t - local) < 0.5 / fps) ?? -1;
}

/**
 * Changes the clip's place or size as seen at `local` seconds into it: the plain transform when it has no keyframes,
 * else the keyframe there, added when there is none yet.
 */
export function withTransformAt(c: Clip, local: number, patch: Partial<ClipTransform>, fps: number): Clip {
  if (!c.keys || c.keys.length === 0) return { ...c, transform: { ...c.transform, ...patch } };
  const at = keyIndexAt(c, local, fps);
  if (at >= 0) return { ...c, keys: c.keys.map((k, i) => (i === at ? { ...k, ...patch } : k)) };
  const t = frameSnap(local, fps);
  const added = { ...transformAt(c, t), ...patch, t, ease: 'smooth' as KeyEase };
  return { ...c, keys: [...c.keys, added].sort((a, b) => a.t - b.t) };
}

/**
 * Puts a keyframe at the playhead holding what the clip shows there, or takes away the one already there. The first
 * keyframe also keeps the current place as a second one at the clip start, so adding a key never moves the picture.
 * Removing the last keyframe leaves the clip where that key had it.
 */
export function toggleKeyAtPlayhead(clipId: string): void {
  const { project, playhead } = get();
  const found = findClip(project, clipId);
  if (!found || !isMediaClip(found.clip) || found.track.locked) return;
  const c = found.clip;
  const fps = project.fps;
  const local = frameSnap(playhead - c.start, fps);
  if (local < 0 || local > clipDuration(c)) return;
  const at = keyIndexAt(c, local, fps);
  commit((p) =>
    updateMediaClip(p, clipId, (clip) => {
      const keys = clip.keys ?? [];
      if (at >= 0) {
        const rest = keys.filter((_, i) => i !== at);
        if (rest.length > 0) return { ...clip, keys: rest };
        return withoutKeys(clip, transformAt(clip, local));
      }
      const here = { ...transformAt(clip, local), t: local, ease: 'smooth' as KeyEase };
      const seed = keys.length === 0 && local > 0 ? [{ ...clip.transform, t: 0, ease: 'smooth' as KeyEase }] : [];
      return { ...clip, keys: [...seed, ...keys, here].sort((a, b) => a.t - b.t) };
    }),
  );
}

function withoutKeys(c: Clip, transform: ClipTransform): Clip {
  const plain = { ...c, transform };
  delete plain.keys;
  return plain;
}

export function setKeyEase(clipId: string, index: number, ease: KeyEase): void {
  commit((p) => updateMediaClip(p, clipId, (c) => ({ ...c, keys: c.keys?.map((k, i) => (i === index ? { ...k, ease } : k)) })));
}

export function clearKeys(clipId: string): void {
  const { project, playhead } = get();
  const found = findClip(project, clipId);
  if (!found || !isMediaClip(found.clip) || !found.clip.keys) return;
  const local = playhead - found.clip.start;
  commit((p) =>
    updateMediaClip(p, clipId, (c) => {
      return withoutKeys(c, transformAt(c, local));
    }),
  );
}

export function deleteSelected(): void {
  const { project, selectedClipId } = get();
  if (!selectedClipId || findClip(project, selectedClipId)?.track.locked) return;
  commit((p) => tidyTracks(p, { ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.id !== selectedClipId) })) }));
  set({ selectedClipId: null });
}

export function toggleTrack(trackId: string, key: 'muted' | 'hidden' | 'locked' | 'clipped'): void {
  commit((p) => withTrack(p, trackId, (t) => ({ ...t, [key]: !t[key] })));
}

export function renameTrack(trackId: string, name: string): void {
  const trimmed = name.trim();
  commit((p) =>
    withTrack(p, trackId, (t) => {
      const rest = { ...t };
      delete rest.name;
      return trimmed ? { ...rest, name: trimmed } : rest;
    }),
  );
}

/** The neighbour a track can swap with or merge into: the next track of the same kind above (-1) or below (1). */
export function trackNeighbour(p: Project, trackId: string, dir: -1 | 1): Track | null {
  const i = p.tracks.findIndex((t) => t.id === trackId);
  const other = i === -1 ? undefined : p.tracks[i + dir];
  return other && other.kind === p.tracks[i].kind ? other : null;
}

/** The track a track swaps with when moved up or down: text and video tracks pass each other, audio stays below. */
export function stackNeighbour(p: Project, trackId: string, dir: -1 | 1): Track | null {
  const i = p.tracks.findIndex((t) => t.id === trackId);
  const other = i === -1 ? undefined : p.tracks[i + dir];
  return other && (other.kind === 'audio') === (p.tracks[i].kind === 'audio') ? other : null;
}

/** Swaps a track with its neighbour, so its clips draw in front of (up) or behind (down) that one. */
export function moveTrack(trackId: string, dir: -1 | 1): void {
  commit((p) => {
    const other = stackNeighbour(p, trackId, dir);
    if (!other) return p;
    const i = p.tracks.findIndex((t) => t.id === trackId);
    const tracks = [...p.tracks];
    [tracks[i], tracks[i + dir]] = [tracks[i + dir], tracks[i]];
    return { ...p, tracks };
  });
}

/**
 * The index a dragged layer ends up at when dropped into gap `slot` (0 = above the top layer, tracks.length = below
 * the bottom one), or null when that leaves it in place or puts it on the wrong side of the picture/audio split.
 */
export function layerDropIndex(p: Project, trackId: string, slot: number): number | null {
  const i = p.tracks.findIndex((t) => t.id === trackId);
  if (i === -1) return null;
  const firstAudio = p.tracks.findIndex((t) => t.kind === 'audio');
  const split = firstAudio === -1 ? p.tracks.length : firstAudio;
  if (p.tracks[i].kind === 'audio' ? slot < split : slot > split) return null;
  const to = slot > i ? slot - 1 : slot;
  return to === i ? null : to;
}

/** Moves a layer to the gap `slot` between layers, as when its card is dragged there. */
export function moveTrackTo(trackId: string, slot: number): void {
  commit((p) => {
    const to = layerDropIndex(p, trackId, slot);
    if (to === null) return p;
    const tracks = p.tracks.filter((t) => t.id !== trackId);
    tracks.splice(to, 0, p.tracks.find((t) => t.id === trackId) as Track);
    return { ...p, tracks };
  });
}

/** Why a track cannot merge into the one below it, or null when it can. */
export function mergeDownBlocker(p: Project, trackId: string): string | null {
  const track = p.tracks.find((t) => t.id === trackId);
  const below = trackNeighbour(p, trackId, 1);
  if (!track || !below) return '아래에 같은 종류 레이어가 없어요';
  if (track.locked || below.locked) return '잠긴 레이어는 병합할 수 없어요';
  if ((track.opacity ?? 1) !== (below.opacity ?? 1) || (track.blend ?? 'normal') !== (below.blend ?? 'normal')) {
    return '불투명도나 혼합 모드가 달라서 병합하면 모양이 바뀌어요';
  }
  if (Boolean(track.clipped) !== Boolean(below.clipped)) return '클리핑 마스크가 달라서 병합하면 모양이 바뀌어요';
  // Video overlaps are baked into one clip when merged; text has nothing to bake them with.
  if (track.kind === 'video') return null;
  const clash = track.clips.find((c) => overlaps(below, c.start, clipEnd(c), null));
  return clash ? `${clash.start.toFixed(1)}초에서 클립이 겹쳐요` : null;
}

interface TimeRange {
  from: number;
  to: number;
}

/** Where clips of the two tracks are on screen at the same time, joined where those stretches touch. */
export function sharedRanges(a: Track, b: Track): TimeRange[] {
  const raw: TimeRange[] = [];
  for (const x of a.clips) {
    for (const y of b.clips) {
      const from = Math.max(x.start, y.start);
      const to = Math.min(clipEnd(x), clipEnd(y));
      if (to - from > 1e-6) raw.push({ from, to });
    }
  }
  raw.sort((r, s) => r.from - s.from);
  const joined: TimeRange[] = [];
  for (const r of raw) {
    const last = joined.at(-1);
    if (last && r.from <= last.to + 1e-6) last.to = Math.max(last.to, r.to);
    else joined.push({ ...r });
  }
  return joined;
}

function inRanges(c: AnyClip, ranges: TimeRange[]): TimeRange | undefined {
  const mid = (c.start + clipEnd(c)) / 2;
  return ranges.find((r) => mid > r.from && mid < r.to);
}

/** Both tracks' clips cut at every edge of the ranges, so each clip is wholly inside one range or outside them all. */
function cutAtRanges(p: Project, ids: string[], ranges: TimeRange[]): Project {
  let out = p;
  for (const t of ranges.flatMap((r) => [r.from, r.to])) {
    const targets = new Set(
      out.tracks
        .filter((tr) => ids.includes(tr.id))
        .flatMap((tr) => tr.clips.filter((c) => c.start < t - 1e-6 && clipEnd(c) > t + 1e-6).map((c) => c.id)),
    );
    if (targets.size > 0) out = splitClips(out, t, targets);
  }
  return out;
}

/** The two layers' clips inside one range, moved to start at 0, as a project of their own to bake. */
function bakeSource(p: Project, upperId: string, lowerId: string, range: TimeRange): Project {
  const part = (id: string): Track => {
    const t = p.tracks.find((tr) => tr.id === id) as Track;
    return {
      id: t.id,
      kind: t.kind,
      muted: t.muted,
      hidden: t.hidden,
      clips: t.clips.filter((c) => inRanges(c, [range])).map((c) => ({ ...c, start: c.start - range.from })),
    };
  };
  const tracks = [part(upperId), part(lowerId)];
  const used = new Set(tracks.flatMap((t) => t.clips.filter(isMediaClip).map((c) => c.assetId)));
  return { ...p, tracks, markers: [], assets: p.assets.filter((a) => used.has(a.id)) };
}

/**
 * Moves every clip into the same-kind track below; that track keeps its own name and switches. Where video clips of
 * the two overlap, that stretch is baked into one see-through clip that looks the same (sound included), so the
 * merged track still plays one clip at a time.
 */
export async function mergeTrackDown(trackId: string): Promise<void> {
  const p = get().project;
  if (mergeDownBlocker(p, trackId) || (get().layerJob && get().layerJob?.error === null)) return;
  const track = p.tracks.find((t) => t.id === trackId);
  const below = trackNeighbour(p, trackId, 1);
  if (!track || !below) return;
  const ranges = track.kind === 'video' ? sharedRanges(track, below) : [];
  if (ranges.length === 0) {
    set({ layerJob: null });
    commit((q) => ({
      ...q,
      tracks: q.tracks.filter((t) => t.id !== trackId).map((t) => (t.id === below.id ? { ...below, clips: sortClips([...below.clips, ...track.clips]) } : t)),
    }));
    return;
  }
  set({ layerJob: { trackId, error: null } });
  try {
    const cut = cutAtRanges(p, [trackId, below.id], ranges);
    const baked: MediaAsset[] = [];
    for (const r of ranges) {
      baked.push(await window.api.bakeLayers(bakeSource(cut, trackId, below.id, r), `병합 ${r.from.toFixed(1)}-${r.to.toFixed(1)}초`));
    }
    if (get().project !== p) throw new Error('병합하는 동안 편집이 바뀌어서 적용하지 않았어요. 다시 병합해 주세요');
    const upper = cut.tracks.find((t) => t.id === trackId) as Track;
    const lower = cut.tracks.find((t) => t.id === below.id) as Track;
    const kept = [...lower.clips, ...upper.clips].filter((c) => !inRanges(c, ranges));
    const bakedClips = ranges.map((r, i) => ({ ...makeClip(baked[i], r.from), out: r.to - r.from }));
    const merged = { ...lower, clips: sortClips([...kept, ...bakedClips]) };
    commit(() => ({
      ...cut,
      assets: [...cut.assets, ...baked],
      tracks: cut.tracks.filter((t) => t.id !== trackId).map((t) => (t.id === below.id ? merged : t)),
    }));
    set({ layerJob: null });
  } catch (err) {
    const message = (err as Error).message;
    console.error(`[merge] ${trackId} into ${below.id}: ${message}`);
    set({ layerJob: { trackId, error: message } });
  }
}

/** A copy of the track with fresh clip ids, right above it. */
export function duplicateTrack(trackId: string): void {
  commit((p) => {
    const i = p.tracks.findIndex((t) => t.id === trackId);
    if (i === -1) return p;
    const src = p.tracks[i];
    const copy: Track = {
      ...structuredClone(src),
      id: uid(src.kind[0]),
      locked: false,
      clips: src.clips.map((c) => ({ ...structuredClone(c), id: uid('c') })),
    };
    if (src.name) copy.name = `${src.name} 복사`;
    const tracks = [...p.tracks];
    tracks.splice(i, 0, copy);
    return { ...p, tracks };
  });
}

/** Removes the track and its clips; the last track of a kind is emptied instead, so there is always one to drop on. */
export function deleteTrack(trackId: string): void {
  const { project, selectedClipId } = get();
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track || track.locked) return;
  const only = project.tracks.filter((t) => t.kind === track.kind).length === 1;
  commit((p) =>
    only ? withTrack(p, trackId, (t) => ({ ...t, clips: [] })) : { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) },
  );
  if (selectedClipId && track.clips.some((c) => c.id === selectedClipId)) set({ selectedClipId: null });
  pruneSelection();
}

function newTextTrack(clips: AnyClip[]): Track {
  return { id: uid('t'), kind: 'text', muted: false, hidden: false, clips };
}

/**
 * Adds a text clip on the selected layer (or a new text layer right above it when there is no room); with no layer
 * selected, on the first text track with room, else on a new top text track.
 */
export function addTextClip(clip: TextClip): void {
  commit((p) => withClipOnLayer(p, clip, 'text', get().selectedTrackId) ?? withTextClip(p, clip));
  set({ selectedClipId: clip.id });
}

let copiedText: TextClip | null = null;

/** Remembers the selected text clip for pasteText; other clip kinds are not copied. */
export function copySelectedText(): void {
  const { project, selectedClipId } = get();
  const found = selectedClipId ? findClip(project, selectedClipId) : null;
  if (found && isTextClip(found.clip)) copiedText = structuredClone(found.clip);
}

/** A fresh copy of the last copied text clip at the playhead, on the selected layer like addTextClip. */
export function pasteText(): void {
  if (!copiedText) return;
  const { project, playhead } = get();
  addTextClip({ ...structuredClone(copiedText), id: uid('c'), start: frameSnap(playhead, project.fps) });
}

export function withTextClip(p: Project, clip: TextClip): Project {
  const room = p.tracks.find((t) => t.kind === 'text' && !t.locked && !overlaps(t, clip.start, clipEnd(clip), null));
  if (room) return withTrack(p, room.id, (t) => ({ ...t, clips: sortClips([...t.clips, clip]) }));
  return { ...p, tracks: [newTextTrack([clip]), ...p.tracks] };
}

/** Puts each group of text clips on its own new text track, above existing tracks. */
export function addTextTracks(groups: TextClip[][], update: (p: Project) => Project = (p) => p): void {
  commit((p) => tidyTracks(p, update(withTextTracks(p, groups))));
}

export function withTextTracks(p: Project, groups: TextClip[][]): Project {
  const fresh = groups.filter((g) => g.length > 0).map((g) => newTextTrack(sortClips(g)));
  return { ...p, tracks: [...fresh, ...p.tracks] };
}
