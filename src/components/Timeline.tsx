import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  Bookmark,
  Copy,
  LayersPlus,
  Magnet,
  Redo2,
  Scissors,
  Snowflake,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AnyClip, BlendMode, Project, Track, TrackKind } from '../../shared/project';
import {
  assetById,
  BLEND_MODES,
  canClip,
  layerBlend,
  layerOpacity,
  clipDuration,
  clipEnd,
  effectiveDissolve,
  isMediaClip,
  isTextClip,
  projectDuration,
  shiftKeys,
} from '../../shared/project';
import { compositor, pause, seek } from '../engine/player';
import { formatTime } from '../format';
import {
  addLayer,
  beginGesture,
  commit,
  deleteSelected,
  deleteTrack,
  duplicateSelected,
  duplicateTrack,
  endGesture,
  findClip,
  fitStart,
  freezeFrame,
  frameSnap,
  layerDropIndex,
  mergeDownBlocker,
  mergeTrackDown,
  sharedRanges,
  moveClip,
  moveClipToNewTrack,
  moveTrack,
  moveTrackTo,
  overlaps,
  placeAssets,
  redo,
  renameTrack,
  selectClips,
  selectTrack,
  splitAtPlayhead,
  tidyTracks,
  toggleMarker,
  toggleTrack,
  trimAtPlayhead,
  stackNeighbour,
  toggleSelect,
  undo,
  updateClip,
  updateGesture,
  useEditor,
  withTrack,
} from '../store';
import { ASSET_MIME } from './MediaBin';

const RULER_H = 24;
/** Row height per layer kind, after OpenCut: pictures get room for their frames, text is a slim bar. */
const TRACK_H: Record<TrackKind, number> = { video: 60, text: 36, audio: 48 };
/** Layer card thumbnail, a 9:16 frame at twice its CSS size. */
/** Layer thumbnails are drawn at twice the size they show, inside a square box. */
const THUMB_BOX = 96;
const ZONE_H = 22;
const SNAP_PX = 8;
/** Scrubbing within this many pixels of a side edge scrolls the timeline, up to EDGE_SPEED px a frame. */
const EDGE_PX = 28;
const EDGE_SPEED = 24;
const MIN_ZOOM = 10;
const MAX_ZOOM = 400;

type Row = { type: 'track'; track: Track } | { type: 'new-video' } | { type: 'new-audio' };

function rowsOf(project: Project): Row[] {
  return [
    { type: 'new-video' },
    ...project.tracks.map((track): Row => ({ type: 'track', track })),
    { type: 'new-audio' },
  ];
}

function rowKey(row: Row): string {
  return row.type === 'track' ? row.track.id : row.type;
}

function snapCandidates(project: Project, ignoreIds: string[]): number[] {
  const out = [0, useEditor.getState().playhead];
  for (const t of project.tracks) for (const c of t.clips) if (!ignoreIds.includes(c.id)) out.push(c.start, clipEnd(c));
  return out;
}

/** Returns the delta that snaps any of `edges` to the nearest candidate within the pixel threshold. */
function snapDelta(edges: number[], candidates: number[], zoom: number): number {
  let best = 0;
  let bestDist = SNAP_PX / zoom;
  for (const e of edges) {
    for (const c of candidates) {
      const d = Math.abs(c - e);
      if (d < bestDist) {
        bestDist = d;
        best = c - e;
      }
    }
  }
  return best;
}

function rowAt(clientX: number, clientY: number): string | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const row = (el as HTMLElement).dataset?.row;
    if (row) return row;
  }
  return null;
}

function tickStep(zoom: number): number {
  for (const s of [0.5, 1, 2, 5, 10, 15, 30, 60, 120]) if (s * zoom >= 70) return s;
  return 300;
}

function trackLabel(project: Project, track: Track): string {
  if (track.name) return track.name;
  const same = project.tracks.filter((t) => t.kind === track.kind);
  const idx = same.indexOf(track);
  if (track.kind === 'video') return idx === same.length - 1 ? '메인' : `영상 ${same.length - 1 - idx}`;
  if (track.kind === 'text') return `텍스트 ${same.length - idx}`;
  return `오디오 ${idx + 1}`;
}

