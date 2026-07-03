/**
 * Job orchestrator: turns a JobConfig (+ optional uploaded file) into a StemSet.
 *
 * Stem separation always runs on the native backend (the browser engine was
 * removed — it was far too slow). YouTube extraction may still run in the browser
 * (through the backend proxy) or on the backend; either way the audio is then
 * separated on the backend and the project is saved to the library.
 */

import type { JobConfig, ProgressUpdate, StemSet } from '@prismaxim/shared';
import { separateFromSource, separateUpload } from './engines/client';
import { extractInBrowser } from './engines/extract.web';
import { importYouTube } from './library';

export interface JobResult {
  set: StemSet;
  title: string;
  /** true if the project was saved to the backend library */
  persisted: boolean;
}

export async function runJob(
  config: JobConfig,
  file: File | null,
  onProgress: (p: ProgressUpdate) => void,
): Promise<JobResult> {
  const { input, backendBaseUrl } = config;

  if (input.kind === 'file') {
    if (!file) throw new Error('No file provided.');
    const title = file.name.replace(/\.[^.]+$/, '');
    const bytes = await file.arrayBuffer();
    const ext = file.name.split('.').pop()?.toLowerCase() || 'audio';
    const set = await separateUpload(backendBaseUrl, bytes, { title, ext }, onProgress);
    return { set, title, persisted: true };
  }

  // YouTube — extract (backend or browser-via-proxy), then separate on the backend.
  if (input.extraction === 'backend') {
    onProgress({ phase: 'extracting', percent: 20, message: 'Importing on backend…' });
    const source = await importYouTube(backendBaseUrl, input.url);
    onProgress({ phase: 'extracting', percent: 100, message: `Imported "${source.title}"` });
    const set = await separateFromSource(backendBaseUrl, source.id, onProgress);
    return { set, title: source.title, persisted: true };
  }

  const bytes = await extractInBrowser(input.url, backendBaseUrl, onProgress);
  const title = input.url;
  const set = await separateUpload(backendBaseUrl, bytes, { title, ext: 'webm' }, onProgress);
  return { set, title, persisted: true };
}
