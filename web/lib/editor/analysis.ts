/**
 * Persistable musical analysis of a freshly separated project.
 *
 * Runs the offline DSP analysers (key/tempo/tempo-stability + loudness) over a
 * mono mixdown reconstructed from the stems, producing an `AnalysisMeta` that is
 * stored in the library alongside the project. This lets the library display and
 * search on key/BPM/loudness without re-analysing on every open.
 *
 * Cheap-by-design: it sums the stems into a single mono Float32Array (not a full
 * stereo copy of every stem) so the extra memory at save time is one song-length
 * buffer, not a second StemSet.
 */

import type { AnalysisMeta, StemSet } from '@prismaxim/shared';
import { detectKey, detectTempo, tempoStability } from './analyze';
import { makeAudioBuffer } from './model';

const round1 = (x: number) => Math.round(x * 10) / 10;

/**
 * Reconstruct a mono mixdown from a StemSet. Summing each stem's own mono
 * (averaged across its channels) reproduces the mixture mono, since the
 * individual stems plus the optional `remaining` bucket partition the mixture.
 */
function stemSetToMono(set: StemSet): AudioBuffer {
  const n = set.length;
  const mono = new Float32Array(n);
  for (const stem of set.stems) {
    const chans = stem.channels;
    const inv = 1 / Math.max(1, chans.length);
    for (const ch of chans) {
      const len = Math.min(n, ch.length);
      for (let i = 0; i < len; i++) mono[i] = mono[i]! + ch[i]! * inv;
    }
  }
  return makeAudioBuffer([mono], set.sampleRate);
}

/** RMS/peak levels (dBFS) of a mono signal. */
function levels(mono: Float32Array): { rmsDb: number; peakDb: number } {
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < mono.length; i++) {
    const v = mono[i]!;
    sum += v * v;
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const rms = Math.sqrt(sum / Math.max(1, mono.length));
  return { rmsDb: 20 * Math.log10(rms || 1e-9), peakDb: 20 * Math.log10(peak || 1e-9) };
}

/**
 * Compute the persistable analysis for a separated StemSet. Best-effort and
 * synchronous; callers should treat a throw as "no analysis" and still save.
 */
export function computeStemSetAnalysis(set: StemSet): AnalysisMeta {
  const buf = stemSetToMono(set);
  const bpm = detectTempo(buf);
  const { key, scale } = detectKey(buf);
  const stability = tempoStability(buf, bpm);
  const { rmsDb, peakDb } = levels(buf.getChannelData(0));
  return {
    key,
    scale,
    bpm,
    tempoStability: stability,
    lufs: round1(-0.691 + rmsDb),
    dynamicRange: round1(peakDb - rmsDb),
    peakDb: round1(peakDb),
  };
}
