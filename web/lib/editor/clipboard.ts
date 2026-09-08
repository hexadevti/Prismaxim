/**
 * The editor clipboard, held at module scope instead of in the editor's own
 * state.
 *
 * Switching songs remounts the editor (see the tab shell in app/page.tsx), so a
 * component-local clipboard would be emptied by the very act of navigating to
 * where you wanted to paste. Keeping it here is what makes copy in one song and
 * paste in another work at all.
 *
 * AudioBuffers are shared with the project they came from, so holding a copy
 * costs no extra audio memory — but it does pin those buffers until something
 * else is copied, which is why closing a song does not clear the clipboard.
 */

import { useSyncExternalStore } from 'react';
import type { Clipboard } from './edits';

export interface HeldClipboard {
  content: Clipboard;
  /** Song the copy came from — labels a cross-song paste and names new tracks. */
  sourceTitle: string;
  /** Identifies the source project, so a paste can tell "same song" from "other". */
  sourceId: string;
}

let held: HeldClipboard | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

export function setClipboard(
  content: Clipboard | null,
  sourceTitle: string,
  sourceId: string,
): void {
  held = content ? { content, sourceTitle, sourceId } : null;
  emit();
}

export function getClipboard(): HeldClipboard | null {
  return held;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Live clipboard for rendering. Server snapshot is null — this is client-only. */
export function useClipboard(): HeldClipboard | null {
  return useSyncExternalStore(subscribe, getClipboard, () => null);
}
