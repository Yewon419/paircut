import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { Download, FilePlus, FolderOpen, Moon, Save, Sun } from 'lucide-react';
import type { Project } from '../shared/project';
import { emptyProject } from '../shared/project';
import { copySelection, cutSelection, pasteAttributes, pasteClipboard } from './clipboard';
import { startAgentBridge } from './components/AgentPanel';
import { ExportDialog } from './components/ExportDialog';
import { Home } from './components/Home';
import { Inspector } from './components/Inspector';
import { SidePanel } from './components/SidePanel';
import { textImagesFor } from './exportTexts';
import type { OpenedProject } from '../shared/api';
import { saveThumb } from './projectThumb';
import type { Theme } from './theme';
import { applyTheme, initialTheme, saveTheme } from './theme';
import { Preview } from './components/Preview';
import { Timeline } from './components/Timeline';
import { compositor, pause, seek, startPausedSync, togglePlay } from './engine/player';
import {
  deleteSelected,
  duplicateSelected,
  freezeFrame,
  loadProject,
  redo,
  splitAtPlayhead,
  toggleMarker,
  trimAtPlayhead,
  undo,
  useEditor,
} from './store';

async function saveProject(saveAs: boolean): Promise<void> {
  const { project, filePath } = useEditor.getState();
  const path = await window.api.saveProject(project, saveAs ? null : filePath);
  if (!path) return;
  useEditor.setState({ filePath: path, dirty: false });
  await saveThumb(path);
}

const TIMELINE_KEY = 'paircut.timelineHeight';
const TIMELINE_DEFAULT = 300;
const TIMELINE_MIN = 120;

function clampTimeline(h: number): number {
  return Math.round(Math.max(TIMELINE_MIN, Math.min(window.innerHeight - 260, h)));
}

function storedTimelineHeight(): number {
  const n = Number(localStorage.getItem(TIMELINE_KEY));
  return Number.isFinite(n) && n > 0 ? clampTimeline(n) : TIMELINE_DEFAULT;
}

const COLUMN_KEYS = { left: 'paircut.leftWidth', right: 'paircut.rightWidth' } as const;
const COLUMN_DEFAULT = 300;
const COLUMN_MIN = 220;

function clampColumn(w: number): number {
  return Math.round(Math.max(COLUMN_MIN, Math.min(window.innerWidth * 0.4, w)));
}

function storedColumn(side: keyof typeof COLUMN_KEYS): number {
  const n = Number(localStorage.getItem(COLUMN_KEYS[side]));
  return Number.isFinite(n) && n > 0 ? clampColumn(n) : COLUMN_DEFAULT;
}

function confirmDiscard(): boolean {
  return !useEditor.getState().dirty || window.confirm('저장하지 않은 변경이 있어요. 버릴까요?');
}

