import type { ClipTransform } from '../../shared/project';
import { assetById, clipDuration, IDENTITY_TRANSFORM, projectDuration } from '../../shared/project';
import { formatSeconds, formatTime } from '../format';
import { beginGesture, commit, endGesture, findClip, updateClip, updateGesture, useEditor } from '../store';

export function Inspector() {
  const project = useEditor((s) => s.project);
  const selectedClipId = useEditor((s) => s.selectedClipId);
  const found = selectedClipId ? findClip(project, selectedClipId) : null;

  if (!found) {
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
        <p className="hint">클립을 선택하면 위치와 크기를 조절할 수 있어요. 가로 영상은 레터박스 없이 세로 화면을 꽉 채워요.</p>
      </aside>
    );
  }

  const { clip, track } = found;
  const asset = assetById(project, clip.assetId);
  const visual = track.kind === 'video';
  const id = clip.id;
  const t = clip.transform;

  const setTransformLive = (patch: Partial<ClipTransform>) =>
    updateGesture((base) => updateClip(base, id, (c) => ({ ...c, transform: { ...c.transform, ...patch } })));
  const setTransform = (patch: Partial<ClipTransform>) =>
    commit((p) => updateClip(p, id, (c) => ({ ...c, transform: { ...c.transform, ...patch } })));

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
