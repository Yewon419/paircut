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
  /** '#RRGGBB' when the asset is a generated one-color image. */
  solid?: string;
  /** Webm codec when the video carries transparency (motion graphics); export must decode it with libvpx. */
  alpha?: 'vp8' | 'vp9';
}

/**
 * Per-frame subject masks cut by rembg for a subject layer: RGBA PNGs `m00000.png`.. in `dir`, white with
 * alpha = subject. Frame n is the source picture at from + n / fps (stills have one frame).
 */
export interface Matte {
  dir: string;
  from: number;
  to: number;
  fps: number;
  count: number;
}

export interface ClipTransform {
  scale: number;
  x: number;
  y: number;
}

/** Fractions of the clip picture cut away from each edge; the rest stays where the transform put it. */
export interface ClipCrop {
  l: number;
  t: number;
  r: number;
  b: number;
}

export interface Clip {
  id: string;
  assetId: string;
  start: number;
  in: number;
  out: number;
  transform: ClipTransform;
  crop: ClipCrop;
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
  /** Position and size keyframes, sorted by time; when present they replace `transform`. */
  keys?: TransformKey[];
}

/** How a keyframe moves on to the next one. */
export type KeyEase = 'linear' | 'smooth';

/** Transform at `t` timeline seconds after the clip start. */
export interface TransformKey extends ClipTransform {
  t: number;
  ease: KeyEase;
}

export function hasKeys(clip: Clip): boolean {
  return (clip.keys?.length ?? 0) > 0;
}

/** Eased progress between two keyframes, the same curve the export expression uses. */
export function easeKey(ease: KeyEase, p: number): number {
  return ease === 'smooth' ? p * p * (3 - 2 * p) : p;
}

/** Transform `local` timeline seconds after the clip start: held before the first key and after the last. */
export function transformAt(clip: Clip, local: number): ClipTransform {
  const keys = clip.keys;
  if (!keys || keys.length === 0) return clip.transform;
  const pick = (k: TransformKey): ClipTransform => ({ scale: k.scale, x: k.x, y: k.y });
  if (local <= keys[0].t) return pick(keys[0]);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (local >= b.t) continue;
    const e = easeKey(a.ease, (local - a.t) / (b.t - a.t));
    return { scale: a.scale + (b.scale - a.scale) * e, x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
  }
  return pick(keys[keys.length - 1]);
}

/** Keyframes moved by `dt` seconds within the clip (a trimmed or split start), so they stay on the same picture. */
export function shiftKeys(clip: Clip, dt: number): Clip {
  if (!clip.keys) return clip;
  return { ...clip, keys: clip.keys.map((k) => ({ ...k, t: k.t + dt })) };
}

export const SPEED_MIN = 0.5;
export const SPEED_MAX = 2;
export const VOLUME_MAX = 2;
export const DISSOLVE_MAX = 2;

export const NO_CROP: ClipCrop = { l: 0, t: 0, r: 0, b: 0 };
/** Opposite edges together may cut at most this much, so something is always left. */
export const CROP_MAX = 0.95;

export const MEDIA_CLIP_DEFAULTS = { volume: 1, fadeIn: 0, fadeOut: 0, speed: 1, color: NEUTRAL_COLOR, dissolve: 0, crop: NO_CROP };

export type FontId =
  | 'black'
  | 'extrabold'
  | 'bold'
  | 'semibold'
  | 'medium'
  | 'regular'
  | 'light'
  | 'extralight'
  | 'thin'
  | 'serif'
  | 'pres-bold'
  | 'pres-black'
  | 'hand'
  | 'josefin'
  | 'josefin-light'
  | 'josefin-slab'
  | 'montserrat'
  | 'montserrat-medium'
  | 'inter'
  | 'inter-regular'
  | 'scratch'
  | 'instrument-italic';
export type TextAlign = 'center' | 'left';
/** Intro anims (see INTRO_ANIMS) bring the letters in themselves, frame by frame; the rest ramp the whole block. */
export type TextAnim = 'none' | 'fade' | 'pop' | 'rise' | 'type' | 'word' | 'letters' | 'blur' | 'track' | 'wipe';

/**
 * How the letters treat the picture under them.
 * invert: difference with the text color (white = photo negative). mono: the picture in gray.
 * frost: the picture blurred and lifted toward white. knockout: a plate in the text color with the letters cut out.
 * glow: a soft halo in the text color. chroma: red and cyan copies split sideways behind the letters.
 * glitch: short bursts where the letters are sliced and shifted with a wider split.
 */
