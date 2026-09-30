export type MediaKind = 'video' | 'audio' | 'image';

export interface MediaAsset {
  id: string;
  path: string;
  name: string;
  kind: MediaKind;
  duration: number;
  width: number;
  height: number;
  hasAudio: boolean;
  thumbPath: string | null;
  wavePath: string | null;
}

export interface ClipTransform {
  scale: number;
  x: number;
  y: number;
}

export interface Clip {
  id: string;
  assetId: string;
  start: number;
  in: number;
  out: number;
  transform: ClipTransform;
}

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: string;
  kind: TrackKind;
  muted: boolean;
  hidden: boolean;
  clips: Clip[];
}

export interface Project {
  version: 1;
  width: number;
  height: number;
  fps: number;
  assets: MediaAsset[];
  tracks: Track[];
}

export const IMAGE_DEFAULT_DURATION = 3;

export const IDENTITY_TRANSFORM: ClipTransform = { scale: 1, x: 0, y: 0 };

export function emptyProject(): Project {
  return {
    version: 1,
    width: 1080,
    height: 1920,
    fps: 30,
    assets: [],
    tracks: [
      { id: 'v-main', kind: 'video', muted: false, hidden: false, clips: [] },
      { id: 'a-1', kind: 'audio', muted: false, hidden: false, clips: [] },
    ],
  };
}

export function clipDuration(clip: Clip): number {
  return clip.out - clip.in;
}

export function clipEnd(clip: Clip): number {
  return clip.start + clipDuration(clip);
}

export function projectDuration(project: Project): number {
  let end = 0;
  for (const track of project.tracks) {
    for (const clip of track.clips) end = Math.max(end, clipEnd(clip));
  }
  return end;
}

export function assetById(project: Project, id: string): MediaAsset {
  const asset = project.assets.find((a) => a.id === id);
  if (!asset) throw new Error(`asset not found: ${id}`);
  return asset;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Cover-fit (no letterbox) then apply the clip transform. Offsets are fractions of the frame.
 * Preview and export both use this so they place pixels identically.
 */
export function placeVisual(
  srcW: number,
  srcH: number,
  frameW: number,
  frameH: number,
  t: ClipTransform,
): Rect {
  const cover = Math.max(frameW / srcW, frameH / srcH) * t.scale;
  const w = Math.max(2, Math.round((srcW * cover) / 2) * 2);
  const h = Math.max(2, Math.round((srcH * cover) / 2) * 2);
  const x = Math.round((frameW - w) / 2 + t.x * frameW);
  const y = Math.round((frameH - h) / 2 + t.y * frameH);
  return { x, y, w, h };
}
