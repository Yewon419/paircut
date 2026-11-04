import type { AnyClip, MediaAsset, Project, Track, TrackKind } from '../shared/project';
import { clipEnd, isMediaClip, isTextClip } from '../shared/project';
import { commit, deleteSelected, findClip, frameSnap, layerInsertIndex, overlaps, selectClips, setPlayhead, uid, useEditor } from './store';

/** Copied clips of one layer, with starts relative to the earliest copied clip. */
interface CopiedLayer {
  kind: TrackKind;
  /** How many layers below the top copied layer this one was. */
  offset: number;
  sourceTrackId: string;
  clips: AnyClip[];
}

export interface Clipboard {
  layers: CopiedLayer[];
  /** Media the clips use, so they paste into another project too. */
  assets: MediaAsset[];
  /** The main selected clip when copied; Ctrl+Alt+V takes its attributes. */
  main: AnyClip;
}

let clipboard: Clipboard | null = null;

const byStart = (a: AnyClip, b: AnyClip) => a.start - b.start;

export function clipboardOf(project: Project, ids: string[], mainId: string | null): Clipboard | null {
  const found = ids.map((id) => findClip(project, id)).filter((f) => f !== null);
  if (found.length === 0) return null;
  const t0 = Math.min(...found.map((f) => f.clip.start));
  const index = (trackId: string) => project.tracks.findIndex((t) => t.id === trackId);
  const trackIds = [...new Set(found.map((f) => f.track.id))].sort((a, b) => index(a) - index(b));
  const top = index(trackIds[0]);
  const layers = trackIds.map((trackId) => ({
    kind: project.tracks[index(trackId)].kind,
    offset: index(trackId) - top,
    sourceTrackId: trackId,
    clips: found
      .filter((f) => f.track.id === trackId)
      .map((f) => ({ ...structuredClone(f.clip), start: f.clip.start - t0 }))
      .sort(byStart),
  }));
  const assetIds = new Set(found.map((f) => f.clip).filter(isMediaClip).map((c) => c.assetId));
  const main = (mainId ? findClip(project, mainId)?.clip : undefined) ?? found[0].clip;
  return { layers, assets: structuredClone(project.assets.filter((a) => assetIds.has(a.id))), main: structuredClone(main) };
}

/** Ctrl+C: remembers every selected clip with its layer and timing. False when nothing is selected. */
export function copySelection(): boolean {
  const { project, selectedIds, selectedClipId } = useEditor.getState();
  const copied = clipboardOf(project, selectedIds, selectedClipId);
  if (copied) clipboard = copied;
  return copied !== null;
}

/** Ctrl+X: copy, then delete the selection. */
export function cutSelection(): void {
  if (copySelection()) deleteSelected();
}

export interface Pasted {
  project: Project;
  /** New clip ids; the last one is the first clip of the top layer. */
  ids: string[];
  end: number;
}

/**
 * The clipboard placed from time t. The top copied layer goes on the anchor layer (the selected one, else the layer it
 * was copied from) and the others on the layers at the same distance below; when any of those is missing, of another
 * kind, locked or taken, every copied layer goes on a new layer right above the anchor instead, in the same order.
 */
export function withPasted(p: Project, cb: Clipboard, t: number, selectedTrackId: string | null): Pasted {
  const known = new Set(p.assets.map((a) => a.id));
  let next: Project = { ...p, assets: [...p.assets, ...structuredClone(cb.assets.filter((a) => !known.has(a.id)))] };
  const fresh = cb.layers.map((l) => ({
    ...l,
    clips: l.clips.map((c) => {
      const copy: AnyClip = { ...structuredClone(c), id: uid('c'), start: frameSnap(t + c.start, p.fps) };
      if (isMediaClip(copy)) copy.dissolve = 0;
      return copy;
    }),
  }));
  const anchorId = selectedTrackId ?? cb.layers[0].sourceTrackId;
  const ai = next.tracks.findIndex((tr) => tr.id === anchorId);
  const targets = ai === -1 ? [] : fresh.map((l) => next.tracks.at(ai + l.offset));
  const fits =
    ai !== -1 &&
    targets.every((tr, i) => tr && tr.kind === fresh[i].kind && !tr.locked && fresh[i].clips.every((c) => !overlaps(tr, c.start, clipEnd(c), null)));
  if (fits) {
    next = {
      ...next,
      tracks: next.tracks.map((tr) => {
        const i = targets.indexOf(tr);
        return i === -1 ? tr : { ...tr, clips: [...tr.clips, ...fresh[i].clips].sort(byStart) };
      }),
    };
  } else {
    const anchor = ai === -1 ? null : anchorId;
    const make = (l: (typeof fresh)[number]): Track => ({ id: uid(l.kind[0]), kind: l.kind, muted: false, hidden: false, clips: l.clips });
    const insert = (proj: Project, kind: TrackKind, tracks: Track[]): Project => {
      if (tracks.length === 0) return proj;
      const all = [...proj.tracks];
      all.splice(layerInsertIndex(proj, kind, anchor), 0, ...tracks);
      return { ...proj, tracks: all };
    };
    const pictures = fresh.filter((l) => l.kind !== 'audio');
    next = insert(next, pictures[0]?.kind ?? 'video', pictures.map(make));
    next = insert(next, 'audio', fresh.filter((l) => l.kind === 'audio').map(make));
  }
  const clips = fresh.flatMap((l) => l.clips);
  return { project: next, ids: clips.map((c) => c.id).reverse(), end: Math.max(...clips.map(clipEnd)) };
}

/** Ctrl+V: pastes at the playhead, selects the pasted clips and moves the playhead to their end. */
export function pasteClipboard(): void {
  if (!clipboard) return;
  const { project, playhead, selectedTrackId } = useEditor.getState();
  const pasted = withPasted(project, clipboard, playhead, selectedTrackId);
  commit(() => pasted.project);
  selectClips(pasted.ids);
  setPlayhead(pasted.end);
}

/** The look of `src` on `c` when both are the same kind: picture transform, keyframes, mirroring, crop, color and volume, or text style and placement. */
export function withAttributes(c: AnyClip, src: AnyClip): AnyClip {
  if (isMediaClip(c) && isMediaClip(src)) {
    const next = { ...c, transform: { ...src.transform }, flipX: src.flipX, crop: { ...src.crop }, color: { ...src.color }, volume: src.volume };
    if (src.keys) next.keys = structuredClone(src.keys);
    else delete next.keys;
    return next;
  }
  if (isTextClip(c) && isTextClip(src)) return { ...c, style: { ...src.style }, x: src.x, y: src.y, rotation: src.rotation, anim: src.anim };
  return c;
}

/** Ctrl+Alt+V: the copied main clip's attributes onto every selected clip of the same kind, as one undo step. */
export function pasteAttributes(): void {
  if (!clipboard) return;
  const src = clipboard.main;
  const { project, selectedIds } = useEditor.getState();
  const same = (c: AnyClip) => selectedIds.includes(c.id) && isMediaClip(c) === isMediaClip(src);
  if (!project.tracks.some((tr) => !tr.locked && tr.clips.some(same))) return;
  commit((p) => ({
    ...p,
    tracks: p.tracks.map((tr) => (tr.locked ? tr : { ...tr, clips: tr.clips.map((c) => (same(c) ? withAttributes(c, src) : c)) })),
  }));
}
