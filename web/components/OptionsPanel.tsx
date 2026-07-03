'use client';

import { useEffect, useState } from 'react';
import { checkBackend } from '@/lib/engines/client';

export default function OptionsPanel({
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
