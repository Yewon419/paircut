import { useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { ChevronDown, ChevronRight, Folder, FolderPlus } from 'lucide-react';
import type { SfxEntry } from '../../shared/api';
import type { AssetFolder, BinTab, MediaAsset } from '../../shared/project';
import { binTabOf } from '../../shared/project';
import { formatSeconds } from '../format';
import { dismissImport, queueImports, useImports } from '../importQueue';
import type { ImportJob } from '../importQueue';
import {
  addAssets,
  addAssetsToTimeline,
  addFolder,
  assetUsage,
  deleteAssets,
  deleteFolder,
  folderAndInside,
  moveAssets,
  moveFolder,
  renameAsset,
  renameFolder,
  useEditor,
} from '../store';

export const ASSET_MIME = 'application/x-paircut-asset';
const FOLDER_MIME = 'application/x-paircut-folder';

const KIND_LABEL: Record<MediaAsset['kind'], string> = { video: '영상', image: '사진', audio: '오디오' };
const TABS: { id: BinTab; label: string }[] = [
  { id: 'visual', label: '영상·사진' },
  { id: 'audio', label: '오디오' },
];
const MENU_W = 190;
const MENU_H = 170;
/** Indent per folder level in the media bin, in pixels. */
const INDENT = 16;
const NO_FOLDERS: AssetFolder[] = [];

/** The folder's place from the top of its tab, like "인물 / 얼굴". */
function folderPath(folders: AssetFolder[], f: AssetFolder): string {
  const names = [f.name];
  for (let up = folders.find((x) => x.id === f.parent); up; up = folders.find((x) => x.id === up?.parent)) names.unshift(up.name);
  return names.join(' / ');
}

/** Closes a menu on a press outside it or on Escape. */
function useDismiss(ref: RefObject<HTMLDivElement | null>, close: () => void): void {
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
  }, [ref, close]);
}

function menuStyle(at: { x: number; y: number }): { left: number; top: number } {
  return { left: Math.min(at.x, window.innerWidth - MENU_W - 8), top: Math.min(at.y, window.innerHeight - MENU_H - 8) };
}

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
  /** The right-clicked item and the others selected with it. */
  group: string[];
  at: { x: number; y: number };
  close: () => void;
  rename: () => void;
}

/**
 * Right-click menu of a media bin item: rename, move to a folder, or delete it along with the clips that use it.
 * With several items selected, moving and deleting apply to all of them.
 */
function AssetMenu({ asset, group, at, close, rename }: AssetMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const project = useEditor((s) => s.project);
  const usage = group
    .map((id) => assetUsage(project, id))
    .reduce((sum, u) => ({ clips: sum.clips + u.clips, locked: sum.locked + u.locked }), { clips: 0, locked: 0 });
  useDismiss(ref, close);
  const folders = (project.folders ?? []).filter((f) => f.tab === binTabOf(asset.kind));
  const options = folders.map((f) => ({ id: f.id, path: folderPath(folders, f) })).sort((a, b) => a.path.localeCompare(b.path, 'ko'));
  const run = (action: () => void) => () => {
    action();
    close();
  };
  return (
    <div className="tl-menu" ref={ref} style={menuStyle(at)} data-testid="asset-menu">
      {group.length > 1 ? <div className="tl-menu-note">{group.length}개 선택됨</div> : <button onClick={run(rename)}>이름 바꾸기</button>}
      {options.length > 0 && (
        <label className="tl-menu-field">
          폴더
          <select
            value={folders.some((f) => f.id === asset.folder) ? asset.folder : ''}
            data-testid="asset-folder"
            onChange={(e) => {
              moveAssets(group, e.target.value || null);
              close();
            }}
          >
            <option value="">맨 위</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.path}
              </option>
            ))}
          </select>
        </label>
      )}
      <button className="danger" disabled={usage.locked > 0} onClick={run(() => deleteAssets(group))}>
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

interface FolderMenuProps {
  folder: AssetFolder;
  at: { x: number; y: number };
  close: () => void;
  addInside: () => void;
  rename: () => void;
}

