import { api } from '../lib/api.js';
import { FolderPicker } from './folderpicker.js';
import { lang } from '../lib/i18n.js';
const { ref } = window.Vue;
export const JournalDirectories = {
  components: { FolderPicker },
  props: { directories: Array, canChange: Function },
  emits: ['close', 'changed'],
  setup(props, { emit }) {
    const L = (zh, en) => lang.value === 'en' ? en : zh;
    const roots = ref([...(props.directories ?? [])]), picking = ref(false), busy = ref(false), error = ref('');
    function add(p) { if (p && !roots.value.includes(p)) roots.value.push(p); picking.value = false; }
    async function browse() {
      if (!window.miztraceDesktop?.chooseDirectories) { picking.value = true; return; }
      busy.value = true; error.value = '';
      try { for (const p of await window.miztraceDesktop.chooseDirectories()) add(p); }
      catch (e) { error.value = e.message; }
      finally { busy.value = false; }
    }
    async function save() {
      if (props.canChange && !props.canChange()) { error.value = L('请先保存当前日记的修改，再更改目录。', 'Save the current entry before changing folders.'); return; }
      busy.value = true; error.value = '';
      try {
        const result = await api('PUT', '/api/journals/directories', { directories: roots.value });
        emit('changed', result.directories); emit('close');
      } catch (e) { error.value = e.message; }
      finally { busy.value = false; }
    }
    return { L, roots, picking, busy, error, add, browse, save };
  },
  template: `
  <div class="overlay" @click.self="!busy && $emit('close')" role="dialog" aria-modal="true" aria-labelledby="directories-title">
    <div class="modal directory-manager">
      <h2 id="directories-title">{{ L('管理日记目录', 'Journal folders') }}</h2>
      <p>{{ L('选择一个或多个文件夹，日记库会汇总其中及子目录内的 .md 文件。', 'Choose folders to include their Markdown files and subfolders.') }}</p>
      <p class="fine">{{ L('这里的目录单独保存。移除目录只取消显示，不删除文件；设置中的日记输出目录不受影响。', 'Folders are saved independently. Removing a folder only hides its files. The export folder in Settings stays separate.') }}</p>
      <ul class="library-roots"><li v-for="(root, i) in roots" :key="root"><code>{{ root }}</code><button class="btn small quiet" :disabled="busy" @click="roots.splice(i, 1)" :aria-label="L('移除目录：', 'Remove folder: ') + root">{{ L('移除', 'Remove') }}</button></li></ul>
      <p class="fine" v-if="!roots.length">{{ L('还没有选择目录。本地日记与草稿始终保留。', 'No folders selected. Local entries and drafts remain available.') }}</p>
      <button class="btn" @click="browse" :disabled="busy">＋ {{ L('选择文件夹…', 'Choose folders…') }}</button>
      <p v-if="error" class="library-error" role="alert">{{ error }}</p>
      <div class="foot"><button class="btn" @click="$emit('close')" :disabled="busy">{{ L('取消', 'Cancel') }}</button><button class="btn primary" @click="save" :disabled="busy">{{ busy ? L('处理中…', 'Working…') : L('保存目录', 'Save folders') }}</button></div>
      <folder-picker v-if="picking" @pick="add" @close="picking=false"></folder-picker>
    </div>
  </div>`,
};
