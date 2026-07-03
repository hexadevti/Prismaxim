# Prismaxim cloud separator

A **stateless, separation-only** GPU service: it receives audio and returns the 6
htdemucs_6s stems as lossless FLAC. No library, no YouTube, no persistence — the
app keeps its own library (IndexedDB/OPFS on web, filesystem on desktop) and calls
this only for the heavy compute. Use it as the app's opt-in **"Cloud (fast)"** mode.

Runs the **same** `separateMixture` pipeline as the rest of the repo, on the
**CUDA** execution provider when a GPU is present, falling back to **CPU**.

## HTTP contract

- `GET /health` → `{ ok: true, engine }`
- `POST /separate` — body = raw audio bytes (mp3/wav/m4a/…). Optional
  `Authorization: Bearer <CLOUD_TOKEN>`. Responds with a **framed binary** body
  (so the browser needs no unzip lib):

  ```
  repeat 6×:  [nameLen u32le][name utf8][dataLen u32le][flac bytes]
  headers:    X-Sample-Rate, X-Stem-Names, X-Engine
  ```

## Env

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | listen port |
| `MODEL_FILE` | baked path | htdemucs_6s.onnx location |
| `ORT_EP` | *(auto)* | force a provider (`cuda` / `cpu`); unset = try CUDA then CPU |
| `SEPARATION_OVERLAP` | `0.1` | window overlap (higher = smoother, slower) |
| `CLOUD_TOKEN` | *(none)* | if set, require `Authorization: Bearer <token>` |

## Run locally (CPU, for testing)

```bash
cd cloud && npm install
ORT_EP=cpu MODEL_FILE=../server/models/htdemucs_6s.onnx npm run dev   # → :8080
# in another shell:
curl -X POST --data-binary @song.mp3 http://localhost:8080/separate -o stems.bin
```

## Docker image

```bash
# from the repo root (context needs shared/ + server/models/htdemucs_6s.onnx)
docker build -f cloud/Dockerfile -t prismaxim-separator .
docker run --gpus all -p 8080:8080 prismaxim-separator     # GPU
docker run -e ORT_EP=cpu -p 8080:8080 prismaxim-separator  # CPU
```

## Deploy — Modal (recommended, scale-to-zero GPU)

```bash
pip install modal && modal setup
modal deploy cloud/modal_app.py      # from repo root → prints a public https URL
```

Point the app at that URL (`NEXT_PUBLIC_CLOUD_SEPARATE_URL`). Pay per second of
separation, ~US$0 when idle; ~US$0.005–0.01 per song on a T4.

## Deploy — RunPod (Pod)

Push the image to a registry and run it as a **GPU Pod**, exposing port `8080`
via RunPod's HTTP proxy; use that proxy URL as `NEXT_PUBLIC_CLOUD_SEPARATE_URL`.
(RunPod *serverless* uses a different job protocol; a Pod serves this raw-HTTP
contract directly.)

## Wire it into the app

Set, for the web/desktop build:

```
NEXT_PUBLIC_CLOUD_SEPARATE_URL=https://…    # the deployed endpoint
NEXT_PUBLIC_CLOUD_TOKEN=…                    # only if you set CLOUD_TOKEN
```

Then **Options → Cloud separation** shows the endpoint, and **Import** gets a
**Local / Cloud (fast)** toggle (default Local). The URL/token are also editable
at runtime in Options.

## Notes

- **CUDA version matters a lot.** onnxruntime-node 1.27's Linux GPU build links
  `libcublasLt.so.13` (cuBLAS SONAME 13, which ships in **CUDA 13** — not 12.x), so
  the runtime base is `nvidia/cuda:13.0.3-cudnn-runtime-ubuntu24.04`. A CUDA 12
  base makes the CUDA EP fail to load and the service silently falls back to CPU.
  Bump the tag if a future onnxruntime-node needs a different CUDA.
- **Two build gotchas** (handled in the Dockerfile): the CUDA EP `.so` files are
  fetched by onnxruntime-node's postinstall from NuGet — skipped if a host
  `node_modules` is copied in (`.dockerignore` + `rm -rf` fix it), and `npm prune`
  can drop them. ffmpeg-static's binary isn't preserved either, so the image uses
  the apt `ffmpeg` (`FFMPEG_PATH=ffmpeg`).
- **Verified:** a warm T4 separates an 8 s clip in ~6–7 s end-to-end and the
  response header reports `X-Engine: cuda`. If it says `cpu`, the CUDA EP failed to
  load — check `modal app logs <app>` for the missing `.so`.
- **Egress:** ~110 MB of FLAC per 3.5-min song.