export function Timeline() {
  const project = useEditor((s) => s.project);
  const zoom = useEditor((s) => s.zoom);
  const snap = useEditor((s) => s.snap);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const selectedIds = useEditor((s) => s.selectedIds);
  const selectedTrackId = useEditor((s) => s.selectedTrackId);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);
  const [viewWidth, setViewWidth] = useState(1000);
  const [freezing, setFreezing] = useState(false);
  const [freezeError, setFreezeError] = useState<string | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        const el = scrollRef.current;
        if (!el || s.playhead === prev.playhead) return;
        const x = s.playhead * s.zoom;
        // Playing: keep a little room ahead. Paused: only when the playhead is actually off-screen, so an
        // edge-scrolling scrub (which clamps to the visible edge) is never snapped away.
        const margin = s.playing ? 40 : -1;
        if (x > el.scrollLeft + el.clientWidth - margin || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80);
      }),
    [],
  );

  // A clip selected elsewhere (the preview) that is off-screen here is scrolled into view, sideways and up or down.
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        const id = s.selectedClipId;
        if (!id || id === prev.selectedClipId) return;
        requestAnimationFrame(() => {
          const scroll = scrollRef.current;
          const body = bodyRef.current;
          const f = findClip(useEditor.getState().project, id);
          if (!scroll || !body || !f) return;
          const z = useEditor.getState().zoom;
          const l = f.clip.start * z;
          const r = clipEnd(f.clip) * z;
          if (r < scroll.scrollLeft || l > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = Math.max(0, l - 40);
          const el = body.querySelector<HTMLElement>(`[data-clip="${id}"]`);
          if (!el) return;
          const box = el.getBoundingClientRect();
          const view = body.getBoundingClientRect();
          if (box.top < view.top) body.scrollTop -= view.top - box.top;
          else if (box.bottom > view.bottom) body.scrollTop += box.bottom - view.bottom;
        });
      }),
    [],
  );

  const duration = projectDuration(project);
  const contentWidth = Math.max(viewWidth, (duration + 20) * zoom);
  const rows = rowsOf(project);
  const [layerDrag, setLayerDrag] = useState<{ id: string; slot: number } | null>(null);
  const [marquee, setMarquee] = useState<{ l: number; t: number; r: number; b: number } | null>(null);

  /** Gap between layer cards under the pointer: 0 = above the top card, tracks.length = below the bottom one. */
  const layerSlot = (clientY: number): number => {
    const cards = [...document.querySelectorAll<HTMLElement>('.tl-heads [data-head]')];
    const at = cards.findIndex((el) => {
      const box = el.getBoundingClientRect();
      return clientY < box.top + box.height / 2;
    });
    return at === -1 ? cards.length : at;
  };
  const onLayerDrag = (trackId: string, clientY: number, drop: boolean) => {
    const slot = layerSlot(clientY);
    if (!drop) {
      setLayerDrag({ id: trackId, slot });
      return;
    }
    setLayerDrag(null);
    moveTrackTo(trackId, slot);
  };
  const dropLineFor = (track: Track): 'before' | 'after' | null => {
    if (!layerDrag || layerDropIndex(project, layerDrag.id, layerDrag.slot) === null) return null;
    const i = project.tracks.indexOf(track);
    if (layerDrag.slot === i) return 'before';
    return layerDrag.slot === project.tracks.length && i === project.tracks.length - 1 ? 'after' : null;
  };

  const timeAt = (clientX: number): number => {
    const el = scrollRef.current;
    if (!el) return 0;
    const box = el.getBoundingClientRect();
    return Math.max(0, (clientX - box.left + el.scrollLeft) / zoom);
  };

  /** Playhead time under the pointer: on the frame grid, or on a clip edge or marker the magnet is close to. */
  const scrubTime = (clientX: number): number => {
    const { project: p, zoom: z, snap: snapOn } = useEditor.getState();
    const t = timeAt(clientX);
    if (snapOn) {
      const edges = [0, ...p.markers.map((m) => m.t), ...p.tracks.flatMap((tr) => tr.clips.flatMap((c) => [c.start, clipEnd(c)]))];
      const near = edges.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), Number.POSITIVE_INFINITY);
      if (Math.abs(near - t) * z <= SNAP_PX) return near;
    }
    return frameSnap(t, p.fps);
  };

  /**
   * Empty layer area: a drag draws a box and selects every clip it touches (Ctrl/Shift adds to the selection); a press
   * without a drag drops the selection and moves the playhead there.
   */
  const startMarquee = (e: React.PointerEvent, el: HTMLElement) => {
    const content = el.querySelector<HTMLElement>('.tl-content');
    if (!content) return;
    el.setPointerCapture(e.pointerId);
    const adding = e.ctrlKey || e.metaKey || e.shiftKey;
    const kept = adding ? useEditor.getState().selectedIds : [];
    const origin = content.getBoundingClientRect();
    const x0 = e.clientX - origin.left;
    const y0 = e.clientY - origin.top;
    let dragged = false;
    const move = (ev: PointerEvent) => {
      const at = content.getBoundingClientRect();
      const x = ev.clientX - at.left;
      const y = ev.clientY - at.top;
      if (!dragged && Math.hypot(x - x0, y - y0) < 3) return;
      dragged = true;
      const box = { l: Math.min(x0, x), t: Math.min(y0, y), r: Math.max(x0, x), b: Math.max(y0, y) };
      setMarquee(box);
      const hit = [...content.querySelectorAll<HTMLElement>('[data-clip]')]
        .filter((c) => {
          const r = c.getBoundingClientRect();
          return r.right - at.left > box.l && r.left - at.left < box.r && r.bottom - at.top > box.t && r.top - at.top < box.b;
        })
        .map((c) => c.dataset.clip ?? '');
      selectClips([...kept.filter((id) => !hit.includes(id)), ...hit]);
    };
    const up = (ev: PointerEvent) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      setMarquee(null);
      if (dragged || adding) return;
      useEditor.setState({ selectedClipId: null });
      seek(scrubTime(ev.clientX));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  /** Ruler or playhead handle: drops the selection and moves the playhead with the pointer. */
  const onScrubDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    // The horizontal scrollbar is part of this element; pressing it scrolls, it does not seek.
    if (e.button !== 0 || e.clientY > el.getBoundingClientRect().top + el.clientHeight) return;
    if (!(e.target as HTMLElement).closest('.tl-ruler, .tl-playhead-grip')) {
      startMarquee(e, el);
      return;
    }
    useEditor.setState({ selectedClipId: null });
    el.setPointerCapture(e.pointerId);
    seek(scrubTime(e.clientX));
    // Holding the pointer at (or past) a side edge keeps scrolling that way; the playhead rides the edge.
    let raf = 0;
    let lastX = e.clientX;
    const edgeSpeed = (clientX: number): number => {
      const px = clientX - el.getBoundingClientRect().left;
      if (px < EDGE_PX) return -Math.min(EDGE_SPEED, EDGE_PX - px);
      if (px > el.clientWidth - EDGE_PX) return Math.min(EDGE_SPEED, px - (el.clientWidth - EDGE_PX));
      return 0;
    };
    const visibleX = (clientX: number): number => {
      const left = el.getBoundingClientRect().left;
      return Math.max(left, Math.min(left + el.clientWidth, clientX));
    };
    const tick = () => {
      const v = edgeSpeed(lastX);
      if (v === 0) {
        raf = 0;
        return;
      }
      el.scrollLeft = Math.max(0, Math.min(el.scrollWidth - el.clientWidth, el.scrollLeft + v));
      seek(scrubTime(visibleX(lastX)));
      raf = requestAnimationFrame(tick);
    };
    const move = (ev: PointerEvent) => {
      lastX = ev.clientX;
      seek(scrubTime(visibleX(ev.clientX)));
      if (!raf && edgeSpeed(ev.clientX) !== 0) raf = requestAnimationFrame(tick);
    };
    const up = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const startClipDrag = (e: React.PointerEvent, clip: AnyClip, mode: 'move' | 'trim-start' | 'trim-end') => {
    e.stopPropagation();
    e.preventDefault();
    // preventDefault keeps focus where it was; an inspector field would then swallow Ctrl+C/V, S and Delete.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      toggleSelect(clip.id);
      return;
    }
    const pickOnly = () => {
      useEditor.setState({ selectedClipId: clip.id, selectedIds: [clip.id] });
      // Selecting a block the playhead is not over brings the playhead to its first frame.
      const { playhead } = useEditor.getState();
      if (playhead < clip.start || playhead >= clipEnd(clip)) seek(clip.start);
    };
    const { selectedIds: group } = useEditor.getState();
    if (mode === 'move' && group.length > 1 && group.includes(clip.id)) {
      startGroupDrag(e, group, pickOnly);
      return;
    }
    pickOnly();
    if (findClip(useEditor.getState().project, clip.id)?.track.locked) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const base = useEditor.getState().project;
    const found = findClip(base, clip.id);
    if (!found) return;
    const asset = isTextClip(clip) ? null : assetById(base, clip.assetId);
    const stretchy = !asset || asset.kind === 'image';
    const candidates = snapCandidates(base, [clip.id]);
    const fps = base.fps;
    const minLen = 1 / fps;
    const rate = isMediaClip(clip) ? clip.speed : 1;
    let moved = false;
    beginGesture();

    const move = (ev: PointerEvent) => {
      const { zoom: z, snap: snapOn } = useEditor.getState();
      let dt = (ev.clientX - x0) / z;
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      if (mode === 'move') {
        if (snapOn) dt += snapDelta([clip.start + dt, clipEnd(clip) + dt], candidates, z);
        const start = Math.max(0, frameSnap(clip.start + dt, fps));
        const row = rowAt(ev.clientX, ev.clientY);
        updateGesture((b) => {
          if (row === 'new-video' && found.track.kind !== 'audio') return moveClipToNewTrack(b, clip.id, start, 0);
          if (row === 'new-audio' && found.track.kind === 'audio')
            return moveClipToNewTrack(b, clip.id, start, b.tracks.length);
          const target = row && b.tracks.some((t) => t.id === row) ? row : found.track.id;
          const fitted = (trackId: string): Project | null => {
            const track = b.tracks.find((t) => t.id === trackId);
            const at = track ? fitStart(track, clip.id, start, clipDuration(clip)) : null;
            return at === null ? null : moveClip(b, clip.id, trackId, at);
          };
          return fitted(target) ?? fitted(found.track.id);
        });
        return;
      }
      if (mode === 'trim-start') {
        if (snapOn) dt += snapDelta([clip.start + dt], candidates, z);
        dt = frameSnap(dt, fps);
        dt = Math.max(dt, -clip.start);
        if (!stretchy) dt = Math.max(dt, -clip.in / rate);
        // Stops exactly at the clip before, wherever its end falls between frames.
        const prevEnd = Math.max(0, ...found.track.clips.filter((c) => c.id !== clip.id && c.start < clip.start).map(clipEnd));
        dt = Math.max(dt, prevEnd - clip.start);
        dt = Math.min(dt, clipDuration(clip) - minLen);
        const moved: AnyClip = stretchy
          ? { ...clip, start: clip.start + dt, out: clip.out - dt }
          : { ...clip, start: clip.start + dt, in: clip.in + dt * rate };
        const next = isMediaClip(moved) ? shiftKeys(moved, -dt) : moved;
        if (overlaps(found.track, next.start, clipEnd(next), clip.id)) return;
        updateGesture((b) => updateClip(b, clip.id, () => next));
        return;
      }
      if (snapOn) dt += snapDelta([clipEnd(clip) + dt], candidates, z);
      dt = frameSnap(dt, fps);
      let out = Math.max(clip.in + minLen * rate, clip.out + dt * rate);
      if (asset && asset.kind !== 'image') out = Math.min(out, asset.duration);
      const nextStart = Math.min(
        Number.POSITIVE_INFINITY,
        ...found.track.clips.filter((c) => c.id !== clip.id && c.start > clip.start).map((c) => c.start),
      );
      out = Math.min(out, clip.in + (nextStart - clip.start) * rate);
      const next: AnyClip = { ...clip, out };
      if (overlaps(found.track, next.start, clipEnd(next), clip.id)) return;
      updateGesture((b) => updateClip(b, clip.id, () => next));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      useEditor.setState((s) => ({ project: tidyTracks(s.gestureBase ?? s.project, s.project) }));
      endGesture();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  /**
   * Dragging one of several selected clips moves them all by the same time, each on its own layer; clips on locked
   * layers stay put. A press without a drag selects just the pressed clip.
   */
  const startGroupDrag = (e: React.PointerEvent, ids: string[], pickOnly: () => void) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const base = useEditor.getState().project;
    const moving = ids.flatMap((id) => {
      const f = findClip(base, id);
      return f && !f.track.locked ? [f] : [];
    });
    if (moving.length === 0) return;
    const movingIds = moving.map((f) => f.clip.id);
    const candidates = snapCandidates(base, movingIds);
    const edges = moving.flatMap((f) => [f.clip.start, clipEnd(f.clip)]);
    const earliest = Math.min(...moving.map((f) => f.clip.start));
    const fps = base.fps;
    let moved = false;
    beginGesture();

    const move = (ev: PointerEvent) => {
      const { zoom: z, snap: snapOn } = useEditor.getState();
      if (!moved && Math.abs(ev.clientX - x0) < 3) return;
      moved = true;
      let dt = (ev.clientX - x0) / z;
      if (snapOn) dt += snapDelta(edges.map((t) => t + dt), candidates, z);
      dt = Math.max(0, frameSnap(earliest + dt, fps)) - earliest;
      updateGesture((b) => {
        const blocked = moving.some((f) => {
          const others = { ...f.track, clips: f.track.clips.filter((c) => !movingIds.includes(c.id)) };
          return overlaps(others, f.clip.start + dt, clipEnd(f.clip) + dt, null);
        });
        if (blocked) return null;
        return moving.reduce((p, f) => updateClip(p, f.clip.id, (c) => ({ ...c, start: f.clip.start + dt })), b);
      });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      endGesture();
      if (!moved) pickOnly();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const onDragOverRow = (e: React.DragEvent, key: string) => {
    if (!e.dataTransfer.types.includes(ASSET_MIME)) return;
    if (project.tracks.some((t) => t.id === key && t.locked)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (dropRow !== key) setDropRow(key);
  };

  const onDropRow = (e: React.DragEvent, row: Row) => {
    e.preventDefault();
    setDropRow(null);
    const ids = e.dataTransfer.getData(ASSET_MIME);
    if (!ids) return;
    const assets = ids.split('\n').map((id) => assetById(project, id));
    const start = timeAt(e.clientX);
    if (row.type === 'track') placeAssets(assets, row.track.id, start, project.tracks.indexOf(row.track));
    else placeAssets(assets, null, start, row.type === 'new-video' ? 0 : project.tracks.length);
  };

  const setZoom = (z: number) => useEditor.setState({ zoom: Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z)) });

  const runFreeze = () => {
    setFreezeError(null);
    setFreezing(true);
    freezeFrame()
      .catch((err: unknown) => setFreezeError((err as Error).message))
      .finally(() => setFreezing(false));
  };

  const step = tickStep(zoom);
  const ticks: number[] = [];
  for (let t = 0; t * zoom <= contentWidth; t += step / 5) ticks.push(Math.round(t * 1000) / 1000);

  return (
    <section className="timeline">
      <div className="tl-toolbar">
        <ToolButton icon={Scissors} label="분할 (S)" onClick={splitAtPlayhead} testId="tl-split" />
        <ToolButton icon={ArrowLeftToLine} label="재생 헤드 앞 잘라내기 (Q)" onClick={() => trimAtPlayhead('right')} testId="tl-trim-before" />
        <ToolButton icon={ArrowRightToLine} label="재생 헤드 뒤 잘라내기 (W)" onClick={() => trimAtPlayhead('left')} testId="tl-trim-after" />
        <ToolButton icon={Copy} label="클립 복제 (Ctrl+D)" onClick={duplicateSelected} disabled={!selectedClipId} testId="tl-duplicate" />
        <ToolButton
          icon={Snowflake}
          label={freezing ? '정지 화면 만드는 중…' : '정지 화면: 재생 헤드의 프레임을 1초 위 레이어로 (F)'}
          onClick={runFreeze}
          disabled={!selectedClipId || freezing}
          testId="tl-freeze"
        />
        <ToolButton icon={Trash2} label="삭제 (Delete)" onClick={deleteSelected} disabled={!selectedClipId} testId="tl-delete" />
        <span className="sep" />
        <ToolButton icon={Bookmark} label="북마크 넣기/빼기 (M)" onClick={toggleMarker} testId="tl-bookmark" />
        <AddLayerButton />
        <span className="sep" />
        <ToolButton icon={Undo2} label="실행 취소 (Ctrl+Z)" onClick={undo} disabled={!canUndo} testId="tl-undo" />
        <ToolButton icon={Redo2} label="다시 실행 (Ctrl+Shift+Z)" onClick={redo} disabled={!canRedo} testId="tl-redo" />
        {freezeError && (
          <span className="tl-error" onClick={() => setFreezeError(null)}>
            {freezeError}
          </span>
        )}
        <div className="grow" />
        <ToolButton
          icon={Magnet}
          label={snap ? '자석 켬 (끄려면 누르기)' : '자석 끔 (켜려면 누르기)'}
          onClick={() => useEditor.setState({ snap: !snap })}
          on={snap}
          testId="tl-snap"
        />
        <span className="sep" />
        <ToolButton icon={ZoomOut} label="축소" onClick={() => setZoom(zoom / 1.25)} testId="tl-zoom-out" />
        <label className="zoom" title="확대 (Ctrl+휠)">
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            value={zoom}
            onChange={(e) => useEditor.setState({ zoom: Number(e.target.value) })}
          />
        </label>
        <ToolButton icon={ZoomIn} label="확대" onClick={() => setZoom(zoom * 1.25)} testId="tl-zoom-in" />
      </div>
      <div
        className="tl-body"
        ref={bodyRef}
        // The ruler sits inside the horizontal scroller, so sticky can't pin it to this one; it follows this offset instead.
        onScroll={(e) => e.currentTarget.style.setProperty('--tl-scroll-y', `${e.currentTarget.scrollTop}px`)}
      >
        <div className="tl-heads">
          <div className="tl-heads-ruler" style={{ height: RULER_H }} />
          {rows.map((row) =>
            row.type === 'track' ? (
              <LayerCard
                key={rowKey(row)}
                project={project}
                track={row.track}
                selected={row.track.id === selectedTrackId}
                dragging={layerDrag?.id === row.track.id}
                dropLine={dropLineFor(row.track)}
                onDrag={onLayerDrag}
              />
            ) : (
              <div key={rowKey(row)} style={{ height: ZONE_H }} />
            ),
          )}
        </div>
        <div
          className="tl-scroll"
          ref={scrollRef}
          onWheel={(e) => {
            if (!e.ctrlKey) return;
            const el = scrollRef.current;
            if (!el) return;
            const anchor = timeAt(e.clientX);
            const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom * Math.pow(1.002, -e.deltaY)));
            useEditor.setState({ zoom: next });
            const px = e.clientX - el.getBoundingClientRect().left;
            requestAnimationFrame(() => (el.scrollLeft = anchor * next - px));
          }}
          onPointerDown={onScrubDown}
        >
          <div className="tl-content" style={{ width: contentWidth }}>
            <div className="tl-ruler" style={{ height: RULER_H }}>
              {ticks.map((t, i) => {
                const major = i % 5 === 0;
                return (
                  <div key={t} className={major ? 'tick major' : 'tick'} style={{ left: t * zoom }}>
                    {major && <span>{formatTime(t, project.fps).replace(/\.\d+$/, '')}</span>}
                  </div>
                );
              })}
              {project.markers.map((m) => (
                <div key={`${m.t}-${m.label}`} className="tl-marker" style={{ left: m.t * zoom }} title={`${m.label}: 누르면 이동`}>
                  <span
                    data-marker={m.label}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      useEditor.setState({ selectedClipId: null });
                      pause();
                      seek(m.t);
                    }}
                  >
                    {m.label}
                  </span>
                </div>
              ))}
            </div>
            {rows.map((row) => {
              const key = rowKey(row);
              if (row.type !== 'track') {
                return (
                  <div
                    key={key}
                    data-row={key}
                    className={`tl-zone${dropRow === key ? ' drop' : ''}`}
                    style={{ height: ZONE_H }}
                    onDragOver={(e) => onDragOverRow(e, key)}
                    onDragLeave={() => setDropRow(null)}
                    onDrop={(e) => onDropRow(e, row)}
                  >
                    {dropRow === key && <span>새 트랙</span>}
                  </div>
                );
              }
              return (
                <div
                  key={key}
                  data-row={key}
                  className={`tl-track kind-${row.track.kind}${dropRow === key ? ' drop' : ''}${row.track.locked ? ' locked' : ''}${row.track.id === selectedTrackId ? ' selected' : ''}`}
                  style={{ height: TRACK_H[row.track.kind] }}
                  onDragOver={(e) => onDragOverRow(e, key)}
                  onDragLeave={() => setDropRow(null)}
                  onDrop={(e) => onDropRow(e, row)}
                >
                  {row.track.clips.map((clip) => (
                    <ClipView
                      key={clip.id}
                      project={project}
                      clip={clip}
                      zoom={zoom}
                      selected={selectedIds.includes(clip.id)}
                      dim={row.track.hidden}
                      dissolve={isMediaClip(clip) ? effectiveDissolve(row.track, clip) : 0}
                      onDown={startClipDrag}
                    />
                  ))}
                </div>
              );
            })}
            {marquee && (
              <div
                className="tl-marquee"
                style={{ left: marquee.l, top: marquee.t, width: marquee.r - marquee.l, height: marquee.b - marquee.t }}
              />
            )}
            <Playhead zoom={zoom} />
          </div>
        </div>
      </div>
    </section>
  );
}

