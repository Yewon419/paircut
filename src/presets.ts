import type { TextAnim, TextClip, TextStyle } from '../shared/project';

/** Bitteul brand values: CHARACTER.md 2-1, 001_intro_video.md sections 2 and 5. */
export const NAVY = '#13293D';
export const BUTTER = '#FFD166';
export const WHITE = '#FFFFFF';

export interface TextPreset {
  id: string;
  label: string;
  text: string;
  duration: number;
  x: number;
  y: number;
  anim: TextAnim;
  style: TextStyle;
}

const outlined = (font: TextStyle['font'], size: number, strokeWidth: number): TextStyle => ({
  font,
  size,
  color: WHITE,
  strokeColor: NAVY,
  strokeWidth,
  background: null,
  align: 'center',
  highlight: '',
  highlightColor: BUTTER,
  highlightDigits: false,
  tracking: 0,
  shadow: 0,
});

/** Title type (decided 2026-10-03): white letters on a soft navy shadow, no outline. Switch color to NAVY on bright screens. */
const title = (font: TextStyle['font'], size: number, tracking: number): TextStyle => ({
  ...outlined(font, size, 0),
  tracking,
  shadow: 0.9,
});

const badge: TextStyle = {
  font: 'bold',
  size: 36,
  color: WHITE,
  strokeColor: NAVY,
  strokeWidth: 0,
  background: NAVY,
  align: 'left',
  highlight: '',
  highlightColor: BUTTER,
  highlightDigits: true,
  tracking: 0,
  shadow: 0,
};

export const PRESETS: TextPreset[] = [
  { id: 'hook-num', label: '훅 숫자', text: 'D-{D}', duration: 3, x: 0.5, y: 0.2, anim: 'pop', style: title('semibold', 180, -0.02) },
  { id: 'hook', label: '훅', text: '판돈 한 문장', duration: 3, x: 0.5, y: 0.32, anim: 'pop', style: title('serif', 88, -0.04) },
  { id: 'sub', label: '자막', text: '자막', duration: 2.5, x: 0.5, y: 0.6, anim: 'none', style: outlined('black', 68, 5) },
  { id: 'aside', label: '딴지', text: '(딴지)', duration: 2, x: 0.5, y: 0.68, anim: 'fade', style: outlined('medium', 54, 4) },
  { id: 'badge-dday', label: '배지 D-day', text: '복학까지 D-{D}', duration: 3, x: 0.06, y: 0.162, anim: 'none', style: badge },
  { id: 'badge-salary', label: '배지 월급', text: '이번 달 월급 {월급}원 / {목표}원', duration: 3, x: 0.06, y: 0.2, anim: 'none', style: badge },
];

export function presetById(id: string): TextPreset {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown preset: ${id}`);
  return p;
}

export function makeTextClip(preset: TextPreset, id: string, start: number, overrides: Partial<TextClip> = {}): TextClip {
  return {
    id,
    start,
    in: 0,
    out: preset.duration,
    text: preset.text,
    preset: preset.id,
    style: { ...preset.style },
    x: preset.x,
    y: preset.y,
    anim: preset.anim,
    ...overrides,
  };
}
