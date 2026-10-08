import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Maximize, Minimize, Pause, Play, ScanLine, SkipBack, SkipForward } from 'lucide-react';
import type { Project } from '../../shared/project';
import { assetById, clipEnd, isMediaClip, isTextClip, placeVisual, projectDuration, transformAt } from '../../shared/project';
import { layerBox, previewSize, snapMove, snapTargets } from '../align';
import { compositor, pause, seek, togglePlay } from '../engine/player';
import { formatTime } from '../format';
import { RULES } from '../rules';
import { beginGesture, endGesture, findClip, frameSnap, updateGesture, updateMediaClip, updateTextClip, useEditor, withTransformAt } from '../store';

/** How close, in screen pixels, a dragged layer has to come to a line before it sticks. */
const SNAP_PX = 6;

/** Preview zoom choices: 0 fits the frame in the panel, the rest are fractions of the project's pixel size. */
const ZOOMS: { value: number; label: string }[] = [
  { value: 0, label: '맞춤' },
  { value: 0.25, label: '25%' },
  { value: 0.5, label: '50%' },
  { value: 1, label: '100%' },
  { value: 2, label: '200%' },
];

export function Preview({ big, onToggleBig }: { big: boolean; onToggleBig: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const wheelTimer = useRef<number | null>(null);
  const [guides, setGuides] = useState(true);
  const [zoom, setZoom] = useState(0);
  const [snapLines, setSnapLines] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const { w: cw, h: ch } = previewSize(project);

  useEffect(() => {
    compositor.attach(canvasRef.current);
    return () => compositor.attach(null);
  }, [cw, ch]);

  const found = selectedClipId ? findClip(project, selectedClipId) : null;
  const live = found && playhead >= found.clip.start && playhead < clipEnd(found.clip) ? found.clip : null;
  const media = live && isMediaClip(live) && found?.track.kind === 'video' ? live : null;
  const text = live && isTextClip(live) ? live : null;
  const asset = media ? assetById(project, media.assetId) : null;
  const rect = media && asset
    ? placeVisual(asset.width, asset.height, cw, ch, transformAt(media, playhead - media.start))
    : text
      ? compositor.textRect(project, text)
      : null;

  /**
   * Drags the selected layer. With the magnet on, its edges and center stick to the frame, the safe-zone lines and
   * the other layers on screen, and the line it stuck to is drawn.
   */
  const dragWith = (e: React.PointerEvent, clipId: string, apply: (dx: number, dy: number) => (base: Project) => Project | null) => {
    if (!stageRef.current) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const stage = stageRef.current.getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const { project: p0, playhead: t0 } = useEditor.getState();
    const start = findClip(p0, clipId);
    const box = start ? layerBox(p0, start.clip, t0) : null;
    const targets = snapTargets(p0, t0, clipId);
    beginGesture();
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / stage.width;
      const dy = (ev.clientY - y0) / stage.height;
      const s = box && useEditor.getState().snap && !ev.altKey
        ? snapMove(box, dx, dy, targets, SNAP_PX / stage.width, SNAP_PX / stage.height)
        : { dx, dy, gx: null, gy: null };
      setSnapLines({ x: s.gx, y: s.gy });
      updateGesture(apply(s.dx, s.dy));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      setSnapLines({ x: null, y: null });
      endGesture();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (media) {
      const local = playhead - media.start;
      const origin = transformAt(media, local);
      const id = media.id;
      dragWith(e, id, (dx, dy) => {
        const x = origin.x + dx;
        const y = origin.y + dy;
        return (base) => updateMediaClip(base, id, (c) => withTransformAt(c, local, { x, y }, base.fps));
      });
    } else if (text) {
      const ox = text.x;
      const oy = text.y;
      const id = text.id;
      dragWith(e, id, (dx, dy) => {
        const x = ox + dx;
        const y = oy + dy;
        return (base) => updateTextClip(base, id, (c) => ({ ...c, x, y }));
      });
    }
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!media && !text) return;
    const id = (media ?? text)?.id ?? '';
    if (wheelTimer.current === null) beginGesture();
    else window.clearTimeout(wheelTimer.current);
    const factor = Math.pow(1.0015, -e.deltaY);
    const current = findClip(useEditor.getState().project, id)?.clip;
    if (current && isMediaClip(current)) {
      const local = useEditor.getState().playhead - current.start;
      const scale = Math.max(0.1, Math.min(8, transformAt(current, local).scale * factor));
      updateGesture((base) => updateMediaClip(base, id, (c) => withTransformAt(c, local, { scale }, base.fps)));
    } else if (current && isTextClip(current)) {
      const size = Math.max(12, Math.min(300, Math.round(current.style.size * factor)));
      updateGesture((base) => updateTextClip(base, id, (c) => ({ ...c, style: { ...c.style, size } })));
    }
    wheelTimer.current = window.setTimeout(() => {
      wheelTimer.current = null;
      endGesture();
    }, 300);
  };

  const jump = (t: number) => {
    pause();
    seek(t);
  };

  /** The bar under the picture: press or drag anywhere on it to move the playhead, like a video player. */
  const onSeekDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = e.currentTarget as HTMLElement;
    const total = projectDuration(useEditor.getState().project);
    const timeAt = (clientX: number) => {
      const box = el.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
      return frameSnap(frac * total, useEditor.getState().project.fps);
    };
    el.setPointerCapture(e.pointerId);
    seek(timeAt(e.clientX));
    const move = (ev: PointerEvent) => seek(timeAt(ev.clientX));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const total = projectDuration(project);
  const seekPct = total > 0 ? Math.min(100, (playhead / total) * 100) : 0;

  const stageStyle: CSSProperties =
    zoom > 0
      ? { aspectRatio: `${project.width} / ${project.height}`, height: `${project.height * zoom}px` }
      : { aspectRatio: `${project.width} / ${project.height}` };

  return (
    <section className="panel preview">
      <div className={zoom > 0 ? 'stage-wrap zoomed' : 'stage-wrap'}>
        <div className="stage" ref={stageRef} style={stageStyle} onWheel={onWheel}>
          <canvas ref={canvasRef} width={cw} height={ch} data-testid="preview-canvas" />
          {guides && (
            <div className="safe-zone" data-testid="safe-zone">
              <div className="band" style={{ left: 0, right: 0, top: 0, height: `${RULES.safeTop * 100}%` }} />
              <div className="band" style={{ left: 0, right: 0, bottom: 0, height: `${RULES.safeBottom * 100}%` }} />
              <div
                className="band"
                style={{ left: 0, top: `${RULES.safeTop * 100}%`, bottom: `${RULES.safeBottom * 100}%`, width: `${RULES.safeSide * 100}%` }}
              />
              <div
                className="band"
                style={{ right: 0, top: `${RULES.safeTop * 100}%`, bottom: `${RULES.safeBottom * 100}%`, width: `${RULES.safeSide * 100}%` }}
              />
            </div>
          )}
          {rect && (
            <div
              className={text ? 'transform-box text' : 'transform-box'}
              style={{
                left: `${(rect.x / cw) * 100}%`,
                top: `${(rect.y / ch) * 100}%`,
                width: `${(rect.w / cw) * 100}%`,
                height: `${(rect.h / ch) * 100}%`,
              }}
              onPointerDown={onPointerDown}
            />
          )}
          {snapLines.x !== null && <div className="snap-line v" style={{ left: `${snapLines.x * 100}%` }} data-testid="snap-x" />}
          {snapLines.y !== null && <div className="snap-line h" style={{ top: `${snapLines.y * 100}%` }} data-testid="snap-y" />}
        </div>
      </div>
      <div className="seekbar" data-testid="seekbar" title="누르거나 끌어서 시간 이동" onPointerDown={onSeekDown}>
        <div className="seekbar-fill" style={{ width: `${seekPct}%` }} />
        <div className="seekbar-knob" style={{ left: `${seekPct}%` }} />
      </div>
      <div className="transport">
        <div className="transport-left">
          <span className="timecode">
            {formatTime(playhead, project.fps)} <span className="dim">/ {formatTime(projectDuration(project), project.fps)}</span>
          </span>
        </div>
        <div className="transport-center">
          <button className="icon" onClick={() => jump(0)} title="처음으로 (Home)" aria-label="처음으로">
            <SkipBack />
          </button>
          <button className="icon play" onClick={togglePlay} title="재생/정지 (Space)" aria-label={playing ? '정지' : '재생'}>
            {playing ? <Pause /> : <Play />}
          </button>
          <button className="icon" onClick={() => jump(Number.POSITIVE_INFINITY)} title="끝으로 (End)" aria-label="끝으로">
            <SkipForward />
          </button>
        </div>
        <div className="transport-right">
          <select value={zoom} onChange={(e) => setZoom(Number(e.target.value))} title="미리보기 배율" data-testid="preview-zoom">
            {ZOOMS.map((z) => (
              <option key={z.value} value={z.value}>
                {z.label}
              </option>
            ))}
          </select>
          <span className="sep" />
          <button
            className={guides ? 'icon on' : 'icon'}
            onClick={() => setGuides(!guides)}
            title="안전 영역: 위 14%, 아래 35%, 좌우 6%"
            aria-label="안전 영역"
          >
            <ScanLine />
          </button>
          <button
            className={big ? 'icon on' : 'icon'}
            onClick={onToggleBig}
            title={big ? '원래대로 (Esc)' : '크게 보기: 타임라인과 양옆 패널을 숨김 (Esc로 복귀)'}
            aria-label="크게 보기"
            data-testid="preview-big"
          >
            {big ? <Minimize /> : <Maximize />}
          </button>
        </div>
      </div>
    </section>
  );
}
