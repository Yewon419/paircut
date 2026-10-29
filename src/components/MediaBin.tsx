import { useEffect, useRef, useState } from 'react';
import type { SfxEntry } from '../../shared/api';
import type { MediaAsset } from '../../shared/project';
import { formatSeconds } from '../format';
import { dismissImport, queueImports, useImports } from '../importQueue';
import type { ImportJob } from '../importQueue';
import { addAssets, addAssetToTimeline, assetUsage, deleteAsset, renameAsset, useEditor } from '../store';

export const ASSET_MIME = 'application/x-paircut-asset';

const KIND_LABEL: Record<MediaAsset['kind'], string> = { video: '영상', image: '사진', audio: '오디오' };
const MENU_W = 190;
const MENU_H = 120;

function jobLabel(job: ImportJob): string {
  if (job.stage === 'wait') return '대기';
  if (job.stage === 'probe') return '파일 확인 중';
  if (job.stage === 'thumb') return `썸네일 만드는 중 ${Math.round(job.ratio * 100)}%`;
  if (job.stage === 'wave') return '파형 만드는 중';
  return '실패';
}

function ImportRow({ job }: { job: ImportJob }) {
  const ratio = job.stage === 'thumb' ? job.ratio : 0;
  return (
    <li className={`import-job stage-${job.stage}`} data-testid="import-job" data-stage={job.stage} title={job.error ?? job.path}>
      <div className="import-head">
        <span className="asset-name">{job.name}</span>
        {job.stage === 'error' && (
          <button className="icon" title="닫기" onClick={() => dismissImport(job.id)}>
            ×
          </button>
        )}
      </div>
      <div className="import-sub">{jobLabel(job)}</div>
      {job.stage === 'error' ? (
        <div className="import-error">{job.error}</div>
      ) : (
        <div className="import-bar">
          <div style={{ width: `${ratio * 100}%` }} />
        </div>
      )}
    </li>
  );
}

interface AssetMenuProps {
  asset: MediaAsset;
  at: { x: number; y: number };
  close: () => void;
  rename: () => void;
}

/** Right-click menu of a media bin item: rename, or delete it along with the clips that use it. */
function AssetMenu({ asset, at, close, rename }: AssetMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const project = useEditor((s) => s.project);
  const usage = assetUsage(project, asset.id);
  useEffect(() => {
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', esc);
    };
  }, [close]);
  const style = {
    left: Math.min(at.x, window.innerWidth - MENU_W - 8),
    top: Math.min(at.y, window.innerHeight - MENU_H - 8),
  };
  const run = (action: () => void) => () => {
    action();
    close();
  };
  return (
    <div className="tl-menu" ref={ref} style={style} data-testid="asset-menu">
      <button onClick={run(rename)}>이름 바꾸기</button>
      <button className="danger" disabled={usage.locked > 0} onClick={run(() => deleteAsset(asset.id))}>
        삭제
      </button>
      {usage.locked > 0 ? (
        <div className="tl-menu-note">잠긴 레이어에서 쓰고 있어서 지울 수 없어요</div>
      ) : (
        usage.clips > 0 && <div className="tl-menu-note">타임라인 클립 {usage.clips}개도 같이 지워져요</div>
      )}
    </div>
  );
}

export function MediaBin() {
  const assets = useEditor((s) => s.project.assets);
  const jobs = useImports((s) => s.jobs);
  const [menu, setMenu] = useState<{ assetId: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameCancelled = useRef(false);
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

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
    queueImports(paths);
  };

  const menuAsset = menu ? assets.find((a) => a.id === menu.assetId) : undefined;

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
        <button onClick={() => void window.api.pickMedia().then(queueImports)}>가져오기</button>
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
      {jobs.length > 0 && (
        <ul className="import-list" data-testid="import-list">
          {jobs.map((j) => (
            <ImportRow key={j.id} job={j} />
          ))}
        </ul>
      )}
      {assets.length === 0 && jobs.length === 0 ? (
        <div className="empty">파일을 여기로 끌어오거나 가져오기를 누르세요</div>
      ) : (
        <ul className="asset-list">
          {assets.map((a) => (
            <li
              key={a.id}
              className={`asset${menu?.assetId === a.id ? ' open' : ''}`}
              data-testid="asset"
              draggable={renaming !== a.id}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ assetId: a.id, x: e.clientX, y: e.clientY });
              }}
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
                {renaming === a.id ? (
                  <input
                    className="asset-name-input"
                    data-testid="asset-rename"
                    autoFocus
                    defaultValue={a.name}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                      if (e.key === 'Escape') {
                        renameCancelled.current = true;
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={(e) => {
                      if (!renameCancelled.current) renameAsset(a.id, e.currentTarget.value);
                      renameCancelled.current = false;
                      setRenaming(null);
                    }}
                  />
                ) : (
                  <div className="asset-name">{a.name}</div>
                )}
                <div className="asset-sub">
                  {KIND_LABEL[a.kind]} · {formatSeconds(a.duration)}
                  {a.kind !== 'audio' ? ` · ${a.width}×${a.height}` : ''}
                </div>
              </div>
              <button className="icon" title="선택한 레이어의 재생 헤드에 추가 (레이어를 안 골랐으면 타임라인 끝)" onClick={() => addAssetToTimeline(a)}>
                +
              </button>
            </li>
          ))}
        </ul>
      )}
      {menuAsset && (
        <AssetMenu asset={menuAsset} at={menu ?? { x: 0, y: 0 }} close={() => setMenu(null)} rename={() => setRenaming(menuAsset.id)} />
      )}
    </section>
  );
}
