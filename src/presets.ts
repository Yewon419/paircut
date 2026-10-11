import type { TextAnim, TextClip, TextSpan, TextStyle } from '../shared/project';

/** Plate color when a text background is first turned on. */
export const DEFAULT_BACKGROUND = '#000000';

export interface TextPreset {
  id: string;
  label: string;
  text: string;
  duration: number;
  x: number;
  y: number;
  anim: TextAnim;
  style: TextStyle;
  rotation: number;
  spans: TextSpan[];
}

/** The one built-in text: white, centered, no outline. Saved templates add the rest. */
export const BASIC_TEXT: TextPreset = {
  id: 'basic',
  label: '기본 텍스트',
  text: '텍스트',
  duration: 3,
  x: 0.5,
  y: 0.5,
  anim: 'none',
  rotation: 0,
  spans: [],
  style: {
    font: 'medium',
    size: 72,
    color: '#FFFFFF',
    strokeColor: '#000000',
    strokeWidth: 0,
    background: null,
    align: 'center',
    highlight: '',
    highlightColor: '#FFE066',
    highlightDigits: false,
    tracking: 0,
    shadow: 0,
    customFont: '',
    effect: 'none',
  },
};

export const PRESETS: TextPreset[] = [BASIC_TEXT];

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
    rotation: preset.rotation,
    spans: structuredClone(preset.spans),
    ...overrides,
  };
}
