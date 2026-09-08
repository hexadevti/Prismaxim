'use client';

import { useEffect, useRef, useState } from 'react';
import { FilePlus2, ListPlus, Music, Plus, X } from 'lucide-react';

/** One open song. The audio lives in the shell; this is only what the bar draws. */
export interface TabMeta {
  id: string;
  title: string;
  /** Unsaved edits — shown as a dot and confirmed before closing. */
  dirty: boolean;
}

/**
 * Tab strip above the editor: one tab per open song, plus the two ways songs
 * relate to each other — open another alongside (＋), or fold another open song
 * into the current project ("Add song…").
 *
 * ＋ offers an empty project as well as an import: a blank tab is where you
 * build something from scratch, or somewhere to paste parts of other songs into
 * without one of them having to be the host.
 *
 * Only the active tab's editor is mounted; the rest are held as project data by
 * the shell, so several long songs can stay open without several audio engines
 * running at once.
 */
export default function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onNewEmpty,
  onMerge,
}: {
  tabs: TabMeta[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  /** Open a tab by importing a song. */
  onNew: () => void;
  /** Open a tab with nothing in it. */
  onNewEmpty: () => void;
  /** Append another open song's tracks to the active project. */
  onMerge: (id: string) => void;
}) {
  const [menu, setMenu] = useState<'new' | 'merge' | null>(null);
  const newRef = useRef<HTMLDivElement | null>(null);
  const mergeRef = useRef<HTMLDivElement | null>(null);

  // Close whichever menu is open on an outside click or Escape.
  useEffect(() => {
    if (!menu) return;
    const host = menu === 'new' ? newRef : mergeRef;
    const onDown = (e: MouseEvent) => {
      if (!host.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menu]);

  const others = tabs.filter((t) => t.id !== activeId);

  return (
    <div className="tabbar" role="tablist" aria-label="Open songs">
      <div className="tabbar-scroll">
        {tabs.map((t) => (
          <div key={t.id} className={`tab${t.id === activeId ? ' active' : ''}`}>
            <button
              className="tab-label"
              role="tab"
              aria-selected={t.id === activeId}
              onClick={() => onSelect(t.id)}
              title={t.title}
            >
              <span className={`tab-dot${t.dirty ? ' dirty' : ''}`} aria-hidden="true" />
              <span className="tab-title">{t.title}</span>
            </button>
            <button
              className="tab-close"
              onClick={() => onClose(t.id)}
              title={`Close ${t.title}`}
              aria-label={`Close ${t.title}`}
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>

      <div className="tab-new-wrap" ref={newRef}>
        <button
          className="tab-new"
          onClick={() => setMenu((m) => (m === 'new' ? null : 'new'))}
          aria-haspopup="menu"
          aria-expanded={menu === 'new'}
          title="Open another tab"
          aria-label="Open another tab"
        >
          <Plus size={14} />
        </button>
        {menu === 'new' && (
          <div className="tab-menu tab-new-menu" role="menu">
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onNew();
              }}
            >
              <Music size={14} /> Open a song…
            </button>
            <button
              role="menuitem"
              onClick={() => {
                setMenu(null);
                onNewEmpty();
              }}
              title="A blank project — record, add tracks, or paste parts of other songs in"
            >
              <FilePlus2 size={14} /> Empty project
            </button>
          </div>
        )}
      </div>

      {others.length > 0 && (
        <div className="tab-merge" ref={mergeRef}>
          <button
            className="btn ghost tab-merge-btn"
            onClick={() => setMenu((m) => (m === 'merge' ? null : 'merge'))}
            aria-haspopup="menu"
            aria-expanded={menu === 'merge'}
            title="Add another open song's tracks to this project"
          >
            <ListPlus size={14} />
            Add song to project
          </button>
          {menu === 'merge' && (
            <div className="tab-menu tab-merge-menu" role="menu">
              {others.map((t) => (
                <button
                  key={t.id}
                  role="menuitem"
                  onClick={() => {
                    setMenu(null);
                    onMerge(t.id);
                  }}
                  title={`Add ${t.title} to the current project`}
                >
                  {t.title}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
