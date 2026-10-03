import { useState } from 'react';
import type { ClipColor } from '../../shared/color';
import { NEUTRAL_COLOR } from '../../shared/color';
import type { Clip, ClipCrop, ClipTransform, FontId, Project, TextAnim, TextClip, TextStyle } from '../../shared/project';
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
  SPEED_MIN,
  VOLUME_MAX,
} from '../../shared/project';
import { allPresets, deletePreset, savePreset, usePresets } from '../colorPresets';
import { formatSeconds, formatTime } from '../format';
import { NAVY, PRESETS } from '../presets';
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
} from '../store';

const FONTS: { id: FontId; label: string }[] = [
  { id: 'black', label: 'Black' },
  { id: 'bold', label: 'Bold' },
  { id: 'semibold', label: 'SemiBold' },
  { id: 'medium', label: 'Medium' },
  { id: 'serif', label: '명조' },
  { id: 'pres-bold', label: '프레젠테이션' },
  { id: 'pres-black', label: '프레젠테이션 Black' },
  { id: 'hand', label: '손글씨' },
];

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
];

export function Inspector() {
  const project = useEditor((s) => s.project);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const found = selectedClipId ? findClip(project, selectedClipId) : null;

  if (!found) return <ProjectPanel project={project} />;
  if (isTextClip(found.clip)) return <TextPanel project={project} clip={found.clip} />;
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

function TextPanel({ project, clip }: { project: Project; clip: TextClip }) {
  const id = clip.id;
  const style = clip.style;
  const live = (update: (c: TextClip) => TextClip) => updateGesture((base) => updateTextClip(base, id, update));
  const set = (update: (c: TextClip) => TextClip) => commit((p) => updateTextClip(p, id, update));
  const setStyle = (patch: Partial<TextStyle>) => set((c) => ({ ...c, style: { ...c.style, ...patch } }));
  const resolved = resolveTokens(clip.text, project.vars);
  const lines = resolved.split('\n');
  const longest = Math.max(...lines.map((l) => l.length));

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
              const p = PRESETS.find((x) => x.id === e.target.value);
              if (p) set((c) => ({ ...c, preset: p.id, style: { ...p.style }, x: p.x, y: p.y, anim: p.anim }));
            }}
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
            {!PRESETS.some((p) => p.id === clip.preset) && <option value={clip.preset}>{clip.preset}</option>}
          </select>
        </label>
        <div className="row">
          <label>
            <span>글꼴</span>
            <select value={style.font} onChange={(e) => setStyle({ font: e.target.value as FontId })}>
              {FONTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>크기</span>
            <input type="number" min={12} max={300} value={style.size} onChange={(e) => setStyle({ size: Number(e.target.value) })} />
          </label>
        </div>
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
        <p className="hint">미리보기에서 끌면 위치, 휠을 굴리면 글자 크기가 바뀌어요.</p>
      </div>
    </aside>
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
          <button onClick={() => setTransform({ ...IDENTITY_TRANSFORM })}>꽉 채우기로 되돌리기</button>
          <p className="hint">미리보기에서 끌면 위치, 휠을 굴리면 확대가 바뀌어요.</p>
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