interface ToolButtonProps {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  on?: boolean;
  testId: string;
}

function ToolButton({ icon: Icon, label, onClick, disabled = false, on = false, testId }: ToolButtonProps) {
  return (
    <button className={on ? 'icon on' : 'icon'} onClick={onClick} disabled={disabled} title={label} aria-label={label} data-testid={testId}>
      <Icon />
    </button>
  );
}

/** Adds an empty video, text or audio layer above the selected one. */
function AddLayerButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [open]);
  const add = (kind: TrackKind) => () => {
    addLayer(kind);
    setOpen(false);
  };
  return (
    <span className="tl-add-layer" ref={ref}>
      <ToolButton icon={LayersPlus} label="선택한 레이어 위에 레이어 추가" onClick={() => setOpen(!open)} on={open} testId="tl-add-layer" />
      {open && (
        <div className="tl-menu tl-add-menu">
          <button onClick={add('video')} data-add-layer="video">
            영상 레이어
          </button>
          <button onClick={add('text')} data-add-layer="text">
            글자 레이어
          </button>
          <button onClick={add('audio')} data-add-layer="audio">
            오디오 레이어
          </button>
        </div>
      )}
    </span>
  );
}

/** The layer's name; double-click (or 이름 바꾸기 in its menu) to rename, empty goes back to the default label. */
function TrackName({
  project,
  track,
  editing,
  setEditing,
}: {
  project: Project;
  track: Track;
  editing: boolean;
  setEditing: (on: boolean) => void;
}) {
  const label = trackLabel(project, track);
  if (!editing) {
    return (
      <span className="tl-head-name" title="두 번 눌러 이름 바꾸기" onDoubleClick={() => setEditing(true)}>
        {label}
      </span>
    );
  }
  return (
    <input
      className="tl-head-input"
      autoFocus
      defaultValue={track.name ?? ''}
      placeholder={label}
      onPointerDown={(e) => e.stopPropagation()}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setEditing(false);
      }}
      onBlur={(e) => {
        if ((e.currentTarget.value.trim() || undefined) !== track.name) renameTrack(track.id, e.currentTarget.value);
        setEditing(false);
      }}
    />
  );
}

