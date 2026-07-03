/**
 * The active LibraryStore, chosen at build time:
 *  - desktop build → backend (Node/Fastify) store
 *  - web build     → 100% in-browser store (IndexedDB + OPFS)
 */

import { IS_DESKTOP } from '../env';
import { backendStore } from './backend';
import { browserStore } from './browser';
import type { LibraryStore } from './types';

export const store: LibraryStore = IS_DESKTOP ? backendStore : browserStore;

export type { LibraryStore, SaveProjectMeta } from './types';
