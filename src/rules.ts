import type { Project, TextClip } from '../shared/project';
import {
  assetById,
  clipDuration,
  clipEnd,
  isMediaClip,
  isTextClip,
  placeVisual,
  projectDuration,
  resolveTokens,
} from '../shared/project';
import { cachedRaster, wrappedLines } from './engine/text';
import { mainTrackId } from './store';

/** Numbers from CONTI_RULES.md (윈드가든인스타). The rule field is the section number there. */
export const RULES = {
  minLength: 15,
  maxLength: 35,
  minCut: 2,
  maxLines: 2,
  maxLineChars: 16,
  maxCharsPerSec: 12,
  safeTop: 0.14,
  safeBottom: 0.35,
  safeSide: 0.06,
};

export interface RuleIssue {
  key: string;
  rule: string;
  message: string;
  t: number;
  clipId: string | null;
}

const EPS = 1e-6;

export function isBadge(clip: TextClip): boolean {
  return clip.style.background !== null;
}

/** Bracketed asides do not count toward the two-line limit (2-4-1). */
export function isAside(clip: TextClip): boolean {
  return clip.preset === 'aside' || /^\(.*\)$/s.test(clip.text.trim());
}

export function checkRules(project: Project): RuleIssue[] {
  const issues: RuleIssue[] = [];
  const add = (rule: string, message: string, t: number, clipId: string | null) =>
    issues.push({ key: `${rule}:${clipId ?? 'project'}:${issues.length}`, rule, message, t, clipId });
  const W = project.width;
  const H = project.height;
  const duration = projectDuration(project);
  if (duration <= 0) return issues;

  if (duration < RULES.minLength - EPS || duration > RULES.maxLength + EPS) {
    add('2-7-1', `길이 ${duration.toFixed(1)}초. ${RULES.minLength}~${RULES.maxLength}초로 맞춰요`, Math.min(duration, RULES.maxLength), null);
  }

  const mainId = mainTrackId(project, 'video');
  const main = project.tracks.find((t) => t.id === mainId);
  for (const clip of main?.clips.filter(isMediaClip) ?? []) {
    const d = clipDuration(clip);
    if (d < RULES.minCut - EPS) add('2-2-1', `컷 ${d.toFixed(2)}초. 컷당 ${RULES.minCut}초 이상`, clip.start, clip.id);
    const asset = assetById(project, clip.assetId);
    const r = placeVisual(asset.width, asset.height, W, H, clip.transform);
    if (r.x > 0 || r.y > 0 || r.x + r.w < W || r.y + r.h < H) {
      add('2-5-1', '메인 화면이 프레임을 다 채우지 않아요(레터박스)', clip.start, clip.id);
    }
  }

  const covered = project.tracks
    .filter((t) => t.kind === 'video' && !t.hidden)
    .flatMap((t) => t.clips.map((c) => [c.start, clipEnd(c)] as const))
    .sort((a, b) => a[0] - b[0]);
  let reach = 0;
  const frame = 1 / project.fps;
  for (const [s, e] of [...covered, [duration, duration] as const]) {
    if (s - reach > frame / 2) add('2-4-3', `${reach.toFixed(1)}~${s.toFixed(1)}초 화면이 비어 있어요(글자만 있는 컷)`, reach, null);
    reach = Math.max(reach, e);
  }

  for (const track of project.tracks) {
    if (track.kind !== 'text' || track.hidden) continue;
    for (const clip of track.clips.filter(isTextClip)) {
      const rect = cachedRaster(clip, project.vars, W, H);
      if (isBadge(clip)) {
        if (rect.y < RULES.safeTop * H || rect.x < RULES.safeSide * W - 1 || rect.x + rect.w > (1 - RULES.safeSide) * W + 1) {
          add('2-4-6', '배지는 위 14% 선 바로 아래, 좌우 6% 안쪽에', clip.start, clip.id);
        }
        continue;
      }
      const lines = wrappedLines(clip, project.vars, W);
      if (!isAside(clip) && lines.length > RULES.maxLines) {
        add('2-4-1', `${lines.length}줄. ${RULES.maxLines}줄 이내로 나눠요`, clip.start, clip.id);
      }
      const longest = Math.max(...lines.map((l) => l.trim().length));
      if (longest > RULES.maxLineChars) add('2-4-2', `한 줄 ${longest}자. ${RULES.maxLineChars}자 이하로`, clip.start, clip.id);
      const chars = resolveTokens(clip.text, project.vars).replace(/\s/g, '').length;
      const perSec = chars / clipDuration(clip);
      if (perSec > RULES.maxCharsPerSec + EPS) {
        add('2-4-2', `초당 ${perSec.toFixed(1)}자. ${RULES.maxCharsPerSec}자 이하로 줄이거나 길게`, clip.start, clip.id);
      }
      if (
        !isAside(clip) &&
        (rect.y < RULES.safeTop * H ||
          rect.y + rect.h > (1 - RULES.safeBottom) * H ||
          rect.x < RULES.safeSide * W ||
          rect.x + rect.w > (1 - RULES.safeSide) * W)
      ) {
        add('2-4-4', '글자가 안전 영역 밖에 있어요', clip.start, clip.id);
      }
    }
  }

  const audible = project.tracks.some(
    (t) =>
      !t.muted &&
      t.clips.some((c) => {
        if (!isMediaClip(c)) return false;
        const a = assetById(project, c.assetId);
        return a.kind === 'audio' || (a.kind === 'video' && a.hasAudio);
      }),
  );
  if (!audible) add('2-7-2', '소리가 없어요. 무음으로 올리지 않아요', 0, null);

  return issues.sort((a, b) => a.t - b.t);
}
