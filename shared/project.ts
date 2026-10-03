import type { ClipColor } from './color';
import { NEUTRAL_COLOR } from './color';

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
  /** Linear gain, 1 = unchanged. */
  volume: number;
  /** Audio fade lengths in timeline seconds. */
  fadeIn: number;
  fadeOut: number;
  /** Playback rate; the clip lasts (out - in) / speed on the timeline. */
  speed: number;
  color: ClipColor;
  /** Cross dissolve from the clip just before this one on the same track, in seconds, centered on the cut. 0 = hard cut. */
  dissolve: number;
}

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;
export const VOLUME_MAX = 2;
export const DISSOLVE_MAX = 2;

export const MEDIA_CLIP_DEFAULTS = { volume: 1, fadeIn: 0, fadeOut: 0, speed: 1, color: NEUTRAL_COLOR, dissolve: 0 };

export type FontId = 'black' | 'bold' | 'semibold' | 'medium' | 'serif';
export type TextAlign = 'center' | 'left';
export type TextAnim = 'none' | 'fade' | 'pop' | 'rise';

export interface TextStyle {
  font: FontId;
  size: number;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  background: string | null;
  align: TextAlign;
  highlight: string;
  highlightColor: string;
  highlightDigits: boolean;
  /** Extra space between letters in em, e.g. -0.04 */
  tracking: number;
  /** 0..1 opacity of a soft shadow in strokeColor; 0 = none */
  shadow: number;
}

export const TEXT_STYLE_DEFAULTS = { tracking: 0, shadow: 0 };

/** On-screen text. `in` is always 0 so the generic timeline math (clipEnd, trim) applies unchanged. */
export interface TextClip {
  id: string;
  start: number;
  in: number;
  out: number;
  text: string;
  preset: string;
  style: TextStyle;
  x: number;
  y: number;
  anim: TextAnim;
}

export type AnyClip = Clip | TextClip;

export type TrackKind = 'video' | 'audio' | 'text';

export interface Track {
  id: string;
  kind: TrackKind;
  muted: boolean;
  hidden: boolean;
  clips: AnyClip[];
}

export interface ProjectVars {
  uploadDate: string;
  ddayTarget: string;
  salary: number;
  goal: number;
}

export interface Marker {
  t: number;
  label: string;
}

export interface Project {
  version: 1;
  width: number;
  height: number;
  fps: number;
  assets: MediaAsset[];
  tracks: Track[];
  vars: ProjectVars;
  markers: Marker[];
}

export function isTextClip(clip: AnyClip): clip is TextClip {
  return 'text' in clip;
}

export function isMediaClip(clip: AnyClip): clip is Clip {
  return 'assetId' in clip;
}

export function mediaClips(track: Track): Clip[] {
  return track.clips.filter(isMediaClip);
}

export function textClips(track: Track): TextClip[] {
  return track.clips.filter(isTextClip);
}

/** Text animation timing, shared by the preview rasterizer and the ffmpeg graph. */
export const ANIM_IN = 0.25;
export const ANIM_OUT = 0.15;
export const POP_FROM = 0.85;
export const RISE_PX = 40;

export const DEFAULT_VARS: ProjectVars = {
  uploadDate: '',
  ddayTarget: '2027-09-01',
  salary: 0,
  goal: 2236300,
};

