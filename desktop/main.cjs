const { app, BrowserWindow, dialog, shell, Menu, ipcMain, autoUpdater, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { fork, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createUpdater } = require('./updater.cjs');
const { externalUrlAllowed, isAppUrl } = require('./navigation.cjs');
const { desktopDataDir } = require('./paths.cjs');

const smoke = process.env.MIZTRACE_DESKTOP_SMOKE === '1';
let mainWindow, child, stopping = false, quitting = false;
const profileBase = desktopDataDir();
process.env.MIZTRACE_DATA_DIR = profileBase;
app.setPath('userData', path.join(profileBase, 'desktop-profile'));
const squirrelEvent = require('electron-squirrel-startup');
if (squirrelEvent || !app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
  app.whenReady().then(launch).catch((error) => { if (!smoke) dialog.showErrorBox('MizTrace 启动失败', error.message); console.error(error.message); child?.kill(); app.exit(1); });
}

function startCore() {
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, '.build');
  const runtime = path.join(base, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const script = path.join(base, 'service', 'service.mjs');
  if (!fs.existsSync(runtime) || !fs.existsSync(script)) throw new Error('缺少本地运行环境，请重新安装完整的 MizTrace 安装包。');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child?.kill(); reject(new Error('本地服务启动超时。')); }, 30_000);
    child = fork(script, [], { execPath: runtime, execArgv: [], cwd: app.getPath('userData'), windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('message', (message) => {
      if (message.type === 'ready') { clearTimeout(timer); resolve(message); }
      else if (message.type === 'startup-error') { clearTimeout(timer); reject(new Error(message.message)); }
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('本地服务意外退出。'));
      if (!stopping && mainWindow && !mainWindow.isDestroyed()) {
        dialog.showErrorBox('MizTrace 本地服务已停止', '请先复制或导出尚未保存的文字，再退出并重新打开应用。');
      }
    });
  });
}

