import type { TextImage } from '../shared/api';
import { outputSize } from '../shared/exportGraph';
import type { Project } from '../shared/project';
import { textClips } from '../shared/project';
import { rasterizeText } from './engine/text';

/** Rasterizes every visible text clip at the export frame size so ffmpeg overlays the same pixels the preview shows. */
export function textImagesFor(project: Project, height: number): TextImage[] {
  const { width, height: h } = outputSize(project, height);
  const out: TextImage[] = [];
  for (const track of project.tracks) {
    if (track.kind !== 'text' || track.hidden) continue;
    for (const clip of textClips(track)) {
      const r = rasterizeText(clip, project.vars, width, h);
      const dataUrl = r.canvas.toDataURL('image/png');
      out.push({ clipId: clip.id, pngBase64: dataUrl.slice(dataUrl.indexOf(',') + 1), x: r.x, y: r.y, w: r.w, h: r.h });
    }
  }
  return out;
}
