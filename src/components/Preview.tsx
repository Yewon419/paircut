import { useEffect, useRef } from 'react';
import { assetById, clipEnd, placeVisual, projectDuration } from '../../shared/project';
import { compositor, togglePlay } from '../engine/player';
import { formatTime } from '../format';
import { beginGesture, endGesture, findClip, updateClip, updateGesture, useEditor } from '../store';

const PREVIEW_SCALE = 0.5;
const CENTER_SNAP = 0.012;

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const wheelTimer = useRef<number | null>(null);
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const cw = Math.round(project.width * PREVIEW_SCALE);
  const ch = Math.round(project.height * PREVIEW_SCALE);

  useEffect(() => {
    compositor.attach(canvasRef.current);
    return () => compositor.attach(null);
  }, [cw, ch]);

  const found = selectedClipId ? findClip(project, selectedClipId) : null;
  const selected =
    found &&
    found.track.kind === 'video' &&
    playhead >= found.clip.start &&
    playhead < clipEnd(found.clip)
      ? found.clip
      : null;
  const asset = selected ? assetById(project, selected.assetId) : null;
  const rect = selected && asset ? placeVisual(asset.width, asset.height, cw, ch, selected.transform) : null;

  const onPointerDown = (e: React.PointerEvent) => {
    if (!selected || !stageRef.current) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const box = stageRef.current.getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const origin = selected.transform;
    const id = selected.id;
    beginGesture();
    const move = (ev: PointerEvent) => {
      const snap = useEditor.getState().snap;
      let x = origin.x + (ev.clientX - x0) / box.width;
      let y = origin.y + (ev.clientY - y0) / box.height;
      if (snap && Math.abs(x) < CENTER_SNAP) x = 0;
      if (snap && Math.abs(y) < CENTER_SNAP) y = 0;
      updateGesture((base) => updateClip(base, id, (c) => ({ ...c, transform: { ...c.transform, x, y } })));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      endGesture();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!selected) return;
    const id = selected.id;
    if (wheelTimer.current === null) beginGesture();
    else window.clearTimeout(wheelTimer.current);
    const factor = Math.pow(1.0015, -e.deltaY);
    const current = findClip(useEditor.getState().project, id)?.clip.transform.scale ?? 1;
    const scale = Math.max(0.1, Math.min(8, current * factor));
    updateGesture((base) => updateClip(base, id, (c) => ({ ...c, transform: { ...c.transform, scale } })));
    wheelTimer.current = window.setTimeout(() => {
      wheelTimer.current = null;
      endGesture();
    }, 300);
  };

  return (
    <section className="panel preview">
      <div className="stage-wrap">
        <div className="stage" ref={stageRef} style={{ aspectRatio: `${project.width} / ${project.height}` }} onWheel={onWheel}>
          <canvas ref={canvasRef} width={cw} height={ch} data-testid="preview-canvas" />
          {rect && (
            <div
              className="transform-box"
              style={{
                left: `${(rect.x / cw) * 100}%`,
                top: `${(rect.y / ch) * 100}%`,
                width: `${(rect.w / cw) * 100}%`,
                height: `${(rect.h / ch) * 100}%`,
              }}
              onPointerDown={onPointerDown}
            />
          )}
        </div>
      </div>
      <div className="transport">
        <button className="play" onClick={togglePlay} title="재생/정지 (Space)">
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="timecode">
          {formatTime(playhead, project.fps)} <span className="dim">/ {formatTime(projectDuration(project), project.fps)}</span>
        </span>
      </div>
    </section>
  );
}
