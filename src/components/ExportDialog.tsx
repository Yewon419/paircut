import { useEffect, useState } from 'react';
import { projectDuration } from '../../shared/project';
import { pause } from '../engine/player';
import { textImagesFor } from '../exportTexts';
import { formatSeconds } from '../format';
import { useEditor } from '../store';

type Phase = { kind: 'idle' } | { kind: 'running'; ratio: number } | { kind: 'done'; outPath: string } | { kind: 'error'; message: string };

const HEIGHTS = [
  { height: 1920, label: '1080p (1080×1920)' },
  { height: 1280, label: '720p (720×1280)' },
];

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const [height, setHeight] = useState(1920);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const duration = projectDuration(project);

  useEffect(
    () =>
      window.api.onExportEvent((ev) => {
        if (ev.type === 'progress') setPhase({ kind: 'running', ratio: ev.ratio });
        else if (ev.type === 'done') setPhase({ kind: 'done', outPath: ev.outPath });
        else if (ev.type === 'error') setPhase({ kind: 'error', message: ev.message });
        else setPhase({ kind: 'idle' });
      }),
    [],
  );

  const start = async () => {
    pause();
    const outPath = await window.api.pickExportPath();
    if (!outPath) return;
    setPhase({ kind: 'running', ratio: 0 });
    try {
      const project = useEditor.getState().project;
      await window.api.startExport(project, { outPath, height }, textImagesFor(project, height));
    } catch (err) {
      setPhase({ kind: 'error', message: (err as Error).message });
    }
  };

  const running = phase.kind === 'running';

  return (
    <div className="modal-backdrop" onPointerDown={() => !running && onClose()}>
      <div className="modal" onPointerDown={(e) => e.stopPropagation()}>
        <h2>내보내기</h2>
        {duration <= 0 ? (
          <p>타임라인이 비어 있어요.</p>
        ) : (
          <>
            <p className="dim">
              MP4 · H.264 · AAC · {project.fps}fps · {formatSeconds(duration)}
            </p>
            <div className="choices">
              {HEIGHTS.map((h) => (
                <label key={h.height} className={height === h.height ? 'choice on' : 'choice'}>
                  <input
                    type="radio"
                    name="height"
                    checked={height === h.height}
                    disabled={running}
                    onChange={() => setHeight(h.height)}
                  />
                  {h.label}
                </label>
              ))}
            </div>
            {phase.kind === 'running' && (
              <div className="progress">
                <div className="bar" style={{ width: `${Math.round(phase.ratio * 100)}%` }} />
                <span>{Math.round(phase.ratio * 100)}%</span>
              </div>
            )}
            {phase.kind === 'done' && (
              <p>
                저장했어요: <span className="path">{phase.outPath}</span>
              </p>
            )}
            {phase.kind === 'error' && <pre className="error">{phase.message}</pre>}
          </>
        )}
        <div className="modal-actions">
          {phase.kind === 'done' && (
            <button onClick={() => void window.api.showInFolder(phase.outPath)}>폴더 열기</button>
          )}
          {running ? (
            <button onClick={() => void window.api.cancelExport()}>취소</button>
          ) : (
            <button onClick={onClose}>닫기</button>
          )}
          {!running && duration > 0 && (
            <button className="primary" onClick={() => void start()}>
              {phase.kind === 'done' ? '다시 내보내기' : '내보내기'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
