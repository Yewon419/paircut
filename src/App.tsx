import { useEffect, useState } from 'react';
import type { Project } from '../shared/project';
import { emptyProject } from '../shared/project';
import { startAgentBridge } from './components/AgentPanel';
import { ExportDialog } from './components/ExportDialog';
import { Inspector } from './components/Inspector';
import { SidePanel } from './components/SidePanel';
import { textImagesFor } from './exportTexts';
import { Preview } from './components/Preview';
import { Timeline } from './components/Timeline';
import { compositor, pause, seek, startPausedSync, togglePlay } from './engine/player';
import { deleteSelected, loadProject, redo, splitAtPlayhead, undo, useEditor } from './store';

async function saveProject(saveAs: boolean): Promise<void> {
  const { project, filePath } = useEditor.getState();
  const path = await window.api.saveProject(project, saveAs ? null : filePath);
  if (path) useEditor.setState({ filePath: path, dirty: false });
}

function confirmDiscard(): boolean {
  return !useEditor.getState().dirty || window.confirm('저장하지 않은 변경이 있어요. 버릴까요?');
}

export function App() {
  const filePath = useEditor((s) => s.filePath);
  const dirty = useEditor((s) => s.dirty);
  const [exportOpen, setExportOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => startPausedSync(), []);
  useEffect(() => startAgentBridge(), []);

  useEffect(() => {
    void window.api.isTest().then((isTest) => {
      if (!isTest) return;
      (window as unknown as { __cutdesk: object }).__cutdesk = {
        load: (p: Project) => loadProject(p, null),
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
      } else if (ctrl && e.code === 'KeyS') {
        e.preventDefault();
        void saveProject(e.shiftKey);
      } else if (!ctrl && e.code === 'KeyS') {
        splitAtPlayhead();
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

  const openProject = async () => {
    if (!confirmDiscard()) return;
    pause();
    try {
      const opened = await window.api.openProject();
      if (!opened) return;
      loadProject(opened.project, opened.path);
      setNotice(opened.missing.length > 0 ? `찾을 수 없는 파일 ${opened.missing.length}개: ${opened.missing.join(', ')}` : null);
    } catch (err) {
      setNotice(`프로젝트를 열지 못했어요: ${(err as Error).message}`);
    }
  };

  const title = filePath ? filePath.split(/[\\/]/).pop() : '새 프로젝트';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">cutdesk</div>
        <nav className="file-actions">
          <button onClick={newProject}>새로 만들기</button>
          <button onClick={() => void openProject()}>열기</button>
          <button onClick={() => void saveProject(false)}>저장</button>
          <button onClick={() => void saveProject(true)}>다른 이름으로</button>
        </nav>
        <div className="doc-title">
          {title}
          {dirty ? ' ·' : ''}
        </div>
        <button className="primary" onClick={() => setExportOpen(true)}>
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
        <Preview />
        <Inspector />
      </main>
      <Timeline />
      {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} />}
    </div>
  );
}
