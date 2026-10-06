import { useEffect, useRef, useState } from 'react';
import type { AnyClip, Project, Track } from '../../shared/project';
import {
  assetById,
  clipDuration,
  clipEnd,
  effectiveDissolve,
  isMediaClip,
  isTextClip,
  projectDuration,
  resolveTokens,
} from '../../shared/project';
import { seek } from '../engine/player';
import { formatTime } from '../format';
import {
  beginGesture,
  deleteSelected,
  deleteTrack,
  duplicateTrack,
  endGesture,
  findClip,
  fitStart,
  frameSnap,
  mergeDownBlocker,
  mergeTrackDown,
  moveClip,
  moveClipToNewTrack,
  moveTrack,
  overlaps,
  placeAsset,
  redo,
  renameTrack,
  splitAtPlayhead,
  tidyTracks,
  toggleTrack,
  trackNeighbour,
  undo,
  updateClip,
  updateGesture,
  useEditor,
} from '../store';
import { ASSET_MIME } from './MediaBin';

const RULER_H = 28;
const TRACK_H = 56;
const ZONE_H = 22;
const SNAP_PX = 8;
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

function snapCandidates(project: Project, ignoreId: string): number[] {
  const out = [0, useEditor.getState().playhead];
  for (const t of project.tracks) for (const c of t.clips) if (c.id !== ignoreId) out.push(c.start, clipEnd(c));
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
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [dropRow, setDropRow] = useState<string | null>(null);
  const [viewWidth, setViewWidth] = useState(1000);

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
        if (!el || !s.playing || s.playhead === prev.playhead) return;
        const x = s.playhead * s.zoom;
        if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80);
      }),
    [],
  );

  const duration = projectDuration(project);
  const contentWidth = Math.max(viewWidth, (duration + 20) * zoom);
  const rows = rowsOf(project);

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

  /** Ruler, playhead handle or empty timeline: drops the selection and moves the playhead with the pointer. */
  const onScrubDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    // The horizontal scrollbar is part of this element; pressing it scrolls, it does not seek.
    if (e.button !== 0 || e.clientY > el.getBoundingClientRect().top + el.clientHeight) return;
    useEditor.setState({ selectedClipId: null });
    el.setPointerCapture(e.pointerId);
    seek(scrubTime(e.clientX));
    const move = (ev: PointerEvent) => seek(scrubTime(ev.clientX));
    const up = () => {
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
    useEditor.setState({ selectedClipId: clip.id });
    // Selecting a block the playhead is not over brings the playhead to its first frame.
    const { playhead } = useEditor.getState();
    if (playhead < clip.start || playhead >= clipEnd(clip)) seek(clip.start);
    if (findClip(useEditor.getState().project, clip.id)?.track.locked) return;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const base = useEditor.getState().project;
    const found = findClip(base, clip.id);
    if (!found) return;
    const asset = isTextClip(clip) ? null : assetById(base, clip.assetId);
    const stretchy = !asset || asset.kind === 'image';
    const candidates = snapCandidates(base, clip.id);
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
        const next: AnyClip = stretchy
          ? { ...clip, start: clip.start + dt, out: clip.out - dt }
          : { ...clip, start: clip.start + dt, in: clip.in + dt * rate };
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
      useEditor.setState((s) => ({ project: tidyTracks(s.project) }));
      endGesture();
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
    const assetId = e.dataTransfer.getData(ASSET_MIME);
    if (!assetId) return;
    const asset = assetById(project, assetId);
    const start = timeAt(e.clientX);
    if (row.type === 'track') placeAsset(asset, row.track.id, start, project.tracks.indexOf(row.track));
    else placeAsset(asset, null, start, row.type === 'new-video' ? 0 : project.tracks.length);
  };

  const step = tickStep(zoom);
  const ticks: number[] = [];
  for (let t = 0; t * zoom <= contentWidth; t += step / 5) ticks.push(Math.round(t * 1000) / 1000);

  return (
    <section className="timeline">
      <div className="tl-toolbar">
        <button onClick={splitAtPlayhead} title="분할 (S)">
          분할
        </button>
        <button onClick={deleteSelected} disabled={!selectedClipId} title="삭제 (Delete)">
          삭제
        </button>
        <span className="sep" />
        <button onClick={undo} disabled={!canUndo} title="실행 취소 (Ctrl+Z)">
          실행 취소
        </button>
        <button onClick={redo} disabled={!canRedo} title="다시 실행 (Ctrl+Shift+Z)">
          다시 실행
        </button>
        <span className="sep" />
        <button className={snap ? 'toggle on' : 'toggle'} onClick={() => useEditor.setState({ snap: !snap })}>
          자석 {snap ? '켬' : '끔'}
        </button>
        <div className="grow" />
        <label className="zoom">
          <span>확대</span>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            value={zoom}
            onChange={(e) => useEditor.setState({ zoom: Number(e.target.value) })}
          />
        </label>
      </div>
      <div className="tl-body">
        <div className="tl-heads">
          <div style={{ height: RULER_H }} />
          {rows.map((row) =>
            row.type === 'track' ? (
              <div key={rowKey(row)} className="tl-head" data-head={row.track.id} style={{ height: TRACK_H }}>
                <TrackName project={project} track={row.track} />
                <div className="tl-head-btns">
                  {row.track.kind !== 'audio' && (
                    <button
                      className={row.track.hidden ? 'toggle' : 'toggle on'}
                      onClick={() => toggleTrack(row.track.id, 'hidden')}
                      title="화면 보이기"
                    >
                      {row.track.hidden ? '숨김' : '보임'}
                    </button>
                  )}
                  {row.track.kind !== 'text' && (
                    <button
                      className={row.track.muted ? 'toggle' : 'toggle on'}
                      onClick={() => toggleTrack(row.track.id, 'muted')}
                      title="소리"
                    >
                      {row.track.muted ? '음소거' : '소리'}
                    </button>
                  )}
                  <button
                    className={row.track.locked ? 'toggle on lock' : 'toggle lock'}
                    onClick={() => toggleTrack(row.track.id, 'locked')}
                    title="잠그면 클립을 옮기거나 자르거나 지울 수 없어요"
                  >
                    {row.track.locked ? '잠김' : '잠금'}
                  </button>
                  <TrackMenu project={project} track={row.track} />
                </div>
              </div>
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
                <div key={`${m.t}-${m.label}`} className="tl-marker" style={{ left: m.t * zoom }} title={m.label}>
                  <span>{m.label}</span>
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
                  className={`tl-track kind-${row.track.kind}${dropRow === key ? ' drop' : ''}${row.track.locked ? ' locked' : ''}`}
                  style={{ height: TRACK_H }}
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
                      selected={clip.id === selectedClipId}
                      dim={row.track.hidden}
                      dissolve={isMediaClip(clip) ? effectiveDissolve(row.track, clip) : 0}
                      onDown={startClipDrag}
                    />
                  ))}
                </div>
              );
            })}
            <Playhead zoom={zoom} />
          </div>
        </div>
      </div>
    </section>
  );
}

