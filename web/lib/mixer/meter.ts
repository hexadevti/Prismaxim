/** Level metering helpers: RMS from an AnalyserNode's time-domain data. */

/** Allocate the reusable byte buffer for an analyser's time-domain samples. */
export function timeBuffer(analyser: AnalyserNode): Uint8Array<ArrayBuffer> {
  return new Uint8Array(analyser.fftSize);
}

/**
 * RMS level of the current signal, ~0..1. Bytes are centered at 128; we map to
 * −1..1 and take the root-mean-square, which tracks perceived loudness better
 * than peak for a VU meter.
 */
export function rmsLevel(analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = (buf[i]! - 128) / 128;
    sum += x * x;
  }
  return Math.sqrt(sum / buf.length);
}

/**
 * Map a linear level (0..1) to a 0..1 meter fill on a dB scale, so quiet-but-audible
 * signal still reads on the meter. `floorDb` is the bottom of the scale (silence).
 */
export function meterFraction(level: number, floorDb = -60): number {
  if (level <= 0) return 0;
  const db = 20 * Math.log10(level);
  const frac = (db - floorDb) / -floorDb;
  return frac < 0 ? 0 : frac > 1 ? 1 : frac;
}
