/**
 * 选目录：一层一层点进去，而不是让人手敲路径。列的是本机目录（走本地服务的 /api/fs/dirs），
 * 只列子目录名，不读文件。浏览器自带的目录选择器拿不到真实路径，所以只能这么做。
 */
import { api } from '../lib/api.js';
import { lang } from '../lib/i18n.js';
const L = (zh, en) => (lang.value === 'en' ? en : zh);

const { ref, onMounted } = window.Vue;

export const FolderPicker = {
  name: 'FolderPicker',
  props: { start: String, title: { type: String, default: '选择目录' } },
  emits: ['close', 'pick'],
  setup(props, { emit }) {
    const cur = ref(null);
    const loading = ref(false);
    const err = ref('');
    const typed = ref('');
    async function go(p) {
      loading.value = true;
      err.value = '';
      try {
        cur.value = await api('GET', `/api/fs/dirs?path=${encodeURIComponent(p ?? '')}`);
        typed.value = cur.value.path || '';
        if (cur.value.error) err.value = cur.value.error;
      } catch (e) {
        err.value = e.message;
      } finally {
        loading.value = false;
      }
    }
    function crumbs() {
      const p = cur.value?.path || '';
      if (!p) return [];
      const parts = p.split(/[\\/]+/).filter(Boolean);
      const isWin = /^[A-Za-z]:/.test(p);
      const out = [];
      let acc = isWin ? '' : '/';
      for (const part of parts) {
        acc = isWin ? (acc ? `${acc}\\${part}` : `${part}\\`) : acc === '/' ? `/${part}` : `${acc}/${part}`;
        out.push({ name: part, path: acc });
      }
      return out;
    }
    function onKey(e) {
      if (e.key === 'Escape') emit('close');
    }
    onMounted(() => {
      document.addEventListener('keydown', onKey);
      go(props.start || '');
    });
    return { cur, loading, err, typed, go, crumbs, L, pick: () => cur.value?.path && emit('pick', cur.value.path) };
  },
  template: `
<div class="overlay" @click.self="$emit('close')" role="dialog" aria-modal="true" :aria-label="L('选择目录', 'Pick a folder')">
  <div class="modal picker-modal">
    <h2>{{ title }}</h2>
    <div class="crumbs" v-if="cur">
      <button class="btn small quiet" @click="go('')">{{ L('根', 'Root') }}</button>
      <template v-for="c in crumbs()" :key="c.path"><span class="sep">›</span><button class="btn small quiet" @click="go(c.path)">{{ c.name }}</button></template>
      <span class="spin" v-if="loading"></span>
    </div>
    <div class="typed"><input type="text" v-model="typed" :placeholder="L('也可以直接粘贴路径，回车跳过去', 'Or paste a path and press Enter')" @keydown.enter="go(typed)"><button class="btn small" @click="go(typed)">{{ L('跳转', 'Go') }}</button></div>
    <p class="err" v-if="err">{{ err }}</p>
    <ul class="dirs" v-if="cur">
      <li v-if="cur.isRoot" v-for="r in cur.roots" :key="r.path"><button class="linklike" @click="go(r.path)">{{ r.name }}</button><small v-if="r.name !== r.path">{{ r.path }}</small></li>
      <li v-if="!cur.isRoot && cur.parent !== null"><button class="linklike up" @click="go(cur.parent)">‹ {{ L('上一级', 'Up') }}</button></li>
      <li v-for="d in cur.dirs" :key="d.path"><button class="linklike" @click="go(d.path)">{{ d.name }}</button></li>
      <li v-if="!cur.isRoot && !cur.dirs.length && !err" class="fine">{{ L('这里没有子目录', 'No subfolders here') }}</li>
    </ul>
    <div class="foot">
      <span class="fine" v-if="cur && cur.path">{{ L('当前：', 'Current: ') }}<code>{{ cur.path }}</code></span>
      <span class="spacer"></span>
      <button class="btn" @click="$emit('close')">{{ L('取消', 'Cancel') }}</button>
      <button class="btn primary" @click="pick" :disabled="!cur || !cur.path">{{ L('选这个目录', 'Use this folder') }}</button>
    </div>
  </div>
</div>`,
};