export function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Days from the upload date to the target date (2026-10-03 -> 2027-09-01 is 333). */
export function ddayOf(vars: ProjectVars): number {
  const from = Date.parse(`${vars.uploadDate || todayIso()}T00:00:00Z`);
  const to = Date.parse(`${vars.ddayTarget}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return 0;
  return Math.round((to - from) / 86400000);
}

export function formatWon(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Replaces {D}, {월급}, {목표} tokens so hook, voice line and badge always show the same numbers. */
export function resolveTokens(text: string, vars: ProjectVars): string {
  return text
    .replaceAll('{D}', String(ddayOf(vars)))
    .replaceAll('{월급}', formatWon(vars.salary))
    .replaceAll('{목표}', formatWon(vars.goal));
}

/** Fills fields added after the first project format so older files still open. */
export function normalizeProject(p: Project): Project {
  return {
    ...p,
    vars: { ...DEFAULT_VARS, ...(p.vars ?? {}) },
    markers: p.markers ?? [],
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) =>
        isMediaClip(c) ? { ...MEDIA_CLIP_DEFAULTS, ...c } : { ...c, style: { ...TEXT_STYLE_DEFAULTS, ...c.style } },
      ),
    })),
  };
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
      { id: 't-1', kind: 'text', muted: false, hidden: false, clips: [] },
      { id: 'v-main', kind: 'video', muted: false, hidden: false, clips: [] },
      { id: 'a-1', kind: 'audio', muted: false, hidden: false, clips: [] },
    ],
    vars: { ...DEFAULT_VARS, uploadDate: todayIso() },
    markers: [],
  };
}

export function clipDuration(clip: AnyClip): number {
  return isMediaClip(clip) ? (clip.out - clip.in) / clip.speed : clip.out - clip.in;
}

/** Position in the source file shown at timeline time t. */
export function sourceTime(clip: Clip, t: number): number {
  return clip.in + (t - clip.start) * clip.speed;
}

/** Clip gain at timeline time t: volume times linear fade ramps, the same curve as ffmpeg afade. */
export function audioGain(clip: Clip, t: number): number {
  const local = t - clip.start;
  const rest = clipDuration(clip) - local;
  const up = clip.fadeIn > 0 ? Math.min(1, Math.max(0, local / clip.fadeIn)) : 1;
  const down = clip.fadeOut > 0 ? Math.min(1, Math.max(0, rest / clip.fadeOut)) : 1;
  return clip.volume * up * down;
}

export function clipEnd(clip: AnyClip): number {
  return clip.start + clipDuration(clip);
}

const CUT_EPS = 1e-6;

/**
 * Dissolve length actually used: only on video tracks, only when the previous clip ends exactly where
 * this one starts, and never longer than either clip.
 */
export function effectiveDissolve(track: Track, clip: Clip): number {
  if (clip.dissolve <= 0 || track.kind !== 'video') return 0;
  const prev = track.clips.find((c) => c !== clip && isMediaClip(c) && Math.abs(clipEnd(c) - clip.start) < CUT_EPS);
  if (!prev) return 0;
  return Math.min(clip.dissolve, clipDuration(prev), clipDuration(clip));
}

/** When a media clip is on screen: its own range widened by half of each dissolve on its cuts. */
export interface VisualSpan {
  from: number;
  to: number;
  /** Length of the incoming dissolve that starts at `from`; 0 = appears at full opacity. */
  fadeIn: number;
}

export function visualSpan(track: Track, clip: Clip): VisualSpan {
  const fadeIn = effectiveDissolve(track, clip);
  const next = track.clips.find((c) => c !== clip && isMediaClip(c) && Math.abs(c.start - clipEnd(clip)) < CUT_EPS);
  const out = next && isMediaClip(next) ? effectiveDissolve(track, next) : 0;
  return { from: clip.start - fadeIn / 2, to: clipEnd(clip) + out / 2, fadeIn };
}

/** Opacity at t: ramps linearly from 0 to 1 across the incoming dissolve, the same ramp as ffmpeg fade. */
export function visualAlpha(span: VisualSpan, t: number): number {
  return span.fadeIn > 0 ? Math.min(1, Math.max(0, (t - span.from) / span.fadeIn)) : 1;
}

/** Source position for a frame at t; past either end of the file it holds the first or last frame. */
export function frameTime(clip: Clip, sourceDuration: number, t: number): number {
  return Math.min(sourceDuration, Math.max(0, sourceTime(clip, t)));
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
