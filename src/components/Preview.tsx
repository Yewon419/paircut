import { useEffect, useRef } from 'react';
import type { Project } from '../../shared/project';
import { assetById, clipEnd, isMediaClip, isTextClip, placeVisual, projectDuration } from '../../shared/project';
import { compositor, togglePlay } from '../engine/player';
import { formatTime } from '../format';
import { beginGesture, endGesture, findClip, updateGesture, updateMediaClip, updateTextClip, useEditor } from '../store';

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
  const live = found && playhead >= found.clip.start && playhead < clipEnd(found.clip) ? found.clip : null;
  const media = live && isMediaClip(live) && found?.track.kind === 'video' ? live : null;
  const text = live && isTextClip(live) ? live : null;
  const asset = media ? assetById(project, media.assetId) : null;
  const rect = media && asset
    ? placeVisual(asset.width, asset.height, cw, ch, media.transform)
    : text
      ? compositor.textRect(project, text)
      : null;

  const dragWith = (e: React.PointerEvent, apply: (dx: number, dy: number, snap: boolean) => (base: Project) => Project | null) => {
    if (!stageRef.current) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const box = stageRef.current.getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    beginGesture();
    const move = (ev: PointerEvent) => {
      updateGesture(apply((ev.clientX - x0) / box.width, (ev.clientY - y0) / box.height, useEditor.getState().snap));
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      endGesture();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (media) {
      const origin = media.transform;
      const id = media.id;
      dragWith(e, (dx, dy, snap) => {
        let x = origin.x + dx;
        let y = origin.y + dy;
        if (snap && Math.abs(x) < CENTER_SNAP) x = 0;
        if (snap && Math.abs(y) < CENTER_SNAP) y = 0;
        return (base) => updateMediaClip(base, id, (c) => ({ ...c, transform: { ...c.transform, x, y } }));
      });
    } else if (text) {
      const ox = text.x;
      const oy = text.y;
      const id = text.id;
      const centered = text.style.align === 'center';
      dragWith(e, (dx, dy, snap) => {
        let x = ox + dx;
        const y = oy + dy;
        if (snap && centered && Math.abs(x - 0.5) < CENTER_SNAP) x = 0.5;
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
      const scale = Math.max(0.1, Math.min(8, current.transform.scale * factor));
      updateGesture((base) => updateMediaClip(base, id, (c) => ({ ...c, transform: { ...c.transform, scale } })));
    } else if (current && isTextClip(current)) {
      const size = Math.max(12, Math.min(300, Math.round(current.style.size * factor)));
      updateGesture((base) => updateTextClip(base, id, (c) => ({ ...c, style: { ...c.style, size } })));
    }
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
