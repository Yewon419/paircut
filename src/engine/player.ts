import type { Clip, MediaAsset, Project, Rect, TextClip, Track } from '../../shared/project';
import { assetById, clipEnd, isMediaClip, isTextClip, placeVisual, projectDuration } from '../../shared/project';
import { setPlayhead, useEditor } from '../store';
import { animState, cachedRaster, DESIGN_WIDTH, drawText } from './text';

type MediaEl = HTMLVideoElement | HTMLAudioElement | HTMLImageElement;

interface Entry {
  el: MediaEl;
  assetId: string;
}

const PRELOAD_AHEAD = 1.0;
const PLAY_DRIFT = 0.2;

class Compositor {
  private entries = new Map<string, Entry>();
  private canvas: HTMLCanvasElement | null = null;
  private redrawQueued = false;

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
      el = media;
    }
    const entry = { el, assetId: asset.id };
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
        this.syncMedia(entry.el, track, clip, t, playing);
      }
    }
    for (const id of [...this.entries.keys()]) if (!live.has(id)) this.release(id);
  }

  private syncMedia(el: HTMLMediaElement, track: Track, clip: Clip, t: number, playing: boolean): void {
    const active = t >= clip.start && t < clipEnd(clip);
    el.muted = track.muted;
    if (!active) {
      if (!el.paused) el.pause();
      const upcoming = t < clip.start && clip.start - t < PRELOAD_AHEAD;
      if (upcoming && Math.abs(el.currentTime - clip.in) > 0.05) el.currentTime = clip.in;
      return;
    }
    const want = clip.in + (t - clip.start);
    if (playing) {
      if (Math.abs(el.currentTime - want) > PLAY_DRIFT) el.currentTime = want;
      if (el.paused) void el.play().catch(() => undefined);
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - want) > 0.5 / 60) el.currentTime = want;
    }
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
      const clip = track.clips.find((c) => t >= c.start && t < clipEnd(c));
      if (!clip) continue;
      if (isTextClip(clip)) {
        drawText(ctx, cachedRaster(clip, project.vars, canvas.width, canvas.height), animState(clip, t), k);
        continue;
      }
      const entry = this.entries.get(clip.id);
      if (!entry) continue;
      const el = entry.el;
      const ready =
        el instanceof HTMLImageElement ? el.complete && el.naturalWidth > 0 : el instanceof HTMLVideoElement && el.readyState >= 2;
      if (!ready) continue;
      const r = this.rectFor(project, clip);
      if (r) ctx.drawImage(el as CanvasImageSource, r.x, r.y, r.w, r.h);
    }
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
