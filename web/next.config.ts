import type { NextConfig } from 'next';

/**
 * onnxruntime-web needs SharedArrayBuffer for WASM threads/SIMD, which requires
 * the page to be cross-origin isolated. These headers set that up; the model
 * and any cross-origin assets must be served with a compatible CORP.
 */
// `credentialless` keeps the page cross-origin isolated (crossOriginIsolated ===
// true → SharedArrayBuffer for onnxruntime-web threads + the AudioWorklet
// recorder) while allowing cross-origin subresources without CORP — needed so
// smplr can load its General-MIDI samples from its CDN. Chrome/Edge only.
const crossOriginIsolationHeaders = [
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
];

// For the desktop (Electron) build we export a static bundle that the packaged
// Fastify server serves locally. The web deploy can also be exported as a fully
// static, serverless bundle (STATIC_EXPORT=1) — hosted anywhere that can send
// the COOP/COEP isolation headers (Vercel/Netlify/Cloudflare Pages). `next dev`
// keeps the normal server so the headers() below apply during development.
const desktop = process.env.BUILD_TARGET === 'desktop';
const staticExport = desktop || process.env.STATIC_EXPORT === '1';

const nextConfig: NextConfig = {
  // Transpile the shared TS workspace package (published as raw source).
  transpilePackages: ['@prismaxim/shared'],
  // Expose the build target to the client bundle (see lib/env.ts).
  env: { NEXT_PUBLIC_BUILD_TARGET: desktop ? 'desktop' : 'web' },
  ...(staticExport ? { output: 'export' as const, images: { unoptimized: true } } : {}),
  async headers() {
    return [
      {
        source: '/:path*',
        headers: crossOriginIsolationHeaders,
      },
    ];
  },
  webpack(config) {
    // onnxruntime-web ships .wasm/.mjs assets; let webpack leave Node core
    // modules alone (they are only referenced by the node build path).
    config.resolve = config.resolve ?? {};
    config.resolve.fallback = {
      ...(config.resolve.fallback ?? {}),
      fs: false,
      path: false,
      crypto: false,
    };
    return config;
  },
};

export default nextConfig;
