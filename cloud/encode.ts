/**
 * Audio (de)coding for the cloud separator, using the npm-bundled ffmpeg binary
 * (`ffmpeg-static`). Self-contained (system tmp dir) so the container has no
 * dependency on the desktop backend's config.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { MODEL_CHANNELS, MODEL_SAMPLE_RATE } from '@prismaxim/shared';

// Prefer an explicit path (the container sets FFMPEG_PATH=ffmpeg to use the
// apt-installed system binary), then the npm-bundled static binary (local dev),
// then a bare `ffmpeg` on PATH.
const ffmpegPath = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string) || 'ffmpeg';

export interface DecodedPcm {
  channels: Float32Array[];
  sampleRate: number;
  length: number;
}

function runFfmpeg(args: string[], input?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-loglevel', 'error', ...args]);
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => errChunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(`ffmpeg exited ${code}: ${Buffer.concat(errChunks).toString()}`));
    });
    if (input) {
      proc.stdin.write(input);
      proc.stdin.end();
    }
  });
}

/** Decode arbitrary audio bytes to 44.1 kHz stereo Float32 channels. */
export async function decodePcm(bytes: Buffer): Promise<DecodedPcm> {
  // MP4/M4A needs a seekable input, so stage the upload to a temp file.
  const dir = await mkdtemp(join(tmpdir(), 'prismaxim-'));
  const inPath = join(dir, 'in');
  await writeFile(inPath, bytes);
  try {
    const out = await runFfmpeg([
      '-i', inPath,
      '-f', 'f32le',
      '-acodec', 'pcm_f32le',
      '-ac', String(MODEL_CHANNELS),
      '-ar', String(MODEL_SAMPLE_RATE),
      'pipe:1',
    ]);
    const interleaved = new Float32Array(out.buffer, out.byteOffset, Math.floor(out.byteLength / 4));
    const frames = Math.floor(interleaved.length / MODEL_CHANNELS);
    const channels: Float32Array[] = [];
    for (let c = 0; c < MODEL_CHANNELS; c++) channels.push(new Float32Array(frames));
    for (let i = 0; i < frames; i++) {
      for (let c = 0; c < MODEL_CHANNELS; c++) channels[c]![i] = interleaved[i * MODEL_CHANNELS + c]!;
    }
    return { channels, sampleRate: MODEL_SAMPLE_RATE, length: frames };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Encode Float32 channels to a FLAC (lossless) Buffer via ffmpeg. */
export async function encodeFlac(channels: Float32Array[], sampleRate: number): Promise<Buffer> {
  const numChannels = channels.length;
  const length = channels[0]?.length ?? 0;
  // Interleave to raw f32le for ffmpeg's stdin.
  const interleaved = new Float32Array(length * numChannels);
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numChannels; c++) interleaved[i * numChannels + c] = channels[c]![i]!;
  }
  const input = Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
  return runFfmpeg(
    [
      '-f', 'f32le',
      '-ar', String(sampleRate),
      '-ac', String(numChannels),
      '-i', 'pipe:0',
      '-c:a', 'flac',
      '-f', 'flac',
      'pipe:1',
    ],
    input,
  );
}
