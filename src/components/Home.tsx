import { useEffect, useState } from 'react';
import { FilePlus, FolderOpen, Moon, Sun, X } from 'lucide-react';
import type { RecentProject } from '../../shared/api';
import type { Theme } from '../theme';

interface HomeProps {
  theme: Theme;
  notice: string | null;
  onToggleTheme: () => void;
  onDismissNotice: () => void;
  onNew: () => void;
  onOpenDialog: () => void;
  onOpenPath: (path: string) => void;
}

function fileName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  return base.replace(/\.json$/i, '').replace(/\.paircut$/i, '');
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function aspectLabel(w: number, h: number): string {
  const d = gcd(w, h);
  return `${w / d}:${h / d}`;
}

function durationLabel(seconds: number): string {
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function whenLabel(ms: number): string {
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 7) return days === 1 ? '어제' : `${days}일 전`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return sameYear ? `${d.getMonth() + 1}월 ${d.getDate()}일` : `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일`;
}

function metaLabel(item: RecentProject): string {
  if (item.status === 'missing') return '파일 없음';
  if (item.status === 'unreadable') return '열 수 없는 파일';
  const parts: string[] = [];
  if (item.modifiedAt !== null) parts.push(whenLabel(item.modifiedAt));
  if (item.duration !== null) parts.push(durationLabel(item.duration));
  if (item.width !== null && item.height !== null) parts.push(aspectLabel(item.width, item.height));
  return parts.join(' · ');
}

function RecentCard({ item, onOpen, onForget }: { item: RecentProject; onOpen: () => void; onForget: () => void }) {
  const thumb = item.thumbPath === null ? null : `${window.api.mediaUrl(item.thumbPath)}?v=${item.thumbAt ?? 0}`;
  return (
    <li className={`recent-card ${item.status}`} data-testid="recent-card">
      <button className="recent-open" onClick={onOpen} disabled={item.status !== 'ok'} title={item.problem ?? item.path}>
        <div className="recent-thumb">
          {thumb ? (
            <img src={thumb} alt="" draggable={false} />
          ) : (
            <div className="recent-blank">
              미리보기 없음
            </div>
          )}
        </div>
        <div className="recent-name">{fileName(item.path)}</div>
        <div className="recent-meta">{metaLabel(item)}</div>
      </button>
      <button className="icon recent-forget" onClick={onForget} title="목록에서 빼기 (파일은 그대로 둬요)" data-testid="recent-forget">
        <X />
      </button>
    </li>
  );
}

/** Start screen: new, open, and the recently opened or saved projects as picture cards. */
export function Home({ theme, notice, onToggleTheme, onDismissNotice, onNew, onOpenDialog, onOpenPath }: HomeProps) {
  const [items, setItems] = useState<RecentProject[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = () => {
    window.api
      .listRecentProjects()
      .then((list) => {
        setItems(list);
        setError(null);
      })
      .catch((err: unknown) => setError(`최근 프로젝트 목록을 읽지 못했어요: ${(err as Error).message}`));
  };

  useEffect(reload, []);

  const forget = (path: string) => {
    window.api
      .forgetRecentProject(path)
      .then(reload)
      .catch((err: unknown) => setError(`목록에서 빼지 못했어요: ${(err as Error).message}`));
  };

  return (
    <div className="home" data-testid="home">
      <header className="topbar">
        <div className="brand" title="paircut">
          <svg className="brand-mark" viewBox="150 150 724 724" aria-hidden="true">
            <path d="M494 172 A320 320 0 0 0 494 812 Z" fill="#f0585c" />
            <path d="M530 212 A320 320 0 0 1 530 852 Z" fill="#4b3ff0" />
          </svg>
          paircut.
        </div>
        <nav className="file-actions">
          <button className="ghost" onClick={onOpenDialog} title="프로젝트 파일 열기">
            <FolderOpen />
            파일 열기
          </button>
        </nav>
        <button className="icon theme-toggle" onClick={onToggleTheme} title={theme === 'dark' ? '라이트 모드로' : '다크 모드로'}>
          {theme === 'dark' ? <Sun /> : <Moon />}
        </button>
        <button className="primary" onClick={onNew} data-testid="home-new">
          <FilePlus />새 프로젝트
        </button>
      </header>
      {(notice ?? error) && (
        <div
          className="notice"
          onClick={() => {
            onDismissNotice();
            setError(null);
          }}
        >
          {notice ?? error}
        </div>
      )}
      <main className="home-body">
        <h2 className="home-heading">
          최근 프로젝트
          {items && items.length > 0 && <span className="dim">{items.length}</span>}
        </h2>
        {items && items.length === 0 && <p className="home-empty dim">아직 열거나 저장한 프로젝트가 없어요. 새 프로젝트를 만들거나 파일을 열어 주세요.</p>}
        {items && items.length > 0 && (
          <ul className="recent-grid">
            {items.map((item) => (
              <RecentCard key={item.path} item={item} onOpen={() => onOpenPath(item.path)} onForget={() => forget(item.path)} />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
