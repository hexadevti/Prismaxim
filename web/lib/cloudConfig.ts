/**
 * Runtime config for the optional cloud separation endpoint. Seeded from the
 * NEXT_PUBLIC_CLOUD_* env vars and overridable in Options (persisted to
 * localStorage). Kept out of React state so pipeline.ts can read it directly.
 */

import { DEFAULT_CLOUD_TOKEN, DEFAULT_CLOUD_URL } from './config';
import { IS_WEB } from './env';

const LS_URL = 'prismaxim-cloud-url';
const LS_TOKEN = 'prismaxim-cloud-token';

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

export function getCloudUrl(): string {
  return (lsGet(LS_URL) ?? DEFAULT_CLOUD_URL).replace(/\/$/, '');
}

export function getCloudToken(): string {
  return lsGet(LS_TOKEN) ?? DEFAULT_CLOUD_TOKEN;
}

export function setCloudUrl(v: string) {
  lsSet(LS_URL, v.trim());
}

export function setCloudToken(v: string) {
  lsSet(LS_TOKEN, v.trim());
}

/**
 * True when the cloud "fast mode" should be offered. Web-only: the desktop build
 * uses native separation and never shows the cloud option.
 */
export function cloudConfigured(): boolean {
  return IS_WEB && getCloudUrl().length > 0;
}
