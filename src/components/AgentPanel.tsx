import { useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import type { AgentEvent, AgentModel } from '../../shared/agentOps';
import { runAgentTool } from '../agentTools';

type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; detail: string }
  | { kind: 'error'; text: string }
  | { kind: 'done'; text: string };

const MODEL_KEY = 'paircut.agentModel';
const MODELS: { id: AgentModel; label: string }[] = [
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'opus', label: 'Opus' },
];

function savedModel(): AgentModel {
  const v = localStorage.getItem(MODEL_KEY);
  return MODELS.some((m) => m.id === v) ? (v as AgentModel) : 'sonnet';
}

/** Lives outside the panel so the conversation survives tab switches. */
const useChat = create(() => ({ entries: [] as Entry[], busy: false, model: savedModel() }));

const push = (e: Entry) => useChat.setState((s) => ({ entries: [...s.entries, e] }));

const k = (x: number): string => (x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(x));

function onEvent(event: AgentEvent): void {
  if (event.type === 'text') push({ kind: 'text', text: event.text });
  else if (event.type === 'tool') push({ kind: 'tool', name: event.name, detail: event.detail });
  else if (event.type === 'error') {
    push({ kind: 'error', text: event.message });
    useChat.setState({ busy: false });
  } else {
    const tokens = `입력 ${k(event.inputTokens)} · 캐시 ${k(event.cachedTokens)} · 출력 ${k(event.outputTokens)}`;
    push({ kind: 'done', text: `${event.seconds.toFixed(1)}초 · ${tokens}` });
    useChat.setState({ busy: false });
  }
}

/** Connects the main-process agent to this window: chat events in, tool calls served from the editor. */
export function startAgentBridge(): () => void {
  const offEvents = window.api.onAgentEvent(onEvent);
  const offCalls = window.api.onAgentCall(runAgentTool);
  return () => {
    offEvents();
    offCalls();
  };
}

async function send(text: string): Promise<void> {
  const prompt = text.trim();
  if (!prompt || useChat.getState().busy) return;
  push({ kind: 'user', text: prompt });
  useChat.setState({ busy: true });
  try {
    await window.api.agentAsk(prompt, useChat.getState().model);
  } catch (err) {
    onEvent({ type: 'error', message: (err as Error).message });
  }
}

export function AgentPanel() {
  const { entries, busy, model } = useChat();
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [entries]);

  const submit = () => {
    void send(draft);
    setDraft('');
  };

  const reset = () => {
    void window.api.agentReset();
    useChat.setState({ entries: [], busy: false });
  };

  const pickModel = (m: AgentModel) => {
    localStorage.setItem(MODEL_KEY, m);
    useChat.setState({ model: m });
  };

  return (
    <section className="panel agent">
      <div className="panel-head">
        <span>Claude</span>
        <select value={model} onChange={(e) => pickModel(e.target.value as AgentModel)} data-testid="agent-model">
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <button onClick={reset} disabled={entries.length === 0} data-testid="agent-reset">
          새 대화
        </button>
      </div>
      <div className="agent-log" ref={listRef} data-testid="agent-log">
        {entries.length === 0 && (
          <p className="hint">편집을 말로 시키면 Claude가 타임라인을 읽고 고쳐요. 한 번에 고친 건 Ctrl+Z 한 번으로 되돌아가요.</p>
        )}
        {entries.map((e, i) =>
          e.kind === 'tool' ? (
            <div key={i} className="agent-tool" title={e.detail}>
              {e.name}
              {e.detail && <span className="dim"> {e.detail}</span>}
            </div>
          ) : (
            <div key={i} className={`agent-msg ${e.kind}`} data-kind={e.kind}>
              {e.text}
            </div>
          ),
        )}
        {busy && <div className="agent-msg busy">작업 중…</div>}
      </div>
      <div className="agent-input">
        <textarea
          value={draft}
          rows={3}
          placeholder="예: 2초 넘는 컷마다 자막 달아줘"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          data-testid="agent-input"
        />
        {busy ? (
          <button onClick={() => void window.api.agentStop()} data-testid="agent-stop">
            멈추기
          </button>
        ) : (
          <button className="primary" onClick={submit} disabled={!draft.trim()} data-testid="agent-send">
            보내기
          </button>
        )}
      </div>
    </section>
  );
}