export function App() {
  const filePath = useEditor((s) => s.filePath);
  const dirty = useEditor((s) => s.dirty);
  const screen = useEditor((s) => s.screen);
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [big, setBig] = useState(false);
  const [timelineHeight, setTimelineHeight] = useState(storedTimelineHeight);
  const [leftWidth, setLeftWidth] = useState(() => storedColumn('left'));
  const [rightWidth, setRightWidth] = useState(() => storedColumn('right'));
  const [theme, setTheme] = useState<Theme>(initialTheme);

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    saveTheme(next);
    setTheme(next);
  };

  const dragColumn = (side: keyof typeof COLUMN_KEYS) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = side === 'left' ? leftWidth : rightWidth;
    const set = side === 'left' ? setLeftWidth : setRightWidth;
    let w = w0;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - x0;
      w = clampColumn(side === 'left' ? w0 + dx : w0 - dx);
      set(w);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      localStorage.setItem(COLUMN_KEYS[side], String(w));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const resetColumn = (side: keyof typeof COLUMN_KEYS) => () => {
    (side === 'left' ? setLeftWidth : setRightWidth)(COLUMN_DEFAULT);
    localStorage.setItem(COLUMN_KEYS[side], String(COLUMN_DEFAULT));
  };

  const dragSplitter = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const h0 = timelineHeight;
    let h = h0;
    const move = (ev: PointerEvent) => {
      h = clampTimeline(h0 - (ev.clientY - y0));
      setTimelineHeight(h);
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      localStorage.setItem(TIMELINE_KEY, String(h));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const resetSplitter = () => {
    setTimelineHeight(TIMELINE_DEFAULT);
    localStorage.setItem(TIMELINE_KEY, String(TIMELINE_DEFAULT));
  };

  useEffect(() => startPausedSync(), []);
  useEffect(() => startAgentBridge(), []);

  useEffect(() => {
    void window.api.isTest().then((isTest) => {
      if (!isTest) return;
      useEditor.setState({ screen: 'editor' });
      (window as unknown as { __paircut: object }).__paircut = {
        load: (p: Project) => loadProject(p, null),
        home: () => useEditor.setState({ screen: 'home' }),
        seek: (t: number) => {
          pause();
          seek(t);
        },
        state: () => useEditor.getState(),
        texts: (height: number) => textImagesFor(useEditor.getState().project, height),
        audio: (clipId: string) => compositor.audioState(clipId),
      };
    });
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select')) return;
      if (useEditor.getState().screen === 'home') return;
      if (e.code === 'Escape') {
        setBig(false);
        return;
      }
      const { project, playhead } = useEditor.getState();
      const frame = 1 / project.fps;
      const ctrl = e.ctrlKey || e.metaKey;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (ctrl && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (ctrl && e.code === 'KeyY') {
        e.preventDefault();
        redo();
      } else if (ctrl && e.code === 'KeyC') {
        copySelection();
      } else if (ctrl && e.code === 'KeyX') {
        cutSelection();
      } else if (ctrl && e.altKey && e.code === 'KeyV') {
        e.preventDefault();
        pasteAttributes();
      } else if (ctrl && e.code === 'KeyV') {
        e.preventDefault();
        pasteClipboard();
      } else if (ctrl && e.code === 'KeyS') {
        e.preventDefault();
        void saveProject(e.shiftKey);
      } else if (ctrl && e.code === 'KeyD') {
        e.preventDefault();
        duplicateSelected();
      } else if (!ctrl && e.code === 'KeyS') {
        splitAtPlayhead();
      } else if (!ctrl && e.code === 'KeyQ') {
        trimAtPlayhead('right');
      } else if (!ctrl && e.code === 'KeyW') {
        trimAtPlayhead('left');
      } else if (!ctrl && e.code === 'KeyM') {
        toggleMarker();
      } else if (!ctrl && e.code === 'KeyF') {
        freezeFrame().catch((err: unknown) => setNotice(`정지 화면을 만들지 못했어요: ${(err as Error).message}`));
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        deleteSelected();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        seek(playhead - (e.shiftKey ? 1 : frame));
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        seek(playhead + (e.shiftKey ? 1 : frame));
      } else if (e.code === 'Home') {
        seek(0);
      } else if (e.code === 'End') {
        seek(Number.POSITIVE_INFINITY);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const newProject = () => {
    if (!confirmDiscard()) return;
    pause();
    loadProject(emptyProject(), null);
  };

  const showOpened = (opened: OpenedProject) => {
    loadProject(opened.project, opened.path);
    setNotice(opened.missing.length > 0 ? `찾을 수 없는 파일 ${opened.missing.length}개: ${opened.missing.join(', ')}` : null);
  };

  const openProject = async () => {
    if (!confirmDiscard()) return;
    pause();
    try {
      const opened = await window.api.openProject();
      if (opened) showOpened(opened);
    } catch (err) {
      setNotice(`프로젝트를 열지 못했어요: ${(err as Error).message}`);
    }
  };

  const openPath = async (path: string) => {
    if (!confirmDiscard()) return;
    pause();
    try {
      showOpened(await window.api.openProjectFile(path));
    } catch (err) {
      setNotice(`프로젝트를 열지 못했어요: ${(err as Error).message}`);
    }
  };

  const goHome = () => {
    if (!confirmDiscard()) return;
    pause();
    setNotice(null);
    setBig(false);
    useEditor.setState({ screen: 'home' });
  };

  const title = filePath ? filePath.split(/[\\/]/).pop() : '새 프로젝트';

  const layout = {
    '--tl-h': `${timelineHeight}px`,
    '--left-w': `${leftWidth}px`,
    '--right-w': `${rightWidth}px`,
  } as CSSProperties;

  return (
    <div className={big ? 'app big' : 'app'} style={layout}>
      <header className="topbar">
        <button className="brand" onClick={goHome} title="시작 화면으로" data-testid="go-home">
          <svg className="brand-mark" viewBox="150 150 724 724" aria-hidden="true">
            <path d="M494 172 A320 320 0 0 0 494 812 Z" fill="#f0585c" />
            <path d="M530 212 A320 320 0 0 1 530 852 Z" fill="#4b3ff0" />
          </svg>
          paircut.
        </button>
        <div className="doc-title" title={filePath ?? undefined}>
          {title}
          {dirty && <span className="dirty"> · 저장 안 됨</span>}
        </div>
        <nav className="file-actions">
          <button className="ghost" onClick={newProject} title="새 프로젝트">
            <FilePlus />
            새로 만들기
          </button>
          <button className="ghost" onClick={() => void openProject()} title="프로젝트 열기">
            <FolderOpen />
            열기
          </button>
          <button className="ghost" onClick={() => void saveProject(false)} title="저장 (Ctrl+S)">
            <Save />
            저장
          </button>
          <button className="ghost" onClick={() => void saveProject(true)} title="다른 이름으로 저장 (Ctrl+Shift+S)">
            다른 이름으로
          </button>
        </nav>
        <button
          className="icon theme-toggle"
          data-testid="theme-toggle"
          onClick={toggleTheme}
          title={theme === 'dark' ? '라이트 모드로' : '다크 모드로'}
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </button>
        <button className="primary" onClick={() => setExportOpen(true)}>
          <Download />
          내보내기
        </button>
      </header>
      {notice && (
        <div className="notice" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
      <main className="workspace">
        <SidePanel />
        <div className="col-splitter" onPointerDown={dragColumn('left')} onDoubleClick={resetColumn('left')} title="끌어서 너비 조절, 두 번 누르면 원래대로" />
        <Preview big={big} onToggleBig={() => setBig(!big)} />
        <div className="col-splitter" onPointerDown={dragColumn('right')} onDoubleClick={resetColumn('right')} title="끌어서 너비 조절, 두 번 누르면 원래대로" />
        <Inspector />
      </main>
      <div className="tl-splitter" onPointerDown={dragSplitter} onDoubleClick={resetSplitter} title="끌어서 타임라인 높이 조절, 두 번 누르면 원래대로" />
      <Timeline />
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
      {screen === 'home' && (
        <Home
          theme={theme}
          notice={notice}
          onToggleTheme={toggleTheme}
          onDismissNotice={() => setNotice(null)}
          onNew={newProject}
          onOpenDialog={() => void openProject()}
          onOpenPath={(path) => void openPath(path)}
        />
      )}
    </div>
  );
}
