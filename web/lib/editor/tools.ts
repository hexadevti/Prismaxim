/**
 * Output-audio visualizer "tools" shown in the editor's right sidebar. These are
 * view-only widgets (not document content), so they live outside the undoable
 * EditorProject and persist to localStorage — mirroring the cloudConfig.ts and
 * `prismaxim-nav-open` patterns.
 */

export type ToolKind = 'vu' | 'spectrum';

export interface ToolInstance {
  id: string;
  kind: ToolKind;
  /** Signal to visualize: 'in' (audio input), 'out' (master mix), or a track id. */
  source: string;
}

const LS_TOOLS = 'prismaxim-tools';
const LS_OPEN = 'prismaxim-tools-open';

function lsGet(key: string): string | null {
  try {
    return typeof window !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string) {
  try {
    if (typeof window !== 'undefined') localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

export function loadTools(): ToolInstance[] {
  const raw = lsGet(LS_TOOLS);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t) => !!t && typeof t.id === 'string' && (t.kind === 'vu' || t.kind === 'spectrum'))
      .map((t) => ({
        id: t.id as string,
        kind: t.kind as ToolKind,
        // Migrate older records (no source) to the master mix.
        source: typeof t.source === 'string' ? t.source : 'out',
      }));
  } catch {
    return [];
  }
}

export function saveTools(tools: ToolInstance[]): void {
  lsSet(LS_TOOLS, JSON.stringify(tools));
}

export function loadToolsOpen(): boolean {
  return lsGet(LS_OPEN) === '1';
}

export function saveToolsOpen(open: boolean): void {
  lsSet(LS_OPEN, open ? '1' : '0');
}
