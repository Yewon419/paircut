import { useMemo, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Bot, Clapperboard, Folder, ListChecks, Type } from 'lucide-react';
import type { Board } from '../conti';
import { draftFromRows, parseBoard } from '../conti';
import type { TextPreset } from '../presets';
import { makeTextClip, presetById } from '../presets';
import { allTemplates, deleteTemplate, restoreBuiltinTemplates, saveTemplate, useTemplates } from '../textTemplates';
import { parseSrt, toSrt } from '../srt';
import { isTextClip, textClips } from '../../shared/project';
import { addTextClip, addTextTracks, frameSnap, uid, useEditor } from '../store';
import { AgentPanel } from './AgentPanel';
import { MediaBin } from './MediaBin';
import { pause, seek } from '../engine/player';
import { formatTime } from '../format';
import type { RuleIssue } from '../rules';
import { checkRules } from '../rules';

type Tab = 'media' | 'text' | 'conti' | 'check' | 'claude';

const TABS: { id: Tab; label: string; icon: LucideIcon }[] = [
  { id: 'media', label: '미디어', icon: Folder },
  { id: 'text', label: '텍스트', icon: Type },
  { id: 'conti', label: '콘티', icon: Clapperboard },
  { id: 'check', label: '점검', icon: ListChecks },
  { id: 'claude', label: 'Claude', icon: Bot },
];

export const DEFAULT_BOARD_PATH = 'C:\\Users\\windg\\Desktop\\PROJECT\\윈드가든인스타\\board\\board.json';
export const BOARD_KEY = 'cutdesk.boardPath';

export function SidePanel() {
  const [tab, setTab] = useState<Tab>('media');
  const project = useEditor((s) => s.project);
  const issues = useMemo(() => checkRules(project), [project]);
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
            {t.id === 'check' && issues.length > 0 && <span className="count bad">{issues.length}</span>}
          </button>
        ))}
      </div>
      <div className="side-body">
        {tab === 'media' && <MediaBin />}
        {tab === 'text' && <TextTab />}
        {tab === 'conti' && <ContiTab />}
        {tab === 'check' && <CheckTab issues={issues} />}
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
      const sub = presetById('sub');
      const cues = parseSrt(file.content);
      if (cues.length === 0) throw new Error(`자막이 없어요: ${file.path}`);
      addTextTracks([cues.map((c) => makeTextClip(sub, uid('c'), c.start, { text: c.text, out: c.end - c.start }))]);
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
      await window.api.saveTextFile(toSrt(clips, project.vars), 'captions.srt', ['srt']);
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

function ContiTab() {
  const [path, setPath] = useState(() => localStorage.getItem(BOARD_KEY) ?? DEFAULT_BOARD_PATH);
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = async (p: string) => {
    setError(null);
    setDone(null);
    try {
      const parsed = parseBoard(JSON.parse(await window.api.readTextFile(p)));
      localStorage.setItem(BOARD_KEY, p);
      setPath(p);
      setBoard(parsed);
    } catch (err) {
      setBoard(null);
      setError(`${p}: ${(err as Error).message}`);
    }
  };

  const pick = async () => {
    const file = await window.api.openTextFile(['json'], path);
    if (file) await load(file.path);
  };

  const importPost = (id: string) => {
    if (!board) return;
    const post = board.posts.find((p) => p.id === id);
    if (!post) return;
    const draft = draftFromRows(post.rows, () => uid('c'));
    addTextTracks([draft.mains, draft.asides], (p) => ({
      ...p,
      markers: draft.markers,
      vars: { ...board.vars, uploadDate: post.date || p.vars.uploadDate },
    }));
    setDone(`${post.title}: 자막 ${draft.mains.length}개, 딴지 ${draft.asides.length}개를 넣었어요.`);
  };

  const posts = board?.posts.filter((p) => p.rows.length > 0) ?? [];

  return (
    <section className="panel">
      <div className="panel-head">
        <span>운영 보드</span>
      </div>
      <div className="board-path">
        <input value={path} onChange={(e) => setPath(e.target.value)} title={path} />
        <button onClick={() => void pick()}>찾기</button>
        <button className="primary" onClick={() => void load(path)} data-testid="board-load">
          읽기
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {done && <p className="hint">{done}</p>}
      {board && posts.length === 0 && <div className="empty">콘티가 있는 게시물이 없어요.</div>}
      <ul className="post-list">
        {posts.map((p) => (
          <li key={p.id} className="post">
            <div className="post-meta">
              <div className="post-title">{p.title}</div>
              <div className="asset-sub">
                {p.date || '날짜 없음'} · {p.kind} · {p.rows.length}줄
              </div>
            </div>
            <button onClick={() => importPost(p.id)} data-post={p.id} title="자막·딴지 트랙과 컷 마커로 넣기">
              넣기
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function CheckTab({ issues }: { issues: RuleIssue[] }) {
  const fps = useEditor((s) => s.project.fps);
  const go = (issue: RuleIssue) => {
    pause();
    seek(issue.t);
    useEditor.setState({ selectedClipId: issue.clipId });
  };
  return (
    <section className="panel">
      <div className="panel-head">
        <span>콘티 규칙</span>
        <span className="dim">{issues.length === 0 ? '통과' : `${issues.length}건`}</span>
      </div>
      {issues.length === 0 ? (
        <div className="empty">걸리는 규칙이 없어요.</div>
      ) : (
        <ul className="issue-list">
          {issues.map((i) => (
            <li key={i.key}>
              <button className="issue" onClick={() => go(i)} data-rule={i.rule} data-issue-clip={i.clipId ?? ''}>
                <span className="issue-time">{formatTime(i.t, fps).replace(/\.\d+$/, '')}</span>
                <span className="issue-msg">{i.message}</span>
                <span className="issue-rule">{i.rule}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="hint">번호는 CONTI_RULES.md 절 번호예요. 누르면 그 위치로 가요.</p>
    </section>
  );
}
