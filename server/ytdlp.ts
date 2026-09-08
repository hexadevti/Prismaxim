/**
 * yt-dlp based YouTube extraction — the reliable path.
 *
 * yt-dlp keeps up with YouTube's signature/PoToken changes far better than
 * pure-JS libraries. We use the standalone binary (no Python), the running
 * Node as its JS runtime (for nsig/signature deciphering), and the bundled
 * ffmpeg from ffmpeg-static.
 *
 * The binary is a moving target: YouTube breaks older builds every few weeks
 * (typically a 403 on the media download, while metadata still resolves fine),
 * so a copy downloaded once at install time eventually stops working. We
 * therefore refresh it when it goes stale, and again on demand when extraction
 * fails in a way a newer build usually fixes.
 */

import { spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import type { ExtractInfo, YouTubeSearchResult } from '@prismaxim/shared';
import { TMP_DIR, YTDLP_BIN, YTDLP_DIR } from './config';

// In a packaged Electron app the binary is unpacked from the asar; ffmpeg-static
// still returns the in-asar path, so redirect it. No-op when not packaged.
const ffmpegPath = ((ffmpegStatic as unknown as string) || 'ffmpeg').replace(
  'app.asar',
  'app.asar.unpacked',
);

const YTDLP_URLS: Record<string, string> = {
  win32: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe',
  linux: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp',
  darwin: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos',
};

/** Refresh the binary once it's older than this — YouTube outpaces old builds. */
const MAX_BIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Never re-download more often than this, however often extraction fails. */
const MIN_REFRESH_INTERVAL_MS = 60 * 60 * 1000;

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** True when `path` is missing, or its mtime is further back than `ms`. */
async function olderThan(path: string, ms: number): Promise<boolean> {
  try {
    const { mtimeMs } = await stat(path);
    return Date.now() - mtimeMs > ms;
  } catch {
    return true;
  }
}

/** Fetch the latest yt-dlp and put it in place of the current one. */
async function downloadYtDlp(url: string, onLog?: (m: string) => void): Promise<void> {
  await mkdir(YTDLP_DIR, { recursive: true });
  onLog?.(`Downloading yt-dlp from ${url} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`yt-dlp download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Stage it next to the target first: a half-written download must never
  // replace a working binary. Windows can refuse to rename onto an existing
  // file, so fall back to removing it.
  const staged = `${YTDLP_BIN}.download`;
  await writeFile(staged, buf, { mode: 0o755 });
  try {
    await rename(staged, YTDLP_BIN);
  } catch {
    await rm(YTDLP_BIN, { force: true });
    await rename(staged, YTDLP_BIN);
  }
  onLog?.(`yt-dlp saved to ${YTDLP_BIN}`);
}

async function resolveYtDlp(onLog?: (m: string) => void): Promise<string> {
  const url = YTDLP_URLS[process.platform];
  const have = await fileExists(YTDLP_BIN);

  // Unknown platform: rely on a system-installed yt-dlp on PATH.
  if (!url) return have ? YTDLP_BIN : 'yt-dlp';

  if (have && !(await olderThan(YTDLP_BIN, MAX_BIN_AGE_MS))) return YTDLP_BIN;
  if (have) onLog?.('yt-dlp is over a week old — refreshing it.');

  try {
    await downloadYtDlp(url, onLog);
  } catch (err) {
    // A failed refresh must not break extraction: keep what we already have.
    if (!have) throw err;
    onLog?.(`yt-dlp refresh failed (${msg(err)}) — keeping the existing binary.`);
  }
  return YTDLP_BIN;
}

let ensuring: Promise<string> | null = null;

/** Return a usable yt-dlp binary path, downloading/refreshing it if necessary. */
export async function ensureYtDlp(onLog?: (m: string) => void): Promise<string> {
  // Coalesce concurrent callers so two imports can't download over each other.
  if (!ensuring) {
    const pending = resolveYtDlp(onLog).finally(() => {
      if (ensuring === pending) ensuring = null;
    });
    ensuring = pending;
  }
  return ensuring;
}

function run(
  bin: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    // When the backend runs inside Electron, `process.execPath` is the Electron
    // binary — which yt-dlp is told to use as its JS runtime (for nsig
    // deciphering). ELECTRON_RUN_AS_NODE makes that binary behave like plain
    // Node when yt-dlp invokes it. Harmless under a normal Node process.
    const proc = spawn(bin, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

async function ytDlpVersion(bin: string): Promise<string | undefined> {
  try {
    const { stdout, code } = await run(bin, ['--version']);
    return code === 0 ? stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Failures a newer yt-dlp usually fixes. YouTube's breakages surface as a 403 on
 * the media URL or as the extractor failing to read the player response — not as
 * "video unavailable" or "private video", which no update would help with.
 */
const STALE_BINARY_HINTS = [
  'http error 403',
  'unable to download video data',
  'unable to extract',
  'failed to extract',
  'nsig',
  'signature',
  'requested format is not available',
  'player response',
  'sign in to confirm',
];

function looksFixableByUpdate(err: unknown): boolean {
  const m = msg(err).toLowerCase();
  return STALE_BINARY_HINTS.some((hint) => m.includes(hint));
}

/**
 * Force-download the latest binary. Returns true only when that actually landed
 * a *different* version — retrying the same extraction otherwise is pointless.
 */
async function refreshYtDlp(onLog?: (m: string) => void): Promise<boolean> {
  const url = YTDLP_URLS[process.platform];
  if (!url) return false;
  // Don't re-fetch 18 MB on every failed import when the binary isn't at fault.
  if (!(await olderThan(YTDLP_BIN, MIN_REFRESH_INTERVAL_MS))) return false;

  const before = await ytDlpVersion(YTDLP_BIN);
  try {
    await downloadYtDlp(url, onLog);
  } catch (err) {
    onLog?.(`yt-dlp refresh failed (${msg(err)}).`);
    return false;
  }
  const after = await ytDlpVersion(YTDLP_BIN);
  if (before && after && before === after) {
    onLog?.(`yt-dlp is already at the latest version (${after}).`);
    return false;
  }
  onLog?.(`yt-dlp updated ${before ?? 'unknown'} → ${after ?? 'unknown'}.`);
  return true;
}

const SEP = '\x1f'; // unit separator, unlikely to appear in a title

/** yt-dlp prints "NA" for a field a video doesn't carry. */
const na = (v?: string) => (v && v !== 'NA' ? v : undefined);
const num = (v?: string) => {
  const n = Number(na(v));
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Run something with a working yt-dlp, updating the binary and retrying once if
 * it fails the way an out-of-date build does.
 */
async function withFreshBinary<T>(run: (bin: string) => Promise<T>): Promise<T> {
  const log = (m: string) => console.log(m);
  const bin = await ensureYtDlp(log);
  try {
    return await run(bin);
  } catch (err) {
    // The usual cause of a 403 or "unable to extract" is a binary YouTube has
    // outrun. Grab the latest build and try once more before giving up.
    if (!looksFixableByUpdate(err)) throw err;
    log(`yt-dlp failed (${msg(err)}) — trying a newer build.`);
    if (!(await refreshYtDlp(log))) throw err;
    return run(YTDLP_BIN);
  }
}

export interface YtDlpResult {
  bytes: Buffer;
  info: ExtractInfo;
  /** actual container extension of the audio bytes, e.g. 'm4a' | 'webm' */
  ext: string;
  /** JPEG thumbnail bytes, when yt-dlp managed to fetch and convert one. */
  thumb?: Buffer;
}

/** Delete every scratch file a run left behind under TMP_DIR. */
async function removeByPrefix(uid: string): Promise<void> {
  try {
    const files = await readdir(TMP_DIR);
    await Promise.all(
      files.filter((f) => f.startsWith(uid)).map((f) => rm(join(TMP_DIR, f), { force: true })),
    );
  } catch {
    /* nothing to clean up */
  }
}

async function runExtraction(bin: string, url: string): Promise<YtDlpResult> {
  await mkdir(TMP_DIR, { recursive: true });
  const uid = `yt_${process.pid}_${Date.now() % 1e9}`;
  const outTmpl = join(TMP_DIR, `${uid}.%(ext)s`);

  const { stdout, stderr, code } = await run(bin, [
    '-f',
    'bestaudio/best',
    '--no-playlist',
    '--no-part',
    '--no-progress',
    '--write-thumbnail',
    '--convert-thumbnails',
    'jpg',
    '--js-runtimes',
    `node:${process.execPath}`,
    '--ffmpeg-location',
    ffmpegPath,
    '-o',
    outTmpl,
    '--print',
    `after_move:%(title)s${SEP}%(duration)s${SEP}%(filepath)s${SEP}%(uploader)s${SEP}%(view_count)s${SEP}%(like_count)s${SEP}%(upload_date)s`,
    url,
  ]);

  if (code !== 0) {
    // A failed run can still have left partial files (e.g. the thumbnail) behind.
    await removeByPrefix(uid);
    throw new Error(`yt-dlp exited ${code}: ${stderr.split('\n').slice(-4).join(' ').trim()}`);
  }

  // Parse the after_move print line (last non-empty stdout line).
  const line = stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const [title, durationStr, filepath, uploader, viewStr, likeStr, uploadDate] = line.split(SEP);

  // yt-dlp writes the converted thumbnail next to the audio as <uid>.jpg.
  const thumbPath = join(TMP_DIR, `${uid}.jpg`);
  let thumb: Buffer | undefined;
  try {
    if (await fileExists(thumbPath)) thumb = await readFile(thumbPath);
  } catch {
    thumb = undefined;
  } finally {
    await rm(thumbPath, { force: true });
  }

  let finalPath = filepath;
  if (!finalPath || !(await fileExists(finalPath))) {
    // Fallback: find the file we wrote by its uid prefix.
    const files = await readdir(TMP_DIR);
    const match = files.find((f) => f.startsWith(uid));
    if (!match) throw new Error('yt-dlp produced no output file');
    finalPath = join(TMP_DIR, match);
  }

  try {
    const bytes = await readFile(finalPath);
    const duration = durationStr ? Number(durationStr) : undefined;
    const ext = (finalPath.split('.').pop() || 'webm').toLowerCase();
    const mimeType =
      ext === 'm4a' || ext === 'mp4'
        ? 'audio/mp4'
        : ext === 'mp3'
          ? 'audio/mpeg'
          : ext === 'opus'
            ? 'audio/opus'
            : 'audio/webm';
    return {
      bytes,
      ext,
      thumb,
      info: {
        title: title || 'audio',
        durationSeconds: Number.isFinite(duration) ? duration : undefined,
        mimeType,
        uploader: na(uploader),
        viewCount: num(viewStr),
        likeCount: num(likeStr),
        uploadDate: na(uploadDate),
      },
    };
  } finally {
    await rm(finalPath, { force: true });
  }
}

export async function extractWithYtDlp(url: string): Promise<YtDlpResult> {
  return withFreshBinary((bin) => runExtraction(bin, url));
}

/* ---------------- Search ---------------- */

/** Cap on results per query — enough to pick from, still one fast round trip. */
const MAX_SEARCH_RESULTS = 25;

async function runSearch(
  bin: string,
  query: string,
  limit: number,
): Promise<YouTubeSearchResult[]> {
  // `ytsearchN:` hits YouTube's search endpoint; --flat-playlist keeps it to one
  // metadata request per query (no per-video page fetch, no stream resolution),
  // which is why this returns in ~2s rather than ~2s per hit.
  const { stdout, stderr, code } = await run(bin, [
    `ytsearch${limit}:${query}`,
    '--flat-playlist',
    '--no-warnings',
    '--no-progress',
    '--ignore-no-formats-error',
    '--print',
    [
      '%(id)s',
      '%(title)s',
      '%(duration)s',
      '%(uploader)s',
      '%(view_count)s',
      '%(thumbnails.0.url)s',
    ].join(SEP),
  ]);

  if (code !== 0) {
    throw new Error(`yt-dlp search exited ${code}: ${stderr.split('\n').slice(-3).join(' ').trim()}`);
  }

  const results: YouTubeSearchResult[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [id, title, duration, uploader, views, thumb] = trimmed.split(SEP);
    if (!id || id === 'NA') continue;
    results.push({
      videoId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
      title: na(title) ?? id,
      durationSeconds: num(duration),
      uploader: na(uploader),
      viewCount: num(views),
      thumbnailUrl: na(thumb),
    });
  }
  return results;
}

/** Search YouTube by song/artist name. Metadata only — nothing is downloaded. */
export async function searchWithYtDlp(
  query: string,
  limit = 12,
): Promise<YouTubeSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  const n = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_SEARCH_RESULTS);
  return withFreshBinary((bin) => runSearch(bin, q, n));
}
