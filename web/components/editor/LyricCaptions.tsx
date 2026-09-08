'use client';

import { useEffect, useRef } from 'react';
import type { LyricSegment } from '@/lib/editor/lyrics';

/**
 * Video-style captions: the lyric line under the playhead, centered at the
 * bottom of the screen. Driven by a rAF loop reading `getCurrentSec` so it stays
 * in sync with playback (and scrubbing) without re-rendering React each frame —
 * the text/opacity are poked straight onto the DOM nodes.
 */
export default function LyricCaptions({
  lyrics,
  getCurrentSec,
  visible,
}: {
  lyrics: LyricSegment[];
  getCurrentSec: () => number;
  visible: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    const tick = () => {
      const now = getCurrentSec();
      // Lyrics are sorted by start; stop scanning once a segment starts after now.
      let active: LyricSegment | undefined;
      for (let i = 0; i < lyrics.length; i++) {
        const seg = lyrics[i]!;
        if (seg.startSec > now) break;
        if (now < seg.endSec) {
          active = seg;
          break;
        }
      }
      const box = boxRef.current;
      const txt = textRef.current;
      if (box && txt) {
        if (active) {
          if (txt.textContent !== active.text) txt.textContent = active.text;
          box.style.opacity = '1';
        } else {
          box.style.opacity = '0';
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lyrics, getCurrentSec, visible]);

  if (!visible) return null;
  return (
    <div
      ref={boxRef}
      aria-live="off"
      style={{
        position: 'fixed',
        left: '50%',
        bottom: '9%',
        transform: 'translateX(-50%)',
        maxWidth: '80vw',
        padding: '6px 16px',
        borderRadius: 8,
        background: 'rgba(0,0,0,0.72)',
        color: '#fff',
        fontSize: 22,
        fontWeight: 600,
        lineHeight: 1.3,
        textAlign: 'center',
        textShadow: '0 1px 2px rgba(0,0,0,0.85)',
        whiteSpace: 'pre-wrap',
        pointerEvents: 'none',
        opacity: 0,
        transition: 'opacity 0.12s ease',
        zIndex: 9999,
      }}
    >
      <span ref={textRef} />
    </div>
  );
}
