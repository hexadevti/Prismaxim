'use client';

import { useEffect, useRef } from 'react';
import { drawSpectrum, freqBuffer } from '@/lib/mixer/spectrum';

/** Output frequency-spectrum analyzer, animated while playing. */
export default function SpectrumView({
  analyser,
  playing,
}: {
  analyser: AnalyserNode | null;
  playing: boolean;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const clear = () => canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    if (!analyser || !playing) {
      clear();
      return;
    }
    const data = freqBuffer(analyser);
    let raf = 0;
    const tick = () => {
      // Canvas fillStyle can't resolve CSS vars, so pass the accent hex directly.
      drawSpectrum(canvas, analyser, data, '#34d0ee');
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clear();
    };
  }, [analyser, playing]);

  return <canvas ref={ref} className="tool-canvas" />;
}
