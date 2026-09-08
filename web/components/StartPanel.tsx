'use client';

import { useEffect, useRef, useState } from 'react';
import type {
  ExtractionEngine,
  JobConfig,
  SeparationEngine,
  SelectableStem,
  YouTubeSearchResult,
} from '@prismaxim/shared';
import { checkBackend } from '@/lib/engines/client';
import { IS_DESKTOP, IS_MOBILE } from '@/lib/env';
import { cloudConfigured } from '@/lib/cloudConfig';
import { searchYouTube } from '@/lib/library';
import { addToHistory, getHistory, removeFromHistory, type HistoryEntry } from '@/lib/history';
import StemPicker from './StemPicker';

type InputKind = 'youtube' | 'file';
/** How the user names a YouTube video: search by song name, or paste a URL. */
type YouTubeMode = 'search' | 'link';
/** Where a finished import lands: its own tab, or appended to the open project. */
export type ImportMode = 'new' | 'add';

/** 245 → "4:05". Undefined duration renders nothing. */
function formatDuration(seconds?: number): string | null {
  if (!seconds || !Number.isFinite(seconds)) return null;
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 875106068 → "875M views". */
function formatViews(views?: number): string | null {
  if (!views || !Number.isFinite(views)) return null;
  if (views >= 1e9) return `${(views / 1e9).toFixed(1)}B views`;
  if (views >= 1e6) return `${Math.round(views / 1e6)}M views`;
  if (views >= 1e3) return `${Math.round(views / 1e3)}K views`;
  return `${views} views`;
}

export interface StartPanelProps {
  onStart: (config: JobConfig, file: File | null, mode: ImportMode) => void;
  backendUrl: string;
  /** true when the editor already has a project to add the import into. */
  canAddToProject?: boolean;
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="seg" role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={o.value === value ? 'active' : ''}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The chosen search hit, with a link out to YouTube so a song can be checked
 * before committing to a download + separation run.
 *
 * Deliberately not an inline player. The app serves itself with
 * `COEP: credentialless` — cross-origin isolation is what gives onnxruntime-web
 * its SharedArrayBuffer threads — and an embedded YouTube frame does not play
 * reliably under it. The link opens in the system browser instead: the desktop
 * window denies in-app navigation and hands the URL to the OS (see
 * setWindowOpenHandler in desktop/main.mjs).
 */
function YouTubePreview({ result }: { result: YouTubeSearchResult }) {
  const meta = [
    formatDuration(result.durationSeconds),
    result.uploader,
    formatViews(result.viewCount),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <a
      className="yt-preview"
      href={result.url}
      target="_blank"
      rel="noopener noreferrer"
      title="Watch on YouTube in your browser"
    >
      <span className="yt-preview-thumb">
        {result.thumbnailUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={result.thumbnailUrl} alt="" loading="lazy" />
        )}
        <span className="yt-preview-play" aria-hidden="true" />
      </span>
      <span className="yt-preview-info">
        <span className="yt-preview-title">{result.title}</span>
        {meta && <span className="yt-preview-meta">{meta}</span>}
        <span className="yt-preview-link">Watch on YouTube ↗</span>
      </span>
    </a>
  );
}

export default function StartPanel({ onStart, backendUrl, canAddToProject }: StartPanelProps) {
  const [inputKind, setInputKind] = useState<InputKind>(IS_DESKTOP ? 'youtube' : 'file');
  const [url, setUrl] = useState('');
  // YouTube by search (default) or by pasted link.
  const [ytMode, setYtMode] = useState<YouTubeMode>('search');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<YouTubeSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  /** The query whose results are on screen — drives the "no results" message. */
  const [searchedFor, setSearchedFor] = useState<string | null>(null);
  const [chosen, setChosen] = useState<YouTubeSearchResult | null>(null);
  // Ignore a slow search that a newer one has already superseded.
  const searchSeq = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [extraction, setExtraction] = useState<ExtractionEngine>('backend');
  const [backendUp, setBackendUp] = useState<boolean | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // Web build: report the browser separation engine so the user knows what to expect.
  const [hasWebGPU, setHasWebGPU] = useState<boolean | null>(null);
  // Optional cloud "fast mode": shown only when a cloud endpoint is configured.
  // On mobile the WebView has no WebGPU and no WASM threads, so cloud is the
  // default — on-device separation is an experimental fallback (see Options).
  const [hasCloud, setHasCloud] = useState(false);
  const [useCloud, setUseCloud] = useState(IS_MOBILE);
  // Low-RAM mobile devices can run out of memory decoding a long 6-stem track.
  const [lowMemory, setLowMemory] = useState(false);
  // Which stems to produce — real sources plus an optional "remaining" bucket.
  // Default: none — the track loads unseparated and the user opts into the stems
  // they want. Selecting fewer cuts memory, encoding and (on cloud/backend)
  // download — the model still runs one full pass.
  const [stems, setStems] = useState<SelectableStem[]>([]);
  // Import into a fresh project (replace) or add to the one already open.
  const [importMode, setImportMode] = useState<ImportMode>('new');

  // Load link history on mount (client-only).
  useEffect(() => {
    setHistory(getHistory());
  }, []);

  // A pick that survives into a new result set stays selected; otherwise drop it,
  // so the tick and the preview never disagree with the list on screen.
  useEffect(() => {
    if (!chosen || results.some((r) => r.videoId === chosen.videoId)) return;
    setChosen(null);
    setUrl('');
  }, [results, chosen]);

  useEffect(() => {
    // WebGPU capability only matters for the pure-web build; a mobile WebView
    // never exposes navigator.gpu, so don't surface a misleading message there.
    if (!IS_DESKTOP && !IS_MOBILE) setHasWebGPU(typeof navigator !== 'undefined' && !!navigator.gpu);
    setHasCloud(cloudConfigured());
    if (IS_MOBILE && typeof navigator !== 'undefined') {
      // navigator.deviceMemory (Android/Chromium) is approximate RAM in GB, capped
      // at 8. ≤4 GB devices risk an out-of-memory crash on long tracks.
      const gb = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
      if (typeof gb === 'number' && gb <= 4) setLowMemory(true);
    }
  }, []);

  // Cloud separation currently applies to uploaded files.
  const cloudApplies = hasCloud && inputKind === 'file';
  const cloudActive = cloudApplies && useCloud;

  // Only the desktop build talks to a backend (YouTube import + native separation).
  const needsBackend = IS_DESKTOP;

  useEffect(() => {
    let cancelled = false;
    if (!needsBackend) {
      setBackendUp(null);
      return;
    }
    setBackendUp(null);
    checkBackend(backendUrl).then((ok) => {
      if (!cancelled) setBackendUp(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [needsBackend, backendUrl]);

  const canStart =
    (inputKind === 'file' && !!file) || (inputKind === 'youtube' && url.trim().length > 0);
  const willSeparate = stems.length > 0;

  async function runSearch() {
    const q = query.trim();
    if (!q || searching) return;
    const seq = ++searchSeq.current;
    setSearching(true);
    setSearchError(null);
    try {
      const found = await searchYouTube(backendUrl.replace(/\/$/, ''), q);
      if (seq !== searchSeq.current) return; // superseded by a newer search
      setResults(found);
      setSearchedFor(q);
    } catch (err) {
      if (seq !== searchSeq.current) return;
      setResults([]);
      setSearchedFor(q);
      setSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  }

  /** Pick a search hit: that's the whole choice — the rest of the flow is unchanged. */
  function choose(result: YouTubeSearchResult) {
    setChosen(result);
    setUrl(result.url);
  }

  function start(mode: ImportMode) {
    // Remember the title too when the URL came from a search hit, so the recent
    // chips read as song names rather than watch URLs.
    if (inputKind === 'youtube') setHistory(addToHistory(url.trim(), chosen?.title));
    const localEngine: SeparationEngine = IS_DESKTOP ? 'backend' : 'browser';
    const separation: SeparationEngine = cloudActive ? 'cloud' : localEngine;
    const config: JobConfig = {
      input:
        inputKind === 'file'
          ? { kind: 'file', fileName: file!.name }
          : { kind: 'youtube', url: url.trim(), extraction },
      separation,
      backendBaseUrl: backendUrl.replace(/\/$/, ''),
      stems,
    };
    onStart(config, inputKind === 'file' ? file : null, canAddToProject ? mode : 'new');
  }

  return (
    <div className="panel">
      <h2>1 · Choose your source</h2>

      {/* Input kind: web build is upload-only (YouTube import is desktop-only). */}
      {IS_DESKTOP && (
        <div className="field">
          <Segmented
            value={inputKind}
            onChange={setInputKind}
            options={[
              { value: 'youtube', label: 'YouTube link' },
              { value: 'file', label: 'Upload file' },
            ]}
          />
        </div>
      )}

      {inputKind === 'youtube' ? (
        <>
          <div className="field">
            <Segmented
              value={ytMode}
              onChange={setYtMode}
              options={[
                { value: 'search', label: 'Search by name' },
                { value: 'link', label: 'Paste a link' },
              ]}
            />
          </div>

          {ytMode === 'search' ? (
            <div className="field">
              <label htmlFor="ytq">Song or artist</label>
              <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                <input
                  id="ytq"
                  type="search"
                  placeholder="e.g. tears for fears everybody wants to rule the world"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void runSearch();
                    }
                  }}
                  style={{ flex: 1, minWidth: 0 }}
                />
                <button
                  type="button"
                  className="btn secondary"
                  disabled={!query.trim() || searching || backendUp === false}
                  onClick={() => void runSearch()}
                >
                  {searching ? 'Searching…' : 'Search'}
                </button>
              </div>

              {searchError && (
                <p className="err" style={{ marginTop: 8 }}>
                  {searchError}
                </p>
              )}

              {!searchError && !searching && searchedFor && results.length === 0 && (
                <p className="hint" style={{ marginTop: 8 }}>
                  No results for “{searchedFor}”.
                </p>
              )}

              {results.length > 0 && (
                <>
                  <div className="yt-results">
                    {results.map((r) => {
                      const picked = chosen?.videoId === r.videoId;
                      const meta = [r.uploader, formatDuration(r.durationSeconds), formatViews(r.viewCount)]
                        .filter(Boolean)
                        .join(' · ');
                      return (
                        <button
                          key={r.videoId}
                          type="button"
                          className={`lib-item yt-result${picked ? ' picked' : ''}`}
                          aria-pressed={picked}
                          onClick={() => choose(r)}
                        >
                          {r.thumbnailUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              className="lib-thumb"
                              src={r.thumbnailUrl}
                              alt=""
                              loading="lazy"
                              onError={(e) => {
                                e.currentTarget.style.visibility = 'hidden';
                              }}
                            />
                          ) : null}
                          <span className="lib-info yt-result-info">
                            <span className="yt-result-title">{r.title}</span>
                            {meta && <span className="yt-result-meta">{meta}</span>}
                          </span>
                          <span className="yt-result-mark" aria-hidden="true">
                            {picked ? '✓' : ''}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {chosen ? (
                    <YouTubePreview result={chosen} />
                  ) : (
                    <p className="hint" style={{ marginTop: 8 }}>
                      Pick a song — the app handles the download and the rest.
                    </p>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="field">
              <label htmlFor="yturl">YouTube URL</label>
              <input
                id="yturl"
                type="url"
                placeholder="https://www.youtube.com/watch?v=…"
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setChosen(null); // a hand-typed URL is no longer the search pick
                }}
              />
            </div>
          )}

          {history.length > 0 && (
            <div className="field">
              <div className="hint" style={{ marginBottom: 4 }}>
                Recent links:
              </div>
              <div className="row" style={{ gap: 6 }}>
                {history.slice(0, 8).map((h) => (
                  <span key={h.url} className="chip">
                    <button
                      type="button"
                      className="chip-main"
                      title={h.url}
                      onClick={() => {
                        // Show what was picked: the link field is where a bare
                        // URL is visible, so reveal it rather than leaving the
                        // search results contradicting the selection.
                        setUrl(h.url);
                        setChosen(null);
                        setYtMode('link');
                      }}
                    >
                      {h.title || h.url.replace(/^https?:\/\/(www\.)?/, '')}
                    </button>
                    <button
                      type="button"
                      className="chip-x"
                      title="Remove"
                      onClick={() => setHistory(removeFromHistory(h.url))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="field">
            <label>Extraction engine</label>
            <Segmented
              value={extraction}
              onChange={setExtraction}
              options={[
                { value: 'backend', label: 'Backend (reliable)' },
                { value: 'browser', label: 'Browser (via proxy)' },
              ]}
            />
            {extraction === 'browser' && (
              <p className="warn" style={{ marginTop: 8 }}>
                Browser extraction still routes through the backend&apos;s CORS proxy — the
                backend must be running.
              </p>
            )}
          </div>
        </>
      ) : (
        <div className="field">
          <label>Audio file</label>
          <div
            className={`dropzone${dragging ? ' drag' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const f = e.dataTransfer.files?.[0];
              if (f) setFile(f);
            }}
            onClick={() => document.getElementById('fileInput')?.click()}
          >
            {file ? (
              <strong>{file.name}</strong>
            ) : (
              <>Drop an MP3 / WAV / M4A here, or click to browse</>
            )}
          </div>
          <input
            id="fileInput"
            type="file"
            accept="audio/*"
            style={{ display: 'none' }}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
      )}

      {/* Which stems to separate (0–6). Default: none → load the original track. */}
      <div className="field">
        <label>Stems to separate</label>
        <StemPicker value={stems} onChange={setStems} />
      </div>

      {/* Opt-in cloud "fast mode" (only when an endpoint is configured). */}
      {cloudApplies && (
        <div className="field">
          <label>Separation</label>
          <Segmented
            value={useCloud ? 'cloud' : 'local'}
            onChange={(v) => setUseCloud(v === 'cloud')}
            options={[
              {
                value: 'local',
                label: IS_DESKTOP ? 'Local (native)' : IS_MOBILE ? 'On-device (beta)' : 'Local (WASM)',
              },
              { value: 'cloud', label: 'Cloud (fast)' },
            ]}
          />
        </div>
      )}

      {/* Cloud fast-mode, backend status (desktop), or WebGPU capability (web). */}
      {cloudActive ? (
        <p className="hint" style={{ marginTop: 16, marginBottom: 12 }}>
          ⚡ Cloud (fast) — separation runs on your GPU endpoint.
        </p>
      ) : needsBackend ? (
        <p
          className={backendUp === false ? 'err' : 'hint'}
          style={{ marginTop: 16, marginBottom: 12 }}
        >
          {backendUp === null
            ? 'Checking service…'
            : backendUp
              ? '✓ Separation service ready'
              : '✗ Separation service not reachable — check the URL in Options.'}
        </p>
      ) : IS_MOBILE ? (
        <p className="warn" style={{ marginTop: 16, marginBottom: 12 }}>
          {hasCloud
            ? '⚡ Cloud is recommended on mobile. On-device (beta) runs single-threaded — slow and may fail on long tracks.'
            : '⚠ On-device (beta) separation is slow and memory-heavy. Set a cloud endpoint in Options for fast, reliable results.'}
        </p>
      ) : (
        <p
          className={hasWebGPU === false ? 'warn' : 'hint'}
          style={{ marginTop: 16, marginBottom: 12 }}
        >
          {hasWebGPU === null
            ? 'Separation runs in your browser.'
            : hasWebGPU
              ? '✓ WebGPU ready — fast in-browser separation (Chrome/Edge).'
              : '⚠ WebGPU unavailable — separation falls back to WASM (much slower). Use Chrome/Edge.'}
        </p>
      )}

      {IS_MOBILE && lowMemory && (
        <p className="warn" style={{ marginTop: 0, marginBottom: 12 }}>
          ⚠ This device is low on memory — long tracks (over ~4 min) may close the app
          while importing. Try shorter clips for the most reliable results.
        </p>
      )}

      {canAddToProject && (
        <div className="field">
          <label>Import as</label>
          <Segmented
            value={importMode}
            onChange={setImportMode}
            options={[
              { value: 'new', label: 'New tab' },
              { value: 'add', label: 'Add to this project' },
            ]}
          />
        </div>
      )}

      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn" disabled={!canStart} onClick={() => start(importMode)}>
          {importMode === 'add'
            ? willSeparate
              ? 'Separate & add ＋'
              : 'Add track ＋'
            : willSeparate
              ? 'Split into stems →'
              : 'Load track →'}
        </button>
      </div>
    </div>
  );
}
