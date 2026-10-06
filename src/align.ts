import type { AnyClip, Project, Rect } from '../shared/project';
import { assetById, clipEnd, cropBox, isMediaClip, isTextClip, placeVisual, transformAt } from '../shared/project';
import { compositor } from './engine/player';
import { RULES } from './rules';

export const PREVIEW_SCALE = 0.5;

/** A layer's visible box as fractions of the frame: left, top, right, bottom. */
export interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** Lines a dragged box can stick to, as fractions of the frame width (xs) and height (ys). */
export interface SnapTargets {
  xs: number[];
  ys: number[];
}

/** A snapped move, with the line it stuck to on each axis (null where it moved freely). */
export interface Snapped {
  dx: number;
  dy: number;
  gx: number | null;
  gy: number | null;
}

export type AlignTo = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

export function previewSize(project: Project): { w: number; h: number } {
  return { w: Math.round(project.width * PREVIEW_SCALE), h: Math.round(project.height * PREVIEW_SCALE) };
}

function toBox(r: Rect, w: number, h: number): Box {
  return { l: r.x / w, t: r.y / h, r: (r.x + r.w) / w, b: (r.y + r.h) / h };
}

/**
 * What the layer shows on screen: a picture after its crop, or the drawn text block. Null for sound.
 * Pictures are measured at the export size, so an edge put on the frame edge leaves no rounding gap there.
 */
export function layerBox(project: Project, clip: AnyClip, t: number): Box | null {
  if (isTextClip(clip)) {
    const { w, h } = previewSize(project);
    const r = compositor.textRect(project, clip);
    return r ? toBox(r, w, h) : null;
  }
  if (!isMediaClip(clip)) return null;
  const asset = assetById(project, clip.assetId);
  if (asset.kind === 'audio') return null;
  const w = project.width;
  const h = project.height;
  const placed = placeVisual(asset.width, asset.height, w, h, transformAt(clip, t - clip.start));
  const kept = cropBox(placed, clip.crop);
  return toBox({ x: placed.x + kept.x, y: placed.y + kept.y, w: kept.w, h: kept.h }, w, h);
}

/** The frame's edges and center, the safe-zone lines, and the edges and centers of the other layers on screen at t. */
export function snapTargets(project: Project, t: number, movingClipId: string): SnapTargets {
  const xs = [0, 0.5, 1, RULES.safeSide, 1 - RULES.safeSide];
  const ys = [0, 0.5, 1, RULES.safeTop, 1 - RULES.safeBottom];
  for (const track of project.tracks) {
    if (track.kind === 'audio' || track.hidden) continue;
    for (const clip of track.clips) {
      if (clip.id === movingClipId || t < clip.start || t >= clipEnd(clip)) continue;
      const box = layerBox(project, clip, t);
      if (!box) continue;
      xs.push(box.l, (box.l + box.r) / 2, box.r);
      ys.push(box.t, (box.t + box.b) / 2, box.b);
    }
  }
  return { xs, ys };
}

function nearest(lo: number, hi: number, lines: number[], tol: number): { shift: number; line: number } | null {
  let best: { shift: number; line: number } | null = null;
  for (const edge of [lo, (lo + hi) / 2, hi]) {
    for (const line of lines) {
      const shift = line - edge;
      if (Math.abs(shift) <= tol && (best === null || Math.abs(shift) < Math.abs(best.shift))) best = { shift, line };
    }
  }
  return best;
}

/** Moves the box by (dx, dy), then nudges each axis onto the closest line within tol if one of its edges or its center is that close. */
export function snapMove(box: Box, dx: number, dy: number, targets: SnapTargets, tolX: number, tolY: number): Snapped {
  const x = nearest(box.l + dx, box.r + dx, targets.xs, tolX);
  const y = nearest(box.t + dy, box.b + dy, targets.ys, tolY);
  return { dx: dx + (x?.shift ?? 0), dy: dy + (y?.shift ?? 0), gx: x?.line ?? null, gy: y?.line ?? null };
}

/** The move that puts the box against a frame edge or on a frame center line. */
export function alignShift(box: Box, to: AlignTo): { dx: number; dy: number } {
  switch (to) {
    case 'left':
      return { dx: -box.l, dy: 0 };
    case 'hcenter':
      return { dx: 0.5 - (box.l + box.r) / 2, dy: 0 };
    case 'right':
      return { dx: 1 - box.r, dy: 0 };
    case 'top':
      return { dx: 0, dy: -box.t };
    case 'vcenter':
      return { dx: 0, dy: 0.5 - (box.t + box.b) / 2 };
    case 'bottom':
      return { dx: 0, dy: 1 - box.b };
  }
}
