# Deploying the 100% web build

The web build is **fully client-side**: stem separation runs in the browser with
**onnxruntime-web + WebGPU** (WASM fallback), and the library (imported songs,
separated stems, edited projects) is stored locally in **IndexedDB + OPFS**.
There is **no backend** — input is **file upload only** (YouTube import is
desktop-only).

> **Browser support:** Chrome/Edge (desktop). Needs WebGPU for reasonable speed,
> `credentialless` COEP, and OPFS. Safari/Firefox are not supported.

**This repo is configured for Cloudflare Workers** (static assets) — see
[Option C](#option-c--cloudflare-workers-this-repos-setup), which is the path
[wrangler.jsonc](../wrangler.jsonc) implements. Options A and B describe the
generic alternatives.

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

## Option C — Cloudflare Workers (this repo's setup)

[wrangler.jsonc](../wrangler.jsonc) at the repo root deploys `web/out` as an
**assets-only Worker** — static assets, no server code. The build is declared in
the config, so the deploy is self-contained:

```bash
npm run deploy        # runs build.command, then uploads web/out
npm run deploy:dry    # same, but checks the upload without publishing
```

`build.command` runs `npm run build:static -w web`, so `wrangler deploy` alone is
enough — no separate build step. The `name` in `wrangler.jsonc` must match the
Worker in your Cloudflare dashboard.

**Git-connected builds.** In the dashboard's *Import a repository* flow, set the
**Deploy command** to `npx wrangler deploy` and leave the **Build command
blank** — `build.command` already builds, so filling that field just builds
twice. (`npm run deploy:build` is available if the field cannot be left empty.)

**Headers.** Workers Static Assets applies [public/_headers](public/_headers)
(copied to `out/` by Next), which sends the COOP/COEP pair above — so the
deployed site is cross-origin isolated even though `output: 'export'` drops
Next's own `headers()`. Verify after a deploy:

```bash
curl -sI https://<your-worker-url>/ | grep -i cross-origin
# cross-origin-embedder-policy: credentialless
# cross-origin-opener-policy: same-origin
```

**The 25 MiB per-file asset limit.** The build emits two ONNX Runtime wasm
binaries that each exceed it, and both are excluded from the upload by
[public/.assetsignore](public/.assetsignore):

| Binary | Size | Loaded at runtime from |
|---|---|---|
| app's `onnxruntime-web` (Demucs separation) | ~26 MB | jsDelivr, via `ORT_WASM_BASE_URL` in [lib/config.ts](lib/config.ts) |
| Transformers.js's bundled copy (Whisper lyrics) | ~21 MB | jsDelivr, via Transformers.js's own `wasmPaths` default |

Nothing requests the local copies, so dropping them is safe — but if you ever
self-host either runtime, remove the matching `.assetsignore` glob. Note that
`ORT_WASM_BASE_URL` is pinned to a version that **must match** the installed
`onnxruntime-web`; bump both together.

> **Why Workers and not Pages?** Cloudflare *Pages* does not read
> `.assetsignore` — its ignore list is hardcoded — and it aborts the whole
> upload on any file over 25 MiB. Deploying this build to Pages therefore means
> physically deleting those two wasm files first. Workers Static Assets honours
> `.assetsignore`, so no extra step is needed.

**Build-time env vars.** `NEXT_PUBLIC_*` values are baked in at build time. Local
builds read `web/.env.local` (gitignored), which Cloudflare does not have — set
`NEXT_PUBLIC_CLOUD_SEPARATE_URL` / `NEXT_PUBLIC_CLOUD_TOKEN` as build variables
in the dashboard if you want "Cloud (fast)" mode on the deployed site. Without
them the toggle is simply hidden.

## Notes

- **First separation** downloads the ~258 MB `htdemucs_6s.onnx` model (then cached
  in Cache Storage). Optionally self-host it and set `NEXT_PUBLIC_MODEL_URL`; it
  must be served CORS-enabled.
- **First lyrics transcription** downloads the Whisper model
  (`NEXT_PUBLIC_WHISPER_MODEL_ID`, default `onnx-community/whisper-base`) from the
  Hugging Face Hub, then caches it in the browser. Like the separation model it is
  fetched cross-origin, which `credentialless` COEP allows.
- **Cloud "fast mode" (optional):** to offer GPU separation, set
  `NEXT_PUBLIC_CLOUD_SEPARATE_URL` (and `NEXT_PUBLIC_CLOUD_TOKEN` if the endpoint
  needs one) in the site's environment — they're read at build time and there is
  no in-app editing. An empty URL hides the "Cloud (fast)" toggle on Import.
- **Storage:** the app requests persistent storage on first save; large libraries
  can still hit the browser's quota. Usage is shown under **Options**.
