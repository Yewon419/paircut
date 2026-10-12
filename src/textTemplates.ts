import { create } from 'zustand';
import type { TextClip } from '../shared/project';
import { clipDuration, TEXT_STYLE_DEFAULTS } from '../shared/project';
import type { TextPreset } from './presets';
import { PRESETS } from './presets';

const KEY = 'paircut.textTemplates';
/** Built-in templates live in code, so deleting one only hides it; the ids here are hidden. */
const HIDDEN_KEY = 'paircut.hiddenTextPresets';

const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

function isTemplate(v: unknown): v is TextPreset {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  const st = p.style as Record<string, unknown> | null;
  return (
    typeof p.id === 'string' &&
    typeof p.label === 'string' &&
    typeof p.text === 'string' &&
    typeof p.anim === 'string' &&
    [p.duration, p.x, p.y, p.rotation].every(isNum) &&
    Array.isArray(p.spans) &&
    typeof st === 'object' &&
    st !== null &&
    typeof st.font === 'string' &&
    isNum(st.size)
  );
}

/** Unreadable data is moved aside, not dropped, like the color presets. */
function load<T>(key: string, valid: (list: unknown[]) => list is T[]): T[] {
  const raw = localStorage.getItem(key);
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list) || !valid(list)) throw new Error('unexpected shape');
    return list;
  } catch (err) {
    const backup = `${key}.broken-${Date.now()}`;
    localStorage.setItem(backup, raw);
    localStorage.removeItem(key);
    console.error(`${key} was unreadable (${(err as Error).message}); moved to ${backup}`);
    return [];
  }
}

const loadUser = () =>
  load(KEY, (l): l is TextPreset[] => l.every(isTemplate)).map((t) => ({ ...t, style: { ...TEXT_STYLE_DEFAULTS, ...t.style } }));
const loadHidden = () => load(HIDDEN_KEY, (l): l is string[] => l.every((x) => typeof x === 'string'));

export const useTemplates = create(() => ({ user: loadUser(), hidden: loadHidden() }));

function persist(user: TextPreset[], hidden: string[]): void {
  localStorage.setItem(KEY, JSON.stringify(user));
  localStorage.setItem(HIDDEN_KEY, JSON.stringify(hidden));
  useTemplates.setState({ user, hidden });
}

export function isBuiltinTemplate(id: string): boolean {
  return PRESETS.some((p) => p.id === id);
}

/** Built-ins not hidden, then the user's own in the order they were saved. */
export function allTemplates(): TextPreset[] {
  const { user, hidden } = useTemplates.getState();
  return [...PRESETS.filter((p) => !hidden.includes(p.id)), ...user];
}

/** Saves the clip's text, look, place, motion and duration under `name`; a user template with the same name is replaced. */
export function saveTemplate(name: string, clip: TextClip): TextPreset {
  const label = name.trim();
  if (!label) throw new Error('템플릿 이름이 비었어요');
  if (PRESETS.some((p) => p.label === label)) throw new Error(`"${label}"은 기본 템플릿 이름이에요`);
  const template: TextPreset = {
    id: `u-${crypto.randomUUID().slice(0, 8)}`,
    label,
    text: clip.text,
    duration: clipDuration(clip),
    x: clip.x,
    y: clip.y,
    anim: clip.anim,
    style: { ...clip.style },
    rotation: clip.rotation,
    spans: structuredClone(clip.spans),
  };
  const { user, hidden } = useTemplates.getState();
  persist([...user.filter((t) => t.label !== label), template], hidden);
  return template;
}

export function deleteTemplate(id: string): void {
  const { user, hidden } = useTemplates.getState();
  if (isBuiltinTemplate(id)) persist(user, hidden.includes(id) ? hidden : [...hidden, id]);
  else persist(user.filter((t) => t.id !== id), hidden);
}

export function restoreBuiltinTemplates(): void {
  persist(useTemplates.getState().user, []);
}
