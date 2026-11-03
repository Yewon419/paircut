import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { Maximize, Minimize, Pause, Play, ScanLine, SkipBack, SkipForward } from 'lucide-react';
import type { Clip, ClipCrop, Project } from '../../shared/project';
import { assetById, clipEnd, CROP_MAX, isMediaClip, isTextClip, projectDuration, transformAt } from '../../shared/project';
import type { Box } from '../align';
import { clipsAtPoint, layerBox, previewSize, snapLine, snapMove, snapTargets } from '../align';
import { compositor, pause, seek, togglePlay } from '../engine/player';
import { formatTime } from '../format';
import { hasSafeZone, SAFE_ZONE } from '../safeZone';
import { beginGesture, endGesture, findClip, frameSnap, updateGesture, updateMediaClip, updateTextClip, useEditor, withTransformAt } from '../store';

/** How close, in screen pixels, a dragged layer has to come to a line before it sticks. */
const SNAP_PX = 6;
/** A press that moves less than this, in screen pixels, is a tap, not a drag. */
const TAP_PX = 3;

/** Preview zoom choices: 0 fits the frame in the panel, the rest are fractions of the project's pixel size. */
const ZOOMS: { value: number; label: string }[] = [
  { value: 0, label: '맞춤' },
  { value: 0.25, label: '25%' },
  { value: 0.5, label: '50%' },
  { value: 1, label: '100%' },
  { value: 2, label: '200%' },
];

/** Picture scale limits, shared by the wheel and the corner handles. */
const SCALE_MIN = 0.1;
const SCALE_MAX = 8;

/** Corner handles resize the picture; side handles crop that side. */
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const;
type Handle = (typeof HANDLES)[number];

/** How far inside the visible area a cut-off edge is drawn, in screen pixels, so its handles stay whole. */
const VIEW_INSET = 7;

const OPPOSITE: Record<keyof ClipCrop, keyof ClipCrop> = { l: 'r', r: 'l', t: 'b', b: 't' };

/** Where a picture sits in frame pixels before placeVisual's rounding, so a drag can solve for the transform. */
function placedAt(project: Project, clip: Clip, local: number): { cx: number; cy: number; w: number; h: number; scale: number } {
  const a = assetById(project, clip.assetId);
  const tr = transformAt(clip, local);
  const k = Math.max(project.width / a.width, project.height / a.height) * tr.scale;
  return { cx: project.width / 2 + tr.x * project.width, cy: project.height / 2 + tr.y * project.height, w: a.width * k, h: a.height * k, scale: tr.scale };
}

