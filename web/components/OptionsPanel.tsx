'use client';

import { useEffect, useState } from 'react';
import { checkBackend } from '@/lib/engines/client';
import { checkCloud } from '@/lib/engines/cloud';
import { getCloudToken, getCloudUrl, setCloudToken, setCloudUrl } from '@/lib/cloudConfig';
import { IS_DESKTOP } from '@/lib/env';
import { store } from '@/lib/store';

function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.round(n / 1e3)} KB`;
}

/** Optional cloud "fast mode" endpoint — available in both builds. */
function CloudOptions() {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [reachable, setReachable] = useState<boolean | null>(null);

  useEffect(() => {
    setUrl(getCloudUrl());
    setToken(getCloudToken());
  }, []);

  useEffect(() => {
    if (!url) {
      setReachable(null);
      return;
    }
    let cancelled = false;
    setReachable(null);
    checkCloud(url).then((ok) => {
      if (!cancelled) setReachable(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <div className="field">
      <label htmlFor="cloudurl">Cloud separation (optional, "fast mode")</label>
      <input
        id="cloudurl"
        type="text"
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          setCloudUrl(e.target.value);
        }}
        placeholder="https://…modal.run"
      />
      <input
        type="password"
        value={token}
        onChange={(e) => {
          setToken(e.target.value);
          setCloudToken(e.target.value);
        }}
        placeholder="Token (only if the endpoint requires one)"
        style={{ marginTop: 6 }}
      />
      <p className={reachable === false ? 'err' : 'hint'} style={{ marginTop: 6 }}>
        {!url
          ? 'Set a GPU endpoint (see /cloud) to enable the "Cloud (fast)" toggle on Import.'
          : reachable === null
            ? 'Checking endpoint…'
            : reachable
              ? '✓ Cloud endpoint reachable'
              : '✗ Cloud endpoint not reachable'}
      </p>
    </div>
  );
}

/** Desktop: configure/monitor the local backend. */
function DesktopOptions({
  backendUrl,
  onBackendUrlChange,
}: {
  backendUrl: string;
  onBackendUrlChange: (v: string) => void;
}) {
  const [up, setUp] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    setUp(null);
    checkBackend(backendUrl).then((ok) => {
      if (!cancelled) setUp(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [backendUrl]);

  return (
    <div className="panel">
      <h2>Options</h2>
      <div className="field">
        <label htmlFor="backend">Backend URL</label>
        <input
          id="backend"
          type="text"
          value={backendUrl}
          onChange={(e) => onBackendUrlChange(e.target.value)}
          placeholder="http://localhost:8787"
        />
        <p className={up === false ? 'err' : 'hint'} style={{ marginTop: 6 }}>
          {up === null
            ? 'Checking service…'
            : up
              ? '✓ Service reachable'
              : '✗ Service not reachable — restart the app (or start it with `npm run dev:server`).'}
        </p>
      </div>
      <p className="hint">
        The local service powers YouTube import, native stem separation, the library, and saving
        edited projects. It starts automatically with the app.
      </p>
    </div>
  );
}

/** Web: 100% in-browser — report engine + local storage usage. */
function WebOptions() {
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null);
  const [hasWebGPU, setHasWebGPU] = useState<boolean | null>(null);

  useEffect(() => {
    setHasWebGPU(typeof navigator !== 'undefined' && !!navigator.gpu);
    store.estimate?.().then(setUsage).catch(() => {});
  }, []);

  return (
    <div className="panel">
      <h2>Options</h2>
      <div className="field">
        <label>Separation engine</label>
        <p className={hasWebGPU === false ? 'warn' : 'hint'} style={{ marginTop: 6 }}>
          {hasWebGPU === null
            ? 'Runs in your browser.'
            : hasWebGPU
              ? '✓ WebGPU — fast in-browser separation.'
              : '⚠ WebGPU unavailable — falls back to WASM (much slower). Use Chrome/Edge.'}
        </p>
      </div>
      <div className="field">
        <label>Local storage</label>
        <p className="hint" style={{ marginTop: 6 }}>
          {usage
            ? `Using ${fmtBytes(usage.usage)}${usage.quota ? ` of ~${fmtBytes(usage.quota)} available` : ''}.`
            : 'Your library (songs, stems, edited projects) is saved in this browser.'}
        </p>
      </div>
      <p className="hint">
        Everything runs locally — no server. Audio never leaves your machine. Best in Chrome/Edge.
      </p>
      <CloudOptions />
    </div>
  );
}

export default function OptionsPanel({
  backendUrl,
  onBackendUrlChange,
}: {
  backendUrl: string;
  onBackendUrlChange: (v: string) => void;
}) {
  return IS_DESKTOP ? (
    <DesktopOptions backendUrl={backendUrl} onBackendUrlChange={onBackendUrlChange} />
  ) : (
    <WebOptions />
  );
}