/** The layer drawn alone at the playhead, on a transparency checkerboard. */
function LayerThumb({ trackId }: { trackId: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const fw = useEditor((s) => s.project.width);
  const fh = useEditor((s) => s.project.height);
  const fit = THUMB_BOX / Math.max(fw, fh);
  const w = Math.round(fw * fit);
  const h = Math.round(fh * fit);
  useEffect(() => {
    compositor.attachThumb(trackId, ref.current);
    return () => compositor.attachThumb(trackId, null);
  }, [trackId]);
  const shape = { '--thumb-w': w / THUMB_BOX, '--thumb-h': h / THUMB_BOX } as React.CSSProperties;
  return <canvas ref={ref} className="layer-thumb" width={w} height={h} style={shape} />;
}

const KIND_LABEL = { text: '글자', video: '영상', audio: '오디오' } as const;
const DRAG_PX = 4;
const MENU_H = 430;

interface LayerCardProps {
  project: Project;
  track: Track;
  /** Gap the dragged card would drop into, shown as a line above (or below, for the last card) this one. */
  dropLine: 'before' | 'after' | null;
  selected: boolean;
  dragging: boolean;
  onDrag: (trackId: string, clientY: number, drop: boolean) => void;
}

/**
 * A layer as a card, like a drawing app's layer list: thumbnail, name, what it holds, a visibility (or sound) check.
 * Tap it to select the layer (new clips go there), tap the selected one for its menu, drag it up or down to restack.
 */
function LayerCard({ project, track, dropLine, selected, dragging, onDrag }: LayerCardProps) {
  const [menuAt, setMenuAt] = useState<React.CSSProperties | null>(null);
  const [editing, setEditing] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const audio = track.kind === 'audio';
  const shown = audio ? !track.muted : !track.hidden;
  const blend = layerBlend(track);
  const opacity = layerOpacity(track);
  const job = useEditor((s) => (s.layerJob?.trackId === track.id ? s.layerJob : null));
  const notes = [
    job ? (job.error === null ? '병합 중…' : '병합 실패') : '',
    KIND_LABEL[track.kind],
    blend !== 'normal' ? (BLEND_MODES.find((m) => m.id === blend)?.label ?? '') : '',
    opacity < 1 ? `${Math.round(opacity * 100)}%` : '',
    track.clipped && track.kind !== 'audio' ? '클리핑' : '',
    track.locked ? '잠김' : '',
    track.kind === 'video' && track.muted ? '음소거' : '',
  ].filter(Boolean);

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || editing) return;
    const startY = e.clientY;
    let moved = false;
    const move = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientY - startY) < DRAG_PX) return;
      moved = true;
      onDrag(track.id, ev.clientY, false);
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) {
        onDrag(track.id, ev.clientY, true);
        return;
      }
      if (!selected) {
        selectTrack(track.id);
        return;
      }
      const box = cardRef.current?.getBoundingClientRect();
      if (!box) return;
      const top = Math.min(box.top, window.innerHeight - MENU_H - 8);
      setMenuAt((open) => (open ? null : { left: box.right + 6, top: Math.max(8, top) }));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div
      ref={cardRef}
      className={`tl-head layer-card${selected ? ' selected' : ''}${track.kind === 'text' ? ' short' : ''}${track.clipped && track.kind !== 'audio' ? ' clipped' : ''}${shown ? '' : ' off'}${menuAt ? ' open' : ''}${dragging ? ' dragging' : ''}${dropLine ? ` drop-${dropLine}` : ''}`}
      data-head={track.id}
      style={{ height: TRACK_H[track.kind] }}
      onPointerDown={onDown}
    >
      {audio ? <div className="layer-thumb layer-thumb-audio">♪</div> : <LayerThumb trackId={track.id} />}
      <div className="layer-info">
        <TrackName project={project} track={track} editing={editing} setEditing={setEditing} />
        <span className={job?.error ? 'layer-notes failed' : 'layer-notes'} title={job?.error ?? undefined}>
          {notes.join(' · ')}
        </span>
      </div>
      <input
        type="checkbox"
        className="layer-check"
        checked={shown}
        title={audio ? '소리' : '화면 보이기'}
        onPointerDown={(e) => e.stopPropagation()}
        onChange={() => toggleTrack(track.id, audio ? 'muted' : 'hidden')}
      />
      {menuAt && (
        <LayerMenu
          project={project}
          track={track}
          at={menuAt}
          card={cardRef}
          close={() => setMenuAt(null)}
          rename={() => setEditing(true)}
        />
      )}
    </div>
  );
}

