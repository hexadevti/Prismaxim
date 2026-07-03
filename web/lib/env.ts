/**
 * Build-target flag. The same `web/` code ships two ways:
 *  - the pure web deploy (100% browser: WebGPU separation, IndexedDB/OPFS
 *    library, upload-only), and
 *  - the Electron desktop app (bundles the Node backend: native separation,
 *    YouTube import, filesystem library).
 *
 * `NEXT_PUBLIC_BUILD_TARGET` is injected at build time by next.config.ts
 * (`desktop` when BUILD_TARGET=desktop, otherwise `web`).
 */
export const IS_DESKTOP = process.env.NEXT_PUBLIC_BUILD_TARGET === 'desktop';

/** True in the pure-browser web build (no backend available). */
export const IS_WEB = !IS_DESKTOP;
