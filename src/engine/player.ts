import type { Clip, MediaAsset, Project, Rect, TextClip, Track } from '../../shared/project';
import {
  assetById,
  audioGain,
  clipEnd,
  frameTime,
  isMediaClip,
  isTextClip,
  placeVisual,
  projectDuration,
  visualAlpha,
  visualSpan,
} from '../../shared/project';
import { setPlayhead, useEditor } from '../store';
import { isNeutral } from '../../shared/color';
import { grader } from './grade';
import { animState, cachedRaster, DESIGN_WIDTH, drawText } from './text';

type MediaEl = HTMLVideoElement | HTMLAudioElement | HTMLImageElement;

interface Entry {
  el: MediaEl;
  assetId: string;
  /** Routes element audio so volume can exceed 1 and fades can ramp. */
  gain: GainNode | null;
  level: number;
}

const PRELOAD_AHEAD = 1.0;
const PLAY_DRIFT = 0.2;
const GRADE_MAX_PX = 2048;

class Compositor {
  private entries = new Map<string, Entry>();
  private canvas: HTMLCanvasElement | null = null;
  private redrawQueued = false;
  private audio: AudioContext | null = null;

  private audioContext(): AudioContext {
    this.audio ??= new AudioContext();
    return this.audio;
  }

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas;
    this.requestDraw();
  }

  private entryFor(clip: Clip, asset: MediaAsset): Entry {
    const existing = this.entries.get(clip.id);
    if (existing && existing.assetId === asset.id) return existing;
    if (existing) this.release(clip.id);
    const url = window.api.mediaUrl(asset.path);
    let el: MediaEl;
    let gain: GainNode | null = null;
    if (asset.kind === 'image') {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => this.requestDraw();
      img.src = url;
      el = img;
    } else {
      const media = asset.kind === 'video' ? document.createElement('video') : document.createElement('audio');
      media.crossOrigin = 'anonymous';
      media.preload = 'auto';
      media.src = url;
      if (media instanceof HTMLVideoElement) media.playsInline = true;
      media.addEventListener('seeked', () => this.requestDraw());
      media.addEventListener('loadeddata', () => this.requestDraw());
      const ctx = this.audioContext();
      gain = ctx.createGain();
      ctx.createMediaElementSource(media).connect(gain).connect(ctx.destination);
      el = media;
    }
    const entry = { el, assetId: asset.id, gain, level: 1 };
    this.entries.set(clip.id, entry);
    return entry;
  }

  private release(clipId: string): void {
    const entry = this.entries.get(clipId);
    if (!entry) return;
    if (!(entry.el instanceof HTMLImageElement)) {
      entry.el.pause();
      entry.el.removeAttribute('src');
      entry.el.load();
    }
    entry.gain?.disconnect();
    this.entries.delete(clipId);
  }

  sync(project: Project, t: number, playing: boolean): void {
    const live = new Set<string>();
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (!isMediaClip(clip)) continue;
        live.add(clip.id);
        const asset = assetById(project, clip.assetId);
        const entry = this.entryFor(clip, asset);
        if (entry.el instanceof HTMLImageElement) continue;
        this.syncMedia(entry, entry.el, track, clip, t, playing);
      }
    }
    for (const id of [...this.entries.keys()]) if (!live.has(id)) this.release(id);
  }

  /** Sound follows the clip's own range; the picture also runs through the dissolves around it. */
  private syncMedia(entry: Entry, el: HTMLMediaElement, track: Track, clip: Clip, t: number, playing: boolean): void {
    const audible = t >= clip.start && t < clipEnd(clip);
    const span = visualSpan(track, clip);
    const active = t >= span.from && t < span.to;
    el.muted = track.muted;
    if (el.playbackRate !== clip.speed) el.playbackRate = clip.speed;
    this.setLevel(entry, track.muted || !audible ? 0 : audioGain(clip, t));
    const length = Number.isFinite(el.duration) ? el.duration : Infinity;
    if (!active) {
      if (!el.paused) el.pause();
      const upcoming = t < span.from && span.from - t < PRELOAD_AHEAD;
      const first = frameTime(clip, length, span.from);
      if (upcoming && Math.abs(el.currentTime - first) > 0.05) el.currentTime = first;
      return;
    }
    const want = frameTime(clip, length, t);
    if (playing) {
      if (this.audio?.state === 'suspended') void this.audio.resume();
      if (Math.abs(el.currentTime - want) > PLAY_DRIFT * clip.speed) el.currentTime = want;
      if (el.paused) void el.play().catch(() => undefined);
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - want) > 0.5 / 60) el.currentTime = want;
    }
  }

  private setLevel(entry: Entry, level: number): void {
    entry.level = level;
    if (!entry.gain || !this.audio) return;
    entry.gain.gain.setTargetAtTime(level, this.audio.currentTime, 0.01);
  }

  /** Current playback rate and gain target of a clip's element, for the UI e2e. */
  audioState(clipId: string): { rate: number; level: number } | null {
    const entry = this.entries.get(clipId);
    if (!entry || entry.el instanceof HTMLImageElement) return null;
    return { rate: entry.el.playbackRate, level: entry.level };
  }

  /** Resolves once every media element active at t has a decoded frame (gives up after 3s). */
  async settled(project: Project, t: number): Promise<void> {
    const deadline = performance.now() + 3000;
    const busy = () =>
      project.tracks.some((track) =>
        track.clips.some((c) => {
          if (!isMediaClip(c)) return false;
          const span = visualSpan(track, c);
          if (t < span.from || t >= span.to) return false;
          const el = this.entries.get(c.id)?.el;
          if (!el) return true;
          if (el instanceof HTMLImageElement) return !el.complete;
          return el.seeking || el.readyState < 2;
        }),
      );
    while (busy() && performance.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  /** Draws the frame at t and returns it scaled to w x h as base64 JPEG (no selection or guide overlays). */
  snapshot(project: Project, t: number, w: number, h: number): string {
    if (!this.canvas) throw new Error('preview canvas is not mounted');
    this.draw(project, t);
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    ctx.drawImage(this.canvas, 0, 0, w, h);
    return out.toDataURL('image/jpeg', 0.8).replace(/^data:image\/jpeg;base64,/, '');
  }

  requestDraw(): void {
    if (this.redrawQueued) return;
    this.redrawQueued = true;
    requestAnimationFrame(() => {
      this.redrawQueued = false;
      const { project, playhead } = useEditor.getState();
      this.draw(project, playhead);
    });
  }

  /** Visual rect of a clip in canvas pixels, used by the preview for selection handles. */
  rectFor(project: Project, clip: Clip): Rect | null {
    if (!this.canvas) return null;
    const asset = assetById(project, clip.assetId);
    if (asset.kind === 'audio') return null;
    return placeVisual(asset.width, asset.height, this.canvas.width, this.canvas.height, clip.transform);
  }

  textRect(project: Project, clip: TextClip): Rect | null {
    if (!this.canvas) return null;
    const r = cachedRaster(clip, project.vars, this.canvas.width, this.canvas.height);
    return { x: r.x, y: r.y, w: r.w, h: r.h };
  }

  draw(project: Project, t: number): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const visual = project.tracks.filter((tr) => tr.kind !== 'audio');
    const k = canvas.width / DESIGN_WIDTH;
    for (let i = visual.length - 1; i >= 0; i--) {
      const track = visual[i];
      if (track.hidden) continue;
      if (track.kind === 'text') {
        const clip = track.clips.find((c) => t >= c.start && t < clipEnd(c));
        if (clip && isTextClip(clip)) drawText(ctx, cachedRaster(clip, project.vars, canvas.width, canvas.height), animState(clip, t), k);
        continue;
      }
      for (const clip of track.clips) {
        if (!isMediaClip(clip)) continue;
        const span = visualSpan(track, clip);
        if (t < span.from || t >= span.to) continue;
        ctx.globalAlpha = visualAlpha(span, t);
        this.drawClip(ctx, project, clip);
        ctx.globalAlpha = 1;
      }
    }
  }

  private drawClip(ctx: CanvasRenderingContext2D, project: Project, clip: Clip): void {
    const entry = this.entries.get(clip.id);
    if (!entry) return;
    const el = entry.el;
    const ready =
      el instanceof HTMLImageElement ? el.complete && el.naturalWidth > 0 : el instanceof HTMLVideoElement && el.readyState >= 2;
    if (!ready) return;
    const r = this.rectFor(project, clip);
    if (!r) return;
    if (isNeutral(clip.color)) {
      ctx.drawImage(el as CanvasImageSource, r.x, r.y, r.w, r.h);
      return;
    }
    const fit = Math.min(1, GRADE_MAX_PX / Math.max(r.w, r.h));
    const graded = grader.apply(el as TexImageSource, Math.round(r.w * fit), Math.round(r.h * fit), clip.color);
    ctx.drawImage(graded, r.x, r.y, r.w, r.h);
  }
}

