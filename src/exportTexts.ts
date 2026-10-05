import type { TextImage, TextIntro } from '../shared/api';
import { outputSize } from '../shared/exportGraph';
import type { Project, TextClip } from '../shared/project';
import { clipDuration, introFrames, isIntroAnim, resolveTokens, textClips } from '../shared/project';
import type { TextRaster } from './engine/text';
import { introRaster, rasterizeText } from './engine/text';

function png(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

/** Every intro frame, then the settled raster, each redrawn into the box that holds them all. */
function introOf(project: Project, clip: TextClip, settled: TextRaster, width: number, height: number): TextIntro | null {
  if (!isIntroAnim(clip.anim)) return null;
  const n = introFrames(clip.anim, resolveTokens(clip.text, project.vars), clipDuration(clip), project.fps);
  const rasters: TextRaster[] = [];
  for (let i = 0; i < n; i++) rasters.push(introRaster(clip, project.vars, width, height, i / project.fps));
  rasters.push(settled);
  const x = Math.min(...rasters.map((r) => r.x));
  const y = Math.min(...rasters.map((r) => r.y));
  const w = Math.max(...rasters.map((r) => r.x + r.w)) - x;
  const h = Math.max(...rasters.map((r) => r.y + r.h)) - y;
  const frames = rasters.map((r) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    if (!g) throw new Error('2d context unavailable');
    g.drawImage(r.canvas, r.x - x, r.y - y);
    return png(c);
  });
  return { frames, x, y, w, h };
}

/** Rasterizes every visible text clip at the export frame size so ffmpeg overlays the same pixels the preview shows. */
export function textImagesFor(project: Project, height: number): TextImage[] {
  const { width, height: h } = outputSize(project, height);
  const out: TextImage[] = [];
  for (const track of project.tracks) {
    if (track.kind !== 'text' || track.hidden) continue;
    for (const clip of textClips(track)) {
      const r = rasterizeText(clip, project.vars, width, h, null, 0);
      out.push({
        clipId: clip.id,
        pngBase64: png(r.canvas),
        x: r.x,
        y: r.y,
        w: r.w,
        h: r.h,
        variants: r.variants.map(png),
        intro: introOf(project, clip, r, width, h),
      });
    }
  }
  return out;
}
