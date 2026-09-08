/**
 * Persistence abstraction for the library (imported sources, separated
 * projects, and edited arrangements).
 *
 * Two implementations back this interface, selected at build time (see
 * ./index.ts):
 *  - browser.ts — IndexedDB (metadata) + OPFS (audio), for the 100% web build.
 *  - backend.ts — the Node/Fastify backend, for the Electron desktop build.
 *
 * Separation itself is NOT part of the store; see ../pipeline.ts, which uses the
 * store only to persist results.
 */

import type {
  AnalysisMeta,
  ArrangementSummary,
  ProgressUpdate,
  ProjectMeta,
  SourceMeta,
  StemSet,
} from '@prismaxim/shared';
import type { EditorProject } from '../editor/model';

/** Metadata supplied when persisting a freshly separated project. */
export interface SaveProjectMeta {
  title: string;
  sourceId?: string;
  /** compute engine that produced the stems, e.g. 'webgpu' | 'wasm' | 'cpu' */
  engine: string;
  separationMs?: number;
  /** Musical analysis computed from the stems; persisted with the project. */
  analysis?: AnalysisMeta;
}

export interface LibraryStore {
  /* ----- sources (original uploaded / imported audio) ----- */
  listSources(): Promise<SourceMeta[]>;
  saveSource(file: File): Promise<SourceMeta>;
  getSourceBytes(id: string): Promise<ArrayBuffer>;
  /** A URL usable for <audio>/<a href> playback; caller may revoke object URLs. */
  getSourceAudioUrl(id: string): Promise<string>;
  /** A thumbnail URL, or null when the source has none (uploads). */
  getSourceThumbUrl(id: string): Promise<string | null>;
  deleteSource(id: string): Promise<void>;

  /* ----- projects (a separated 6-stem set) ----- */
  listProjects(): Promise<ProjectMeta[]>;
  saveProject(
    set: StemSet,
    meta: SaveProjectMeta,
    onProgress?: (p: ProgressUpdate) => void,
  ): Promise<ProjectMeta>;
  loadProject(project: ProjectMeta, onProgress?: (p: ProgressUpdate) => void): Promise<StemSet>;
  deleteProject(id: string): Promise<void>;

  /* ----- arrangements (edited clip layouts + referenced audio) ----- */
  listArrangements(): Promise<ArrangementSummary[]>;
  saveArrangement(
    project: EditorProject,
    title: string,
    onProgress?: (p: ProgressUpdate) => void,
  ): Promise<ArrangementSummary>;
  loadArrangement(
    id: string,
    onProgress?: (p: ProgressUpdate) => void,
  ): Promise<{ project: EditorProject; title: string }>;
  deleteArrangement(id: string): Promise<void>;

  /** Optional storage usage report (browser store only). */
  estimate?(): Promise<{ usage: number; quota: number } | null>;
}