export type TextEffect = 'none' | 'invert' | 'mono' | 'frost' | 'knockout' | 'glow' | 'chroma' | 'glitch';
export type BackdropEffect = 'invert' | 'mono' | 'frost';

export function backdropEffect(effect: TextEffect): BackdropEffect | null {
  return effect === 'invert' || effect === 'mono' || effect === 'frost' ? effect : null;
}

/** Gray weights of the canvas 'saturation' blend (Rec. 601 rounded); the exporter mixes channels with the same numbers. */
export const MONO_WEIGHTS = [0.3, 0.59, 0.11] as const;
/** Frost blur sigma in pixels of a 1080-wide frame, and how far the blurred picture is mixed toward white. */
export const FROST_SIGMA = 14;
export const FROST_LIFT = 0.25;
/** Glow blur (canvas shadowBlur) and chroma split, as fractions of the font size. */
export const GLOW_BLUR = 0.35;
export const CHROMA_SPLIT = 0.035;

/**
 * Glitch timing in clip-local seconds: a burst every GLITCH_EVERY lasting GLITCH_BURST, switching variant every
 * GLITCH_STEP. All three have at most 4 decimals so the exporter's expression uses the very same numbers.
 */
export const GLITCH_EVERY = 1.5;
export const GLITCH_BURST = 0.3;
export const GLITCH_STEP = 0.1;
export const GLITCH_VARIANTS = 3;
/** Nudges frame times off the slot edges so float rounding in ffmpeg and JS lands on the same slot. */
export const GLITCH_EPS = 0.0001;

/** Which glitch variant shows at clip-local time `local`, or -1 for the plain letters. */
export function glitchVariant(local: number): number {
  const u = local + GLITCH_EPS;
  const p = u - GLITCH_EVERY * Math.floor(u / GLITCH_EVERY);
  if (p >= GLITCH_BURST) return -1;
  const n = Math.floor(u / GLITCH_EVERY) + Math.floor(p / GLITCH_STEP);
  return n % GLITCH_VARIANTS;
}

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
  /** Family name of a font installed on this PC; '' = use `font`. Never bundled, so other PCs fall back to `font`. */
  customFont: string;
  effect: TextEffect;
}

export const TEXT_STYLE_DEFAULTS = { tracking: 0, shadow: 0, customFont: '', effect: 'none' as TextEffect };

/** Names that would break out of the quoted CSS family in a canvas font string. */
export function validCustomFont(name: string): boolean {
  return name.length <= 100 && !/["\\;{}]/.test(name);
}

/**
 * Typography on part of a text clip. The styled part is the `nth` (0-based) occurrence of `match`
 * in the clip text after tokens are resolved, so editing other words keeps it attached.
 */
export interface TextSpan {
  match: string;
  nth: number;
  color?: string;
  font?: FontId;
  /** Size multiplier against the clip size. */
  scale?: number;
  /** Degrees, clockwise, around the span's own center. */
  rotate?: number;
  /** Offset in design (1080-wide) pixels. */
  dx?: number;
  dy?: number;
}

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
  /** Degrees, clockwise, of the whole text around its center. */
  rotation: number;
  spans: TextSpan[];
}

export const TEXT_CLIP_DEFAULTS = { rotation: 0, spans: [] as TextSpan[] };

/** Start index of the `nth` occurrence of `match` in `text`, or -1. */
export function spanIndex(text: string, match: string, nth: number): number {
  if (!match) return -1;
  let from = 0;
  for (let i = 0; ; i++) {
    const at = text.indexOf(match, from);
    if (at === -1 || i === nth) return at;
    from = at + match.length;
  }
}

export type AnyClip = Clip | TextClip;

export type TrackKind = 'video' | 'audio' | 'text';

export interface Track {
  id: string;
  kind: TrackKind;
  muted: boolean;
  hidden: boolean;
  /** Shown instead of the default "텍스트 1" style label; absent or empty = default. */
  name?: string;
  /** Locked tracks keep their clips where they are: no drag, trim, split, delete or drop. */
  locked?: boolean;
  /** How see-through the whole layer is, 0..1; absent = 1. */
  opacity?: number;
  /** How the layer mixes with the layers under it; absent = normal. */
  blend?: BlendMode;
  /** Clipping mask: the layer shows only where the picture layer under it (its group's base) is opaque. */
  clipped?: boolean;
  clips: AnyClip[];
}

