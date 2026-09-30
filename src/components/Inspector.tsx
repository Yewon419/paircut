import type { Clip, ClipTransform, FontId, Project, TextAnim, TextClip, TextStyle } from '../../shared/project';
import {
  assetById,
  clipDuration,
  ddayOf,
  IDENTITY_TRANSFORM,
  isTextClip,
  projectDuration,
  resolveTokens,
} from '../../shared/project';
import { formatSeconds, formatTime } from '../format';
import { NAVY, PRESETS } from '../presets';
import {
  beginGesture,
  commit,
  endGesture,
  findClip,
  setVars,
  updateGesture,
  updateMediaClip,
  updateTextClip,
  useEditor,
} from '../store';

const FONTS: { id: FontId; label: string }[] = [
  { id: 'black', label: 'Black' },
  { id: 'bold', label: 'Bold' },
  { id: 'medium', label: 'Medium' },
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
            <span>굵기</span>
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
            <span>테두리</span>
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

function MediaPanel({ project, clip, visual }: { project: Project; clip: Clip; visual: boolean }) {
  const asset = assetById(project, clip.assetId);
  const id = clip.id;
  const t = clip.transform;

  const setTransformLive = (patch: Partial<ClipTransform>) =>
    updateGesture((base) => updateMediaClip(base, id, (c) => ({ ...c, transform: { ...c.transform, ...patch } })));
  const setTransform = (patch: Partial<ClipTransform>) =>
    commit((p) => updateMediaClip(p, id, (c) => ({ ...c, transform: { ...c.transform, ...patch } })));

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
    </aside>
  );
}
