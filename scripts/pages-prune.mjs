/**
 * Prepare web/out for a `wrangler pages deploy`.
 *
 * Cloudflare Pages hard-fails the whole upload on any file over 25 MiB, and —
 * unlike Workers Static Assets — it does NOT read `.assetsignore`. Its ignore
 * list is hardcoded in wrangler (`_worker.js`, `_headers`, `_routes.json`,
 * `functions`, `.DS_Store`, `node_modules`, `.git`, `.wrangler`), so the only
 * way to keep an oversized file out of a Pages deploy is to delete it from the
 * output directory first.
 *
 * The static export emits two ONNX Runtime wasm binaries that are both over the
 * limit and both fetched from a CDN at runtime, so nothing ever requests the
 * local copies:
 *   * ~26 MB  the app's own onnxruntime-web (Demucs separation) — CDN base set
 *             explicitly in web/lib/config.ts (ORT_WASM_BASE_URL).
 *   * ~21 MB  the copy Transformers.js bundles (Whisper lyrics) — Transformers.js
 *             defaults its own wasmPaths to jsDelivr.
 *
 * If you ever self-host either runtime, drop the matching pattern below (and the
 * glob in web/public/.assetsignore) so the wasm ships with the site.
 */
import { readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Not `import.meta.dirname` — that needs Node >= 20.11 and package.json allows >= 20.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', 'web', 'out');
const MAX_ASSET_SIZE = 25 * 1024 * 1024;

/** Files to delete before uploading, relative to web/out (posix separators). */
const PRUNE = [
  /^_next\/static\/media\/.*\.wasm$/, // CDN-loaded ORT runtimes (see above)
  /^\.assetsignore$/,                 // Workers-only metafile; Pages would upload it as an asset
];

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(abs);
    else yield abs;
  }
}

let removed = 0;
const oversize = [];

for await (const abs of walk(OUT)) {
  const rel = path.relative(OUT, abs).split(path.sep).join('/');
  if (PRUNE.some((re) => re.test(rel))) {
    const { size } = await stat(abs);
    await unlink(abs);
    console.log(`  pruned  ${rel} (${mb(size)})`);
    removed++;
    continue;
  }
  const { size } = await stat(abs);
  if (size > MAX_ASSET_SIZE) oversize.push({ rel, size });
}

console.log(`pages-prune: removed ${removed} file(s) from web/out`);

// Fail loudly rather than letting wrangler abort mid-upload.
if (oversize.length) {
  console.error(`\nPages rejects files over 25 MiB, and these would fail the upload:`);
  for (const f of oversize) console.error(`  ${f.rel} (${mb(f.size)})`);
  console.error(`\nAdd a pattern to PRUNE in scripts/pages-prune.mjs, or load the file from a CDN.`);
  process.exit(1);
}