/** Layer blend modes, as in a drawing app. Preview uses the canvas operation of the same name ('add' is 'lighter'). */
export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'add' | 'difference';

export const BLEND_MODES: { id: BlendMode; label: string }[] = [
  { id: 'normal', label: '표준' },
  { id: 'multiply', label: '곱하기' },
  { id: 'screen', label: '스크린' },
  { id: 'overlay', label: '오버레이' },
  { id: 'darken', label: '어둡게' },
  { id: 'lighten', label: '밝게' },
  { id: 'add', label: '더하기' },
  { id: 'difference', label: '차이' },
];

export function layerOpacity(track: Track): number {
  return track.opacity ?? 1;
}

export function layerBlend(track: Track): BlendMode {
  return track.blend ?? 'normal';
}

/**
 * Whether the layer is drawn on its own and then mixed in with its opacity and blend mode. Not for a layer at full
 * opacity in normal mode, and not for text whose effect treats the picture under it (frost, mono, invert): that
 * effect needs the whole picture, so such a layer is drawn straight in.
 */
export function mixesAsLayer(track: Track): boolean {
  if (track.kind === 'audio' || (layerOpacity(track) >= 1 && layerBlend(track) === 'normal')) return false;
  return drawsAlone(track);
}

/** False for text whose effect treats the picture under it: that needs the whole picture, not a layer of its own. */
function drawsAlone(track: Track): boolean {
  return !track.clips.some((c) => isTextClip(c) && backdropEffect(c.style.effect) !== null);
}

/** A picture layer with the clipping-mask layers stacked right above it, which show only where it is opaque. */
export interface LayerGroup {
  base: Track;
  /** Bottom to top. */
  clipped: Track[];
}

/**
 * Picture layers bottom to top, each clipping-mask layer joined to the layer under it. A clipped layer with no
 * picture layer under it, or one that can't be drawn on its own (or onto such a base), stands as a layer by itself.
 */
export function layerGroups(project: Project): LayerGroup[] {
  const groups: LayerGroup[] = [];
  const visual = project.tracks.filter((t) => t.kind !== 'audio');
  for (let i = visual.length - 1; i >= 0; i--) {
    const track = visual[i];
    const group = groups[groups.length - 1];
    if (track.clipped && group && drawsAlone(track) && drawsAlone(group.base)) group.clipped.push(track);
    else groups.push({ base: track, clipped: [] });
  }
  return groups;
}

