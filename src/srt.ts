import type { ProjectVars, TextClip } from '../shared/project';
import { clipEnd, resolveTokens } from '../shared/project';

export interface SrtCue {
  start: number;
  end: number;
  text: string;
}

function parseStamp(s: string): number {
  const m = /(\d+):(\d{2}):(\d{2})[,.](\d{1,3})/.exec(s);
  if (!m) throw new Error(`bad SRT timestamp: ${s}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

function stamp(t: number): string {
  const ms = Math.round(Math.max(0, t) * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
}

export function parseSrt(content: string): SrtCue[] {
  const cues: SrtCue[] = [];
  for (const block of content.replace(/^\uFEFF/, '').replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    const timeIdx = lines.findIndex((l) => l.includes('-->'));
    if (timeIdx === -1) continue;
    const [a, b] = lines[timeIdx].split('-->');
    const start = parseStamp(a);
    const end = parseStamp(b);
    const text = lines.slice(timeIdx + 1).join('\n').trim();
    if (text && end > start) cues.push({ start, end, text });
  }
  return cues;
}

/** Badges (text with a background box) are overlays, not dialogue, so they are left out. */
export function toSrt(clips: TextClip[], vars: ProjectVars): string {
  return [...clips]
    .filter((c) => !c.style.background)
    .sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(clipEnd(c))}\n${resolveTokens(c.text, vars)}\n`)
    .join('\n');
}
