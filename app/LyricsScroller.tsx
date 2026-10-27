"use client";

import { memo, useCallback, useLayoutEffect, useRef } from "react";

type LyricLine = { time: number; text: string };

type Props = {
  lines: LyricLine[];
  activeIndex: number;
  variant: "feature" | "fullscreen";
  enabled: boolean;
  reducedMotion: boolean;
  trackKey: string;
};

function LyricsScroller({ lines, activeIndex, variant, enabled, reducedMotion, trackKey }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const activeIndexRef = useRef(0);
  const lastSizeRef = useRef({ width: 0, height: 0 });
  const wasEnabledRef = useRef(false);
  const previousIndexRef = useRef<number | null>(null);
  const previousTrackRef = useRef(trackKey);
  // Before the first timed cue there is no current lyric. Keep the first line
  // in view, but do not turn an intro into an early lyric activation.
  const safeIndex = Math.max(-1, Math.min(activeIndex, lines.length - 1));
  activeIndexRef.current = safeIndex;

  const positionActiveLine = useCallback((behavior: ScrollBehavior) => {
    const viewport = viewportRef.current;
    const track = trackRef.current;
    const activeLine = track?.children.item(Math.max(0, activeIndexRef.current) + 1) as HTMLElement | null;
    if (!viewport || !track || !activeLine) return;

    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    if (width !== lastSizeRef.current.width || height !== lastSizeRef.current.height) {
      track.style.setProperty("--lyric-spacer-height", `${height * .48}px`);
      lastSizeRef.current = { width, height };
    }
    viewport.scrollTo({
      top: Math.max(0, activeLine.offsetTop + activeLine.offsetHeight / 2 - height * .48),
      behavior,
    });
  }, []);

  useLayoutEffect(() => {
    if (!enabled || !lines.length) {
      wasEnabledRef.current = false;
      return;
    }
    const trackChanged = previousTrackRef.current !== trackKey;
    const jumped = previousIndexRef.current !== null && Math.abs(safeIndex - previousIndexRef.current) > 1;
    positionActiveLine(reducedMotion || !wasEnabledRef.current || trackChanged || jumped ? "auto" : "smooth");
    wasEnabledRef.current = true;
    previousIndexRef.current = safeIndex;
    previousTrackRef.current = trackKey;
  }, [enabled, lines, positionActiveLine, reducedMotion, safeIndex, trackKey]);

  useLayoutEffect(() => {
    if (!enabled || typeof ResizeObserver === "undefined") return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const observer = new ResizeObserver(() => {
      if (viewport.clientWidth !== lastSizeRef.current.width || viewport.clientHeight !== lastSizeRef.current.height) {
        positionActiveLine("auto");
      }
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [enabled, positionActiveLine]);

  if (!lines.length) return null;
  return (
    <div className={`codio-lyrics-scroller codio-lyrics-${variant}`} aria-live="polite">
      <div className="codio-lyric-viewport" ref={viewportRef}>
        <div className="codio-lyric-track" ref={trackRef}>
          <span className="codio-lyric-spacer" aria-hidden="true" />
          {lines.map((line, index) => {
            const distance = Math.abs(index - safeIndex);
            return (
              <div
                key={`${trackKey}-${line.time}-${index}`}
                data-lyric-time={line.time}
                className={`codio-lyric-line ${index === safeIndex ? "active" : distance === 1 ? "near" : distance === 2 ? "far" : "farthest"}`}
                aria-current={index === safeIndex ? "true" : undefined}
              >
                {line.text}
              </div>
            );
          })}
          <span className="codio-lyric-spacer" aria-hidden="true" />
        </div>
      </div>
    </div>
  );
}

export default memo(LyricsScroller, (previous, next) =>
  (previous.activeIndex === next.activeIndex || (!previous.enabled && !next.enabled)) &&
  previous.variant === next.variant &&
  previous.enabled === next.enabled &&
  previous.reducedMotion === next.reducedMotion &&
  previous.trackKey === next.trackKey &&
  (previous.lines === next.lines || (
    previous.lines.length === 1 && next.lines.length === 1 &&
    previous.lines[0].time === next.lines[0].time &&
    previous.lines[0].text === next.lines[0].text
  ))
);
