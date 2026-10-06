import { useState } from 'react';
import type { ClipColor } from '../../shared/color';
import { NEUTRAL_COLOR } from '../../shared/color';
import type { Clip, ClipCrop, ClipTransform, FontId, Project, TextAnim, TextClip, TextEffect, TextSpan, TextStyle } from '../../shared/project';
import {
  assetById,
  clipDuration,
  CROP_MAX,
  ddayOf,
  DISSOLVE_MAX,
  effectiveDissolve,
  IDENTITY_TRANSFORM,
  isTextClip,
  NO_CROP,
  projectDuration,
  resolveTokens,
  SPEED_MAX,
  spanIndex,
  SPEED_MIN,
  validCustomFont,
  VOLUME_MAX,
} from '../../shared/project';
import type { AlignTo } from '../align';
import { alignShift, layerBox } from '../align';
import { allPresets, deletePreset, savePreset, usePresets } from '../colorPresets';
import { formatSeconds, formatTime } from '../format';
import { fontInstalled } from '../engine/text';
import { NAVY } from '../presets';
import { allTemplates, useTemplates } from '../textTemplates';
import {
  applyColorToAll,
  beginGesture,
  commit,
  endGesture,
  findClip,
  setClipSpeed,
  setVars,
  updateGesture,
  updateMediaClip,
  updateTextClip,
  useEditor,
  withSubjectLayer,
} from '../store';

const FONTS: { id: FontId; label: string }[] = [
  { id: 'black', label: 'Black' },
  { id: 'extrabold', label: 'ExtraBold' },
  { id: 'bold', label: 'Bold' },
  { id: 'semibold', label: 'SemiBold' },
  { id: 'medium', label: 'Medium' },
  { id: 'regular', label: 'Regular' },
  { id: 'light', label: 'Light' },
  { id: 'extralight', label: 'ExtraLight' },
  { id: 'thin', label: 'Thin' },
  { id: 'serif', label: '명조' },
  { id: 'pres-bold', label: '프레젠테이션' },
  { id: 'pres-black', label: '프레젠테이션 Black' },
  { id: 'hand', label: '손글씨' },
];

const PC_FONT = '__pc';

const ALIGNS: { to: AlignTo; label: string }[] = [
  { to: 'left', label: '왼쪽' },
  { to: 'hcenter', label: '가로 가운데' },
  { to: 'right', label: '오른쪽' },
  { to: 'top', label: '위' },
  { to: 'vcenter', label: '세로 가운데' },
  { to: 'bottom', label: '아래' },
];

/** Puts the layer against a frame edge or on a center line, by what it shows (a picture after its crop). */
function AlignButtons({ project, clip }: { project: Project; clip: Clip | TextClip }) {
  const align = (to: AlignTo) => {
    const box = layerBox(project, clip);
    if (!box) return;
    const { dx, dy } = alignShift(box, to);
    commit((p) =>
      isTextClip(clip)
        ? updateTextClip(p, clip.id, (c) => ({ ...c, x: c.x + dx, y: c.y + dy }))
        : updateMediaClip(p, clip.id, (c) => ({ ...c, transform: { ...c.transform, x: c.transform.x + dx, y: c.transform.y + dy } })),
    );
  };
  return (
    <div className="align-grid">
      {ALIGNS.map((a) => (
        <button key={a.to} data-align={a.to} onClick={() => align(a.to)}>
          {a.label}
        </button>
      ))}
    </div>
  );
}

const SPEEDS = [0.5, 1, 1.5, 2];
const DISSOLVES = [0, 0.3, 0.5, 1];

const COLOR_SLIDERS: { key: keyof ClipColor; label: string; min: number }[] = [
  { key: 'brightness', label: '밝기', min: -100 },
  { key: 'contrast', label: '대비', min: -100 },
  { key: 'saturation', label: '채도', min: -100 },
  { key: 'temperature', label: '색온도', min: -100 },
  { key: 'look', label: '빛뜰 톤', min: 0 },
];

const CROP_EDGES: { key: keyof ClipCrop; opposite: keyof ClipCrop; label: string }[] = [
  { key: 't', opposite: 'b', label: '위' },
  { key: 'b', opposite: 't', label: '아래' },
  { key: 'l', opposite: 'r', label: '왼쪽' },
  { key: 'r', opposite: 'l', label: '오른쪽' },
];

