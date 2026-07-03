// Bundle the cloud separator (TypeScript + the @prismaxim/shared TS package) into
// a single ESM file. Native / heavyweight deps stay external and ship as real
// node_modules in the image (see Dockerfile).
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(here, 'server.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(here, 'dist', 'cloud.mjs'),
  external: ['onnxruntime-node', 'ffmpeg-static', 'fastify'],
  banner: {
    js: "import { createRequire as _cr } from 'module'; const require = _cr(import.meta.url);",
  },
  logLevel: 'info',
});

console.log('cloud separator bundled -> dist/cloud.mjs');
