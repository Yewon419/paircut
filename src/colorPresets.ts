import { create } from 'zustand';
import type { ClipColor } from '../shared/color';
import { BITTEUL_COLOR } from '../shared/color';

export interface ColorPreset {
  id: string;
  name: string;
  color: ClipColor;
  builtin: boolean;
}

const KEY = 'cutdesk.colorPresets';
const COLOR_KEYS: (keyof ClipColor)[] = ['brightness', 'contrast', 'saturation', 'temperature', 'look'];

export const BUILTIN_PRESETS: ColorPreset[] = [{ id: 'bitteul', name: '빛뜰 보정', color: BITTEUL_COLOR, builtin: true }];

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
    return list.map((p) => ({ ...p, builtin: false }));
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
  return [...BUILTIN_PRESETS, ...usePresets.getState().user];
}

/** Saves under `name`; an existing user preset with the same name is replaced. */
export function savePreset(name: string, color: ClipColor): ColorPreset {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('preset name is empty');
  if (BUILTIN_PRESETS.some((p) => p.name === trimmed)) throw new Error(`"${trimmed}" is a built-in preset name`);
  const preset: ColorPreset = { id: `u-${crypto.randomUUID().slice(0, 8)}`, name: trimmed, color: { ...color }, builtin: false };
  persist([...usePresets.getState().user.filter((p) => p.name !== trimmed), preset]);
  return preset;
}

export function deletePreset(id: string): void {
  persist(usePresets.getState().user.filter((p) => p.id !== id));
}
