import { app, BrowserWindow, shell, dialog, Menu } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import electronUpdater from 'electron-updater';
import { startServer, stopServer } from './server.js';

const { autoUpdater } = electronUpdater;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let win = null;
let serverPort = null;
let updateInFlight = false;

// ── Auto-update: check GitHub Releases on startup, notify with release notes ──
function setupAutoUpdates() {
  // We control the prompts ourselves, so disable the library's auto behaviour.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-available', async (info) => {
    // Format release notes (GitHub gives an HTML string or an array)
    let notes = '';
    if (typeof info.releaseNotes === 'string') {
      notes = info.releaseNotes.replace(/<[^>]+>/g, '').trim(); // strip HTML tags
    } else if (Array.isArray(info.releaseNotes)) {
      notes = info.releaseNotes.map(n => n.note || '').join('\n\n');
    }
    if (notes.length > 1200) notes = notes.slice(0, 1200) + '…';

    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Update now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update available',
      message: `Stock Scanner ${info.version} is available (you have ${app.getVersion()}).`,
      detail: notes ? `What's new:\n\n${notes}` : 'Download and install now? The app will restart to apply it.',
    });
    if (response === 0) {
      updateInFlight = true;
      autoUpdater.downloadUpdate();
    }
  });

  autoUpdater.on('update-downloaded', async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart now', 'On next quit'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: 'The update has been downloaded.',
      detail: 'Restart now to apply it, or it will install automatically when you next close the app.',
    });
    if (response === 0) {
      await stopServer();
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (err) => {
    // Never block the app over an update failure — just log it.
    console.error('Auto-update error:', err == null ? 'unknown' : (err.stack || err).toString());
    updateInFlight = false;
  });

  // Fire the check a few seconds after launch so it never delays startup.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((e) => console.error('Update check failed:', e.message));
  }, 4000);
}

async function createWindow() {
  // Boot the embedded server first (with its automatic port fallback)
  if (serverPort === null) {
    try {
      serverPort = await startServer();
    } catch (err) {
      dialog.showErrorBox('Stock Scanner could not start', err.message);
      app.quit();
      return;
    }
  }

  win = new BrowserWindow({
    width: 1380,
    height: 880,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#080b10', // matches the app theme — no white flash on load
    title: 'Stock Scanner',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // No menu bar at all — this is an app, not a browser
  Menu.setApplicationMenu(null);

  // News articles (target=_blank links) open in the user's DEFAULT browser,
  // never inside the app window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Belt and braces: block in-window navigation away from the scanner too
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(`http://localhost:${serverPort}`)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => { win = null; });

  await win.loadURL(`http://localhost:${serverPort}`);

  // Show the installed version in the title bar so it's obvious an update took.
  // The page sets its own <title>, so block that from overwriting ours.
  win.webContents.on('page-title-updated', (e) => e.preventDefault());
  win.setTitle(`Stock Scanner v${app.getVersion()}`);

  setupAutoUpdates(); // check GitHub for a newer release once we're up
}

app.whenReady().then(createWindow);

// Quit fully when the window closes — unless an update is mid-install, in
// which case electron-updater handles the relaunch.
app.on('window-all-closed', async () => {
  if (updateInFlight) return;
  await stopServer();
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// Only one instance of the app at a time — a second launch focuses the
// existing window instead of fighting over the port
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}
