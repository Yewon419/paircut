import { compositor } from './engine/player';
import { useEditor } from './store';

/** Long side of the start-screen picture, in pixels. */
const THUMB_LONG = 480;

/**
 * Stores the preview as it is now as the start-screen picture of the file just saved.
 * The save already happened, so a failure here is logged and does not undo or fail it.
 */
export async function saveThumb(path: string): Promise<void> {
  const { project, playhead } = useEditor.getState();
  const scale = THUMB_LONG / Math.max(project.width, project.height);
  const w = Math.round(project.width * scale);
  const h = Math.round(project.height * scale);
  try {
    await window.api.saveProjectThumb(path, compositor.snapshot(project, playhead, w, h));
  } catch (err) {
    console.error(`[thumb] ${path} (${w}x${h} at ${playhead}s): ${(err as Error).message}`);
  }
}
