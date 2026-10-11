import { useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Bot, Folder, Type } from 'lucide-react';
import type { TextPreset } from '../presets';
import { BASIC_TEXT, makeTextClip } from '../presets';
import { allTemplates, deleteTemplate, restoreBuiltinTemplates, saveTemplate, useTemplates } from '../textTemplates';
import { parseSrt, toSrt } from '../srt';
import { isTextClip, textClips } from '../../shared/project';
import { addTextClip, addTextTracks, frameSnap, uid, useEditor } from '../store';
import { AgentPanel } from './AgentPanel';
import { MediaBin } from './MediaBin';

type Tab = 'media' | 'text' | 'claude';

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'media', label: '미디어', icon: Folder },
  { id: 'text', label: '텍스트', icon: Type },
  { id: 'claude', label: 'Claude', icon: Bot },
];

export function SidePanel() {
  const [tab, setTab] = useState<Tab>('media');
  return (
    <div className="side">
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'tab on' : 'tab'}
            onClick={() => setTab(t.id)}
            data-tab={t.id}
            title={t.label}
            aria-label={t.label}
          >
            <t.icon />
          </button>
        ))}
      </div>
      <div className="side-body">
        {tab === 'media' && <MediaBin />}
        {tab === 'text' && <TextTab />}
        {tab === 'claude' && <AgentPanel />}
      </div>
    </div>
  );
}

function TextTab() {
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const hidden = useTemplates((s) => s.hidden);
  useTemplates((s) => s.user);
  const selected = useEditor((s) =>
    s.project.tracks.flatMap((t) => t.clips).find((c) => c.id === s.selectedClipId && isTextClip(c)),
  );

  const add = (template: TextPreset) => {
    const { project, playhead } = useEditor.getState();
    addTextClip(makeTextClip(template, uid('c'), frameSnap(playhead, project.fps)));
  };

  const saveSelected = () => {
    setError(null);
    if (!selected || !isTextClip(selected)) return;
    try {
      saveTemplate(name.trim() || selected.text.slice(0, 12), selected);
      setName('');
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const importSrt = async () => {
    setError(null);
    try {
      const file = await window.api.openTextFile(['srt'], null);
      if (!file) return;
      const cues = parseSrt(file.content);
      if (cues.length === 0) throw new Error(`자막이 없어요: ${file.path}`);
      addTextTracks([cues.map((c) => makeTextClip(BASIC_TEXT, uid('c'), c.start, { text: c.text, out: c.end - c.start, y: 0.72 }))]);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const exportSrt = async () => {
    setError(null);
    const project = useEditor.getState().project;
    const clips = project.tracks.filter((t) => t.kind === 'text').flatMap(textClips);
    if (clips.length === 0) {
      setError('내보낼 텍스트가 없어요.');
      return;
    }
    try {
      await window.api.saveTextFile(toSrt(clips), 'captions.srt', ['srt']);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <span>템플릿</span>
        {hidden.length > 0 && (
          <button className="link" onClick={restoreBuiltinTemplates} data-testid="template-restore">
            기본 템플릿 되살리기
          </button>
        )}
      </div>
      <div className="preset-list">
        {allTemplates().map((p) => (
          <div key={p.id} className="preset-row">
            <button className="preset" onClick={() => add(p)} data-preset={p.id} data-template={p.label}>
              <span className="preset-name">{p.label}</span>
              <span className="preset-sample">{p.text}</span>
            </button>
            <button className="preset-x" onClick={() => deleteTemplate(p.id)} title="템플릿 삭제" data-delete-template={p.label}>
              ×
            </button>
          </div>
        ))}
      </div>
      <p className="hint">재생 헤드 위치에 추가돼요. 겹치면 위에 새 텍스트 트랙이 생겨요.</p>
      <div className="button-row">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && saveSelected()}
          placeholder={selected ? '템플릿 이름 (비우면 문구로)' : '타임라인에서 텍스트를 고르세요'}
          disabled={!selected}
          data-testid="template-name"
        />
        <button onClick={saveSelected} disabled={!selected} data-testid="template-save">
          템플릿으로 추가
        </button>
      </div>
      <div className="panel-head">
        <span>SRT</span>
      </div>
      <div className="button-row">
        <button onClick={() => void importSrt()}>가져오기</button>
        <button onClick={() => void exportSrt()}>내보내기</button>
      </div>
      {error && <div className="error">{error}</div>}
    </section>
  );
}