const ANIMS: { id: TextAnim; label: string }[] = [
  { id: 'none', label: '없음' },
  { id: 'pop', label: '팝' },
  { id: 'fade', label: '페이드' },
  { id: 'rise', label: '올라오기' },
  { id: 'type', label: '타자기' },
  { id: 'word', label: '단어씩' },
  { id: 'letters', label: '글자별 페이드' },
  { id: 'blur', label: '블러 인' },
  { id: 'track', label: '자간 좁히기' },
  { id: 'wipe', label: '와이프' },
];

const TEXT_EFFECTS: { id: TextEffect; label: string }[] = [
  { id: 'none', label: '없음' },
  { id: 'invert', label: '반전' },
  { id: 'mono', label: '흑백 창' },
  { id: 'frost', label: '유리 창' },
  { id: 'knockout', label: '뚫린 글자' },
  { id: 'glow', label: '글로우' },
  { id: 'chroma', label: '색수차' },
  { id: 'glitch', label: '글리치' },
];

/** Measured u2net speed on this machine's CPU (electron/matte.ts). */
const MATTE_SECONDS_PER_FRAME = 0.5;

export function Inspector() {
  const project = useEditor((s) => s.project);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const found = selectedClipId ? findClip(project, selectedClipId) : null;

  if (!found) return <ProjectPanel project={project} />;
  if (isTextClip(found.clip)) return <TextPanel key={found.clip.id} project={project} clip={found.clip} />;
  return <MediaPanel project={project} clip={found.clip} visual={found.track.kind === 'video'} />;
}

function ProjectPanel({ project }: { project: Project }) {
  const vars = project.vars;
  return (
    <aside className="panel inspector">
      <div className="panel-head">
        <span>프로젝트</span>
      </div>
      <dl className="props">
        <dt>크기</dt>
        <dd>
          {project.width}×{project.height} (9:16)
        </dd>
        <dt>프레임</dt>
        <dd>{project.fps}fps</dd>
        <dt>길이</dt>
        <dd>{formatSeconds(projectDuration(project))}</dd>
      </dl>
      <div className="panel-sub">배지 숫자</div>
      <div className="transform-controls">
        <div className="row">
          <label>
            <span>올리는 날</span>
            <input type="date" value={vars.uploadDate} onChange={(e) => setVars({ uploadDate: e.target.value })} />
          </label>
          <label>
            <span>복학일</span>
            <input type="date" value={vars.ddayTarget} onChange={(e) => setVars({ ddayTarget: e.target.value })} />
          </label>
        </div>
        <div className="row">
          <label>
            <span>이번 달 월급</span>
            <input type="number" min={0} step={100} value={vars.salary} onChange={(e) => setVars({ salary: Number(e.target.value) })} />
          </label>
          <label>
            <span>목표</span>
            <input type="number" min={0} step={100} value={vars.goal} onChange={(e) => setVars({ goal: Number(e.target.value) })} />
          </label>
        </div>
        <p className="hint" data-testid="dday">
          D-{ddayOf(vars)} · 자막에 {'{D}'} {'{월급}'} {'{목표}'}를 쓰면 이 값으로 바뀌어요.
        </p>
      </div>
    </aside>
  );
}

function PcFontInput({ style, onSet }: { style: TextStyle; onSet: (name: string) => void }) {
  const [draft, setDraft] = useState(style.customFont);
  const name = draft.trim();
  const ok = validCustomFont(name);
  const apply = () => {
    if (ok && name !== style.customFont) onSet(name);
  };
  const fallback = FONTS.find((f) => f.id === style.font)?.label ?? style.font;
  return (
    <label>
      <span>PC 설치 폰트 이름</span>
      <input
        type="text"
        value={draft}
        placeholder="예: a옛날사진관3"
        data-testid="pc-font"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={apply}
        onKeyDown={(e) => e.key === 'Enter' && apply()}
      />
      <span className="hint" data-testid="pc-font-status">
        {!ok
          ? '폰트 이름에 쓸 수 없는 문자가 있어요.'
          : !name
            ? 'Windows에 설치된 폰트 이름을 그대로 적어요.'
            : fontInstalled(name)
              ? '이 PC에 설치된 폰트예요. 앱에 포함되지 않아서 다른 PC에서는 보이지 않아요.'
              : `이 PC에서 찾을 수 없어서 ${fallback}(으)로 그려요.`}
      </span>
    </label>
  );
}

