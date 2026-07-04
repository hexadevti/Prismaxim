'use client';

import { useEffect, useRef } from 'react';
import { meterFraction, rmsLevel, timeBuffer } from '@/lib/mixer/meter';

/** Output-level VU meter with a slow-decay peak-hold, animated while playing. */
export default function VuMeter({
  analyser,
  playing,
}: {
  analyser: AnalyserNode | null;
  playing: boolean;
}) {
  const fillRef = useRef<HTMLDivElement>(null);
  const peakRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fill = fillRef.current;
    const peak = peakRef.current;
    if (!fill) return;
    const reset = () => {
      fill.style.width = '0%';
      if (peak) peak.style.left = '0%';
    };
    if (!analyser || !playing) {
      reset();
      return;
    }
    const buf = timeBuffer(analyser);
    let raf = 0;
    let peakFrac = 0;
    const tick = () => {
      const frac = meterFraction(rmsLevel(analyser, buf));
      fill.style.width = `${frac * 100}%`;
      fill.style.background =
        frac > 0.92 ? 'var(--danger)' : frac > 0.75 ? 'var(--warn)' : 'var(--ok)';
      peakFrac = frac > peakFrac ? frac : Math.max(frac, peakFrac - 0.006);
      if (peak) peak.style.left = `${peakFrac * 100}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      reset();
    };
  }, [analyser, playing]);

  return (
    <div className="vu-meter" title="Output level">
      <div ref={fillRef} className="vu-fill" />
      <div ref={peakRef} className="vu-peak" />
    </div>
  );
}
