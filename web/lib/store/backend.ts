/**
 * Backend-backed LibraryStore for the Electron desktop build. Thin adapter over
 * the existing Node/Fastify client modules (library.ts, editor/persist.ts).
 *
 * The base URL is fixed to the local bundled server (same origin in the packaged
 * app); it is overridable at build time via NEXT_PUBLIC_BACKEND_URL.
 */

import { DEFAULT_BACKEND_URL } from '../config';
import {
  deleteProject,
  deleteSource,
  getSourceAudioBytes,
  listProjects,
  listSources,
  loadProject,
  saveBrowserProject,
  sourceAudioUrl,
  sourceThumbUrl,
  uploadSource,
} from '../library';
import { deleteArrangement, listArrangements } from '../library';
import { loadArrangement, saveArrangement } from '../editor/persist';
import type { LibraryStore } from './types';

const base = DEFAULT_BACKEND_URL.replace(/\/$/, '');

export const backendStore: LibraryStore = {
  listSources: () => listSources(base),
  saveSource: (file) => uploadSource(base, file),
  getSourceBytes: (id) => getSourceAudioBytes(base, id),
  getSourceAudioUrl: async (id) => sourceAudioUrl(base, id),
  getSourceThumbUrl: async (id) => sourceThumbUrl(base, id),
  deleteSource: (id) => deleteSource(base, id),

  listProjects: () => listProjects(base),
  saveProject: (set, meta, onProgress) =>
    saveBrowserProject(base, set, meta.title, onProgress, meta.analysis),
  loadProject: (project, onProgress) => loadProject(base, project, onProgress),
  deleteProject: (id) => deleteProject(base, id),

  listArrangements: () => listArrangements(base),
  saveArrangement: (project, title, onProgress) =>
    saveArrangement(base, project, title, onProgress),
  loadArrangement: (id, onProgress) => loadArrangement(base, id, onProgress),
  deleteArrangement: (id) => deleteArrangement(base, id),
};
