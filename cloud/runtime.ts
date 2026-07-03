/**
 * ONNX inference session for the cloud separator. Tries the CUDA execution
 * provider first (GPU) and falls back to CPU, so the same image runs on a GPU
 * instance or a plain CPU box. Override with ORT_EP (e.g. `cpu`).
 */

import * as ort from 'onnxruntime-node';
import type { SeparationSession } from '@prismaxim/shared';

export async function createSession(
  modelPath: string,
): Promise<{ session: SeparationSession; engine: string }> {
  const envEp = process.env.ORT_EP?.toLowerCase();
  const order = envEp ? [envEp] : ['cuda', 'cpu'];

  let created: ort.InferenceSession | null = null;
  let engine = 'cpu';
  let lastErr: unknown = null;
  for (const ep of order) {
    try {
      created = await ort.InferenceSession.create(modelPath, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
        enableCpuMemArena: true,
      });
      engine = ep;
      break;
    } catch (err) {
      lastErr = err;
      console.error(`[ort] provider '${ep}' unavailable: ${err instanceof Error ? err.message : err}`);
    }
  }
  if (!created) throw new Error(`Failed to create ONNX session: ${lastErr}`);

  const session = created;
  const inputName = session.inputNames[0]!;
  const outputName = session.outputNames[0]!;
  const wrapped: SeparationSession = {
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
  return { session: wrapped, engine };
}
