/**
 * The project file: every tab open in the app — arrangements *and* the audio
 * they play — written to one file on disk, and read back into the same session.
 *
 * The library (lib/store) saves songs one at a time into app-managed storage.
 * This is the other thing people want from a DAW: a document they own, can put
 * on a backup drive or hand to someone else, and can reopen months later to find
 * the app exactly as they left it.
 *
 * ## Format
 *
 * A tiny container rather than a zip, so nothing has to be bundled to read or
 * write it:
 *
 *     "PXWORK\0\0"           8 bytes, magic
 *     uint32 LE              header length
 *     header                 UTF-8 JSON (see WorkspaceHeader)
 *     payload                each buffer's WAV bytes, back to back
 *
 * The header holds one ArrangementManifest per tab — the same shape a single
 * saved arrangement uses — plus an index of byte ranges into the payload. Audio
 * is interned across all tabs, so two tabs that share a buffer (a clip pasted
 * from one song into another) store it once.
 *
 * Audio is 16-bit PCM WAV, the same encoding every other save path in the app
 * uses. That makes project files big — roughly 10 MB per stereo minute — but
 * lossless against what is in memory and readable by anything.
 */

import {
  createBufferPool,
  deserializeManifest,
  serializeTracks,
  type ArrangementManifest,
} from './editor/persist';
import { encodeWav } from './mixer/export';
import { makeAudioBuffer, type EditorProject } from './editor/model';
import type { ProgressUpdate } from '@prismaxim/shared';

/** Extension for saved project files. */
export const WORKSPACE_EXT = 'pxproj';

const MAGIC = 'PXWORK\0\0';
const MAGIC_BYTES = 8;
const LENGTH_BYTES = 4;
/** Refuse to parse a header claiming an absurd size — a wrong file, not ours. */
const MAX_HEADER_BYTES = 64 * 1024 * 1024;

interface BufferEntry {
  id: string;
  /** Offset from the start of the payload, not the start of the file. */
  offset: number;
  length: number;
}

interface WorkspaceHeader {
  format: 'prismaxim-workspace';
  version: 1;
  savedAt: string;
  /** Which tab was in front. Restored so a reopened file looks like it was left. */
  activeIndex: number;
  tabs: ArrangementManifest[];
  buffers: BufferEntry[];
}

/** One open tab, as the app hands it over to be saved. */
export interface WorkspaceTab {
  title: string;
  project: EditorProject;
}

export interface Workspace {
  tabs: WorkspaceTab[];
  activeIndex: number;
  savedAt?: string;
}

/** What a project file will cost on disk, for warning before a long save. */
export function estimateWorkspaceBytes(tabs: WorkspaceTab[]): number {
  const seen = new Set<AudioBuffer>();
  let bytes = 0;
  for (const tab of tabs) {
    for (const track of tab.project.tracks) {
      for (const clip of track.clips) {
        if (seen.has(clip.buffer)) continue;
        seen.add(clip.buffer);
        bytes += 44 + clip.buffer.length * clip.buffer.numberOfChannels * 2;
      }
    }
  }
  return bytes;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/** A filename that won't upset any filesystem. */
export function workspaceFilename(name: string): string {
  const safe = name.trim().replace(/[^\w\-. ]+/g, '_').replace(/\s+/g, ' ').slice(0, 60);
  return `${safe || 'project'}.${WORKSPACE_EXT}`;
}

/** UTF-8 bytes, typed so they can go straight into a Blob (see BlobPart). */
function textBytes(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;
}

/**
 * Pack the open tabs into a project file.
 *
 * Encoding runs one buffer at a time with a yield between each, so a session
 * with half an hour of audio in it doesn't freeze the UI while it saves.
 */
export async function serializeWorkspace(
  tabs: WorkspaceTab[],
  activeIndex: number,
  onProgress?: (p: ProgressUpdate) => void,
): Promise<Blob> {
  const pool = createBufferPool();
  const manifests: ArrangementManifest[] = tabs.map((tab) => {
    const { tracks, bufferIds } = serializeTracks(tab.project, pool);
    return {
      version: 1,
      title: tab.title,
      sampleRate: tab.project.sampleRate,
      numChannels: tab.project.numChannels,
      buffers: bufferIds,
      tracks,
    };
  });

  const parts: Blob[] = [];
  const index: BufferEntry[] = [];
  let offset = 0;
  for (let i = 0; i < pool.list.length; i++) {
    const { id, buffer } = pool.list[i]!;
    onProgress?.({
      phase: 'separating',
      percent: Math.round(((i + 1) / pool.list.length) * 100),
      message: `Packing audio ${i + 1}/${pool.list.length}`,
    });
    const wav = encodeWav(buffer);
    index.push({ id, offset, length: wav.size });
    offset += wav.size;
    parts.push(wav);
    // Let the browser paint the progress bar before the next encode.
    await new Promise((r) => setTimeout(r, 0));
  }

  const header: WorkspaceHeader = {
    format: 'prismaxim-workspace',
    version: 1,
    savedAt: new Date().toISOString(),
    activeIndex: Math.max(0, Math.min(activeIndex, tabs.length - 1)),
    tabs: manifests,
    buffers: index,
  };
  const headerBytes = textBytes(JSON.stringify(header));
  const prefix = new Uint8Array(MAGIC_BYTES + LENGTH_BYTES);
  for (let i = 0; i < MAGIC_BYTES; i++) prefix[i] = MAGIC.charCodeAt(i);
  new DataView(prefix.buffer).setUint32(MAGIC_BYTES, headerBytes.length, true);

  return new Blob([prefix, headerBytes, ...parts], { type: 'application/octet-stream' });
}

/**
 * Decode one of our own WAV payloads.
 *
 * Deliberately not `decodeAudioData`: that resamples to whatever rate the
 * device's AudioContext runs at, so a 44.1 kHz project reopened on a 48 kHz
 * machine would come back resampled — lossy, and a little larger every time it
 * was saved and opened again. These payloads are written by encodeWav, so the
 * common case is a plain 16-bit PCM header we can read exactly. Anything else
 * (a file written by some future version) falls back to the browser decoder.
 */
async function decodeWav(bytes: ArrayBuffer): Promise<AudioBuffer> {
  const pcm = readPcmWav(bytes);
  if (pcm) return makeAudioBuffer(pcm.channels, pcm.sampleRate);

  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(bytes);
    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
    // Rebuild off the AudioContext so closing it can't invalidate the data.
    return makeAudioBuffer(channels, decoded.sampleRate);
  } finally {
    void ctx.close();
  }
}

