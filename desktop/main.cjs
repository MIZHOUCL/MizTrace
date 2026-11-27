const { app, BrowserWindow, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { fork } = require('node:child_process');
const { externalUrlAllowed, isAppUrl } = require('./navigation.cjs');

const smoke = process.env.MIZTRACE_DESKTOP_SMOKE === '1';
let mainWindow, child, stopping = false, quitting = false;
const profileBase = process.env.MIZTRACE_DATA_DIR || app.getPath('userData');
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
    child = fork(script, [], { execPath: runtime, cwd: app.getPath('userData'), windowsHide: true,
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
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false, spellcheck: false } });
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
  ]));
  await mainWindow.loadURL(ready.url);
  if (smoke) {
    const rendered = await mainWindow.webContents.executeJavaScript(`new Promise((resolve, reject) => { const deadline = Date.now() + 10000; const check = () => { if (document.querySelector('.module-sidebar')) resolve(true); else if (Date.now() > deadline) reject(new Error('页面没有加载完成')); else setTimeout(check, 100); }; check(); })`);
    if (!rendered) throw new Error('桌面页面未正常加载');
    const saved = await mainWindow.webContents.executeJavaScript(`(async () => {
      const headers = {'content-type':'application/json', 'x-miztrace-token': sessionStorage.getItem('dt_token')};
      const create = await fetch('/api/journals', {method:'POST', headers, body:JSON.stringify({date:'2026-11-27'})});
      const {document} = await create.json();
      const save = await fetch('/api/journals/document', {method:'PUT', headers, body:JSON.stringify({...document, markdown:'# Desktop smoke'})});
      return save.ok && (await save.json()).markdown === '# Desktop smoke';
    })()`);
    if (!saved) throw new Error('桌面日记保存失败');
    if (process.env.MIZTRACE_DESKTOP_SMOKE_OUTPUT) fs.writeFileSync(process.env.MIZTRACE_DESKTOP_SMOKE_OUTPUT, JSON.stringify({ ok: true, sqlite: ready.sqlite, saved, node: ready.nodeVersion, platform: process.platform, arch: process.arch }));
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
