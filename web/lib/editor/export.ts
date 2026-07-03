/**
 * Clip-aware offline render of the whole arrangement, reusing the mixer's
 * WAV/MP3 encoders and download helper.
 */

import { clipEnd, effectiveTrackGain, totalDuration, type EditorProject } from './model';
import { encodeMp3, encodeWav, downloadBlob } from '../mixer/export';

export { encodeMp3, encodeWav, downloadBlob };

/** Render a single track (unmuted, full gain) to an AudioBuffer — for transcription. */
export async function renderTrack(
  project: EditorProject,
  trackId: string,
): Promise<AudioBuffer | null> {
  const track = project.tracks.find((t) => t.id === trackId);
  if (!track) return null;
  return renderProject({
    sampleRate: project.sampleRate,
    numChannels: project.numChannels,
    tracks: [{ ...track, muted: false, soloed: false, volume: 1 }],
  });
}

/** Render the arrangement (clip positions, trims, gains) to a single buffer. */
export async function renderProject(project: EditorProject): Promise<AudioBuffer> {
  const sr = project.sampleRate;
  const dur = Math.max(totalDuration(project), 1 / sr);
  const frames = Math.max(1, Math.ceil(dur * sr));
  const offline = new OfflineAudioContext(project.numChannels, frames, sr);
  const master = offline.createGain();
  master.connect(offline.destination);

  for (const track of project.tracks) {
    const g = effectiveTrackGain(project, track);
    if (g <= 0) continue;
    const trackGain = offline.createGain();
    trackGain.gain.value = g;
    trackGain.connect(master);
    for (const clip of track.clips) {
      const src = offline.createBufferSource();
      src.buffer = clip.buffer;
      const fadeIn = clip.fadeInSec ?? 0;
      const fadeOut = clip.fadeOutSec ?? 0;
      if (fadeIn > 1e-4 || fadeOut > 1e-4) {
        const cg = offline.createGain();
        src.connect(cg);
        cg.connect(trackGain);
        const g = cg.gain;
        const s = clip.startSec;
        const e = clipEnd(clip);
        g.setValueAtTime(fadeIn > 1e-4 ? 0 : 1, s);
        if (fadeIn > 1e-4) g.linearRampToValueAtTime(1, s + fadeIn);
        if (fadeOut > 1e-4) {
          g.setValueAtTime(1, Math.max(s + fadeIn, e - fadeOut));
          g.linearRampToValueAtTime(0, e);
        }
      } else {
        src.connect(trackGain);
      }
      try {
        src.start(clip.startSec, clip.offsetSec, clip.durationSec);
      } catch {
        /* out-of-range clip; skip */
      }
    }
  }
  return offline.startRendering();
}
