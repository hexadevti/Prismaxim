'use client';

import { useEffect, useRef, useState } from 'react';
import { clipEnd, totalDuration, type EditorProject } from '@/lib/editor/model';

const HEIGHT = 44;
const ZOOM_MIN = 2;
const ZOOM_MAX = 400;
/** Grab tolerance (px) for the window's left/right resize edges. */
const EDGE = 8;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface OverviewProps {
  project: EditorProject;
  /** left edge of the visible window, in seconds. */
  scrollSec: number;
  /** width of the visible window, in seconds (viewportWidth / pxPerSec). */
  viewportSec: number;
  /** px width of the main timeline viewport, to convert a window width → zoom. */
  viewportWidth: number;
  onScroll: (sec: number) => void;
  onZoom: (pxPerSec: number) => void;
}

/**
 * A minimap of the whole project: the full arrangement drawn as a simplified
 * per-track waveform, with a highlighted window marking the currently-visible
 * range (its width reflects the zoom). Drag the window to pan; drag its edges to
 * zoom; click elsewhere to jump.
 */
export default function Overview({
  project,
  scrollSec,
  viewportSec,
  viewportWidth,
  onScroll,
  onZoom,
}: OverviewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(0);
  const duration = Math.max(totalDuration(project), 0.001);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // Draw the whole-project simplified overview (static; redraws on project/size).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || w === 0) return;
    const h = HEIGHT;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const oPx = w / duration;
    const rows = Math.max(project.tracks.length, 1);
    const rowH = h / rows;

    project.tracks.forEach((track, ti) => {
      const yTop = ti * rowH;
      const yMid = yTop + rowH / 2;
      const scale = (rowH - 2) / 2;

      // MIDI-only track: draw notes as small blocks.
      if (track.midi && track.clips.length === 0) {
        ctx.fillStyle = track.color;
        ctx.globalAlpha = 0.7;
        for (const n of track.midi) {
          ctx.fillRect(n.startSec * oPx, yTop + 1, Math.max(1, n.durationSec * oPx), rowH - 2);
        }
        ctx.globalAlpha = 1;
        return;
      }

      for (const clip of track.clips) {
        const x0 = clip.startSec * oPx;
        const clipW = Math.max(1, (clipEnd(clip) - clip.startSec) * oPx);
        // faint clip block for context
        ctx.fillStyle = track.color;
        ctx.globalAlpha = 0.12;
        ctx.fillRect(x0, yTop + 1, clipW, rowH - 2);
        // coarse peak waveform (channel 0, sampled cheaply — no shared peak cache)
        ctx.globalAlpha = 0.85;
        const ch = clip.buffer.getChannelData(0);
        const sr = clip.buffer.sampleRate;
        const startS = Math.floor(clip.offsetSec * sr);
        const buckets = Math.max(1, Math.floor(clipW));
        const per = (clip.durationSec * sr) / buckets;
        for (let b = 0; b < buckets; b++) {
          const s0 = startS + Math.floor(b * per);
          const s1 = Math.min(ch.length, startS + Math.floor((b + 1) * per));
          let peak = 0;
          const step = Math.max(1, Math.floor((s1 - s0) / 24));
          for (let i = s0; i < s1; i += step) {
            const v = Math.abs(ch[i] ?? 0);
            if (v > peak) peak = v;
          }
          const bh = Math.max(0.5, peak * scale * 2);
          ctx.fillRect(x0 + b, yMid - bh / 2, 1, bh);
        }
        ctx.globalAlpha = 1;
      }
    });
  }, [project, duration, w]);

  const widthPct = clamp((viewportSec / duration) * 100, 2, 100);
  const leftPct = clamp((scrollSec / duration) * 100, 0, 100 - widthPct);

  const onPointerDown = (e: React.PointerEvent) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const width = rect.width;
    if (width === 0) return;
    e.preventDefault();

    const xToSec = (clientX: number) => clamp(((clientX - rect.left) / width) * duration, 0, duration);
    const maxStart = Math.max(0, duration - viewportSec);
    const minViewSec = viewportWidth > 0 ? viewportWidth / ZOOM_MAX : viewportSec;
    const maxViewSec = viewportWidth > 0 ? viewportWidth / ZOOM_MIN : duration;

    const winLeftPx = (scrollSec / duration) * width;
    const winRightPx = ((scrollSec + viewportSec) / duration) * width;
    const x = e.clientX - rect.left;
    const canZoom = viewportWidth > 0;

    let mode: 'pan' | 'left' | 'right';
    let grabOffsetSec = 0;
    if (canZoom && Math.abs(x - winLeftPx) <= EDGE) {
      mode = 'left';
    } else if (canZoom && Math.abs(x - winRightPx) <= EDGE) {
      mode = 'right';
    } else if (x >= winLeftPx && x <= winRightPx) {
      mode = 'pan';
      grabOffsetSec = xToSec(e.clientX) - scrollSec;
    } else {
      // click outside the window → jump so it centers on the click, then pan
      onScroll(clamp(xToSec(e.clientX) - viewportSec / 2, 0, maxStart));
      mode = 'pan';
      grabOffsetSec = viewportSec / 2;
    }
    const rightFixedSec = scrollSec + viewportSec; // anchor for left-edge resize
    const leftFixedSec = scrollSec; // anchor for right-edge resize

    const onMove = (ev: PointerEvent) => {
      const sec = xToSec(ev.clientX);
      if (mode === 'pan') {
        onScroll(clamp(sec - grabOffsetSec, 0, maxStart));
      } else if (mode === 'right') {
        const vSec = clamp(sec - leftFixedSec, minViewSec, maxViewSec);
        onZoom(clamp(viewportWidth / vSec, ZOOM_MIN, ZOOM_MAX));
      } else {
        const newLeft = clamp(sec, 0, rightFixedSec - minViewSec);
        const vSec = clamp(rightFixedSec - newLeft, minViewSec, maxViewSec);
        onScroll(newLeft);
        onZoom(clamp(viewportWidth / vSec, ZOOM_MIN, ZOOM_MAX));
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  return (
    <div className="overview" ref={wrapRef} onPointerDown={onPointerDown} title="Overview — drag to pan, drag edges to zoom">
      <canvas ref={canvasRef} className="overview-canvas" style={{ width: '100%', height: HEIGHT }} />
      <div className="overview-window" style={{ left: `${leftPct}%`, width: `${widthPct}%` }}>
        <span className="overview-handle left" />
        <span className="overview-handle right" />
      </div>
    </div>
  );
}
