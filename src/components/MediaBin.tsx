import { useState } from 'react';
import type { MediaAsset } from '../../shared/project';
import { formatSeconds } from '../format';
import { addAssets, appendToMain, useEditor } from '../store';

export const ASSET_MIME = 'application/x-cutdesk-asset';

const KIND_LABEL: Record<MediaAsset['kind'], string> = { video: '영상', image: '사진', audio: '오디오' };

export function MediaBin() {
  const assets = useEditor((s) => s.project.assets);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);

  const importPaths = async (paths: string[]) => {
    if (paths.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      addAssets(await window.api.probeMedia(paths));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
    void importPaths(paths);
  };

  return (
    <section
      className={`panel media-bin${dragOver ? ' drag-over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
    >
      <div className="panel-head">
        <span>미디어</span>
        <button disabled={busy} onClick={() => void window.api.pickMedia().then(importPaths)}>
          {busy ? '불러오는 중' : '가져오기'}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {assets.length === 0 ? (
        <div className="empty">파일을 여기로 끌어오거나 가져오기를 누르세요</div>
      ) : (
        <ul className="asset-list">
          {assets.map((a) => (
            <li
              key={a.id}
              className="asset"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(ASSET_MIME, a.id);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              title={a.path}
            >
              <div
                className={`asset-thumb kind-${a.kind}`}
                style={
                  a.thumbPath
                    ? { backgroundImage: `url("${window.api.mediaUrl(a.thumbPath)}")` }
                    : a.wavePath
                      ? { backgroundImage: `url("${window.api.mediaUrl(a.wavePath)}")` }
                      : undefined
                }
              />
              <div className="asset-meta">
                <div className="asset-name">{a.name}</div>
                <div className="asset-sub">
                  {KIND_LABEL[a.kind]} · {formatSeconds(a.duration)}
                  {a.kind !== 'audio' ? ` · ${a.width}×${a.height}` : ''}
                </div>
              </div>
              <button className="icon" title="타임라인 끝에 추가" onClick={() => appendToMain(a)}>
                +
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