interface LayerMenuProps {
  project: Project;
  track: Track;
  at: React.CSSProperties;
  card: React.RefObject<HTMLDivElement | null>;
  close: () => void;
  rename: () => void;
}

/** Layer actions beside its card: rename, lock, sound, order, merge, duplicate, delete. */
function LayerMenu({ project, track, at, card, close, rename }: LayerMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The card itself is left to its own tap, which toggles; closing here too would reopen it.
    const away = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !card.current?.contains(target)) close();
    };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, [card, close]);
  const blocker = mergeDownBlocker(project, track.id);
  const busy = useEditor((s) => s.layerJob !== null && s.layerJob.error === null);
  const below = project.tracks[project.tracks.findIndex((t) => t.id === track.id) + 1];
  const overlapping = track.kind === 'video' && below?.kind === 'video' && sharedRanges(track, below).length > 0;
  const run = (action: () => void) => () => {
    action();
    close();
  };
  const setOpacity = (opacity: number) => {
    const update = (p: Project) =>
      withTrack(p, track.id, (t) => {
        const rest = { ...t };
        delete rest.opacity;
        return opacity >= 1 ? rest : { ...rest, opacity };
      });
    // A drag is one undo step; a change from anywhere else is committed on its own.
    if (useEditor.getState().gestureBase) updateGesture(update);
    else commit(update);
  };
  const setBlend = (blend: BlendMode) =>
    commit((p) =>
      withTrack(p, track.id, (t) => {
        const rest = { ...t };
        delete rest.blend;
        return blend === 'normal' ? rest : { ...rest, blend };
      }),
    );
  return (
    <div className="tl-menu" ref={menuRef} style={at} data-menu={track.id} onPointerDown={(e) => e.stopPropagation()}>
      {track.kind !== 'audio' && (
        <div className="layer-look">
          <label>
            <span>불투명도 {Math.round(layerOpacity(track) * 100)}%</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={Math.round(layerOpacity(track) * 100)}
              data-testid="layer-opacity"
              onPointerDown={beginGesture}
              onPointerUp={endGesture}
              onChange={(e) => setOpacity(Number(e.target.value) / 100)}
            />
          </label>
          <label>
            <span>혼합 모드</span>
            <select value={layerBlend(track)} data-testid="layer-blend" onChange={(e) => setBlend(e.target.value as BlendMode)}>
              {BLEND_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <div className="tl-menu-sep" />
        </div>
      )}
      {track.kind !== 'audio' && (
        <button
          disabled={!track.clipped && !canClip(project, track.id)}
          title="아래 레이어가 보이는 곳에만 이 레이어가 보여요"
          onClick={run(() => toggleTrack(track.id, 'clipped'))}
        >
          {track.clipped ? '클리핑 마스크 해제' : '클리핑 마스크'}
        </button>
      )}
      <button onClick={run(rename)}>이름 바꾸기</button>
      <button onClick={run(() => toggleTrack(track.id, 'locked'))}>{track.locked ? '잠금 해제' : '잠금'}</button>
      {track.kind === 'video' && (
        <button onClick={run(() => toggleTrack(track.id, 'muted'))}>{track.muted ? '소리 켜기' : '소리 끄기'}</button>
      )}
      <div className="tl-menu-sep" />
      <button disabled={!stackNeighbour(project, track.id, -1)} onClick={run(() => moveTrack(track.id, -1))}>
        앞으로 (위로)
      </button>
      <button disabled={!stackNeighbour(project, track.id, 1)} onClick={run(() => moveTrack(track.id, 1))}>
        뒤로 (아래로)
      </button>
      <button disabled={blocker !== null || busy} title={blocker ?? ''} onClick={run(() => void mergeTrackDown(track.id))}>
        아래 레이어와 병합
      </button>
      {blocker && <div className="tl-menu-note">{blocker}</div>}
      {!blocker && overlapping && <div className="tl-menu-note">겹치는 구간은 영상 하나로 구워서 합쳐요</div>}
      <button onClick={run(() => duplicateTrack(track.id))}>복제</button>
      <button className="danger" disabled={track.locked} onClick={run(() => deleteTrack(track.id))}>
        삭제
      </button>
    </div>
  );
}

