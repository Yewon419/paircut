import { useRef, useState } from 'react';
import type { SfxEntry } from '../../shared/api';
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
  const [solid, setSolid] = useState('#000000');
  const [sfx, setSfx] = useState<SfxEntry[] | null>(null);
  const preview = useRef<HTMLAudioElement | null>(null);

  const toggleSfx = async () => {
    if (sfx) {
      setSfx(null);
      return;
    }
    setError(null);
    try {
      setSfx(await window.api.listSfx());
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const playSfx = (entry: SfxEntry) => {
    preview.current?.pause();
    const audio = new Audio(window.api.mediaUrl(entry.path));
    preview.current = audio;
    void audio.play();
  };

  const addSfx = async (entry: SfxEntry) => {
    if (useEditor.getState().project.assets.some((a) => a.path === entry.path)) return;
    setBusy(true);
    setError(null);
    try {
      addAssets(await window.api.probeMedia([entry.path]));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const addSolid = async () => {
    setBusy(true);
    setError(null);
    try {
      const { width, height } = useEditor.getState().project;
      addAssets([await window.api.makeSolid(solid, width, height)]);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
      <div className="solid-row">
        <input type="color" value={solid} data-testid="solid-color" onChange={(e) => setSolid(e.target.value)} title="단색 배경 색" />
        <button disabled={busy} data-testid="solid-add" onClick={() => void addSolid()}>
          단색 배경 추가
        </button>
        <button className={sfx ? 'on' : undefined} data-testid="sfx-toggle" onClick={() => void toggleSfx()}>
          효과음
        </button>
      </div>
      {sfx && (
        <ul className="sfx-list" data-testid="sfx-list">
          {sfx.flatMap((entry, i) => [
            ...(i === 0 || sfx[i - 1].group !== entry.group
              ? [
                  <li key={`g-${entry.group}`} className="sfx-group">
                    {entry.group}
                  </li>,
                ]
              : []),
            <li key={entry.path} className="sfx-item" title={entry.path}>
              <span className="sfx-name">{entry.name}</span>
              <button className="icon" title="미리 듣기" onClick={() => playSfx(entry)}>
                ▶
              </button>
              <button className="icon" title="미디어에 추가" disabled={busy} onClick={() => void addSfx(entry)}>
                +
              </button>
            </li>,
          ])}
        </ul>
      )}
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
