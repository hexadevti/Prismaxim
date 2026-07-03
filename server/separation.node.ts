/**
 * Backend separation runtime using onnxruntime-node (native).
 *
 * Runs on the CPU. htdemucs_6s is heavy, so two things matter for speed:
 *  1. Graph optimization ('all') — big inference speedup, but it costs ~30 s at
 *     load. We persist the optimized graph to disk (once, per machine + ORT
 *     version) so every launch after the first loads it in ~1–2 s.
 *  2. Thread count — left to the ORT default (all physical cores); override with
 *     ORT_THREADS if needed.
 *
 * DirectML (GPU) was evaluated: this htdemucs_6s export crashes the DirectML EP
 * at session creation (unsupported ops), so we stay on CPU. ORT_EP can still
 * force another provider for experimentation.
 */

import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import * as ort from 'onnxruntime-node';
import type { SeparationRuntime, SeparationSession } from '@prismaxim/shared';
import { MODEL_DIR, MODEL_FILE, MODEL_URL } from './config';

// onnxruntime-node version — keys the optimized-graph cache so an ORT upgrade
// (which persists across app updates in userData) can't load a stale graph.
const ORT_VERSION: string = (() => {
  try {
    const req = createRequire(import.meta.url);
    return (req('onnxruntime-node/package.json') as { version: string }).version;
  } catch {
    return 'x';
  }
})();

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Ensure the ONNX model is on disk, downloading it from MODEL_URL if needed. */
export async function ensureModel(onLog?: (msg: string) => void): Promise<string> {
  if (await fileExists(MODEL_FILE)) return MODEL_FILE;
  await mkdir(MODEL_DIR, { recursive: true });
  onLog?.(`Downloading model from ${MODEL_URL} …`);
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Model download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(MODEL_FILE, buf);
  onLog?.(`Model saved to ${MODEL_FILE} (${(buf.length / 1e6).toFixed(0)} MB)`);
  return MODEL_FILE;
}

/**
 * Create a tuned InferenceSession. For the CPU provider we persist the optimized
 * graph next to the model and reuse it on later launches (skips the ~30 s
 * optimization pass), falling back to a fresh optimize if the cache is unusable.
 */
async function createTunedSession(origPath: string, ep: string): Promise<ort.InferenceSession> {
  const base: ort.InferenceSession.SessionOptions = {
    executionProviders: [ep],
    graphOptimizationLevel: 'all',
    enableCpuMemArena: true,
  };
  const threads = Number(process.env.ORT_THREADS ?? 0);
  if (threads > 0) base.intraOpNumThreads = threads;

  // The optimized graph is CPU-specific; only cache it for the CPU provider.
  if (ep !== 'cpu') return ort.InferenceSession.create(origPath, base);

  const optPath = join(dirname(origPath), `htdemucs_6s.opt.${ORT_VERSION}.onnx`);
  if (await fileExists(optPath)) {
    try {
      // Already optimized on this machine → skip re-optimization (fast load).
      return await ort.InferenceSession.create(optPath, {
        ...base,
        graphOptimizationLevel: 'disabled',
      });
    } catch {
      await rm(optPath, { force: true }).catch(() => {});
    }
  }
  // First launch (this machine + ORT version): optimize once and persist it.
  return ort.InferenceSession.create(origPath, { ...base, optimizedModelFilePath: optPath });
}

export function createNodeRuntime(): SeparationRuntime {
  const ep = (process.env.ORT_EP ?? 'cpu').toLowerCase();
  return {
    engine: ep,
    async createSession(model): Promise<SeparationSession> {
      const path = typeof model === 'string' ? model : MODEL_FILE;
      const session = await createTunedSession(path, ep);
      const inputName = session.inputNames[0]!;
      const outputName = session.outputNames[0]!;
      return {
        async run(input) {
          const tensor = new ort.Tensor('float32', input.data, input.dims);
          const output = await session.run({ [inputName]: tensor });
          const out = output[outputName]!;
          return { data: out.data as Float32Array, dims: out.dims as number[] };
        },
        dispose() {
          void session.release();
        },
      };
    },
  };
}