/** The track's label; double-click to rename, an empty name goes back to the default label. */
function TrackName({ project, track }: { project: Project; track: Track }) {
  const [editing, setEditing] = useState(false);
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

const MENU_H = 230;

/** Layer actions: order, merge, duplicate, delete. Opens below its button (above near the window's bottom). */
function TrackMenu({ project, track }: { project: Project; track: Track }) {
  const [at, setAt] = useState<React.CSSProperties | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!at) return;
    // Its own button is left to onClick, which toggles; closing here too would reopen it.
    const close = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !btnRef.current?.contains(target)) setAt(null);
    };
    window.addEventListener('pointerdown', close, true);
    return () => window.removeEventListener('pointerdown', close, true);
  }, [at]);
  const blocker = mergeDownBlocker(project, track.id);
  const run = (action: () => void) => () => {
    action();
    setAt(null);
  };
  return (
    <>
      <button
        ref={btnRef}
        className="icon tl-menu-btn"
        title="레이어 메뉴"
        onClick={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const up = box.bottom + 4 + MENU_H > window.innerHeight;
          setAt(at ? null : up ? { left: box.left, bottom: window.innerHeight - box.top + 4 } : { left: box.left, top: box.bottom + 4 });
        }}
      >
        ⋯
      </button>
      {at && (
        <div className="tl-menu" ref={menuRef} style={at} data-menu={track.id}>
          <button disabled={!trackNeighbour(project, track.id, -1)} onClick={run(() => moveTrack(track.id, -1))}>
            앞으로 (위로)
          </button>
          <button disabled={!trackNeighbour(project, track.id, 1)} onClick={run(() => moveTrack(track.id, 1))}>
            뒤로 (아래로)
          </button>
          <button disabled={blocker !== null} title={blocker ?? ''} onClick={run(() => mergeTrackDown(track.id))}>
            아래 레이어와 병합
          </button>
          {blocker && <div className="tl-menu-note">{blocker}</div>}
          <button onClick={run(() => duplicateTrack(track.id))}>복제</button>
          <button className="danger" disabled={track.locked} onClick={run(() => deleteTrack(track.id))}>
            삭제
          </button>
        </div>
      )}
    </>
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
    label = resolveTokens(clip.text, project.vars).replaceAll('\n', ' ');
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