/** De-interleave a canonical 16-bit PCM WAV, or null if it isn't one. */
function readPcmWav(bytes: ArrayBuffer): { channels: Float32Array[]; sampleRate: number } | null {
  if (bytes.byteLength < 44) return null;
  const view = new DataView(bytes);
  const tag = (offset: number) =>
    String.fromCharCode(
      view.getUint8(offset),
      view.getUint8(offset + 1),
      view.getUint8(offset + 2),
      view.getUint8(offset + 3),
    );
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  // Walk the chunks rather than assuming encodeWav's exact layout.
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  let data: { offset: number; length: number } | null = null;
  let at = 12;
  while (at + 8 <= bytes.byteLength) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ' && size >= 16) {
      if (view.getUint16(body, true) !== 1) return null; // not raw PCM
      fmt = {
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      data = { offset: body, length: Math.min(size, bytes.byteLength - body) };
      break;
    }
    at = body + size + (size % 2); // chunks are word-aligned
  }
  if (!fmt || !data || fmt.bits !== 16 || fmt.channels < 1 || !fmt.sampleRate) return null;

  const frames = Math.floor(data.length / (fmt.channels * 2));
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames));
  let offset = data.offset;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.channels; c++) {
      channels[c]![i] = view.getInt16(offset, true) / 32768;
      offset += 2;
    }
  }
  return { channels, sampleRate: fmt.sampleRate };
}

/** Read a project file back into the tabs it was saved from. */
export async function parseWorkspace(
  file: Blob,
  onProgress?: (p: ProgressUpdate) => void,
): Promise<Workspace> {
  const head = new Uint8Array(await file.slice(0, MAGIC_BYTES + LENGTH_BYTES).arrayBuffer());
  if (head.length < MAGIC_BYTES + LENGTH_BYTES) throw new Error('Not a Prismaxim project file');
  for (let i = 0; i < MAGIC_BYTES; i++) {
    if (head[i] !== MAGIC.charCodeAt(i)) throw new Error('Not a Prismaxim project file');
  }
  const headerLength = new DataView(head.buffer).getUint32(MAGIC_BYTES, true);
  if (headerLength === 0 || headerLength > MAX_HEADER_BYTES) {
    throw new Error('This project file looks damaged');
  }

  const headerStart = MAGIC_BYTES + LENGTH_BYTES;
  const headerText = await file.slice(headerStart, headerStart + headerLength).text();
  let header: WorkspaceHeader;
  try {
    header = JSON.parse(headerText) as WorkspaceHeader;
  } catch {
    throw new Error('This project file looks damaged');
  }
  if (header.format !== 'prismaxim-workspace') throw new Error('Not a Prismaxim project file');
  if (header.version !== 1) {
    throw new Error(`This file was saved by a newer version of Prismaxim (v${header.version})`);
  }

  const payloadStart = headerStart + headerLength;
  const bufMap = new Map<string, AudioBuffer>();
  const entries = header.buffers ?? [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    onProgress?.({
      phase: 'loading-model',
      percent: Math.round(((i + 1) / entries.length) * 100),
      message: `Loading audio ${i + 1}/${entries.length}`,
    });
    const slice = file.slice(payloadStart + entry.offset, payloadStart + entry.offset + entry.length);
    bufMap.set(entry.id, await decodeWav(await slice.arrayBuffer()));
  }

  const tabs = (header.tabs ?? []).map((manifest) => ({
    title: manifest.title,
    project: deserializeManifest(manifest, bufMap),
  }));
  if (!tabs.length) throw new Error('This project file has no tabs in it');

  return {
    tabs,
    activeIndex: Math.max(0, Math.min(header.activeIndex ?? 0, tabs.length - 1)),
    savedAt: header.savedAt,
  };
}