function TextPanel({ project, clip }: { project: Project; clip: TextClip }) {
  const id = clip.id;
  const style = clip.style;
  const live = (update: (c: TextClip) => TextClip) => updateGesture((base) => updateTextClip(base, id, update));
  const set = (update: (c: TextClip) => TextClip) => commit((p) => updateTextClip(p, id, update));
  const setStyle = (patch: Partial<TextStyle>) => set((c) => ({ ...c, style: { ...c.style, ...patch } }));
  const resolved = resolveTokens(clip.text, project.vars);
  const lines = resolved.split('\n');
  const longest = Math.max(...lines.map((l) => l.length));
  useTemplates((s) => s.user);
  const templates = allTemplates();
  const [pcMode, setPcMode] = useState(false);
  const pc = pcMode || style.customFont !== '';
  const [selection, setSelection] = useState({ start: 0, end: 0 });

  return (
    <aside className="panel inspector">
      <div className="panel-head">
        <span>텍스트</span>
        <span className="dim">
          {formatTime(clip.start, project.fps)} · {formatSeconds(clipDuration(clip))}
        </span>
      </div>
      <div className="transform-controls">
        <textarea
          className="text-input"
          rows={3}
          value={clip.text}
          data-testid="text-input"
          onFocus={beginGesture}
          onBlur={endGesture}
          onSelect={(e) => setSelection({ start: e.currentTarget.selectionStart, end: e.currentTarget.selectionEnd })}
          onChange={(e) => {
            const text = e.target.value;
            live((c) => ({ ...c, text }));
          }}
        />
        <p className="hint">
          {lines.length}줄 · 한 줄 최대 {longest}자{resolved !== clip.text ? ` · 미리보기: ${resolved}` : ''}
        </p>
        <label>
          <span>프리셋</span>
          <select
            value={clip.preset}
            onChange={(e) => {
              const p = templates.find((x) => x.id === e.target.value);
              if (p) set((c) => ({ ...c, preset: p.id, style: { ...p.style }, x: p.x, y: p.y, anim: p.anim }));
            }}
          >
            {templates.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            {!templates.some((p) => p.id === clip.preset) && <option value={clip.preset}>{clip.preset}</option>}
          </select>
        </label>
        <div className="row">
          <label>
            <span>글꼴</span>
            <select
              value={pc ? PC_FONT : style.font}
              data-testid="font-select"
              onChange={(e) => {
                if (e.target.value === PC_FONT) return setPcMode(true);
                setPcMode(false);
                setStyle({ font: e.target.value as FontId, customFont: '' });
              }}
            >
              {FONTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
              <option value={PC_FONT}>PC 설치 폰트...</option>
            </select>
          </label>
          <label>
            <span>크기</span>
            <input type="number" min={12} max={300} value={style.size} onChange={(e) => setStyle({ size: Number(e.target.value) })} />
          </label>
        </div>
        {pc && <PcFontInput key={id} style={style} onSet={(customFont) => setStyle({ customFont })} />}
        <div className="row">
          <label>
            <span>글자색</span>
            <input type="color" value={style.color} onChange={(e) => setStyle({ color: e.target.value })} />
          </label>
          <label>
            <span>테두리·그림자 색</span>
            <span className="inline">
              <input type="color" value={style.strokeColor} onChange={(e) => setStyle({ strokeColor: e.target.value })} />
              <input
                type="number"
                min={0}
                max={30}
                value={style.strokeWidth}
                onChange={(e) => setStyle({ strokeWidth: Number(e.target.value) })}
              />
            </span>
          </label>
        </div>
        <div className="row">
          <label>
            <span>자간(%)</span>
            <input
              type="number"
              min={-10}
              max={30}
              step={1}
              data-testid="text-tracking"
              value={Math.round(style.tracking * 100)}
              onChange={(e) => setStyle({ tracking: Number(e.target.value) / 100 })}
            />
          </label>
          <label>
            <span>그림자(%)</span>
            <input
              type="number"
              min={0}
              max={100}
              step={10}
              data-testid="text-shadow"
              value={Math.round(style.shadow * 100)}
              onChange={(e) => setStyle({ shadow: Number(e.target.value) / 100 })}
            />
          </label>
        </div>
        <label>
          <span>글자 효과</span>
          <select
            data-testid="text-effect"
            value={style.effect}
            onChange={(e) => setStyle({ effect: e.target.value as TextEffect })}
            title="반전·흑백 창·유리 창은 글자 아래 화면을 바꿔 그려요. 뚫린 글자는 글자색 판에서 글자 모양을 뚫어요. 사람·물체를 글자 앞에 두려면 영상 클립의 피사체를 새 레이어로 만든 뒤 그 레이어를 글자 레이어 위로 올려요"
          >
            {TEXT_EFFECTS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={style.background !== null}
            onChange={(e) => setStyle({ background: e.target.checked ? NAVY : null })}
          />
          <span>배경 상자</span>
          {style.background !== null && (
            <input type="color" value={style.background} onChange={(e) => setStyle({ background: e.target.value })} />
          )}
        </label>
        <div className="row">
          <label>
            <span>강조 단어</span>
            <input type="text" value={style.highlight} onChange={(e) => setStyle({ highlight: e.target.value })} />
          </label>
          <label>
            <span>강조색</span>
            <input type="color" value={style.highlightColor} onChange={(e) => setStyle({ highlightColor: e.target.value })} />
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={style.highlightDigits} onChange={(e) => setStyle({ highlightDigits: e.target.checked })} />
          <span>숫자 강조</span>
        </label>
        <div className="row">
          <label>
            <span>정렬</span>
            <select value={style.align} onChange={(e) => setStyle({ align: e.target.value as TextStyle['align'] })}>
              <option value="center">가운데</option>
              <option value="left">왼쪽</option>
            </select>
          </label>
          <label>
            <span>등장</span>
            <select value={clip.anim} onChange={(e) => set((c) => ({ ...c, anim: e.target.value as TextAnim }))}>
              {ANIMS.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="row">
          <label>
            <span>가로 %</span>
            <input
              type="number"
              step={0.5}
              value={Math.round(clip.x * 1000) / 10}
              onChange={(e) => set((c) => ({ ...c, x: Number(e.target.value) / 100 }))}
            />
          </label>
          <label>
            <span>세로 %</span>
            <input
              type="number"
              step={0.5}
              value={Math.round(clip.y * 1000) / 10}
              onChange={(e) => set((c) => ({ ...c, y: Number(e.target.value) / 100 }))}
            />
          </label>
        </div>
        <label>
          <span>회전(°)</span>
          <input
            type="number"
            min={-180}
            max={180}
            step={1}
            data-testid="text-rotation"
            value={clip.rotation}
            onChange={(e) => set((c) => ({ ...c, rotation: clampNum(e.target.value, -180, 180) }))}
          />
        </label>
        <AlignButtons project={project} clip={clip} />
        <p className="hint">미리보기에서 끌면 위치, 휠을 굴리면 글자 크기가 바뀌어요. 끌 때 화면·다른 레이어 선에 붙고, Alt를 누르면 안 붙어요.</p>
      </div>
      <SpanControls clip={clip} resolved={resolved} selection={selection} set={set} />
    </aside>
  );
}

function clampNum(v: string, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number(v)));
}

/** Occurrence number of the selected text among earlier matches, so the span sticks to that spot. */
function occurrenceAt(text: string, match: string, start: number): number {
  let nth = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(match, from);
    if (at === -1 || at >= start) return nth;
    nth++;
    from = at + match.length;
  }
}

/** Copy of the span with `key` set, or dropped when `value` is undefined. */
function withSpanValue<K extends keyof TextSpan>(sp: TextSpan, key: K, value: TextSpan[K] | undefined): TextSpan {
  const next = { ...sp };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function SpanControls({
  clip,
  resolved,
  selection,
  set,
}: {
  clip: TextClip;
  resolved: string;
  selection: { start: number; end: number };
  set: (update: (c: TextClip) => TextClip) => void;
}) {
  const picked = clip.text.slice(selection.start, selection.end);
  const hasToken = /[{}]/.test(picked);
  const usable = picked.trim() !== '' && !hasToken;
  const add = () => {
    if (!usable) return;
    const nth = occurrenceAt(clip.text, picked, selection.start);
    set((c) => (c.spans.some((sp) => sp.match === picked && sp.nth === nth) ? c : { ...c, spans: [...c.spans, { match: picked, nth }] }));
  };
  const update = (i: number, change: (sp: TextSpan) => TextSpan) =>
    set((c) => ({ ...c, spans: c.spans.map((sp, j) => (j === i ? change(sp) : sp)) }));
  const remove = (i: number) => set((c) => ({ ...c, spans: c.spans.filter((_, j) => j !== i) }));
  const short = picked.length > 12 ? `${picked.slice(0, 12)}…` : picked;

  return (
    <>
      <div className="panel-sub">부분 꾸미기</div>
      <div className="transform-controls">
        <button data-testid="span-add" disabled={!usable} onClick={add}>
          {usable ? `선택한 글자 꾸미기: ${short}` : '선택한 글자 꾸미기'}
        </button>
        <p className="hint">
          {hasToken
            ? '{D} 같은 자리표시는 꾸밀 수 없어요. 그 앞뒤 글자만 골라요.'
            : '위 글상자에서 글자를 끌어 고른 뒤 눌러요. 문장을 고쳐도 같은 글자를 따라가요.'}
        </p>
        {clip.spans.map((sp, i) => (
          <div key={`${sp.match}#${sp.nth}`} className="span-card" data-testid="span-row">
            <div className="span-head">
              <span>
                “{sp.match}”{sp.nth > 0 ? ` (${sp.nth + 1}번째)` : ''}
              </span>
              <button onClick={() => remove(i)} data-testid="span-remove">
                삭제
              </button>
            </div>
            {spanIndex(resolved, sp.match, sp.nth) === -1 && <p className="span-missing">문장에 이 글자가 없어서 지금은 안 보여요.</p>}
            <div className="row">
              <label>
                <span>두께·글꼴</span>
                <select
                  value={sp.font ?? ''}
                  data-testid="span-font"
                  onChange={(e) => update(i, (x) => withSpanValue(x, 'font', e.target.value ? (e.target.value as FontId) : undefined))}
                >
                  <option value="">자막과 같게</option>
                  {FONTS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>글자색</span>
                <span className="inline">
                  <input
                    type="checkbox"
                    checked={sp.color !== undefined}
                    data-testid="span-color-on"
                    onChange={(e) => update(i, (x) => withSpanValue(x, 'color', e.target.checked ? clip.style.highlightColor : undefined))}
                  />
                  {sp.color !== undefined && (
                    <input type="color" value={sp.color} data-testid="span-color" onChange={(e) => update(i, (x) => withSpanValue(x, 'color', e.target.value))} />
                  )}
                </span>
              </label>
            </div>
            <div className="row">
              <label>
                <span>크기(%)</span>
                <input
                  type="number"
                  min={20}
                  max={500}
                  step={5}
                  data-testid="span-scale"
                  value={Math.round((sp.scale ?? 1) * 100)}
                  onChange={(e) => update(i, (x) => withSpanValue(x, 'scale', clampNum(e.target.value, 20, 500) / 100))}
                />
              </label>
              <label>
                <span>회전(°)</span>
                <input
                  type="number"
                  min={-180}
                  max={180}
                  step={1}
                  data-testid="span-rotate"
                  value={sp.rotate ?? 0}
                  onChange={(e) => update(i, (x) => withSpanValue(x, 'rotate', clampNum(e.target.value, -180, 180)))}
                />
              </label>
            </div>
            <div className="row">
              <label>
                <span>가로 이동(px)</span>
                <input
                  type="number"
                  min={-1080}
                  max={1080}
                  step={2}
                  data-testid="span-dx"
                  value={sp.dx ?? 0}
                  onChange={(e) => update(i, (x) => withSpanValue(x, 'dx', clampNum(e.target.value, -1080, 1080)))}
                />
              </label>
              <label>
                <span>세로 이동(px)</span>
                <input
                  type="number"
                  min={-1920}
                  max={1920}
                  step={2}
                  data-testid="span-dy"
                  value={sp.dy ?? 0}
                  onChange={(e) => update(i, (x) => withSpanValue(x, 'dy', clampNum(e.target.value, -1920, 1920)))}
                />
              </label>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

/** Dissolve from the clip just before this one; it sits half before and half after the cut. */
function DissolveControls({ project, clip }: { project: Project; clip: Clip }) {
  const track = findClip(project, clip.id)?.track;
  if (!track) return null;
  const joined = effectiveDissolve(track, { ...clip, dissolve: DISSOLVE_MAX }) > 0;
  const used = effectiveDissolve(track, clip);
  const set = (v: number) => commit((p) => updateMediaClip(p, clip.id, (c) => ({ ...c, dissolve: v })));
  return (
    <div className="transform-controls">
      <span className="label">앞 클립에서 디졸브</span>
      <div className="button-row">
        {DISSOLVES.map((v) => (
          <button key={v} className={clip.dissolve === v ? 'on' : ''} disabled={!joined} onClick={() => set(v)} data-dissolve={v}>
            {v === 0 ? '없음' : `${v}초`}
          </button>
        ))}
      </div>
      <p className="hint">
        {!joined
          ? '바로 앞에 붙은 클립이 있어야 써요.'
          : used < clip.dissolve
            ? `클립이 짧아서 ${formatSeconds(used)}만 겹쳐요.`
            : '컷을 가운데 두고 앞뒤로 반씩 겹쳐요. 영상 길이와 자막 위치는 그대로예요.'}
      </p>
    </div>
  );
}

/** Recolors a one-color clip by pointing it at a solid asset of the new color (made once, then reused). */
function SolidColor({ project, clip, color }: { project: Project; clip: Clip; color: string }) {
  const [draft, setDraft] = useState(color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const apply = async () => {
    setBusy(true);
    setError(null);
    try {
      const made = await window.api.makeSolid(draft, project.width, project.height);
      commit((p) => {
        const known = p.assets.find((a) => a.path === made.path);
        const asset = known ?? made;
        const assets = known ? p.assets : [...p.assets, made];
        return updateMediaClip({ ...p, assets }, clip.id, (c) => ({ ...c, assetId: asset.id }));
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="transform-controls">
      <label>
        <span>단색</span>
        <span className="inline">
          <input type="color" value={draft} data-testid="solid-recolor" onChange={(e) => setDraft(e.target.value)} />
          <button disabled={busy || draft.toUpperCase() === color} data-testid="solid-apply" onClick={() => void apply()}>
            이 색으로 바꾸기
          </button>
        </span>
      </label>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** Cuts the clip's subject into a see-through copy on a new track above it (rembg, then VP9 with alpha). */
function SubjectLayer({ project, clip }: { project: Project; clip: Clip }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const asset = assetById(project, clip.assetId);
  const frames = asset.kind === 'image' ? 1 : Math.round((clip.out - clip.in) * project.fps) + 1;
  const cut = async () => {
    setError(null);
    setBusy('준비 중');
    const off = window.api.onMatteProgress((p) => {
      if (p.assetId === asset.id) setBusy(p.done === p.total ? '투명 영상 만드는 중' : `${p.done}/${p.total}`);
    });
    try {
      const from = asset.kind === 'image' ? 0 : clip.in;
      const to = asset.kind === 'image' ? 0 : Math.min(asset.duration, clip.out);
      const subject = await window.api.makeSubject(asset, from, to, project.fps);
      commit((p) => withSubjectLayer(p, clip.id, subject));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      off();
      setBusy(null);
    }
  };
  return (
    <div className="transform-controls">
      <button onClick={() => void cut()} disabled={busy !== null} data-testid="subject-layer">
        {busy ?? `피사체를 새 레이어로 (${frames}프레임, 약 ${Math.ceil(frames * MATTE_SECONDS_PER_FRAME)}초)`}
      </button>
      {error && <div className="error">{error}</div>}
      <p className="hint">사람·물체만 남긴 투명 영상을 바로 위 새 트랙에 올려요. 두 트랙 사이에 다른 그림을 넣을 수 있어요.</p>
    </div>
  );
}

function MediaPanel({ project, clip, visual }: { project: Project; clip: Clip; visual: boolean }) {
  const asset = assetById(project, clip.assetId);
  const id = clip.id;
  const t = clip.transform;

  const setTransformLive = (patch: Partial<ClipTransform>) =>
    updateGesture((base) => updateMediaClip(base, id, (c) => ({ ...c, transform: { ...c.transform, ...patch } })));
  const setTransform = (patch: Partial<ClipTransform>) =>
    commit((p) => updateMediaClip(p, id, (c) => ({ ...c, transform: { ...c.transform, ...patch } })));
  const hasAudio = asset.kind === 'audio' || (asset.kind === 'video' && asset.hasAudio);
  const dur = clipDuration(clip);
  const setFade = (key: 'fadeIn' | 'fadeOut', value: number) =>
    commit((p) =>
      updateMediaClip(p, id, (c) => ({ ...c, [key]: Math.max(0, Math.min(clipDuration(c), value || 0)) })),
    );

  return (
    <aside className="panel inspector">
      <div className="panel-head">
        <span>클립</span>
      </div>
      <dl className="props">
        <dt>파일</dt>
        <dd className="ellipsis" title={asset.path}>
          {asset.name}
        </dd>
        <dt>시작</dt>
        <dd>{formatTime(clip.start, project.fps)}</dd>
        <dt>길이</dt>
        <dd>{formatSeconds(clipDuration(clip))}</dd>
      </dl>
      {asset.solid !== undefined && <SolidColor key={asset.id} project={project} clip={clip} color={asset.solid} />}
      {visual && asset.solid === undefined && !asset.alpha && <SubjectLayer project={project} clip={clip} />}
      {asset.kind !== 'image' && (
        <div className="transform-controls">
          <label>
            <span>속도 {clip.speed.toFixed(2)}x</span>
            <input
              type="range"
              min={SPEED_MIN * 100}
              max={SPEED_MAX * 100}
              step={5}
              value={Math.round(clip.speed * 100)}
              onPointerDown={beginGesture}
              onPointerUp={endGesture}
              onChange={(e) => updateGesture((base) => setClipSpeed(base, id, Number(e.target.value) / 100))}
              data-testid="speed"
            />
          </label>
          <div className="button-row">
            {SPEEDS.map((v) => (
              <button
                key={v}
                className={clip.speed === v ? 'on' : ''}
                onClick={() => commit((p) => setClipSpeed(p, id, v))}
                data-speed={v}
              >
                {v}x
              </button>
            ))}
          </div>
          <p className="hint">길이가 바뀌면 같은 트랙 뒤 클립이 따라 움직여요. 소리는 음높이를 유지해요.</p>
        </div>
      )}
      {visual && <DissolveControls project={project} clip={clip} />}
      {hasAudio && (
        <div className="transform-controls">
          <label>
            <span>소리 {Math.round(clip.volume * 100)}%</span>
            <input
              type="range"
              min={0}
              max={VOLUME_MAX * 100}
              step={1}
              value={Math.round(clip.volume * 100)}
              onPointerDown={beginGesture}
              onPointerUp={endGesture}
              onChange={(e) =>
                updateGesture((base) => updateMediaClip(base, id, (c) => ({ ...c, volume: Number(e.target.value) / 100 })))
              }
              data-testid="volume"
            />
          </label>
          <div className="row">
            <label>
              <span>페이드 인 (초)</span>
              <input
                type="number"
                min={0}
                max={dur}
                step={0.1}
                value={clip.fadeIn}
                onChange={(e) => setFade('fadeIn', Number(e.target.value))}
                data-testid="fade-in"
              />
            </label>
            <label>
              <span>페이드 아웃 (초)</span>
              <input
                type="number"
                min={0}
                max={dur}
                step={0.1}
                value={clip.fadeOut}
                onChange={(e) => setFade('fadeOut', Number(e.target.value))}
                data-testid="fade-out"
              />
            </label>
          </div>
        </div>
      )}
      {visual && (
        <div className="transform-controls">
          <label>
            <span>확대 {Math.round(t.scale * 100)}%</span>
            <input
              type="range"
              min={10}
              max={400}
              step={1}
              value={Math.round(t.scale * 100)}
              onPointerDown={beginGesture}
              onPointerUp={endGesture}
              onChange={(e) => setTransformLive({ scale: Number(e.target.value) / 100 })}
            />
          </label>
          <div className="row">
            <label>
              <span>가로 위치</span>
              <input
                type="number"
                step={1}
                value={Math.round(t.x * 1000) / 10}
                onChange={(e) => setTransform({ x: Number(e.target.value) / 100 })}
              />
            </label>
            <label>
              <span>세로 위치</span>
              <input
                type="number"
                step={1}
                value={Math.round(t.y * 1000) / 10}
                onChange={(e) => setTransform({ y: Number(e.target.value) / 100 })}
              />
            </label>
          </div>
          <AlignButtons project={project} clip={clip} />
          <button onClick={() => setTransform({ ...IDENTITY_TRANSFORM })}>꽉 채우기로 되돌리기</button>
          <p className="hint">미리보기에서 끌면 위치, 휠을 굴리면 확대가 바뀌어요. 끌 때 화면·다른 레이어 선에 붙고, Alt를 누르면 안 붙어요.</p>
        </div>
      )}
      {visual && <CropControls clip={clip} />}
      {visual && <ColorControls clip={clip} />}
    </aside>
  );
}

function CropControls({ clip }: { clip: Clip }) {
  const id = clip.id;
  const setEdge = (key: keyof ClipCrop, opposite: keyof ClipCrop, percent: number) =>
    updateGesture((base) =>
      updateMediaClip(base, id, (c) => ({
        ...c,
        crop: { ...c.crop, [key]: Math.max(0, Math.min(percent / 100, CROP_MAX - c.crop[opposite])) },
      })),
    );
  return (
    <div className="transform-controls">
      {CROP_EDGES.map(({ key, opposite, label }) => (
        <label key={key}>
          <span>
            자르기 {label} {Math.round(clip.crop[key] * 100)}%
          </span>
          <input
            type="range"
            min={0}
            max={CROP_MAX * 100}
            step={1}
            value={Math.round(clip.crop[key] * 100)}
            onPointerDown={beginGesture}
            onPointerUp={endGesture}
            onChange={(e) => setEdge(key, opposite, Number(e.target.value))}
            data-testid={`crop-${key}`}
          />
        </label>
      ))}
      <button onClick={() => commit((p) => updateMediaClip(p, id, (c) => ({ ...c, crop: { ...NO_CROP } })))}>자르기 없애기</button>
      <p className="hint">잘린 자리는 아래 트랙이나 검은 배경이 보여요. 위치와 크기는 그대로예요.</p>
    </div>
  );
}

function ColorControls({ clip }: { clip: Clip }) {
  usePresets((s) => s.user);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const id = clip.id;
  const setColor = (color: ClipColor) => commit((p) => updateMediaClip(p, id, (c) => ({ ...c, color })));
  const save = () => {
    setError(null);
    try {
      savePreset(name, clip.color);
      setName('');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="transform-controls">
      <div className="panel-sub">색 보정</div>
      <div className="button-row wrap">
        {allPresets().map((p) => (
          <span key={p.id} className="chip">
            <button onClick={() => setColor(p.color)} data-color-preset={p.name}>
              {p.name}
            </button>
            {!p.builtin && (
              <button className="chip-x" onClick={() => deletePreset(p.id)} title="프리셋 삭제" data-delete-preset={p.name}>
                ×
              </button>
            )}
          </span>
        ))}
        <button onClick={() => setColor(NEUTRAL_COLOR)}>원래대로</button>
      </div>
      {COLOR_SLIDERS.map(({ key, label, min }) => (
        <label key={key}>
          <span>
            {label} {Math.round(clip.color[key] * 100)}
          </span>
          <input
            type="range"
            min={min}
            max={100}
            step={1}
            value={Math.round(clip.color[key] * 100)}
            onPointerDown={beginGesture}
            onPointerUp={endGesture}
            onChange={(e) =>
              updateGesture((base) =>
                updateMediaClip(base, id, (c) => ({ ...c, color: { ...c.color, [key]: Number(e.target.value) / 100 } })),
              )
            }
            data-color={key}
          />
        </label>
      ))}
      <div className="button-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && save()}
          placeholder="지금 값을 프리셋으로"
          data-testid="preset-name"
        />
        <button onClick={save} disabled={!name.trim()} data-testid="preset-save">
          저장
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      <button onClick={() => applyColorToAll(clip.color)} data-testid="color-all">
        모든 영상·사진 클립에 적용
      </button>
      <p className="hint">빛뜰 보정은 밝게, 대비는 부드럽게, 초록은 채도를 낮추고 파랑은 세룰리안으로 모아요(CHARACTER 2-1).</p>
    </div>
  );
}
