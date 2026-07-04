'use client';

import { useEffect, useRef } from 'react';

export const BEAT_STRIP_HEIGHT = 22;
const BEATS_PER_BAR = 4;

/**
 * Beat grid strip: draws the BPM beat/bar count under the ruler when snap is on.
 * Beats fall at `offsetSec + n * (60 / bpm)`; downbeats (bar starts) are accented.
 * Uses the same time↔pixel mapping as the ruler: x = (sec - scrollSec) * pxPerSec.
 */
export default function BeatStrip({
  bpm,
  offsetSec,
  pxPerSec,
  scrollSec,
  viewportWidth,
  sidebarWidth,
}: {
  bpm: number;
  offsetSec: number;
  pxPerSec: number;
  scrollSec: number;
  viewportWidth: number;
  sidebarWidth: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || viewportWidth <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    const w = viewportWidth;
    const h = BEAT_STRIP_HEIGHT;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px ui-sans-serif, system-ui';
    ctx.textBaseline = 'middle';

    const beatSec = 60 / bpm;
    if (!(beatSec > 0)) return;
    const beatPx = beatSec * pxPerSec;
    const showBeatLabels = beatPx > 26; // avoid clutter when zoomed out
    const n0 = Math.floor((scrollSec - offsetSec) / beatSec);

    for (let n = n0; ; n++) {
      const t = offsetSec + n * beatSec;
      const x = (t - scrollSec) * pxPerSec;
      if (x > w) break;
      if (x < 0) continue;
      const isDownbeat = ((n % BEATS_PER_BAR) + BEATS_PER_BAR) % BEATS_PER_BAR === 0;
      ctx.strokeStyle = isDownbeat ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.14)';
      ctx.beginPath();
      ctx.moveTo(x + 0.5, isDownbeat ? 0 : 8);
      ctx.lineTo(x + 0.5, h);
      ctx.stroke();
      if (n < 0) continue; // count bars/beats only from the offset onward
      if (isDownbeat) {
        const bar = Math.floor(n / BEATS_PER_BAR) + 1;
        ctx.fillStyle = '#e6e9ef';
        ctx.fillText(String(bar), x + 3, h / 2);
      } else if (showBeatLabels) {
        const beat = (n % BEATS_PER_BAR) + 1;
        ctx.fillStyle = '#8b94a7';
        ctx.fillText(String(beat), x + 3, h / 2);
      }
    }
  }, [bpm, offsetSec, pxPerSec, scrollSec, viewportWidth]);

  return (
    <div className="beat-strip-row">
      <div className="beat-strip-gutter" style={{ width: sidebarWidth }}>
        beats
      </div>
      <canvas ref={canvasRef} className="beat-strip-canvas" style={{ width: viewportWidth, height: BEAT_STRIP_HEIGHT }} />
    </div>
  );
}