/** Right-click menu of a folder. Deleting it keeps what was inside, one level up. */
function FolderMenu({ folder, at, close, addInside, rename }: FolderMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, close);
  const run = (action: () => void) => () => {
    action();
    close();
  };
  return (
    <div className="tl-menu" ref={ref} style={menuStyle(at)} data-testid="folder-menu">
      <button onClick={run(addInside)}>안에 새 폴더</button>
      <button onClick={run(rename)}>이름 바꾸기</button>
      <button className="danger" onClick={run(() => deleteFolder(folder.id))}>
        폴더 삭제
      </button>
      <div className="tl-menu-note">안에 있던 파일은 지워지지 않고 한 단계 위로 나와요</div>
    </div>
  );
}

/** The name field shown while renaming an asset or a folder: Enter keeps it, Escape takes it back. */
function NameInput({ value, testId, save, done }: { value: string; testId: string; save: (name: string) => void; done: () => void }) {
  const cancelled = useRef(false);
  return (
    <input
      className="asset-name-input"
      data-testid={testId}
      autoFocus
      defaultValue={value}
      onFocus={(e) => e.currentTarget.select()}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          cancelled.current = true;
          e.currentTarget.blur();
        }
      }}
      onBlur={(e) => {
        if (!cancelled.current) save(e.currentTarget.value);
        cancelled.current = false;
        done();
      }}
    />
  );
}

