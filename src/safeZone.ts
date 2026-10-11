import type { Project } from '../shared/project';
import { aspectOf } from '../shared/project';

/** Frame fractions short-form apps cover with their own UI (top bar, caption and buttons, side icons). */
export const SAFE_ZONE = {
  top: 0.14,
  bottom: 0.35,
  side: 0.06,
};

/** The safe zone is drawn and snapped to only on a 9:16 frame, the shape whose apps cover it. */
export function hasSafeZone(project: Project): boolean {
  return aspectOf(project) === '9:16';
}
