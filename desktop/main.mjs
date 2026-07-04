// Prismaxim desktop (Electron). Runs the bundled Fastify backend in a separate
// utility process — so heavy work (YouTube import, native stem separation) never
// blocks the window's UI thread — and opens a window pointed at it. Running
// locally means yt-dlp uses the user's own (residential) IP, so YouTube import
// works without cookies/proxies.
import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electronUpdater from 'electron-updater'; // CJS package — default import, then destructure

const { autoUpdater } = electronUpdater;

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PRISMAXIM_PORT ?? 8787);
const BASE = `http://127.0.0.1:${PORT}`;

// Per-user storage: library, model cache, scratch, and the yt-dlp binary.
const dataDir = join(app.getPath('userData'), 'data');
for (const d of ['library', 'models', 'tmp', 'bin']) {
  mkdirSync(join(dataDir, d), { recursive: true });
}

// Environment handed to the backend process.
const backendEnv = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1', // local only — not exposed on the network
  LIBRARY_DIR: join(dataDir, 'library'),
  MODEL_DIR: join(dataDir, 'models'),
  TMP_DIR: join(dataDir, 'tmp'),
  YTDLP_DIR: join(dataDir, 'bin'), // yt-dlp(.exe) auto-downloads here on first use
  WEB_DIR: app.isPackaged ? join(process.resourcesPath, 'web') : join(here, '..', 'web', 'out'),
};

let backend = null;
let mainWindow = null;

// ── Auto-update (GitHub Releases via electron-updater) ────────────────────────
// The packaged app carries its provider/owner/repo in app-update.yml (generated
// from `build.publish` in package.json). We check/download on demand from the
// Settings screen rather than silently, so the user is always in control.
autoUpdater.autoDownload = false; // wait for an explicit "Download" click
autoUpdater.autoInstallOnAppQuit = true; // if already downloaded, install on next quit

function sendUpdate(payload) {
  try {
    mainWindow?.webContents.send('updates:event', payload);
  } catch {
    /* window already gone */
  }
}

function wireAutoUpdater() {
  autoUpdater.on('checking-for-update', () => sendUpdate({ status: 'checking' }));
  autoUpdater.on('update-available', (info) =>
    sendUpdate({ status: 'available', version: info?.version }),
  );
  autoUpdater.on('update-not-available', (info) =>
    sendUpdate({ status: 'not-available', version: info?.version }),
  );
  autoUpdater.on('download-progress', (p) =>
    sendUpdate({
      status: 'downloading',
      percent: p?.percent ?? 0,
      transferred: p?.transferred ?? 0,
      total: p?.total ?? 0,
      bytesPerSecond: p?.bytesPerSecond ?? 0,
    }),
  );
  autoUpdater.on('update-downloaded', (info) =>
    sendUpdate({ status: 'downloaded', version: info?.version }),
  );
  autoUpdater.on('error', (err) => sendUpdate({ status: 'error', error: String(err?.message ?? err) }));

  ipcMain.handle('updates:getVersion', () => app.getVersion());

  ipcMain.handle('updates:check', async () => {
    // electron-updater only works in the packaged app (it reads app-update.yml
    // from the install). In dev there's nothing to update — say so plainly.
    if (!app.isPackaged) {
      const error = 'Updates are only available in the installed app.';
      sendUpdate({ status: 'error', error });
      return { ok: false, error };
    }
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (err) {
      const error = String(err?.message ?? err);
      sendUpdate({ status: 'error', error });
      return { ok: false, error };
    }
  });

  ipcMain.handle('updates:download', async () => {
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (err) {
      const error = String(err?.message ?? err);
      sendUpdate({ status: 'error', error });
      return { ok: false, error };
    }
  });

  // Quit and launch the downloaded installer. `before-quit` tears down the backend.
  ipcMain.handle('updates:install', () => autoUpdater.quitAndInstall());
}

wireAutoUpdater();

function startBackend() {
  // A dedicated Node process: its CPU-heavy work can't freeze the UI/window.
  backend = utilityProcess.fork(join(here, 'dist', 'backend.mjs'), [], { env: backendEnv });

  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    // Primary signal: the backend posts { type: 'ready' } once it's actually
    // listening (see server/index.ts). Reliable even on a slow cold start.
    backend.on('message', (msg) => {
      if (msg && msg.type === 'ready') done(resolve);
    });
    // If it dies before becoming ready, fail fast.
    backend.on('exit', (code) => done(reject, new Error(`backend exited (code ${code})`)));
    // Fallback: poll /health (covers a dropped message). Generous window (~60s)
    // so a slow first launch right after a build isn't mistaken for a failure.
    (async () => {
      for (let i = 0; i < 300 && !settled; i++) {
        try {
          const r = await fetch(`${BASE}/health`);
          if (r.ok) return done(resolve);
        } catch {
          /* backend not listening yet */
        }
        await new Promise((res) => setTimeout(res, 200));
      }
      done(reject, new Error('backend did not become ready within 60s'));
    })();
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0b0e14',
    autoHideMenuBar: true,
    icon: join(here, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      preload: join(here, 'preload.cjs'), // exposes window.prismaxim.updates
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });
  void win.loadURL(BASE);
  // External links (help, YouTube) open in the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // The web app's `beforeunload` (unsaved-changes guard) fires this only when
  // there ARE unsaved edits — Electron would otherwise silently cancel the close
  // (dead X button). Ask the user with a native dialog instead. With no unsaved
  // changes this never fires and the window closes immediately.
  win.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Sair', 'Cancelar'],
      defaultId: 1,
      cancelId: 1,
      title: 'Alterações não salvas',
      message: 'Há alterações não salvas no editor.',
      detail: 'Se sair agora, elas serão perdidas.',
    });
    if (choice === 0) e.preventDefault(); // "Sair" → allow the close to proceed
  });
}

app.whenReady().then(async () => {
  try {
    await startBackend();
  } catch (err) {
    dialog.showErrorBox(
      'Prismaxim',
      `O serviço interno não pôde iniciar.\n\n${err?.message ?? err}\n\nA aplicação será encerrada.`,
    );
    app.quit();
    return;
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
// Tear down the backend process, then make sure we really exit.
app.on('before-quit', () => {
  try {
    backend?.kill();
  } catch {
    /* already gone */
  }
});
app.on('quit', () => process.exit(0));
