/**
 * Cloud separation endpoint config. Sourced entirely from build-time environment
 * variables (NEXT_PUBLIC_CLOUD_SEPARATE_URL / NEXT_PUBLIC_CLOUD_TOKEN) — set them
 * in the site's environment. Not editable at runtime.
 */

import { DEFAULT_CLOUD_TOKEN, DEFAULT_CLOUD_URL } from './config';
import { IS_WEB } from './env';

export function getCloudUrl(): string {
  return DEFAULT_CLOUD_URL.replace(/\/$/, '');
}

export function getCloudToken(): string {
  return DEFAULT_CLOUD_TOKEN;
}

/**
 * True when the cloud "fast mode" should be offered. Web-only: the desktop build
 * uses native separation and never shows the cloud option.
 */
export function cloudConfigured(): boolean {
  return IS_WEB && getCloudUrl().length > 0;
}
