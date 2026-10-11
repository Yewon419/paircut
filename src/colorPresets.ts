import { create } from 'zustand';
import type { ClipColor } from '../shared/color';

export interface ColorPreset {
  id: string;
  name: string;
  color: ClipColor;
}

const KEY = 'cutdesk.colorPresets';
const COLOR_KEYS: (keyof ClipColor)[] = ['brightness', 'contrast', 'saturation', 'temperature'];

const pickColor = (c: Record<string, unknown>): ClipColor =>
  Object.fromEntries(COLOR_KEYS.map((k) => [k, c[k]])) as unknown as ClipColor;

function isPreset(v: unknown): v is ColorPreset {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  const c = p.color as Record<string, unknown> | null;
  return (
    typeof p.id === 'string' &&
    typeof p.name === 'string' &&
    typeof c === 'object' &&
    c !== null &&
    COLOR_KEYS.every((k) => typeof c[k] === 'number' && Number.isFinite(c[k]))
  );
}

/** User presets live in localStorage so every project shares them. Unreadable data is moved aside, not dropped. */
function loadUserPresets(): ColorPreset[] {
  const raw = localStorage.getItem(KEY);
  if (!raw) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list) || !list.every(isPreset)) throw new Error('unexpected shape');
    // Presets saved before the Bitteul tone was dropped still carry 'look'; only the known fields are kept.
    return list.map((p) => ({ id: p.id, name: p.name, color: pickColor(p.color as unknown as Record<string, unknown>) }));
  } catch (err) {
    const backup = `${KEY}.broken-${Date.now()}`;
    localStorage.setItem(backup, raw);
    localStorage.removeItem(KEY);
    console.error(`color presets in ${KEY} were unreadable (${(err as Error).message}); moved to ${backup}`);
    return [];
  }
}

export const usePresets = create(() => ({ user: loadUserPresets() }));

function persist(user: ColorPreset[]): void {
  localStorage.setItem(KEY, JSON.stringify(user));
  usePresets.setState({ user });
}

export function allPresets(): ColorPreset[] {
  return usePresets.getState().user;
}

/** Saves under `name`; an existing user preset with the same name is replaced. */
export function savePreset(name: string, color: ClipColor): ColorPreset {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('preset name is empty');
  const preset: ColorPreset = { id: `u-${crypto.randomUUID().slice(0, 8)}`, name: trimmed, color: { ...color } };
  persist([...usePresets.getState().user.filter((p) => p.name !== trimmed), preset]);
  return preset;
}

export function deletePreset(id: string): void {
  persist(usePresets.getState().user.filter((p) => p.id !== id));
}
