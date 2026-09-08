'use client';

import { FileDown, FilePlus2, FolderOpen, Save } from 'lucide-react';
import { formatBytes } from '@/lib/workspace';

/** What the shell knows about the session, for the panel to describe. */
export interface WorkspaceStatus {
  /** Titles of the open tabs, in order. */
  tabTitles: string[];
  trackCount: number;
  /** Size the project file will be, estimated from the audio in memory. */
  estimatedBytes: number;
  /** The file this session is bound to, once saved or opened. */
  fileName: string | null;
  savedAt: string | null;
  /** Some tab has edits made since the last save to this file. */
  dirty: boolean;
  /** False on platforms that can only download — "Save" has to ask where. */
  canWriteInPlace: boolean;
}

function when(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/**
 * Manage the project file: the whole open session — every tab and the audio in
 * it — written to one file on disk, and read back later.
 *
 * The library saves one song at a time into storage the app owns. This is the
 * document the user owns: back it up, move it to another machine, open it in a
 * year and find the tabs as they left them.
 */
export default function ProjectPanel({
  status,
  onSave,
  onSaveAs,
  onOpen,
  onNew,
}: {
  status: WorkspaceStatus;
  /** Write back to the bound file (or ask, when the platform can't). */
  onSave: () => void;
  onSaveAs: () => void;
  onOpen: () => void;
  /** Close every tab and start over. */
  onNew: () => void;
}) {
  const { tabTitles, trackCount, estimatedBytes, fileName, savedAt, dirty } = status;
  const empty = tabTitles.length === 0;
  const savedLabel = when(savedAt);

  return (
    <div className="panel">
      <h2>Project</h2>
      <p className="hint">
        A project file holds everything open in the app — every tab, its tracks, and the audio they
        play — in one file you can back up, move to another machine, or reopen later.
      </p>

      <div className="field">
        <label>This session</label>
        {empty ? (
          <p className="hint" style={{ marginTop: 6 }}>
            Nothing is open yet. Import a song or open a saved project file.
          </p>
        ) : (
          <>
            <ul className="proj-tabs">
              {tabTitles.map((t, i) => (
                <li key={`${t}-${i}`}>{t}</li>
              ))}
            </ul>
            <p className="hint" style={{ marginTop: 6 }}>
              {tabTitles.length} {tabTitles.length === 1 ? 'tab' : 'tabs'} · {trackCount}{' '}
              {trackCount === 1 ? 'track' : 'tracks'} · about {formatBytes(estimatedBytes)} on disk
            </p>
          </>
        )}
      </div>

      <div className="field">
        <label>Project file</label>
        <p className={dirty ? 'warn' : 'hint'} style={{ marginTop: 6 }}>
          {!fileName
            ? 'Not saved to a file yet.'
            : dirty
              ? `${fileName} — unsaved changes since ${savedLabel || 'the last save'}.`
              : `${fileName}${savedLabel ? ` — saved ${savedLabel}` : ''}.`}
        </p>
        {!status.canWriteInPlace && fileName && (
          <p className="hint">
            This browser can&apos;t write back to a file, so each save downloads a fresh copy.
          </p>
        )}
      </div>

      <div className="proj-actions">
        <button className="btn" onClick={onSave} disabled={empty}>
          <Save size={15} /> {fileName && status.canWriteInPlace ? 'Save' : 'Save project…'}
        </button>
        <button className="btn secondary" onClick={onSaveAs} disabled={empty}>
          <FileDown size={15} /> Save as…
        </button>
        <button className="btn secondary" onClick={onOpen}>
          <FolderOpen size={15} /> Open project…
        </button>
        <button className="btn ghost" onClick={onNew} disabled={empty}>
          <FilePlus2 size={15} /> New project
        </button>
      </div>

      <p className="hint">
        Audio is stored uncompressed, so files are large — roughly 10 MB per stereo minute of audio
        across all tabs. Opening a project file replaces everything currently open.
      </p>
    </div>
  );
}
