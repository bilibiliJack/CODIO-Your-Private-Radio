// Finite request lifecycle, independent of the animation/render clock.
export async function loadLyricsWithRetry(request: () => Promise<Array<{ time: number; text: string }>>, signal: AbortSignal,
  wait: (ms: number, signal: AbortSignal) => Promise<void> = (ms, signal) => new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, ms); signal.addEventListener("abort", finish, { once: true });
  })) {
  let attempts = 0;
  while (!signal.aborted && attempts < 3) {
    attempts++;
    try {
      const lines = (await request()).filter(line => line.text.trim() && Number.isFinite(line.time)).slice(0, 800);
      if (signal.aborted) return { status: "cancelled", lines: [], attempts };
      return { status: lines.length ? "ready" : "unavailable", lines, attempts };
    } catch {
      if (attempts < 3 && !signal.aborted) await wait(attempts * 750, signal);
    }
  }
  return { status: signal.aborted ? "cancelled" : "failed", lines: [], attempts };
}
