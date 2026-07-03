# Prismaxim desktop app (Windows)

A single Electron app that bundles the whole thing — the UI **and** the Fastify
backend — into one installable Windows program. Because it runs on your own
machine, **yt-dlp uses your home (residential) IP, so YouTube import just works**
(no cookies/proxies like the cloud needs).

## How it's put together

- The web UI is exported as a **static bundle** (`BUILD_TARGET=desktop next build` → `web/out`).
- The backend is bundled to a single file (`desktop/dist/backend.mjs`) with esbuild. It also
  **serves the static UI on its own origin** (with the COOP/COEP isolation headers), so the whole
  app is one local server on `127.0.0.1:8787`.
- Electron (`desktop/main.mjs`) starts that backend in-process and opens a window pointed at it.
- Per-user data (library, saved projects, the ~258 MB separation model, the yt-dlp binary) lives
  under the app's `userData` folder (`%APPDATA%/Prismaxim/data`), so it survives updates.

The `desktop/` project is **standalone** (its own `node_modules`) so it doesn't disturb the web /
Docker workspaces.

## Prerequisites (one-time)

```bash
npm install                 # repo root — web/server/shared deps
cd desktop && npm install   # Electron, electron-builder, esbuild + backend runtime deps
```

## Run it in dev

```bash
# from desktop/
npm run dev
```

That exports the static UI (`../web`), bundles the backend, and launches the Electron window.

## Build the Windows installer

```bash
# from desktop/
npm run dist
```

electron-builder produces an **NSIS installer** in `desktop/release/` (e.g.
`Prismaxim Setup <version>.exe`). Native modules (`onnxruntime-node`, `ffmpeg-static`) are
unpacked from the asar automatically; `web/out` is shipped as an app resource.

> Build the Windows installer **on Windows** (or a Windows CI runner). The native `onnxruntime-node`
> binary in the package must match the target OS/arch.

## Code signing (removes the SmartScreen warning)

The installer is **unsigned** by default, so Windows SmartScreen warns on first run
("More info → Run anyway"). electron-builder signs automatically when it finds a certificate in the
environment — **no config change needed**, just set two env vars before building:

```powershell
# PowerShell (Windows), from desktop/
$env:CSC_LINK = "C:\path\to\certificate.pfx"   # path to the .pfx (or a base64 string of it)
$env:CSC_KEY_PASSWORD = "the-pfx-password"
npm run dist                                    # now produces a signed installer
```

Getting a certificate:

- **Self-signed** — for testing the signing flow only; does **not** clear the warning for other
  users. Create with `New-SelfSignedCertificate` and export to `.pfx`.
- **Trusted OV/EV cert** — from a CA (DigiCert, Sectigo, SSL.com…). Since mid-2023 the private key
  must live on a **hardware token/HSM** or a **cloud signing service**, so a plain `.pfx` usually
  isn't issued anymore. For those, sign via **Azure Trusted Signing** (`build.win.azureSignOptions`
  in `desktop/package.json`, no hardware) or a custom `sign` hook that calls `signtool` against the
  token/service. An **EV** cert is trusted by SmartScreen immediately; an **OV** cert earns
  reputation gradually.

## Notes & known rough edges

- **First separation** downloads the 258 MB `htdemucs_6s.onnx` model into `userData` (one time).
  You can pre-seed it or point `MODEL_URL` elsewhere.
- **First YouTube import** downloads `yt-dlp.exe` into `userData/data/bin` (one time).
- **RAM:** native separation is heavy — a couple of GB free is comfortable.
- **Browser engine:** Electron is Chromium, so the sample instruments (smplr), cross-origin
  isolation and AudioWorklet recorder all work like in Chrome/Edge.
- If the backend fails to boot, the window won't open (the bundled server currently `exit`s on a
  fatal startup error). Run `npm run desktop:dev` from a terminal to see the backend logs.
- Optional niceties not wired yet: app icon (`build.win.icon`) and auto-update.
