/**
 * Vocals → lyrics transcription (ASR) using Whisper via Transformers.js.
 *
 * Runs best on the *isolated vocals stem* — feed it a track already separated
 * from the mix. Transformers.js + the model are dynamically imported on first
 * use so they stay out of the initial bundle (same approach as transcribe.ts).
 * It prefers WebGPU and falls back to WASM. The model is fetched from the
 * Hugging Face Hub and cached by the browser between runs.
 *
 * Output is a list of time-stamped segments suitable for a karaoke strip and
 * for `.lrc` / `.srt` export.
 */

import { WHISPER_MODEL_ID } from '../config';

/** One time-stamped line of transcribed vocals. */
export interface LyricSegment {
  startSec: number;
  endSec: number;
  text: string;
}

export interface LyricsOptions {
  /** Force a language (ISO code, e.g. 'en', 'pt'); omit to auto-detect. */
  language?: string;
  /** 'transcribe' keeps the original language; 'translate' → English. */
  task?: 'transcribe' | 'translate';
}

// Whisper expects 16 kHz mono PCM.
const TARGET_RATE = 16000;

/** Resample an AudioBuffer to a mono Float32Array at 16 kHz. */
async function resample16kMono(buffer: AudioBuffer): Promise<Float32Array> {
  if (buffer.sampleRate === TARGET_RATE && buffer.numberOfChannels === 1) {
    return buffer.getChannelData(0);
  }
  const frames = Math.max(1, Math.ceil(buffer.duration * TARGET_RATE));
  const off = new OfflineAudioContext(1, frames, TARGET_RATE);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination);
  src.start(0);
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}

// Cache the pipeline instance across transcriptions (loading is expensive).
let pipePromise: Promise<any> | null = null;

async function buildPipeline(device: 'webgpu' | undefined, onDownload?: (p: number) => void) {
  const mod: any = await import('@huggingface/transformers');
  const opts: any = { progress_callback: (d: any) => reportDownload(d, onDownload) };
  if (device) opts.device = device;
  return mod.pipeline('automatic-speech-recognition', WHISPER_MODEL_ID, opts);
}

/** Map a Transformers.js progress event to a coarse 0..0.9 download fraction. */
function reportDownload(data: any, onDownload?: (p: number) => void) {
  if (!onDownload) return;
  if (data?.status === 'progress' && typeof data.progress === 'number') {
    onDownload(Math.min(0.9, (data.progress / 100) * 0.9));
  }
}

async function getTranscriber(onDownload?: (p: number) => void) {
  if (!pipePromise) {
    // Prefer WebGPU; if it can't be constructed, fall back to the WASM backend.
    pipePromise = buildPipeline('webgpu', onDownload).catch(() => buildPipeline(undefined, onDownload));
  }
  return pipePromise;
}

/**
 * Transcribe a (vocals) AudioBuffer into time-stamped lyric segments.
 * @param onProgress 0..1 — download progress then a bump while decoding.
 */
export async function transcribeLyrics(
  buffer: AudioBuffer,
  onProgress?: (p: number) => void,
  options: LyricsOptions = {},
): Promise<LyricSegment[]> {
  const audio = await resample16kMono(buffer);
  const transcriber = await getTranscriber((p) => onProgress?.(p));
  onProgress?.(0.92);

  const out = await transcriber(audio, {
    // Segment-level timestamps: [start, end] per chunk — enough for a karaoke
    // strip and for .lrc/.srt without the extra cost of word-level alignment.
    return_timestamps: true,
    chunk_length_s: 30,
    stride_length_s: 5,
    language: options.language,
    task: options.task ?? 'transcribe',
  });
  onProgress?.(1);

  const chunks: { timestamp: [number, number | null]; text: string }[] = out?.chunks ?? [];
  const duration = buffer.duration;
  const segments: LyricSegment[] = [];
  for (const c of chunks) {
    const text = (c.text ?? '').trim();
    if (!text) continue;
    const start = c.timestamp?.[0] ?? 0;
    // The final chunk can have a null end; clamp to the buffer length.
    const end = c.timestamp?.[1] ?? Math.min(duration, start + 4);
    segments.push({ startSec: start, endSec: Math.max(start, end), text });
  }
  return segments;
}

/* ------------------------------ exporters ------------------------------ */

function pad(n: number, width = 2): string {
  return String(Math.floor(n)).padStart(width, '0');
}

/** `[mm:ss.xx]` LRC timestamp. */
function lrcStamp(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const cs = Math.round((s - Math.floor(s)) * 100);
  return `[${pad(m)}:${pad(Math.floor(s))}.${pad(cs)}]`;
}

/** `HH:MM:SS,mmm` SRT timestamp. */
function srtStamp(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** Serialize segments to a synced `.lrc` lyrics file. */
export function toLrc(segments: LyricSegment[]): string {
  return segments.map((s) => `${lrcStamp(s.startSec)}${s.text}`).join('\n') + '\n';
}

/** Serialize segments to a `.srt` subtitle file. */
export function toSrt(segments: LyricSegment[]): string {
  return (
    segments
      .map((s, i) => `${i + 1}\n${srtStamp(s.startSec)} --> ${srtStamp(s.endSec)}\n${s.text}`)
      .join('\n\n') + '\n'
  );
}