/** Whether turning on the clipping mask would clip this layer to something. */
export function canClip(project: Project, trackId: string): boolean {
  const visual = project.tracks.filter((t) => t.kind !== 'audio');
  const i = visual.findIndex((t) => t.id === trackId);
  return i !== -1 && i < visual.length - 1;
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
/**
 * Intro animations bring the letters in themselves: the renderer draws every frame of the intro (preview and export
 * alike) and the exporter only lines those frames up. After the intro the clip shows its settled raster.
 */
export const INTRO_ANIMS = ['type', 'word', 'letters', 'blur', 'track', 'wipe'] as const;
export type IntroAnim = (typeof INTRO_ANIMS)[number];
export type StepAnim = 'type' | 'word' | 'letters';

export function isIntroAnim(anim: TextAnim): anim is IntroAnim {
  return (INTRO_ANIMS as readonly string[]).includes(anim);
}

/** Seconds per step (letter or word), sped up so the steps end within INTRO_SHARE of the clip. */
export const TYPE_STEP = 0.06;
export const WORD_STEP = 0.22;
export const LETTER_STEP = 0.05;
/** Seconds one letter of 'letters' takes to fade in. */
export const LETTER_FADE = 0.3;
/** Length of the blur, track and wipe intros. */
export const REVEAL = 0.8;
export const INTRO_SHARE = 0.6;
/** Blur intro starts at this blur radius, in font sizes. */
export const BLUR_FROM = 0.35;
/** Track intro starts with this much extra letter spacing, in font sizes. */
export const TRACK_FROM = 0.6;
/** Soft edge of the wipe, as a share of the text width. */
export const WIPE_EDGE = 0.25;

/** Text lengths (UTF-16 units) after each letter; whitespace is not a step and a code point is never split. */
export function letterStops(text: string): number[] {
  const stops: number[] = [];
  let i = 0;
  for (const ch of text) {
    i += ch.length;
    if (!/\s/.test(ch)) stops.push(i);
  }
  return stops;
}

/** Text lengths after each word (run of non-whitespace). */
export function wordStops(text: string): number[] {
  const stops: number[] = [];
  for (const m of text.matchAll(/\S+/g)) stops.push((m.index ?? 0) + m[0].length);
  return stops;
}

function stepOf(anim: StepAnim, steps: number, duration: number): number {
  if (steps < 2) return 0;
  if (anim === 'letters') return Math.min(LETTER_STEP, Math.max(0, INTRO_SHARE * duration - LETTER_FADE) / (steps - 1));
  return Math.min(anim === 'word' ? WORD_STEP : TYPE_STEP, (INTRO_SHARE * duration) / steps);
}

/** Seconds from the clip start until the intro is over, never past the clip. */
export function introLength(anim: IntroAnim, text: string, duration: number): number {
  if (anim === 'blur' || anim === 'track' || anim === 'wipe') return Math.min(REVEAL, INTRO_SHARE * duration);
  const stops = anim === 'word' ? wordStops(text) : letterStops(text);
  const lastStart = Math.max(0, stops.length - 1) * stepOf(anim, stops.length, duration);
  return Math.min(duration, lastStart + (anim === 'letters' ? LETTER_FADE : 0));
}

/** Intro frames drawn at local times 0, 1/fps, ...; frame n is shown from start + n / fps. */
export function introFrames(anim: IntroAnim, text: string, duration: number, fps: number): number {
  return Math.ceil(introLength(anim, text, duration) * fps - 1e-6);
}

/** Opacity of each character (UTF-16 unit) `local` seconds into a type, word or letters intro. */
export function letterAlphas(anim: StepAnim, text: string, duration: number, local: number): number[] {
  const stops = anim === 'word' ? wordStops(text) : letterStops(text);
  const alphas = new Array<number>(text.length).fill(1);
  if (stops.length === 0) return alphas;
  const step = stepOf(anim, stops.length, duration);
  let from = 0;
  stops.forEach((to, k) => {
    const start = k * step;
    const a =
      anim === 'letters'
        ? Math.max(0, Math.min(1, (local - start) / LETTER_FADE))
        : local + 1e-6 >= start
          ? 1
          : 0;
    for (let i = from; i < to; i++) alphas[i] = a;
    from = to;
  });
  return alphas;
}

/** Eased 0..1 progress of a blur, track or wipe intro. */
export function introProgress(anim: 'blur' | 'track' | 'wipe', text: string, duration: number, local: number): number {
  const len = introLength(anim, text, duration);
  const p = len <= 0 ? 1 : Math.max(0, Math.min(1, local / len));
  return 1 - (1 - p) ** 3;
}

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
    // Subject masks belonged to the dropped 'behind' text effect.
    assets: p.assets.map((a) => ('matte' in a ? (Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'matte')) as MediaAsset) : a)),
    vars: { ...DEFAULT_VARS, ...(p.vars ?? {}) },
    markers: p.markers ?? [],
    tracks: p.tracks.map((t) => ({
      ...t,
      clips: t.clips.map((c) => {
        if (isMediaClip(c)) return { ...MEDIA_CLIP_DEFAULTS, ...c };
        const style = { ...TEXT_STYLE_DEFAULTS, ...c.style };
        // 'behind' (the subject drawn over the letters) was dropped for a subject layer moved above the text.
        if ((style.effect as string) === 'behind') style.effect = 'none';
        return { ...TEXT_CLIP_DEFAULTS, ...c, style };
      }),
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

/**
 * The part of a placed picture kept by the crop, relative to the placed rect. Edges snap to even
 * pixels because ffmpeg's crop does so on 4:2:0 video; preview uses the same box to match export.
 */
export function cropBox(r: Rect, c: ClipCrop): Rect {
  const even = (v: number) => Math.round(v / 2) * 2;
  const x = even(c.l * r.w);
  const y = even(c.t * r.h);
  const w = Math.max(2, r.w - x - even(c.r * r.w));
  const h = Math.max(2, r.h - y - even(c.b * r.h));
  return { x, y, w, h };
}

export function hasCrop(c: ClipCrop): boolean {
  return c.l > 0 || c.t > 0 || c.r > 0 || c.b > 0;
}
