const fs = require('node:fs');
const path = require('node:path');
const REPOSITORY = 'MIZHOUCL/MizTrace';
const RELEASE_API = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

function versionParts(value) {
  const match = String(value).match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\w.-]+))?$/);
  return match ? { numbers: match.slice(1, 4).map(Number), prerelease: match[4] || '' } : null;
}
function newerVersion(next, current) {
  const a = versionParts(next), b = versionParts(current);
  if (!a || !b || a.prerelease) return false;
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i] > b.numbers[i];
  return Boolean(b.prerelease);
}
function releaseInfo(release, current, platform, arch) {
  if (!release || release.draft || release.prerelease || !newerVersion(release.tag_name, current)) return null;
  if (!/^v\d+\.\d+\.\d+$/.test(release.tag_name) || !Number.isFinite(Date.parse(release.published_at))) throw new Error('发布信息缺少有效版本或日期');
  const version = release.tag_name.slice(1), base = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/`;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = (name) => assets.find((a) => a.name === name && a.browser_download_url === base + name && a.state === 'uploaded' && a.size > 0);
  let feed, packageAsset;
  if (platform === 'win32' && arch === 'x64') {
    packageAsset = asset(`MizTrace-${version}-full.nupkg`);
    if (packageAsset && asset('RELEASES')) feed = base;
  } else if (platform === 'darwin' && ['arm64', 'x64'].includes(arch)) {
    packageAsset = asset(`MizTrace-macOS-${arch}.zip`);
    if (packageAsset && asset(`update-darwin-${arch}.json`)) feed = base + `update-darwin-${arch}.json`;
  }
  return { version, date: release.published_at, notes: String(release.body || '此版本未提供更新说明。').slice(0, 32_000),
    name: String(release.name || `MizTrace ${version}`).slice(0, 160), feed: feed || null, bytes: packageAsset?.size || 0,
    error: feed ? '' : '此版本尚未发布适用于本机的完整更新文件，请稍后检查。' };
}

function createUpdater({ autoUpdater, version, platform, arch, fetchImpl, preferencesFile, managed = () => false, supportError = () => '', notify = () => {}, restart }) {
  let preferences = { autoCheck: true };
  try { preferences.autoCheck = JSON.parse(fs.readFileSync(preferencesFile, 'utf8')).autoCheck !== false; } catch { /* 首次启动使用默认值 */ }
  let state = { phase: 'idle', current: version, autoCheck: preferences.autoCheck, release: null, error: '', checkedAt: null, supportError: '' };
  let checking, installing = false;
  const busy = () => ['downloading', 'downloaded', 'installing'].includes(state.phase);
  const publish = (patch) => { state = { ...state, ...patch }; notify(snapshot()); return snapshot(); };
  const snapshot = () => ({ ...state, release: state.release ? { ...state.release, feed: undefined } : null, managed: managed() });
  const fail = (e) => publish({ phase: 'error', error: e.message || String(e) });
  autoUpdater.on('error', (e) => { if (state.phase === 'downloading') fail(e); });
  autoUpdater.on('update-downloaded', () => { if (state.phase === 'downloading') publish({ phase: 'downloaded', error: '' }); });
  autoUpdater.on('update-not-available', () => { if (state.phase === 'downloading') fail(new Error('更新源尚未就绪，请稍后重试。')); });
  return {
    snapshot,
    setAutoCheck(enabled) {
      if (typeof enabled !== 'boolean') throw new Error('更新选项无效');
      fs.mkdirSync(path.dirname(preferencesFile), { recursive: true });
      fs.writeFileSync(preferencesFile, JSON.stringify({ autoCheck: enabled }), { mode: 0o600 });
      return publish({ autoCheck: enabled });
    },
    async check() {
      if (checking) return checking;
      if (busy()) return snapshot();
      if (managed()) return fail(new Error('受管设备已禁止联网，无法检查更新。'));
      publish({ phase: 'checking', error: '', release: null });
      checking = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        try {
          const response = await fetchImpl(RELEASE_API, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'MizTrace-Desktop', 'X-GitHub-Api-Version': '2022-11-28' }, signal: controller.signal });
          if (response.status === 404) return publish({ phase: 'no-release', checkedAt: new Date().toISOString(), error: '' });
          if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'GitHub 检查次数受限，请稍后再试。' : `更新检查失败（HTTP ${response.status}）`);
          const raw = await response.text();
          if (raw.length > 1_000_000) throw new Error('更新信息过大');
          const release = releaseInfo(JSON.parse(raw), version, platform, arch);
          return publish({ phase: release ? 'available' : 'current', release, checkedAt: new Date().toISOString(), supportError: await supportError(), error: release?.error || '' });
        } catch (e) { return fail(new Error(controller.signal.aborted ? '检查更新超时，请确认能够连接 GitHub 后重试。' : e.message)); }
        finally { clearTimeout(timer); checking = null; }
      })();
      return checking;
    },
    async download() {
      if (busy() || checking) return snapshot();
      if (managed()) return fail(new Error('受管设备已禁止联网，无法下载更新。'));
      if (!state.release?.feed) return fail(new Error('请先检查并确认可用的新版本。'));
      const unsupported = await supportError();
      if (busy() || checking) return snapshot();
      if (unsupported) return publish({ supportError: unsupported, error: unsupported });
      // 原生检查会下载并暂存更新，只在用户点击下载后调用。重复点击不能启动第二次下载。
      publish({ phase: 'downloading', error: '' });
      try { autoUpdater.setFeedURL({ url: state.release.feed }); autoUpdater.checkForUpdates(); }
      catch (e) { return fail(e); }
      return snapshot();
    },
    async install() {
      if (state.phase !== 'downloaded' || installing) return snapshot();
      installing = true;
      try {
        // 主进程再次确认未保存内容；未通过时保留已下载状态。
        const result = await restart(() => publish({ phase: 'installing' }));
        if (result === false) return publish({ phase: 'downloaded', error: '请先保存正在编辑的内容，或等待当前操作完成，再重启更新。' });
      } catch (e) { return publish({ phase: 'downloaded', error: e.message }); }
      finally { installing = false; }
      return snapshot();
    },
  };
}
module.exports = { REPOSITORY, RELEASE_API, newerVersion, releaseInfo, createUpdater };
