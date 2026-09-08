# Deploying the 100% web build

The web build is **fully client-side**: stem separation runs in the browser with
**onnxruntime-web + WebGPU** (WASM fallback), and the library (imported songs,
separated stems, edited projects) is stored locally in **IndexedDB + OPFS**.
There is **no backend** — input is **file upload only** (YouTube import is
desktop-only).

> **Browser support:** Chrome/Edge (desktop). Needs WebGPU for reasonable speed,
> `credentialless` COEP, and OPFS. Safari/Firefox are not supported.

**This repo is configured for Cloudflare Pages** — see
[Option C](#option-c--cloudflare-pages-this-repos-setup), which is the path
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

## Option C — Cloudflare Pages (this repo's setup)

[wrangler.jsonc](../wrangler.jsonc) at the repo root deploys `web/out` to the
**`prismaxim` Pages project** (`https://prismaxim.pages.dev`) as a direct upload —
no git integration, no build on Cloudflare's side. Deploy from the repo root:

```bash
npm run deploy          # build → prune → wrangler pages deploy
npm run deploy:build    # build + prune only, to inspect web/out first
```

Pages has **no `build.command` hook** (that is a Workers feature), so the build
and prune steps live in the npm script. Run `npm run deploy` rather than calling
`wrangler pages deploy` directly, or you will upload a stale or unpruned
`web/out`.

Authentication is via `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in the
environment (or an interactive `npx wrangler login`).

**Headers.** Pages reads [public/_headers](public/_headers) (copied to `out/` by
Next) and applies the COOP/COEP pair as configuration rather than uploading it as
an asset — so the deployed site is cross-origin isolated even though
`output: 'export'` drops Next's own `headers()`. Verify after a deploy:

```bash
curl -sI https://prismaxim.pages.dev/ | grep -i cross-origin
# cross-origin-embedder-policy: credentialless
# cross-origin-opener-policy: same-origin
```

**The 25 MiB per-file limit.** The build emits two ONNX Runtime wasm binaries
that each exceed it, and Pages **aborts the entire upload** when it walks one:

| Binary | Size | Loaded at runtime from |
|---|---|---|
| app's `onnxruntime-web` (Demucs separation) | ~26 MB | jsDelivr, via `ORT_WASM_BASE_URL` in [lib/config.ts](lib/config.ts) |
| Transformers.js's bundled copy (Whisper lyrics) | ~21 MB | jsDelivr, via Transformers.js's own `wasmPaths` default |

Neither is ever requested locally, so both are deleted from `web/out` before the
upload by [scripts/pages-prune.mjs](../scripts/pages-prune.mjs), which also fails
the deploy if any *other* oversized file appears.

> **Note:** Pages does **not** read `.assetsignore` — that is Workers Static
> Assets only, and its Pages ignore list is hardcoded in wrangler. Deleting the
> files is the only way to exclude them. [public/.assetsignore](public/.assetsignore)
> is kept for a possible Workers deploy; on Pages the prune script is what counts.

**Build-time env vars.** `NEXT_PUBLIC_*` values are baked in at build time, and
because this is a direct upload the build runs **on your machine** — so
`web/.env.local` (gitignored) is what applies. Set
`NEXT_PUBLIC_CLOUD_SEPARATE_URL` / `NEXT_PUBLIC_CLOUD_TOKEN` there to enable
"Cloud (fast)" mode; without them the toggle is simply hidden.

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