export const compositor = new Compositor();

let raf = 0;
let clockStart = 0;
let playheadStart = 0;

function tick(now: number): void {
  const { project } = useEditor.getState();
  const duration = projectDuration(project);
  const t = playheadStart + (now - clockStart) / 1000;
  if (t >= duration) {
    pause();
    setPlayhead(duration);
    return;
  }
  useEditor.setState({ playhead: t });
  compositor.sync(project, t, true);
  compositor.draw(project, t);
  raf = requestAnimationFrame(tick);
}

export function play(): void {
  const state = useEditor.getState();
  if (state.playing) return;
  const duration = projectDuration(state.project);
  if (duration <= 0) return;
  if (state.playhead >= duration - 1e-3) setPlayhead(0);
  playheadStart = useEditor.getState().playhead;
  clockStart = performance.now();
  useEditor.setState({ playing: true });
  raf = requestAnimationFrame(tick);
}

export function pause(): void {
  cancelAnimationFrame(raf);
  useEditor.setState({ playing: false });
  const { project, playhead } = useEditor.getState();
  compositor.sync(project, playhead, false);
  compositor.requestDraw();
}

export function togglePlay(): void {
  if (useEditor.getState().playing) pause();
  else play();
}

/** While paused, keep media elements and the canvas in step with edits and scrubbing. */
export function startPausedSync(): () => void {
  return useEditor.subscribe((state, prev) => {
    if (state.playing) {
      if (state.project !== prev.project) compositor.sync(state.project, state.playhead, true);
      return;
    }
    if (state.project !== prev.project || state.playhead !== prev.playhead || state.playing !== prev.playing) {
      compositor.sync(state.project, state.playhead, false);
      compositor.requestDraw();
    }
  });
}

/** Scrubbing during playback restarts the clock from the new position. */
export function seek(t: number): void {
  setPlayhead(t);
  if (useEditor.getState().playing) {
    playheadStart = useEditor.getState().playhead;
    clockStart = performance.now();
  }
}
