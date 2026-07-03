# Prismaxim cloud stem-separator. Build from the REPO ROOT:
#   docker build -f cloud/Dockerfile -t prismaxim-separator .
# The htdemucs_6s model must exist at server/models/htdemucs_6s.onnx (it is baked
# into the image so there is no cold-start download).

# ---- builder: install deps + bundle the service (Node, linux-x64) ----
FROM node:20-bookworm AS builder
WORKDIR /build
COPY shared ./shared
COPY cloud ./cloud
WORKDIR /build/cloud
# Drop any node_modules/dist copied in from the host — a pre-existing node_modules
# makes npm skip dependency postinstalls (so the CUDA EP download never runs).
RUN rm -rf node_modules dist
# onnxruntime-node downloads its CUDA EP shared libs from NuGet in a postinstall.
# It uses `void installPackages(...)`, so a failed download does NOT fail the
# install (and the runtime then silently falls back to CPU). Force the flag,
# surface the download logs (--foreground-scripts), and HARD-FAIL the build here
# if the CUDA libs didn't land. (No `npm prune` — it can drop these .so files.)
ENV ONNXRUNTIME_NODE_INSTALL=cuda12
RUN npm install --foreground-scripts --onnxruntime-node-install=cuda12
RUN ls -la node_modules/onnxruntime-node/bin/napi-v6/linux/x64/ \
  && test -f node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_cuda.so \
  && test -f node_modules/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_shared.so
RUN npm run build

# ---- runtime: CUDA 13 + cuDNN so onnxruntime-node's CUDA EP loads ----
# onnxruntime 1.27's Linux GPU build links libcublasLt.so.13 (cuBLAS SONAME 13,
# which ships in CUDA 13 — NOT 12.x) + cuDNN. So the base must be CUDA 13. Adjust
# the tag if a future onnxruntime-node needs a different CUDA. CPU-only hosts still
# run (the service falls back to the CPU provider).
FROM nvidia/cuda:13.0.3-cudnn-runtime-ubuntu24.04 AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates ffmpeg \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/cloud/dist ./dist
COPY --from=builder /build/cloud/node_modules ./node_modules
# Bake the model in (258 MB) so there's no download on cold start.
COPY server/models/htdemucs_6s.onnx ./model/htdemucs_6s.onnx

ENV MODEL_FILE=/app/model/htdemucs_6s.onnx
ENV PORT=8080
# Use the apt-installed system ffmpeg (ffmpeg-static's downloaded binary isn't
# reliably preserved through the multi-stage build / npm prune).
ENV FFMPEG_PATH=ffmpeg
# ORT_EP unset → tries CUDA then CPU. Set ORT_EP=cpu to force CPU.
EXPOSE 8080
CMD ["node", "dist/cloud.mjs"]
