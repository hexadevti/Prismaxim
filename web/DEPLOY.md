# Deploying the 100% web build

The web build is **fully client-side**: stem separation runs in the browser with
**onnxruntime-web + WebGPU** (WASM fallback), and the library (imported songs,
separated stems, edited projects) is stored locally in **IndexedDB + OPFS**.
There is **no backend** — input is **file upload only** (YouTube import is
desktop-only).

> **Browser support:** Chrome/Edge (desktop). Needs WebGPU for reasonable speed,
> `credentialless` COEP, and OPFS. Safari/Firefox are not supported.

## Hard requirement: cross-origin isolation headers

Every response for the app must carry:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: credentialless
```

Without them `crossOriginIsolated` is false and `SharedArrayBuffer` (onnxruntime-web
WASM threads) + the AudioWorklet recorder break. `credentialless` (not `require-corp`)
keeps the page isolated **and** lets smplr load its General-MIDI samples cross-origin.

## Option A — Next host (Vercel / Netlify / Render)

Deploy `web/` as a normal Next.js app. The headers in
[next.config.ts](next.config.ts) (`headers()`) are applied by the Next server, so
nothing else is needed.

```bash
npm run build -w web    # normal Next build
```

## Option B — Static export (any static host)

Produces a fully static `web/out/` with no Node server:

```bash
npm run build:static -w web   # cross-env STATIC_EXPORT=1 next build → web/out
```

`output: 'export'` ignores `headers()`, so the **host** must send the COOP/COEP
headers:

- **Netlify / Cloudflare Pages** — the bundled [public/_headers](public/_headers)
  is copied into `out/` and applied automatically.
- **Vercel (static)** — add a `vercel.json`:
  ```json
  {
    "headers": [
      { "source": "/(.*)", "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "credentialless" }
      ]}
    ]
  }
  ```
- **GitHub Pages / hosts that can't set headers** — they can't send COOP/COEP, so
  use the [`coi-serviceworker`](https://github.com/gzuidhof/coi-serviceworker)
  shim (a service worker that re-serves the page isolated) as a fallback.

## Notes

- **First separation** downloads the ~258 MB `htdemucs_6s.onnx` model (then cached
  in Cache Storage). Optionally self-host it and set `NEXT_PUBLIC_MODEL_URL`; it
  must be served CORS-enabled.
- **Storage:** the app requests persistent storage on first save; large libraries
  can still hit the browser's quota. Usage is shown under **Options**.
