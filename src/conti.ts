import type { Marker, ProjectVars, TextClip } from '../shared/project';
import { DEFAULT_VARS } from '../shared/project';
import type { TextPreset } from './presets';
import { makeTextClip, presetById } from './presets';

/** Rows without a time range (vlog drafts) get this length, above the 2s-per-cut rule. */
export const DEFAULT_CUT = 3;

export interface BoardRow {
  no: string;
  time: string | null;
  text: string;
}

export interface BoardPost {
  id: string;
  title: string;
  kind: string;
  date: string;
  rows: BoardRow[];
}

export interface Board {
  posts: BoardPost[];
  vars: ProjectVars;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/** Validates the operations board JSON; malformed posts or rows are skipped, not guessed. */
export function parseBoard(raw: unknown): Board {
  if (typeof raw !== 'object' || raw === null) throw new Error('board.json is not an object');
  const root = raw as { posts?: unknown; settings?: unknown };
  if (!Array.isArray(root.posts)) throw new Error('board.json has no posts array');
  const settings = (typeof root.settings === 'object' && root.settings !== null ? root.settings : {}) as Record<string, unknown>;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const vars: ProjectVars = {
    uploadDate: '',
    ddayTarget: str(settings.ddayTarget) ?? DEFAULT_VARS.ddayTarget,
    salary: num(settings.revenue, DEFAULT_VARS.salary),
    goal: num(settings.goal, DEFAULT_VARS.goal),
  };
  const posts: BoardPost[] = [];
  for (const p of root.posts as unknown[]) {
    if (typeof p !== 'object' || p === null) continue;
    const post = p as Record<string, unknown>;
    const id = str(post.id);
    if (!id) continue;
    const conti = (typeof post.conti === 'object' && post.conti !== null ? post.conti : {}) as { rows?: unknown };
    const rows: BoardRow[] = [];
    if (Array.isArray(conti.rows)) {
      for (const r of conti.rows as unknown[]) {
        if (typeof r !== 'object' || r === null) continue;
        const row = r as Record<string, unknown>;
        rows.push({ no: str(row.no) ?? String(rows.length + 1), time: str(row.time), text: str(row.text) ?? '' });
      }
    }
    posts.push({ id, title: str(post.title) ?? id, kind: str(post.kind) ?? '', date: str(post.date) ?? '', rows });
  }
  return { posts, vars };
}

export function parseRange(time: string | null): [number, number] | null {
  const m = /([\d.]+)\s*~\s*([\d.]+)/.exec(time ?? '');
  if (!m) return null;
  const a = Number(m[1]);
  const b = Number(m[2]);
  return b > a ? [a, b] : null;
}

interface Segment {
  text: string;
  aside: boolean;
}

function cleanSegment(raw: string): Segment | null {
  let s = raw.trim();
  let aside = false;
  const size = /^(작게|크게)\s*:?\s*/.exec(s);
  if (size) {
    aside = size[1] === '작게';
    s = s.slice(size[0].length);
  }
  s = s.replace(/^["“”]+|["“”]+$/g, '').trim();
  if (!s) return null;
  if (/^\(.*\)$/.test(s)) aside = true;
  return { text: s.replaceAll('D-[N]', 'D-{D}'), aside };
}

/** Splits one conti text cell into timed parts ("→" = one after another) of main lines and asides. */
export function parseCell(cell: string): Segment[][] {
  const body = cell.trim().replace(/^[가-힣 ]{1,6}:\s*/, '');
  if (!body) return [];
  return body
    .split('→')
    .map((part) => {
      const segs: Segment[] = [];
      for (const piece of part.split(/\s+[/+]\s+/)) {
        const seg = cleanSegment(piece);
        if (!seg) continue;
        const tail = /^(.*\S)\s+(\([^()]+\))$/.exec(seg.text);
        if (!seg.aside && tail) {
          segs.push({ text: tail[1], aside: false }, { text: tail[2], aside: true });
        } else {
          segs.push(seg);
        }
      }
      return segs;
    })
    .filter((segs) => segs.length > 0);
}

export interface ContiDraft {
  mains: TextClip[];
  asides: TextClip[];
  markers: Marker[];
}

function estimateLines(text: string, preset: TextPreset): number {
  const perLine = preset.id === 'hook' ? 13 : 16;
  return text.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / perLine)), 0);
}

export function draftFromRows(rows: BoardRow[], newId: () => string): ContiDraft {
  const draft: ContiDraft = { mains: [], asides: [], markers: [] };
  const hook = presetById('hook');
  const sub = presetById('sub');
  const asidePreset = presetById('aside');
  let cursor = 0;
  rows.forEach((row, i) => {
    const range = parseRange(row.time);
    const start = range ? range[0] : cursor;
    const end = range ? range[1] : cursor + DEFAULT_CUT;
    cursor = end;
    draft.markers.push({ t: start, label: `#${row.no}` });
    const parts = parseCell(row.text);
    const slice = (end - start) / Math.max(1, parts.length);
    parts.forEach((segs, k) => {
      const s = start + k * slice;
      const mainText = segs.filter((g) => !g.aside).map((g) => g.text).join('\n');
      const preset = i === 0 ? hook : sub;
      let asideY = asidePreset.y;
      if (mainText) {
        draft.mains.push(makeTextClip(preset, newId(), s, { text: mainText, out: slice }));
        const halfMain = (estimateLines(mainText, preset) * preset.style.size * 1.22) / 2;
        asideY = preset.y + (halfMain + asidePreset.style.size) / 1920;
      }
      for (const g of segs.filter((x) => x.aside)) {
        draft.asides.push(makeTextClip(asidePreset, newId(), s, { text: g.text, out: slice, y: mainText ? asideY : sub.y }));
      }
    });
  });
  return draft;
}