interface ClipViewProps {
  project: Project;
  clip: AnyClip;
  zoom: number;
  selected: boolean;
  dim: boolean;
  /** Seconds of incoming dissolve actually used; its half after the cut is marked inside the clip. */
  dissolve: number;
  onDown: (e: React.PointerEvent, clip: AnyClip, mode: 'move' | 'trim-start' | 'trim-end') => void;
}

function ClipView({ project, clip, zoom, selected, dim, dissolve, onDown }: ClipViewProps) {
  const width = clipDuration(clip) * zoom;
  const style: React.CSSProperties = { left: clip.start * zoom, width };
  let kind: string;
  let label: string;
  if (isTextClip(clip)) {
    kind = 'text';
    label = clip.text.replaceAll('\n', ' ');
  } else {
    const asset = assetById(project, clip.assetId);
    kind = asset.kind;
    label = asset.name;
    const strip = asset.thumbPath ?? asset.wavePath;
    if (strip) {
      style.backgroundImage = `url("${window.api.mediaUrl(strip)}")`;
      if (asset.kind === 'image') {
        style.backgroundSize = 'auto 100%';
        style.backgroundRepeat = 'repeat-x';
      } else {
        style.backgroundSize = `${(asset.duration * zoom) / clip.speed}px 100%`;
        style.backgroundPosition = `${(-clip.in * zoom) / clip.speed}px 0`;
        style.backgroundRepeat = 'no-repeat';
      }
    }
  }
  return (
    <div
      className={`tl-clip kind-${kind}${selected ? ' selected' : ''}${dim ? ' dim' : ''}`}
      style={style}
      data-clip={clip.id}
      onPointerDown={(e) => onDown(e, clip, 'move')}
      title={label}
    >
      {dissolve > 0 && <div className="tl-dissolve" style={{ width: (dissolve / 2) * zoom }} data-dissolve-mark={dissolve} />}
      {isMediaClip(clip) &&
        clip.keys?.map((k) =>
          k.t >= 0 && k.t <= clipDuration(clip) ? <div key={k.t} className="tl-key" style={{ left: k.t * zoom }} data-key={k.t} /> : null,
        )}
      <div className="tl-clip-label">
        {label} · {clipDuration(clip).toFixed(1)}초
      </div>
      <div className="handle left" onPointerDown={(e) => onDown(e, clip, 'trim-start')} />
      <div className="handle right" onPointerDown={(e) => onDown(e, clip, 'trim-end')} />
    </div>
  );
}

function Playhead({ zoom }: { zoom: number }) {
  const playhead = useEditor((s) => s.playhead);
  return (
    <div className="tl-playhead" style={{ left: playhead * zoom }}>
      <div className="tl-playhead-grip" style={{ height: RULER_H }} title="끌어서 시간 이동" />
    </div>
  );
}