export function MediaBin() {
  const assets = useEditor((s) => s.project.assets);
  const folders = useEditor((s) => s.project.folders) ?? NO_FOLDERS;
  const project = useEditor((s) => s.project);
  const jobs = useImports((s) => s.jobs);
  const [tab, setTab] = useState<BinTab>('visual');
  const tabRef = useRef(tab);
  const [unseen, setUnseen] = useState<Record<BinTab, number>>({ visual: 0, audio: 0 });
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [folderMenu, setFolderMenu] = useState<{ folderId: string; x: number; y: number } | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ assetId: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [marquee, setMarquee] = useState<{ l: number; t: number; r: number; b: number } | null>(null);
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

  // New files that land in the other tab are counted on that tab until it is opened. Only edits count (they put the
  // previous project on the undo history); opening a project clears the history and adds no count.
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        if (s.project.assets === prev.project.assets || s.past.at(-1) !== prev.project) return;
        const old = new Set(prev.project.assets.map((a) => a.id));
        const added = s.project.assets.filter((a) => !old.has(a.id) && binTabOf(a.kind) !== tabRef.current);
        if (added.length > 0) {
          setUnseen((u) => ({ ...u, [binTabOf(added[0].kind)]: u[binTabOf(added[0].kind)] + added.length }));
        }
      }),
    [],
  );

  const openTab = (t: BinTab) => {
    tabRef.current = t;
    setTab(t);
    setPicked([]);
    setUnseen((u) => ({ ...u, [t]: 0 }));
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
    queueImports(paths);
  };

  const menuAsset = menu ? assets.find((a) => a.id === menu.assetId) : undefined;
  const menuFolder = folderMenu ? folders.find((f) => f.id === folderMenu.folderId) : undefined;
  const tabFolders = folders.filter((f) => f.tab === tab);
  const tabAssets = assets.filter((a) => binTabOf(a.kind) === tab);
  const folderIds = new Set(tabFolders.map((f) => f.id));
  const placeOf = (a: MediaAsset) => (a.folder && folderIds.has(a.folder) ? a.folder : null);
  const pickedHere = picked.filter((id) => tabAssets.some((a) => a.id === id));
  /** The item and, when it is one of several selected, the others with it, top to bottom as the bin lists them. */
  const groupOf = (a: MediaAsset, list: HTMLElement | null): string[] => {
    if (pickedHere.length < 2 || !pickedHere.includes(a.id) || !list) return [a.id];
    const shown = [...list.querySelectorAll<HTMLElement>('[data-asset]')].map((el) => el.dataset.asset ?? '');
    return shown.filter((id) => pickedHere.includes(id));
  };

  /**
   * Empty space in the list: a drag draws a box and selects every item it touches (Ctrl/Shift adds to the selection);
   * a press without a drag drops the selection.
   */
  const startMarquee = (e: React.PointerEvent<HTMLUListElement>) => {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const list = e.currentTarget;
    list.setPointerCapture(e.pointerId);
    const adding = e.ctrlKey || e.metaKey || e.shiftKey;
    const kept = adding ? pickedHere : [];
    const local = (ev: { clientX: number; clientY: number }) => {
      const box = list.getBoundingClientRect();
      return { x: ev.clientX - box.left + list.scrollLeft, y: ev.clientY - box.top + list.scrollTop };
    };
    const p0 = local(e);
    let dragged = false;
    const move = (ev: PointerEvent) => {
      const p1 = local(ev);
      if (!dragged && Math.hypot(p1.x - p0.x, p1.y - p0.y) < 3) return;
      dragged = true;
      const box = { l: Math.min(p0.x, p1.x), t: Math.min(p0.y, p1.y), r: Math.max(p0.x, p1.x), b: Math.max(p0.y, p1.y) };
      setMarquee(box);
      const hit = [...list.querySelectorAll<HTMLElement>('[data-asset]')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const tl = local({ clientX: r.left, clientY: r.top });
          return tl.x + r.width > box.l && tl.x < box.r && tl.y + r.height > box.t && tl.y < box.b;
        })
        .map((el) => el.dataset.asset ?? '');
      setPicked([...kept.filter((id) => !hit.includes(id)), ...hit]);
    };
    const up = () => {
      list.removeEventListener('pointermove', move);
      list.removeEventListener('pointerup', up);
      setMarquee(null);
      if (!dragged && !adding) setPicked([]);
    };
    list.addEventListener('pointermove', move);
    list.addEventListener('pointerup', up);
  };

  const newFolder = (parent: string | null) => {
    const id = addFolder(tab, parent);
    if (parent) setCollapsed((c) => new Set([...c].filter((x) => x !== parent)));
    setRenamingFolder(id);
  };

  const toggle = (id: string) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  /** Bin items dragged inside the bin move into a folder (or to the top); files from outside still import. */
  const acceptMove = (e: React.DragEvent, target: string) => {
    if (!e.dataTransfer.types.includes(ASSET_MIME) && !e.dataTransfer.types.includes(FOLDER_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    setDropOn(target);
  };

  const dropMove = (e: React.DragEvent, folderId: string | null) => {
    const assetId = e.dataTransfer.getData(ASSET_MIME);
    const movedFolder = e.dataTransfer.getData(FOLDER_MIME);
    if (!assetId && !movedFolder) return;
    e.preventDefault();
    e.stopPropagation();
    setDropOn(null);
    if (assetId) moveAssets(assetId.split('\n'), folderId);
    else moveFolder(movedFolder, folderId);
  };

  const assetRow = (a: MediaAsset, depth: number): ReactNode => (
    <li
      key={a.id}
      className={`asset${menu?.assetId === a.id ? ' open' : ''}${pickedHere.includes(a.id) ? ' picked' : ''}`}
      data-testid="asset"
      data-asset={a.id}
      style={{ paddingLeft: 6 + depth * INDENT }}
      draggable={renaming !== a.id}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ assetId: a.id, x: e.clientX, y: e.clientY });
      }}
      onClick={() => {
        if (!pickedHere.includes(a.id)) setPicked([]);
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData(ASSET_MIME, groupOf(a, e.currentTarget.parentElement).join('\n'));
        e.dataTransfer.effectAllowed = 'copyMove';
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
          <NameInput value={a.name} testId="asset-rename" save={(name) => renameAsset(a.id, name)} done={() => setRenaming(null)} />
        ) : (
          <div className="asset-name">{a.name}</div>
        )}
        <div className="asset-sub">
          {KIND_LABEL[a.kind]} · {formatSeconds(a.duration)}
          {a.kind !== 'audio' ? ` · ${a.width}×${a.height}` : ''}
        </div>
      </div>
      <button className="icon" title="선택한 레이어의 재생 헤드에 추가 (레이어를 안 골랐으면 타임라인 끝)" onClick={(e) => {
          const list = e.currentTarget.closest('ul');
          addAssetsToTimeline(groupOf(a, list).flatMap((id) => tabAssets.filter((x) => x.id === id)));
        }}
      >
        +
      </button>
    </li>
  );

  const folderRow = (f: AssetFolder, depth: number): ReactNode => {
    const inside = folderAndInside(project, f.id);
    const count = tabAssets.filter((a) => {
      const at = placeOf(a);
      return at !== null && inside.has(at);
    }).length;
    const open = !collapsed.has(f.id);
    return (
      <li
        key={f.id}
        className={`bin-folder${dropOn === f.id ? ' drop' : ''}${folderMenu?.folderId === f.id ? ' open' : ''}`}
        data-folder={f.id}
        style={{ paddingLeft: 6 + depth * INDENT }}
        draggable={renamingFolder !== f.id}
        onClick={() => toggle(f.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          setFolderMenu({ folderId: f.id, x: e.clientX, y: e.clientY });
        }}
        onDragStart={(e) => {
          e.stopPropagation();
          e.dataTransfer.setData(FOLDER_MIME, f.id);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => acceptMove(e, f.id)}
        onDragLeave={() => setDropOn((d) => (d === f.id ? null : d))}
        onDrop={(e) => dropMove(e, f.id)}
      >
        {open ? <ChevronDown className="bin-folder-chev" /> : <ChevronRight className="bin-folder-chev" />}
        <Folder className="bin-folder-icon" />
        {renamingFolder === f.id ? (
          <NameInput value={f.name} testId="folder-rename" save={(name) => renameFolder(f.id, name)} done={() => setRenamingFolder(null)} />
        ) : (
          <span className="bin-folder-name">{f.name}</span>
        )}
        <span className="bin-folder-count">{count}</span>
      </li>
    );
  };

  /** Folders first, then the files, each folder followed by what is in it unless it is folded. */
  const rows = (parent: string | null, depth: number): ReactNode[] => [
    ...tabFolders
      .filter((f) => f.parent === parent)
      .sort((a, b) => a.name.localeCompare(b.name, 'ko'))
      .flatMap((f) => [folderRow(f, depth), ...(collapsed.has(f.id) ? [] : rows(f.id, depth + 1))]),
    ...tabAssets.filter((a) => placeOf(a) === parent).map((a) => assetRow(a, depth)),
  ];

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
      <div className="bin-tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? 'bin-tab on' : 'bin-tab'}
            data-testid={`bin-tab-${t.id}`}
            onClick={() => openTab(t.id)}
          >
            {t.label}
            {unseen[t.id] > 0 && <span className="bin-tab-badge">{unseen[t.id]}</span>}
          </button>
        ))}
        <button className="icon" title="새 폴더" aria-label="새 폴더" data-testid="folder-new" onClick={() => newFolder(null)}>
          <FolderPlus />
        </button>
      </div>
      <div className="solid-row">
        {tab === 'visual' ? (
          <>
            <input type="color" value={solid} data-testid="solid-color" onChange={(e) => setSolid(e.target.value)} title="단색 배경 색" />
            <button disabled={busy} data-testid="solid-add" onClick={() => void addSolid()}>
              단색 배경 추가
            </button>
          </>
        ) : (
          <button className={sfx ? 'on' : undefined} data-testid="sfx-toggle" onClick={() => void toggleSfx()}>
            효과음
          </button>
        )}
      </div>
      {tab === 'audio' && sfx && (
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
      {tabAssets.length === 0 && tabFolders.length === 0 && jobs.length === 0 ? (
        <div className="empty">
          {tab === 'visual' ? '영상·사진 파일을 여기로 끌어오거나 가져오기를 누르세요' : '오디오 파일을 여기로 끌어오거나 가져오기를 누르세요'}
        </div>
      ) : (
        <ul
          className={`asset-list${dropOn === 'top' ? ' drop' : ''}`}
          onDragOver={(e) => acceptMove(e, 'top')}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropOn(null);
          }}
          onDrop={(e) => dropMove(e, null)}
          onPointerDown={startMarquee}
        >
          {rows(null, 0)}
          {marquee && (
            <li
              className="bin-marquee"
              aria-hidden
              style={{ left: marquee.l, top: marquee.t, width: marquee.r - marquee.l, height: marquee.b - marquee.t }}
            />
          )}
        </ul>
      )}
      {menuAsset && (
        <AssetMenu
          asset={menuAsset}
          group={pickedHere.length > 1 && pickedHere.includes(menuAsset.id) ? pickedHere : [menuAsset.id]}
          at={menu ?? { x: 0, y: 0 }}
          close={() => setMenu(null)}
          rename={() => setRenaming(menuAsset.id)}
        />
      )}
      {menuFolder && (
        <FolderMenu
          folder={menuFolder}
          at={folderMenu ?? { x: 0, y: 0 }}
          close={() => setFolderMenu(null)}
          addInside={() => newFolder(menuFolder.id)}
          rename={() => setRenamingFolder(menuFolder.id)}
        />
      )}
    </section>
  );
}
