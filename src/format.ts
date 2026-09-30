export function formatTime(t: number, fps: number): string {
  const frames = Math.round(Math.max(0, t) * fps);
  const f = frames % fps;
  const totalSec = Math.floor(frames / fps);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
}

export function formatSeconds(t: number): string {
  return `${t.toFixed(1)}초`;
}
