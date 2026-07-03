# Modal deployment for the Prismaxim cloud separator.
#
#   pip install modal && modal setup            # one-time
#   modal serve cloud/modal_app.py              # live test (auto-reload)
#   modal deploy cloud/modal_app.py             # deploy → prints a public URL
#
# Run from the REPO ROOT so the Docker build context can see shared/ and the
# model at server/models/htdemucs_6s.onnx. GPU + scale-to-zero: you pay per
# second of actual separation, ~US$0 when idle.

import subprocess
import modal

# Build the same image as the Dockerfile (repo root is the build context).
# add_python installs a standalone Python — the base CUDA image only has Node, and
# Modal needs Python in the image to run its container agent.
image = modal.Image.from_dockerfile("cloud/Dockerfile", context_dir=".", add_python="3.11")

app = modal.App("prismaxim-separator")


@app.function(
    image=image,
    gpu="T4",              # T4 is plenty for htdemucs_6s; bump to "L4"/"A10G" if desired
    timeout=600,           # max seconds per separation request
    scaledown_window=120,  # keep a warm container ~2 min after the last request
    max_containers=2,      # cap concurrency/cost; raise for more parallelism
    # Injects CLOUD_TOKEN → the service requires `Authorization: Bearer <token>`.
    # Set the same value as NEXT_PUBLIC_CLOUD_TOKEN in the web app.
    secrets=[modal.Secret.from_name("prismaxim-cloud")],
)
@modal.web_server(8080, startup_timeout=180)
def serve():
    # The image's CMD would run this, but under web_server we start it ourselves
    # so Modal can proxy the port. The model is baked into the image.
    subprocess.Popen(["node", "/app/dist/cloud.mjs"])


# The endpoint is gated by the `prismaxim-cloud` secret (CLOUD_TOKEN) attached
# above. To rotate the token:
#   modal secret create prismaxim-cloud CLOUD_TOKEN=<new> --force
#   modal deploy cloud/modal_app.py
# and update NEXT_PUBLIC_CLOUD_TOKEN (or the token field in Options) in the web app.
