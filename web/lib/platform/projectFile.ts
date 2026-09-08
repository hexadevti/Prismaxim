/**
 * Picking a place on disk for the project file.
 *
 * Where the browser supports it (Chromium — so the Electron desktop app always
 * does) this uses the File System Access API, which gives a real Save-As dialog
 * and, more importantly, a handle: "Save" then overwrites the same file instead
 * of dropping another copy in Downloads. Everywhere else it degrades to a normal
 * download and a hidden file input, which still works — the user just picks the
 * file again each time.
 */

import { WORKSPACE_EXT } from '../workspace';
import { saveOrShare } from './save';

/** Minimal shape of the File System Access API bits we use. */
interface FileSystemWritable {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
}
interface FileHandle {
  name: string;
  createWritable(): Promise<FileSystemWritable>;
  getFile(): Promise<File>;
  /** Present in Chromium. A handle from an *open* dialog is read-only until asked. */
  queryPermission?: (opts: { mode: string }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: string }) => Promise<PermissionState>;
}
interface PickerWindow {
  showSaveFilePicker?: (opts: unknown) => Promise<FileHandle>;
  showOpenFilePicker?: (opts: unknown) => Promise<FileHandle[]>;
}

/** A file the session can write back to, when the platform allows it. */
export interface ProjectFile {
  name: string;
  /** Absent when the platform can only download — "Save" has to ask again. */
  handle?: FileHandle;
}

const ACCEPT = {
  description: 'Prismaxim project',
  accept: { 'application/octet-stream': [`.${WORKSPACE_EXT}`] },
};

function picker(): PickerWindow | null {
  return typeof window === 'undefined' ? null : (window as unknown as PickerWindow);
}

/** Whether "Save" can overwrite the file in place instead of re-asking. */
export function canWriteInPlace(): boolean {
  return typeof picker()?.showSaveFilePicker === 'function';
}

/** Thrown-away marker for a user-cancelled picker (not an error worth showing). */
function isAbort(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * Ask where to save. Returns null if the user cancelled.
 *
 * Separate from the write so the dialog opens on the click that asked for it —
 * packing a session's audio takes seconds, and by the time it finished the user
 * activation the picker requires would be gone.
 */
export async function pickSaveTarget(suggestedName: string): Promise<ProjectFile | null> {
  const show = picker()?.showSaveFilePicker;
  // No picker: nothing to choose, the write will just download under this name.
  if (!show) return { name: suggestedName };
  try {
    const handle = await show({ suggestedName, types: [ACCEPT] });
    return { name: handle.name, handle };
  } catch (err) {
    if (isAbort(err)) return null;
    throw err;
  }
}

/** Whether this handle may be written to, asking the user once if need be. */
async function canWrite(handle: FileHandle): Promise<boolean> {
  // Not every engine implements these; where they're missing, writing either
  // just works or throws below, which the caller reports either way.
  if (!handle.queryPermission || !handle.requestPermission) return true;
  try {
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/** Overwrite an already-chosen file. Falls back to a download without a handle. */
export async function writeProjectFile(file: ProjectFile, blob: Blob): Promise<void> {
  if (!file.handle) {
    await saveOrShare(blob, file.name);
    return;
  }
  const writable = await file.handle.createWritable();
  try {
    await writable.write(blob);
  } finally {
    await writable.close();
  }
}

/** Pick a project file to open. Returns null if the user cancelled. */
export async function openProjectFile(): Promise<{ file: File; project: ProjectFile } | null> {
  const show = picker()?.showOpenFilePicker;
  if (show) {
    let handles: FileHandle[];
    try {
      handles = await show({ types: [ACCEPT], multiple: false });
    } catch (err) {
      if (isAbort(err)) return null;
      throw err;
    }
    const handle = handles[0];
    if (!handle) return null;
    // A handle from an open dialog can only read. Ask now, while the click that
    // opened the dialog still counts as activation, so a later Save can write
    // back to the same file; if the user says no, keep the handle off the
    // result and Save falls back to asking where to put it.
    const writable = await canWrite(handle);
    return { file: await handle.getFile(), project: { name: handle.name, ...(writable ? { handle } : {}) } };
  }

  // No picker API: a hidden input. There is no cancel event, so the promise
  // settles on the next focus if nothing was chosen.
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = `.${WORKSPACE_EXT}`;
    input.style.display = 'none';
    let settled = false;
    const finish = (value: { file: File; project: ProjectFile } | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.onchange = () => {
      const file = input.files?.[0];
      finish(file ? { file, project: { name: file.name } } : null);
    };
    window.addEventListener(
      'focus',
      () => setTimeout(() => finish(null), 500),
      { once: true },
    );
    document.body.appendChild(input);
    input.click();
  });
}