async function launch() {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const ready = await startCore();
  const origin = new URL(ready.url).origin;
  mainWindow = new BrowserWindow({ width: 1440, height: 960, minWidth: 760, minHeight: 600, show: !smoke,
    title: 'MizTrace', backgroundColor: '#f3f3ef',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, spellcheck: false } });
  const managed = () => {
    try { return JSON.parse(fs.readFileSync(path.join(profileBase, 'config.json'), 'utf8')).managedDevice === true; }
    catch (e) { return e.code !== 'ENOENT'; }
  };
  const supportError = async () => {
    if (!app.isPackaged) return '开发预览不能安装更新，请使用正式安装版。';
    if (process.platform === 'win32') return fs.existsSync(path.resolve(path.dirname(process.execPath), '..', 'Update.exe')) ? '' : '请先通过 Setup 安装一次，之后即可在应用内更新。';
    if (process.platform === 'darwin') {
      try {
        const { stderr } = await promisify(execFile)('/usr/bin/codesign', ['-dv', '--verbose=2', path.resolve(process.resourcesPath, '../..')], { timeout: 5000 });
        if (/TeamIdentifier=[A-Z0-9]{10}/.test(stderr)) return '';
      } catch { /* 未签名构建不能通过 Squirrel.Mac 校验 */ }
      return '此 macOS 构建未使用 Developer ID 签名，暂不能安装自动更新。';
    }
    return '当前平台暂不支持应用内安装更新。';
  };
  const updater = createUpdater({ autoUpdater, version: app.getVersion(), platform: process.platform, arch: process.arch,
    fetchImpl: smoke ? async () => ({ ok: true, text: async () => JSON.stringify({ tag_name: `v${app.getVersion()}` }) }) : (...args) => net.fetch(...args),
    preferencesFile: path.join(app.getPath('userData'), 'updates.json'), managed, supportError,
    notify: (state) => { if (!mainWindow.isDestroyed()) mainWindow.webContents.send('miztrace:update-state', state); },
    restart: async (starting) => {
      const blocked = await mainWindow.webContents.executeJavaScript(`!window.dispatchEvent(new Event('miztrace-before-update', {cancelable:true}))`);
      if (blocked) return false;
      starting(); stopping = true;
      await new Promise((resolve) => {
        if (!child || child.exitCode !== null) return resolve();
        const timer = setTimeout(() => { child.kill(); resolve(); }, 3000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        if (child.connected) child.send({ type: 'shutdown' }); else { child.kill(); resolve(); }
      });
      quitting = true; autoUpdater.quitAndInstall();
      return true;
    },
  });
  // 只允许主窗口的顶层本地页面调用固定能力，不向网页暴露通用 IPC / 文件 API。
  const handle = (name, fn) => ipcMain.handle(name, (event, ...args) => {
    if (event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || !isAppUrl(event.senderFrame.url, origin)) throw new Error('不允许的桌面请求');
    return fn(...args);
  });
  handle('miztrace:choose-directories', async () => {
    const result = await dialog.showOpenDialog(mainWindow, { title: '选择日记目录（可多选）', properties: ['openDirectory', 'multiSelections'] });
    return result.canceled ? [] : result.filePaths;
  });
  handle('miztrace:update-state', () => updater.snapshot());
  handle('miztrace:update-check', () => updater.check());
  handle('miztrace:update-download', () => updater.download());
  handle('miztrace:update-install', () => updater.install());
  handle('miztrace:update-preferences', (enabled) => updater.setAutoCheck(enabled));
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.webContents.session.setPermissionCheckHandler(() => false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (externalUrlAllowed(url) && !isAppUrl(url, origin)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url, origin)) return;
    event.preventDefault();
    if (externalUrlAllowed(url)) shell.openExternal(url).catch(() => {});
  });
  mainWindow.webContents.on('will-attach-webview', (event) => event.preventDefault());
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const leave = dialog.showMessageBoxSync(mainWindow, { type: 'question', buttons: ['继续编辑', '放弃修改并关闭'], defaultId: 0, cancelId: 0, title: '有未保存的日记', message: '当前编辑尚未保存，是否放弃修改？' });
    if (leave === 1) event.preventDefault();
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ label: 'MizTrace', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'quit' }] }] : []),
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'reload' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    { label: '更新', submenu: [{ id: 'check-for-updates', label: '检查更新…', enabled: false, click: () => {
      if (mainWindow.isDestroyed()) return;
      if (!smoke) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus(); }
      mainWindow.webContents.send('miztrace:update-open');
    } }] },
  ]));
  await mainWindow.loadURL(ready.url);
  Menu.getApplicationMenu().getMenuItemById('check-for-updates').enabled = true;
  if (!smoke && app.isPackaged && updater.snapshot().autoCheck && !managed()) {
    // Squirrel 首次安装仍持有锁，给它留出释放时间。
    const timer = setTimeout(() => { if (!mainWindow.isDestroyed() && updater.snapshot().autoCheck) updater.check(); }, process.argv.includes('--squirrel-firstrun') ? 20_000 : 8000);
    timer.unref();
  }
  if (smoke) {
    const rendered = await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => { const deadline = Date.now() + 10000; const check = () => { if (document.querySelector('.module-sidebar')) resolve(true); else if (Date.now() > deadline) reject(new Error('页面没有加载完成')); else setTimeout(check, 100); }; check(); })`);
    if (!rendered) throw new Error('桌面页面未正常加载');
    const bridge = await mainWindow.webContents.executeJavaScript(`(async () => {
      if (typeof window.miztraceDesktop?.chooseDirectories !== 'function') return false;
      const update = await window.miztraceDesktop.updates.state();
      return update.current === '${app.getVersion()}' && update.phase === 'idle' && typeof window.miztraceDesktop.updates.onOpen === 'function' && document.querySelector('.app-update-trigger') === null;
    })()`);
    if (!bridge) throw new Error('桌面更新与目录选择桥接未加载');
    const updateMenu = Menu.getApplicationMenu().getMenuItemById('check-for-updates');
    if (!updateMenu?.enabled) throw new Error('更新菜单不可用');
    updateMenu.click();
    const updateDialog = await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => { const deadline = Date.now() + 5000; const check = () => { const title = document.querySelector('#update-title'); if (document.querySelector('.update-overlay') && /最新正式版本|latest stable release/.test(title?.textContent || '')) resolve(true); else if (Date.now() > deadline) reject(new Error('更新菜单未打开检查结果')); else setTimeout(check, 100); }; check(); })`);
    const saved = await mainWindow.webContents.executeJavaScript(`(async () => {
      const headers = {'content-type':'application/json', 'x-miztrace-token': sessionStorage.getItem('dt_token')};
      const create = await fetch('/api/journals', {method:'POST', headers, body:JSON.stringify({date:'2026-11-27'})});
      const {document} = await create.json();
      const save = await fetch('/api/journals/document', {method:'PUT', headers, body:JSON.stringify({...document, markdown:'# Desktop smoke'})});
      return save.ok && (await save.json()).markdown === '# Desktop smoke';
    })()`);
    if (!saved) throw new Error('桌面日记保存失败');
    if (process.env.MIZTRACE_DESKTOP_SMOKE_OUTPUT) fs.writeFileSync(process.env.MIZTRACE_DESKTOP_SMOKE_OUTPUT, JSON.stringify({ ok: true, sqlite: ready.sqlite, saved, bridge, updateDialog, node: ready.nodeVersion, platform: process.platform, arch: process.arch }));
    app.quit();
  }
}

function stopCore() {
  if (stopping) return;
  stopping = true;
  const finish = () => { quitting = true; app.quit(); };
  if (!child || child.exitCode !== null) { finish(); return; }
  const timeout = setTimeout(() => { child.kill(); finish(); }, 3000);
  child.once('exit', () => { clearTimeout(timeout); finish(); });
  if (child.connected) child.send({ type: 'shutdown' }); else { child.kill(); finish(); }
}
app.on('window-all-closed', stopCore);
app.on('before-quit', (event) => {
  if (quitting || !child) return;
  event.preventDefault();
  // close 会触发网页的未保存提醒；用户取消时不关闭服务。
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  else stopCore();
});
