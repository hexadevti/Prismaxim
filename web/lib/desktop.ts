/**
 * Typed accessor for the bridge the Electron preload injects on the window.
 * Only present in the packaged desktop app (see desktop/preload.cjs); `null`
 * everywhere else (pure-web build, or `next dev` without Electron), so callers
 * must feature-detect.
 */

/** One event from the update lifecycle, pushed from the main process. */
export type UpdateStatus =
  | { status: 'checking' }
  | { status: 'available'; version?: string }
  | { status: 'not-available'; version?: string }
  | { status: 'downloading'; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { status: 'downloaded'; version?: string }
  | { status: 'error'; error: string };

export interface DesktopUpdates {
  /** Current running app version. */
  getVersion(): Promise<string>;
  /** Ask GitHub whether a newer release exists. Results arrive via onEvent. */
  check(): Promise<{ ok: boolean; error?: string }>;
  /** Download the pending update (progress arrives via onEvent). */
  download(): Promise<{ ok: boolean; error?: string }>;
  /** Quit and run the downloaded installer. */
  install(): Promise<void>;
  /** Subscribe to update events; returns an unsubscribe function. */
  onEvent(cb: (e: UpdateStatus) => void): () => void;
}

export interface DesktopBridge {
  updates: DesktopUpdates;
}

declare global {
  interface Window {
    prismaxim?: DesktopBridge;
  }
}

/** The desktop bridge, or null when not running inside the Electron app. */
export function getDesktopBridge(): DesktopBridge | null {
  if (typeof window === 'undefined') return null;
  return window.prismaxim ?? null;
}