export function Preview({ big, onToggleBig }: { big: boolean; onToggleBig: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const wheelTimer = useRef<number | null>(null);
  const [guides, setGuides] = useState(true);
  const [zoom, setZoom] = useState(0);
  const [view, setView] = useState<Box>({ l: 0, t: 0, r: 1, b: 1 });
  const [snapLines, setSnapLines] = useState<{ x: number | null; y: number | null }>({ x: null, y: null });
  const project = useEditor((s) => s.project);
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const { w: cw, h: ch } = previewSize(project);
  const safeZone = hasSafeZone(project);

  useEffect(() => {
    compositor.attach(canvasRef.current);
    return () => compositor.attach(null);
  }, [cw, ch]);

  // The part of the panel the selection box can be seen in, as fractions of the frame; zoomed, the frame clips it.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const stage = stageRef.current;
    if (!wrap || !stage) return;
    const measure = () => {
      const w = wrap.getBoundingClientRect();
      const s = stage.getBoundingClientRect();
      if (s.width === 0 || s.height === 0) return;
      const left = w.left + wrap.clientLeft + VIEW_INSET;
      const top = w.top + wrap.clientTop + VIEW_INSET;
      const next = {
        l: (left - s.left) / s.width,
        t: (top - s.top) / s.height,
        r: (left + wrap.clientWidth - 2 * VIEW_INSET - s.left) / s.width,
        b: (top + wrap.clientHeight - 2 * VIEW_INSET - s.top) / s.height,
      };
      const v = zoom > 0
        ? { l: Math.max(0, next.l), t: Math.max(0, next.t), r: Math.min(1, next.r), b: Math.min(1, next.b) }
        : next;
      setView((old) => (old.l === v.l && old.t === v.t && old.r === v.r && old.b === v.b ? old : v));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    ro.observe(stage);
    wrap.addEventListener('scroll', measure);
    return () => {
      ro.disconnect();
      wrap.removeEventListener('scroll', measure);
    };
  }, [zoom]);

  const found = selectedClipId ? findClip(project, selectedClipId) : null;
  const live = found && playhead >= found.clip.start && playhead < clipEnd(found.clip) ? found.clip : null;
  const media = live && isMediaClip(live) && found?.track.kind === 'video' ? live : null;
  const text = live && isTextClip(live) ? live : null;
  const shown = media ?? text;
  const box = shown ? layerBox(project, shown, playhead) : null;
  // Drawn inside what can be seen; a side that runs past it shows as a white line on the visible edge.
  const seen = box && { l: Math.max(box.l, view.l), t: Math.max(box.t, view.t), r: Math.min(box.r, view.r), b: Math.min(box.b, view.b) };
  const cut = box && seen ? (['l', 't', 'r', 'b'] as const).filter((k) => seen[k] !== box[k]) : [];

  /** Follows one press as a single undo step; move gets the pointer's shift in stage pixels once it passes TAP_PX. */
  const pointerDrag = (
    e: React.PointerEvent,
    move: (px: number, py: number, ev: PointerEvent, stage: DOMRect) => void,
    done: (moved: boolean) => void,
  ) => {
    if (!stageRef.current) return;
    e.preventDefault();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const stage = stageRef.current.getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moved = false;
    beginGesture();
    const onMove = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < TAP_PX) return;
      moved = true;
      move(ev.clientX - x0, ev.clientY - y0, ev, stage);
    };
    const up = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', up);
      setSnapLines({ x: null, y: null });
      endGesture();
      done(moved);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', up);
  };

  /**
   * Drags the selected layer. With the magnet on, its edges and center stick to the frame, the safe-zone lines and
   * the other layers on screen, and the line it stuck to is drawn.
   */
  const dragWith = (
    e: React.PointerEvent,
    clipId: string,
    apply: (dx: number, dy: number) => (base: Project) => Project | null,
    onTap: () => void,
  ) => {
    const { project: p0, playhead: t0 } = useEditor.getState();
    const start = findClip(p0, clipId);
    const from = start ? layerBox(p0, start.clip, t0) : null;
    const targets = snapTargets(p0, t0, clipId);
    pointerDrag(
      e,
      (px, py, ev, stage) => {
        const dx = px / stage.width;
        const dy = py / stage.height;
        const s = from && useEditor.getState().snap && !ev.altKey
          ? snapMove(from, dx, dy, targets, SNAP_PX / stage.width, SNAP_PX / stage.height)
          : { dx, dy, gx: null, gy: null };
        setSnapLines({ x: s.gx, y: s.gy });
        updateGesture(apply(s.dx, s.dy));
      },
      (moved) => {
        if (!moved) onTap();
      },
    );
  };

  /**
   * A corner resizes the picture at its shape around the opposite corner (Shift: around its center); a side moves
   * that edge of the crop while the picture stays put. The moving edge sticks to the same lines as a drag; Alt frees it.
   */
  const onHandleDown = (e: React.PointerEvent, handle: Handle) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const { project: p0, playhead: t0, selectedClipId: id } = useEditor.getState();
    const clip = id ? findClip(p0, id)?.clip : undefined;
    if (!clip || !isMediaClip(clip)) return;
    const local = t0 - clip.start;
    const g = placedAt(p0, clip, local);
    const W = p0.width;
    const H = p0.height;
    const c = clip.crop;
    const edges: ClipCrop = { l: -0.5 + c.l, r: 0.5 - c.r, t: -0.5 + c.t, b: 0.5 - c.b };
    const targets = snapTargets(p0, t0, clip.id);
    const hx = handle.includes('w') ? 'l' : handle.includes('e') ? 'r' : null;
    const hy = handle.includes('n') ? 't' : handle.includes('s') ? 'b' : null;
    const snapping = (ev: PointerEvent) => useEditor.getState().snap && !ev.altKey;
    if (hx && hy) {
      pointerDrag(
        e,
        (px, py, ev, stage) => {
          const ax = ev.shiftKey ? (edges.l + edges.r) / 2 : edges[OPPOSITE[hx]];
          const ay = ev.shiftKey ? (edges.t + edges.b) / 2 : edges[OPPOSITE[hy]];
          const anchorX = g.cx + ax * g.w;
          const anchorY = g.cy + ay * g.h;
          const vx = (edges[hx] - ax) * g.w;
          const vy = (edges[hy] - ay) * g.h;
          const qx = vx + (px * W) / stage.width;
          const qy = vy + (py * H) / stage.height;
          let ratio = (qx * vx + qy * vy) / (vx * vx + vy * vy);
          let gx: number | null = null;
          let gy: number | null = null;
          if (snapping(ev)) {
            const sx = snapLine((anchorX + vx * ratio) / W, targets.xs, SNAP_PX / stage.width);
            const sy = snapLine((anchorY + vy * ratio) / H, targets.ys, SNAP_PX / stage.height);
            if (sx && (!sy || Math.abs(sx.shift) * stage.width <= Math.abs(sy.shift) * stage.height)) {
              ratio = (sx.line * W - anchorX) / vx;
              gx = sx.line;
            } else if (sy) {
              ratio = (sy.line * H - anchorY) / vy;
              gy = sy.line;
            }
          }
          const scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, g.scale * ratio));
          const r = scale / g.scale;
          if (Math.abs(r - ratio) > 1e-9) {
            gx = null;
            gy = null;
          }
          const x = (anchorX - ax * g.w * r) / W - 0.5;
          const y = (anchorY - ay * g.h * r) / H - 0.5;
          setSnapLines({ x: gx, y: gy });
          updateGesture((base) => updateMediaClip(base, clip.id, (m) => withTransformAt(m, local, { scale, x, y }, base.fps)));
        },
        () => {},
      );
      return;
    }
    const key = hx ?? hy;
    if (!key) return;
    const across = hx !== null;
    const size = across ? g.w : g.h;
    const center = across ? g.cx : g.cy;
    const frame = across ? W : H;
    const from = center + edges[key] * size;
    pointerDrag(
      e,
      (px, py, ev, stage) => {
        const stagePx = across ? stage.width : stage.height;
        let edge = from + ((across ? px : py) * frame) / stagePx;
        let guide: number | null = null;
        const s = snapping(ev) ? snapLine(edge / frame, across ? targets.xs : targets.ys, SNAP_PX / stagePx) : null;
        if (s) {
          edge += s.shift * frame;
          guide = s.line;
        }
        const raw = key === 'l' || key === 't' ? (edge - (center - size / 2)) / size : (center + size / 2 - edge) / size;
        const v = Math.max(0, Math.min(CROP_MAX - c[OPPOSITE[key]], raw));
        if (v !== raw) guide = null;
        setSnapLines(across ? { x: guide, y: null } : { x: null, y: guide });
        updateGesture((base) => updateMediaClip(base, clip.id, (m) => ({ ...m, crop: { ...m.crop, [key]: v } })));
      },
      () => {},
    );
  };

  /** Moves the clip with the pointer; a press that does not move calls onTap instead. */
  const dragClip = (e: React.PointerEvent, id: string, onTap: () => void) => {
    const { project: p, playhead: t } = useEditor.getState();
    const f = findClip(p, id);
    if (!f) return;
    const c = f.clip;
    if (isMediaClip(c)) {
      const local = t - c.start;
      const origin = transformAt(c, local);
      dragWith(e, id, (dx, dy) => {
        const x = origin.x + dx;
        const y = origin.y + dy;
        return (base) => updateMediaClip(base, id, (m) => withTransformAt(m, local, { x, y }, base.fps));
      }, onTap);
    } else if (isTextClip(c)) {
      const ox = c.x;
      const oy = c.y;
      dragWith(e, id, (dx, dy) => {
        const x = ox + dx;
        const y = oy + dy;
        return (base) => updateTextClip(base, id, (m) => ({ ...m, x, y }));
      }, onTap);
    }
  };

  /**
   * Pressing the picture picks the top layer under the pointer and drags it in the same press. Pressing the selected
   * layer drags it; tapping it without moving picks the next layer down under the same point, wrapping to the top.
   * An empty spot drops the selection.
   */
  const onStageDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !stageRef.current) return;
    const r = stageRef.current.getBoundingClientRect();
    const { project: p, playhead: t, selectedClipId: sel } = useEditor.getState();
    const hits = clipsAtPoint(p, t, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
    const pick = (id: string) => useEditor.setState({ selectedClipId: id, selectedIds: [id] });
    const i = sel ? hits.indexOf(sel) : -1;
    if (sel && i !== -1) {
      dragClip(e, sel, () => {
        if (hits.length > 1) pick(hits[(i + 1) % hits.length]);
      });
    } else if (hits.length > 0) {
      pick(hits[0]);
      dragClip(e, hits[0], () => {});
    } else {
      useEditor.setState({ selectedClipId: null });
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
      // The point under the pointer stays put, so the picture grows toward where you look.
      const local = useEditor.getState().playhead - current.start;
      const tr = transformAt(current, local);
      const scale = Math.max(SCALE_MIN, Math.min(SCALE_MAX, tr.scale * factor));
      const r = scale / tr.scale;
      const st = e.currentTarget.getBoundingClientRect();
      const fx = (e.clientX - st.left) / st.width;
      const fy = (e.clientY - st.top) / st.height;
      const x = fx + (0.5 + tr.x - fx) * r - 0.5;
      const y = fy + (0.5 + tr.y - fy) * r - 0.5;
      updateGesture((base) => updateMediaClip(base, id, (c) => withTransformAt(c, local, { scale, x, y }, base.fps)));
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
      <div className={zoom > 0 ? 'stage-wrap zoomed' : 'stage-wrap'} ref={wrapRef}>
        <div className="stage" ref={stageRef} style={stageStyle} onWheel={onWheel} onPointerDown={onStageDown}>
          <canvas ref={canvasRef} width={cw} height={ch} data-testid="preview-canvas" />
          {guides && safeZone && (
            <div className="safe-zone" data-testid="safe-zone">
              <div className="band" style={{ left: 0, right: 0, top: 0, height: `${SAFE_ZONE.top * 100}%` }} />
              <div className="band" style={{ left: 0, right: 0, bottom: 0, height: `${SAFE_ZONE.bottom * 100}%` }} />
              <div
                className="band"
                style={{ left: 0, top: `${SAFE_ZONE.top * 100}%`, bottom: `${SAFE_ZONE.bottom * 100}%`, width: `${SAFE_ZONE.side * 100}%` }}
              />
              <div
                className="band"
                style={{ right: 0, top: `${SAFE_ZONE.top * 100}%`, bottom: `${SAFE_ZONE.bottom * 100}%`, width: `${SAFE_ZONE.side * 100}%` }}
              />
            </div>
          )}
          {seen && seen.r > seen.l && seen.b > seen.t && (
            <div
              className={text ? 'transform-box text' : 'transform-box'}
              style={{
                left: `${seen.l * 100}%`,
                top: `${seen.t * 100}%`,
                width: `${(seen.r - seen.l) * 100}%`,
                height: `${(seen.b - seen.t) * 100}%`,
              }}
            >
              {cut.map((k) => (
                <div key={k} className={`cut-edge ${k}`} data-cut={k} />
              ))}
              {media &&
                HANDLES.map((h) => (
                  <div key={h} className={`handle ${h}`} data-handle={h} onPointerDown={(e) => onHandleDown(e, h)} />
                ))}
            </div>
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
            className={guides && safeZone ? 'icon on' : 'icon'}
            onClick={() => setGuides(!guides)}
            disabled={!safeZone}
            title={safeZone ? '안전 영역: 위 14%, 아래 35%, 좌우 6%' : '안전 영역은 9:16에서만 써요'}
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
