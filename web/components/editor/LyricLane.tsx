'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Captions, Trash2 } from 'lucide-react';
import type { LyricSegment } from '@/lib/editor/lyrics';

export const LYRIC_LANE_HEIGHT = 46;
const MIN_DUR = 0.2;

type DragMode = 'move' | 'resize-l' | 'resize-r';
interface Drag {
  index: number;
  mode: DragMode;
  startX: number;
  origStart: number;
  origEnd: number;
}

interface Menu {
  x: number;
  y: number;
}

/**
 * An editable lyrics/caption track. Each transcribed segment is a block you can
 * select (click, Ctrl-click, Shift-range), follow (it highlights under the
 * playhead), drag to retime, resize at either edge, edit the text (double-click),
 * and copy / paste / split / delete via keyboard (when focused) or the
 * right-click menu. Edits are lifted via `onChange`, so captions, playback and
 * .lrc/.srt export all reflect them. Segments stay sorted by start on commit.
 */
export default function LyricLane({
  lyrics,
  onChange,
  pxPerSec,
  scrollSec,
  viewportWidth,
  sidebarWidth,
  getCurrentSec,
  captionsOn,
  onToggleCaptions,
  onExport,
  onDelete,
  onSelect,
  audioSelected,
}: {
  lyrics: LyricSegment[];
  onChange: (next: LyricSegment[]) => void;
  pxPerSec: number;
  scrollSec: number;
  viewportWidth: number;
  sidebarWidth: number;
  getCurrentSec: () => number;
  captionsOn: boolean;
  onToggleCaptions: () => void;
  onExport: (fmt: 'lrc' | 'srt') => void;
  onDelete: () => void;
  /** Called when a lyric block is selected, so the editor can clear its audio (clip) selection. */
  onSelect: () => void;
  /** True while the editor has an audio clip/track/range selected; clears the lyric selection. */
  audioSelected: boolean;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [preview, setPreview] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const blockEls = useRef<Map<number, HTMLDivElement>>(new Map());
  const contentRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<LyricSegment[]>([]);
  const lyricsRef = useRef(lyrics);
  lyricsRef.current = lyrics;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  const secToX = (s: number) => (s - scrollSec) * pxPerSec;

  /** Sort + lift to the parent, then select the given segment objects by identity. */
  const commitSel = useCallback(
    (next: LyricSegment[], selectRefs: LyricSegment[] = []) => {
      const sorted = [...next].sort((a, b) => a.startSec - b.startSec);
      onChange(sorted);
      const idx = new Set<number>();
      for (const r of selectRefs) {
        const i = sorted.indexOf(r);
        if (i >= 0) idx.add(i);
      }
      setSelected(idx);
      setAnchor(null);
    },
    [onChange],
  );

  const selectedSegs = useCallback(
    () =>
      [...selectedRef.current]
        .sort((a, b) => a - b)
        .map((i) => lyricsRef.current[i])
        .filter((s): s is LyricSegment => !!s),
    [],
  );

  /* ---------------- edit operations ---------------- */

  const copySel = useCallback(() => {
    const segs = selectedSegs();
    if (segs.length) clipRef.current = segs.map((s) => ({ ...s }));
  }, [selectedSegs]);

  const paste = useCallback(() => {
    const clip = clipRef.current;
    if (!clip.length) return;
    const now = getCurrentSec();
    const s0 = Math.min(...clip.map((s) => s.startSec));
    const pasted = clip.map((s) => ({
      text: s.text,
      startSec: s.startSec - s0 + now,
      endSec: s.endSec - s0 + now,
    }));
    commitSel([...lyricsRef.current, ...pasted], pasted);
  }, [getCurrentSec, commitSel]);

  const deleteSel = useCallback(() => {
    const gone = new Set(selectedSegs());
    if (!gone.size) return;
    commitSel(
      lyricsRef.current.filter((s) => !gone.has(s)),
      [],
    );
  }, [selectedSegs, commitSel]);

  const splitSel = useCallback(() => {
    const now = getCurrentSec();
    const toSplit = selectedSegs().filter((s) => now > s.startSec + 0.02 && now < s.endSec - 0.02);
    if (!toSplit.length) return;
    const cut = new Set(toSplit);
    const next = lyricsRef.current.filter((s) => !cut.has(s));
    const halves: LyricSegment[] = [];
    for (const s of toSplit) {
      const ratio = (now - s.startSec) / (s.endSec - s.startSec);
      const words = s.text.split(/\s+/).filter(Boolean);
      const at = Math.max(1, Math.min(Math.max(1, words.length - 1), Math.round(words.length * ratio)));
      const a = { startSec: s.startSec, endSec: now, text: words.slice(0, at).join(' ') };
      const b = { startSec: now, endSec: s.endSec, text: words.slice(at).join(' ') };
      next.push(a, b);
      halves.push(a, b);
    }
    commitSel(next, halves);
  }, [getCurrentSec, selectedSegs, commitSel]);

  const canSplit = () => {
    const now = getCurrentSec();
    return selectedSegs().some((s) => now > s.startSec + 0.02 && now < s.endSec - 0.02);
  };

  /* ---------------- selection ---------------- */

  const selectOnly = (i: number) => {
    setSelected(new Set([i]));
    setAnchor(i);
  };
  const toggle = (i: number) => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
    setAnchor(i);
  };
  const rangeTo = (i: number) => {
    if (anchor === null) return selectOnly(i);
    const lo = Math.min(anchor, i);
    const hi = Math.max(anchor, i);
    const n = new Set<number>();
    for (let k = lo; k <= hi; k++) n.add(k);
    setSelected(n);
  };

  /* ---------------- live highlight of the segment under the playhead ---------------- */
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const now = getCurrentSec();
      blockEls.current.forEach((el, i) => {
        const seg = lyricsRef.current[i];
        el.classList.toggle('lyric-block-active', !!seg && now >= seg.startSec && now < seg.endSec);
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [getCurrentSec]);

  /* ---------------- drag / resize gesture ---------------- */
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => setPreview((e.clientX - drag.startX) / pxPerSec);
    const onUp = (e: PointerEvent) => {
      // A press without real movement (plain click / double-click) is not a drag.
      if (Math.abs(e.clientX - drag.startX) < 2) {
        setDrag(null);
        setPreview(0);
        return;
      }
      const dsec = (e.clientX - drag.startX) / pxPerSec;
      const next = lyricsRef.current.slice();
      const seg = { ...next[drag.index]! };
      if (drag.mode === 'move') {
        const start = Math.max(0, drag.origStart + dsec);
        seg.startSec = start;
        seg.endSec = start + (drag.origEnd - drag.origStart);
      } else if (drag.mode === 'resize-l') {
        seg.startSec = Math.min(drag.origEnd - MIN_DUR, Math.max(0, drag.origStart + dsec));
      } else {
        seg.endSec = Math.max(drag.origStart + MIN_DUR, drag.origEnd + dsec);
      }
      next[drag.index] = seg;
      setDrag(null);
      setPreview(0);
      commitSel(next, [seg]);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drag, pxPerSec, commitSel]);

  const startDrag = (e: React.PointerEvent, index: number, mode: DragMode) => {
    if (editing !== null) return;
    e.preventDefault();
    e.stopPropagation();
    const seg = lyrics[index]!;
    setPreview(0);
    setDrag({ index, mode, startX: e.clientX, origStart: seg.startSec, origEnd: seg.endSec });
  };

  const onBlockPointerDown = (e: React.PointerEvent, index: number) => {
    contentRef.current?.focus();
    onSelect(); // hand focus to the lyrics track: clear the editor's audio selection
    if (e.shiftKey) rangeTo(index);
    else if (e.ctrlKey || e.metaKey) toggle(index);
    else if (!selected.has(index)) selectOnly(index);
    startDrag(e, index, 'move');
  };

  const del = (e: React.MouseEvent, index: number) => {
    e.stopPropagation();
    commitSel(
      lyrics.filter((_, i) => i !== index),
      [],
    );
  };

  const saveEdit = (index: number, text: string) => {
    const trimmed = text.trim();
    setEditing(null);
    if (!trimmed) return; // empty text: keep the original line
    const next = lyrics.slice();
    next[index] = { ...next[index]!, text: trimmed };
    commitSel(next, [next[index]!]);
  };

  /* ---------------- keyboard (scoped to the focused lane) ---------------- */
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (editing !== null) return;
    const mod = e.ctrlKey || e.metaKey;
    const sel = selectedRef.current.size > 0;
    const clip = clipRef.current.length > 0;
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    // Only intercept (and shadow the editor's clip shortcut) when there is a
    // relevant action; otherwise let the key bubble to the editor.
    if (mod && e.key.toLowerCase() === 'c' && sel) {
      stop();
      copySel();
    } else if (mod && e.key.toLowerCase() === 'v' && clip) {
      stop();
      paste();
    } else if (mod && e.key.toLowerCase() === 'x' && sel) {
      stop();
      copySel();
      deleteSel();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) {
      stop();
      deleteSel();
    } else if (e.key.toLowerCase() === 's' && !mod && canSplit()) {
      stop();
      splitSel();
    } else if (e.key === 'Escape') {
      setSelected(new Set());
      setMenu(null);
    }
    // Unhandled keys (space, arrows, undo, …) bubble to the editor's shortcuts.
  };

  /* Mutual exclusivity: selecting an audio clip/track clears the lyric selection. */
  useEffect(() => {
    if (audioSelected) setSelected(new Set());
  }, [audioSelected]);

  /* Close the context menu on any outside pointer press. */
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  /** Preview-adjusted [start,end] for a block (applies the in-progress gesture). */
  const timesFor = useMemo(() => {
    return (i: number, seg: LyricSegment): [number, number] => {
      if (!drag || drag.index !== i) return [seg.startSec, seg.endSec];
      if (drag.mode === 'move') {
        const start = Math.max(0, drag.origStart + preview);
        return [start, start + (drag.origEnd - drag.origStart)];
      }
      if (drag.mode === 'resize-l') {
        return [Math.min(drag.origEnd - MIN_DUR, Math.max(0, drag.origStart + preview)), drag.origEnd];
      }
      return [drag.origStart, Math.max(drag.origStart + MIN_DUR, drag.origEnd + preview)];
    };
  }, [drag, preview]);

  const hasSel = selected.size > 0;
  const hasClip = clipRef.current.length > 0;

  return (
    <div className="lyric-lane-row">
      <div className="lyric-lane-header" style={{ width: sidebarWidth }}>
        <div className="lyric-lane-title">
          <strong>Lyrics</strong>
          <span className="lyric-lane-count">{lyrics.length} lines</span>
        </div>
        <div className="lyric-lane-btns">
          <button
            className={`lyric-lane-btn${captionsOn ? ' active' : ''}`}
            onClick={onToggleCaptions}
            title="Show/hide on-screen captions (like video subtitles)"
          >
            <Captions size={12} /> CC
          </button>
          <button className="lyric-lane-btn" onClick={() => onExport('lrc')} title="Export synced lyrics (.lrc)">
            .lrc
          </button>
          <button className="lyric-lane-btn" onClick={() => onExport('srt')} title="Export subtitles (.srt)">
            .srt
          </button>
          <button className="lyric-lane-btn danger" onClick={onDelete} title="Delete the lyrics track">
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      <div
        ref={contentRef}
        className="lyric-lane-content"
        style={{ width: viewportWidth }}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={() => {
          contentRef.current?.focus();
          setSelected(new Set());
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {lyrics.map((seg, i) => {
          const [start, end] = timesFor(i, seg);
          const x0 = secToX(start);
          const w = Math.max(6, (end - start) * pxPerSec);
          if (x0 + w < -40 || x0 > viewportWidth + 40) return null; // cull off-screen
          if (editing === i) {
            return (
              <input
                key={seg.startSec + ':' + i}
                className="lyric-block-input"
                style={{ left: x0, width: Math.max(80, w) }}
                defaultValue={seg.text}
                autoFocus
                onBlur={(e) => saveEdit(i, e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  else if (e.key === 'Escape') setEditing(null);
                }}
              />
            );
          }
          return (
            <div
              key={seg.startSec + ':' + i}
              className={`lyric-block${selected.has(i) ? ' lyric-block-selected' : ''}`}
              ref={(el) => {
                if (el) blockEls.current.set(i, el);
                else blockEls.current.delete(i);
              }}
              style={{ left: x0, width: w }}
              title={seg.text}
              onPointerDown={(e) => onBlockPointerDown(e, i)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditing(i);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!selected.has(i)) selectOnly(i);
                setMenu({ x: e.clientX, y: e.clientY });
              }}
            >
              <div className="lyric-block-edge l" onPointerDown={(e) => startDrag(e, i, 'resize-l')} />
              {seg.text}
              <button
                className="lyric-block-del"
                title="Delete line"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => del(e, i)}
              >
                ×
              </button>
              <div className="lyric-block-edge r" onPointerDown={(e) => startDrag(e, i, 'resize-r')} />
            </div>
          );
        })}
      </div>

      {menu && (
        <div
          className="lyric-lane-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button disabled={!hasSel} onClick={() => { copySel(); setMenu(null); }}>
            Copy <kbd>Ctrl+C</kbd>
          </button>
          <button disabled={!hasClip} onClick={() => { paste(); setMenu(null); }}>
            Paste at playhead <kbd>Ctrl+V</kbd>
          </button>
          <button disabled={!canSplit()} onClick={() => { splitSel(); setMenu(null); }}>
            Split at playhead <kbd>S</kbd>
          </button>
          <button disabled={!hasSel} onClick={() => { deleteSel(); setMenu(null); }}>
            Delete <kbd>Del</kbd>
          </button>
        </div>
      )}
    </div>
  );
}
