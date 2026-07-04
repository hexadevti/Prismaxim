'use client';

import { Activity, AudioLines, PanelRightClose, Plus, X } from 'lucide-react';
import type { ToolInstance, ToolKind } from '@/lib/editor/tools';
import VuMeter from './VuMeter';
import SpectrumView from './SpectrumView';

const LABELS: Record<ToolKind, string> = { vu: 'VU meter', spectrum: 'Spectrum' };

export interface ToolSourceOption {
  value: string;
  label: string;
}

export interface ToolsPanelProps {
  items: ToolInstance[];
  /** Selectable sources: Audio In, Audio Out, and each track. */
  sources: ToolSourceOption[];
  /** Resolve the AnalyserNode for a tool's source (null when unavailable). */
  getAnalyser: (source: string) => AnalyserNode | null;
  playing: boolean;
  onAdd: (kind: ToolKind) => void;
  onRemove: (id: string) => void;
  onSetSource: (id: string, source: string) => void;
  onClose: () => void;
}

/** Right sidebar of user-created visualizers, each bound to a selectable source. */
export default function ToolsPanel(p: ToolsPanelProps) {
  return (
    <aside className="editor-tools">
      <div className="tools-head">
        <div className="tools-title">
          <strong>Tools</strong>
        </div>
        <button className="btn ghost tools-close" title="Close tools" onClick={p.onClose}>
          <PanelRightClose size={16} />
        </button>
      </div>

      <div className="tools-add">
        <button className="btn secondary" onClick={() => p.onAdd('vu')} title="Add a VU meter">
          <Plus size={14} /> VU
        </button>
        <button
          className="btn secondary"
          onClick={() => p.onAdd('spectrum')}
          title="Add a spectrum analyzer"
        >
          <Plus size={14} /> Spectrum
        </button>
      </div>

      {p.items.length === 0 ? (
        <p className="tools-empty hint">
          Add a visualizer with the buttons above, then pick its source.
        </p>
      ) : (
        <div className="tools-list">
          {p.items.map((t) => {
            const analyser = p.getAnalyser(t.source);
            // The input is live whenever it's open; playback sources need transport.
            const active = t.source === 'in' ? true : p.playing;
            return (
              <div key={t.id} className="tool-card">
                <div className="tool-card-head">
                  <span className="tool-card-title">
                    {t.kind === 'vu' ? <Activity size={13} /> : <AudioLines size={13} />}
                    {LABELS[t.kind]}
                  </span>
                  <button className="mini" title="Remove" onClick={() => p.onRemove(t.id)}>
                    <X size={13} />
                  </button>
                </div>
                <select
                  className="tool-source"
                  value={t.source}
                  onChange={(e) => p.onSetSource(t.id, e.target.value)}
                  title="Source"
                >
                  {p.sources.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <div className="tool-card-body">
                  {t.kind === 'vu' ? (
                    <VuMeter analyser={analyser} playing={active} />
                  ) : (
                    <SpectrumView analyser={analyser} playing={active} />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </aside>
  );
}
