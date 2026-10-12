import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { validCustomFont } from '../../shared/project';
import { fontInstalled } from '../engine/text';

export interface FontItem {
  value: string;
  label: string;
  /** CSS font-family list; empty draws in the UI font. */
  family: string;
  weight: number;
  /** Extra search words, e.g. the family name in Korean. */
  tags: string;
}

const POPUP_W = 280;
const POPUP_H = 340;
const SAMPLE_MAX = 18;
const FALLBACK_SAMPLE = '가나다 Abc 123';

function squash(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '');
}

function sampleOf(text: string): string {
  const line = text.split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
  if (!line) return FALLBACK_SAMPLE;
  return line.length > SAMPLE_MAX ? `${line.slice(0, SAMPLE_MAX)}…` : line;
}

function faceStyle(item: { family: string; weight: number }): React.CSSProperties {
  return item.family ? { fontFamily: item.family, fontWeight: item.weight } : {};
}

/**
 * Font dropdown with a search box; every row draws the sample text in its own font, so a font can
 * be judged before picking it. `onPcFont`, when given, also offers a typed name of a font installed
 * on this PC.
 */
export function FontPicker({
  items,
  value,
  current,
  sample,
  testId,
  onPick,
  onPcFont,
}: {
  items: FontItem[];
  value: string;
  /** What the closed button shows; defaults to the item matching `value`. */
  current?: FontItem;
  sample: string;
  testId: string;
  onPick: (value: string) => void;
  onPcFont?: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ left: 0, top: 0, width: POPUP_W });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = current ?? items.find((i) => i.value === value) ?? items[0];
  const text = sampleOf(sample);
  const q = squash(query);
  const matches = q ? items.filter((i) => squash(`${i.label} ${i.value} ${i.tags}`).includes(q)) : items;
  const pcName = query.trim();
  const pcOffer =
    onPcFont && pcName !== '' && validCustomFont(pcName) && fontInstalled(pcName) && !matches.some((m) => squash(m.label) === q)
      ? { value: `pc:${pcName}`, label: `이 PC의 ${pcName}`, family: `"${pcName}"`, weight: 400, tags: '' }
      : null;
  const rows = pcOffer ? [...matches, pcOffer] : matches;

  const close = () => {
    setOpen(false);
    setQuery('');
  };

  const pick = (row: FontItem) => {
    if (pcOffer && row === pcOffer) onPcFont?.(pcName);
    else onPick(row.value);
    close();
    buttonRef.current?.focus();
  };

  const toggle = () => {
    if (open) return close();
    const r = buttonRef.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(r.width, POPUP_W);
    const left = Math.min(r.left, window.innerWidth - width - 8);
    const below = window.innerHeight - r.bottom > POPUP_H + 8;
    setPos({ left: Math.max(8, left), top: below ? r.bottom + 4 : Math.max(8, r.top - POPUP_H - 4), width });
    setActive(Math.max(0, items.findIndex((i) => i.value === value)));
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const outside = (e: Event) => {
      const t = e.target as Node;
      if (popupRef.current?.contains(t) || buttonRef.current?.contains(t)) return;
      close();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('scroll', outside, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('scroll', outside, true);
      window.removeEventListener('resize', close);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    listRef.current?.querySelector('.font-row.active')?.scrollIntoView({ block: 'nearest' });
  }, [open, active, query]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(rows.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      if (row) pick(row);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      buttonRef.current?.focus();
    }
  };

  return (
    <>
      <button ref={buttonRef} type="button" className="font-picker" data-testid={testId} onClick={toggle} title={shown.label}>
        <span style={faceStyle(shown)}>{shown.label}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          ref={popupRef}
          className="font-popup"
          style={{ left: pos.left, top: pos.top, width: pos.width, maxHeight: POPUP_H }}
          data-testid={`${testId}-popup`}
          onKeyDown={onKey}
        >
          <div className="font-search">
            <Search size={14} />
            <input
              type="text"
              autoFocus
              value={query}
              placeholder="글꼴 검색"
              data-testid={`${testId}-search`}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
            />
          </div>
          <div ref={listRef} className="font-list">
            {rows.map((row, i) => (
              <button
                key={row.value}
                type="button"
                className={`font-row${i === active ? ' active' : ''}${row.value === value ? ' on' : ''}`}
                data-testid={`${testId}-option`}
                data-value={row.value}
                onPointerEnter={() => setActive(i)}
                onClick={() => pick(row)}
              >
                <span className="font-sample" style={faceStyle(row)}>
                  {row.family ? text : row.label}
                </span>
                {row.family && <span className="font-label">{row.label}</span>}
              </button>
            ))}
            {rows.length === 0 && (
              <p className="font-empty">
                {onPcFont ? '맞는 글꼴이 없어요. PC에 설치된 폰트라면 이름을 정확히 적어요.' : '맞는 글꼴이 없어요.'}
              </p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
