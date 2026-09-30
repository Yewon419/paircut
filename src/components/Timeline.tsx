import { useEffect, useRef, useState } from 'react';
import type { AnyClip, Project, Track } from '../../shared/project';
import { assetById, clipDuration, clipEnd, isTextClip, projectDuration, resolveTokens } from '../../shared/project';
import { seek } from '../engine/player';
import { formatTime } from '../format';
import {
  beginGesture,
  deleteSelected,
  endGesture,
  findClip,
  frameSnap,
  moveClip,
  moveClipToNewTrack,
  overlaps,
  placeAsset,
  redo,
  splitAtPlayhead,
  tidyTracks,
  toggleTrack,
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

  const onRulerDown = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    seek(frameSnap(timeAt(e.clientX), project.fps));
    const move = (ev: PointerEvent) => seek(frameSnap(timeAt(ev.clientX), useEditor.getState().project.fps));
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
    useEditor.setState({ selectedClipId: clip.id });
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
          return moveClip(b, clip.id, target, start) ?? moveClip(b, clip.id, found.track.id, start);
        });
        return;
      }
      if (mode === 'trim-start') {
        if (snapOn) dt += snapDelta([clip.start + dt], candidates, z);
        dt = frameSnap(dt, fps);
        dt = Math.max(dt, -clip.start);
        if (!stretchy) dt = Math.max(dt, -clip.in);
        dt = Math.min(dt, clipDuration(clip) - minLen);
        const next: AnyClip = stretchy
          ? { ...clip, start: clip.start + dt, out: clip.out - dt }
          : { ...clip, start: clip.start + dt, in: clip.in + dt };
        if (overlaps(found.track, next.start, clipEnd(next), clip.id)) return;
        updateGesture((b) => updateClip(b, clip.id, () => next));
        return;
      }
      if (snapOn) dt += snapDelta([clipEnd(clip) + dt], candidates, z);
      dt = frameSnap(dt, fps);
      let out = Math.max(clip.in + minLen, clip.out + dt);
      if (asset && asset.kind !== 'image') out = Math.min(out, asset.duration);
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
              <div key={rowKey(row)} className="tl-head" style={{ height: TRACK_H }}>
                <span className="tl-head-name">{trackLabel(project, row.track)}</span>
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
          onPointerDown={() => useEditor.setState({ selectedClipId: null })}
        >
          <div className="tl-content" style={{ width: contentWidth }}>
            <div className="tl-ruler" style={{ height: RULER_H }} onPointerDown={onRulerDown}>
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
                  className={`tl-track kind-${row.track.kind}${dropRow === key ? ' drop' : ''}`}
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

interface ClipViewProps {
  project: Project;
  clip: AnyClip;
  zoom: number;
  selected: boolean;
  dim: boolean;
  onDown: (e: React.PointerEvent, clip: AnyClip, mode: 'move' | 'trim-start' | 'trim-end') => void;
}

function ClipView({ project, clip, zoom, selected, dim, onDown }: ClipViewProps) {
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
        style.backgroundSize = `${asset.duration * zoom}px 100%`;
        style.backgroundPosition = `${-clip.in * zoom}px 0`;
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
  return <div className="tl-playhead" style={{ left: playhead * zoom }} />;
}
