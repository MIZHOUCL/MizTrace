import { lang } from '../lib/i18n.js';
import { renderMd } from '../lib/md.js';
const { ref, computed, onMounted, onBeforeUnmount } = window.Vue;
export const AppUpdates = {
  setup() {
    const L = (zh, en) => lang.value === 'en' ? en : zh;
    const bridge = window.miztraceDesktop?.updates, state = ref(null), visible = ref(false), localError = ref('');
    let unsubscribe, announced = '';
    function receive(value) {
      state.value = value;
      if (value.phase === 'available' && value.release?.version !== announced) { visible.value = true; announced = value.release.version; }
    }
    async function action(name, arg) {
      localError.value = '';
      try { receive(await bridge[name](arg)); } catch (e) { localError.value = e.message; }
    }
    async function open() { visible.value = true; await action('state'); if (['idle', 'error', 'current', 'no-release'].includes(state.value?.phase) && !state.value?.release) action('check'); }
    const busy = computed(() => ['checking', 'downloading', 'installing'].includes(state.value?.phase));
    const notes = computed(() => renderMd(state.value?.release?.notes || ''));
    const date = computed(() => state.value?.release?.date ? new Date(state.value.release.date).toLocaleString(lang.value === 'en' ? 'en-US' : 'zh-CN') : '');
    const status = computed(() => ({
      idle: L('检查新版本', 'Check for updates'), checking: L('正在检查新版本…', 'Checking for updates…'),
      current: L('当前已是最新正式版本', 'You have the latest stable release'),
      'no-release': L('仓库尚未发布正式版本', 'No stable release has been published yet'),
      available: L('发现新版本', 'An update is available'),
      downloading: L('正在下载并准备更新，可以继续使用应用…', 'Downloading and preparing the update. You can keep working…'),
      downloaded: L('更新已准备好，下次启动将使用新版本', 'Update ready. It will apply the next time the app starts'),
      installing: L('正在关闭并安装更新…', 'Restarting to install the update…'),
      error: L('暂时无法完成更新', 'Unable to complete the update'),
    })[state.value?.phase] || '');
    onMounted(() => { if (bridge) { unsubscribe = bridge.onState(receive); action('state'); } });
    onBeforeUnmount(() => unsubscribe?.());
    return { L, enabled: Boolean(bridge), state, visible, localError, busy, notes, date, status, open, action };
  },
  template: `
  <button v-if="enabled" class="btn app-update-trigger" @click="open">{{ state?.release ? L('发现更新', 'Update available') : L('检查更新', 'Check updates') }}<i v-if="state?.release" class="update-dot"></i></button>
  <teleport to="body">
  <div v-if="visible && state" class="overlay update-overlay" @click.self="state.phase !== 'installing' && (visible=false)" role="dialog" aria-modal="true" aria-labelledby="update-title">
    <div class="modal update-modal">
      <p class="eyebrow">MIZTRACE · APP UPDATE</p><h2 id="update-title">{{ status }}</h2>
      <p class="fine">{{ L('当前版本', 'Current version') }} {{ state.current }}<template v-if="state.release"> → <strong>{{ state.release.version }}</strong></template></p>
      <template v-if="state.release"><p class="fine">{{ L('发布日期：', 'Released: ') }}{{ date }}<span v-if="state.release.bytes"> · {{ (state.release.bytes / 1048576).toFixed(1) }} MB</span></p><article class="md update-notes" v-html="notes"></article></template>
      <progress v-if="state.phase === 'downloading' || state.phase === 'checking'" class="update-progress" :aria-label="status"></progress>
      <p v-if="state.error || localError" class="library-error" role="alert">{{ localError || state.error }}</p>
      <p v-if="state.supportError" class="fine">{{ state.supportError }}</p>
      <p v-if="state.managed" class="fine">{{ L('受管设备：已禁止联网检查。', 'Managed device: online update checks are disabled.') }}</p>
      <label class="toggle update-preference"><input type="checkbox" :checked="state.autoCheck" :disabled="state.managed || state.phase==='installing'" @change="action('setAutoCheck', $event.target.checked)"><span>{{ L('打开应用时自动检查更新', 'Check for updates when the app starts') }}</span></label>
      <p class="fine">{{ L('自动检查只读取 GitHub 版本信息，不上传日记。点击下载后，更新会在下次启动时生效；也可下载完成后立即重启。', 'Automatic checks only read GitHub release information. Journals stay local. After you choose to download, the update applies on the next launch, or you can restart immediately once it is ready.') }}</p>
      <div class="foot">
        <button class="btn" @click="visible=false" :disabled="state.phase==='installing'">{{ state.phase==='downloaded' ? L('稍后重启', 'Restart later') : L('关闭', 'Close') }}</button>
        <button v-if="state.release && state.phase !== 'downloaded'" class="btn" @click="action('check')" :disabled="busy || state.managed">{{ L('重新检查', 'Check again') }}</button>
        <button v-if="state.phase==='downloaded'" class="btn primary" @click="action('install')">{{ L('重启并更新', 'Restart to update') }}</button>
        <button v-else-if="state.release" class="btn primary" @click="action('download')" :disabled="busy || !!state.supportError || state.managed || !!state.release.error">{{ state.phase==='downloading' ? L('下载中…', 'Downloading…') : L('下载更新', 'Download update') }}</button>
        <button v-else class="btn primary" @click="action('check')" :disabled="busy || state.managed">{{ L('重新检查', 'Check again') }}</button>
      </div>
    </div>
  </div></teleport>`,
};
