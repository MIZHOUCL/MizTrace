import { api } from '../lib/api.js';
import { renderMd } from '../lib/md.js';
import { lang } from '../lib/i18n.js';
import { formatSelection } from '../lib/editor.js';
import { JournalDirectories } from './journal-directories.js';

const { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } = window.Vue;
export const JournalLibrary = {
  components: { JournalDirectories },
  props: { active: Boolean, today: String },
  emits: ['saved'],
  setup(props, { expose, emit }) {
    const L = (zh, en) => lang.value === 'en' ? en : zh;
    const documents = ref([]), warnings = ref([]), search = ref(''), filter = ref('all');
    const selected = ref(null), text = ref(''), savedText = ref(''), editor = ref(null);
    const loading = ref(false), opening = ref(false), saving = ref(false), error = ref(''), message = ref('');
    const mode = ref('split'), newDate = ref(props.today), showCreate = ref(false), history = ref(null);
    const conflict = ref(false), historyBusy = ref(false);
    const directories = ref([]), managing = ref(false);
    const listCollapsed = ref(localStorage.getItem('mt_journal_list_collapsed') === '1');
    function toggleList() {
      listCollapsed.value = !listCollapsed.value;
      localStorage.setItem('mt_journal_list_collapsed', listCollapsed.value ? '1' : '0');
    }
    async function directoriesChanged(roots) {
      directories.value = roots;
      await refresh();
      if (selected.value?.kind === 'file' && !documents.value.some((d) => d.id === selected.value.id) && !dirty.value) {
        selected.value = null; text.value = ''; savedText.value = '';
      }
    }
    let request = 0, listRequest = 0, previewTimer;
    const previewText = ref('');
    const undo = [], redo = [];
    let lastInput = 0;
    const dirty = computed(() => selected.value && text.value !== savedText.value);
    const filtered = computed(() => {
      const query = search.value.trim().toLowerCase();
      return documents.value.filter((d) => (filter.value === 'all' || d.kind === filter.value) &&
        `${d.title} ${d.date} ${d.relativePath || ''}`.toLowerCase().includes(query));
    });
    const html = computed(() => renderMd(previewText.value));
    const charCount = computed(() => text.value.length);
    const kindName = (kind) => ({ file: L('Markdown 文件', 'Markdown file'), journal: L('本地日记', 'Local journal'), draft: L('生成草稿', 'Draft') })[kind];
    const timeLabel = (v) => v ? new Date(v).toLocaleString(lang.value === 'en' ? 'en-US' : 'zh-CN') : '';

    async function refresh() {
      const seq = ++listRequest;
      loading.value = true;
      try {
        const result = await api('GET', '/api/journals');
        if (seq !== listRequest) return;
        documents.value = result.documents; warnings.value = result.warnings;
        directories.value = result.directories;
      } catch (e) { if (seq === listRequest) error.value = e.message; }
      finally { if (seq === listRequest) loading.value = false; }
    }
    function canReplace() {
      if (saving.value) return false;
      return !dirty.value || confirm(L('当前编辑尚未保存。放弃这些修改并继续？', 'Discard the unsaved changes and continue?'));
    }
    function install(doc) {
      selected.value = doc; text.value = doc.markdown; savedText.value = doc.markdown;
      previewText.value = doc.markdown; undo.length = 0; redo.length = 0;
      history.value = null; conflict.value = false; error.value = ''; message.value = '';
    }
    async function openDocument(id) {
      if (!canReplace()) return;
      const seq = ++request;
      opening.value = true; error.value = '';
      try {
        const doc = await api('GET', `/api/journals/document?id=${encodeURIComponent(id)}`);
        if (seq === request) install(doc);
      } catch (e) { if (seq === request) error.value = e.message; }
      finally { if (seq === request) opening.value = false; }
    }
    async function openSaved(saved) {
      await refresh();
      const entry = documents.value.find((d) => saved.path && d.path === saved.path && d.kind === 'file');
      await openDocument(entry?.id || saved.id);
    }
    async function create() {
      if (opening.value || !canReplace()) return;
      const seq = ++request;
      opening.value = true; error.value = '';
      try {
        const result = await api('POST', '/api/journals', { date: newDate.value });
        if (seq !== request) return;
        install(result.document); showCreate.value = false;
        if (result.existing) message.value = L('已打开当天已有记录。', 'Opened the existing entry for this date.');
        await refresh();
        await nextTick(); editor.value?.focus();
      } catch (e) { if (seq === request) error.value = e.message; }
      finally { if (seq === request) opening.value = false; }
    }
    async function save() {
      if (!selected.value || saving.value || opening.value || !dirty.value) return;
      const doc = selected.value, submitted = text.value;
      saving.value = true; error.value = ''; message.value = '';
      try {
        const result = await api('PUT', '/api/journals/document', { id: doc.id, revision: doc.revision, markdown: submitted });
        if (selected.value?.id !== doc.id) return;
        selected.value = result; savedText.value = submitted; conflict.value = false;
        message.value = L('已保存到本机', 'Saved locally'); history.value = null;
        emit('saved'); await refresh();
      } catch (e) { error.value = e.message; conflict.value = e.status === 409; }
      finally { saving.value = false; }
    }
    function download() {
      const blob = new Blob([text.value], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = `${(selected.value?.title || 'journal').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 100)}.md`;
      a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function remember() { undo.push(text.value); if (undo.length > 40) undo.shift(); redo.length = 0; }
    function input(e) {
      if (Date.now() - lastInput > 600 || !undo.length) remember();
      lastInput = Date.now(); text.value = e.target.value; message.value = '';
    }
    async function format(action) {
      if (opening.value) return;
      if (mode.value === 'preview') { mode.value = 'split'; await nextTick(); }
      const el = editor.value;
      if (!el) return;
      remember(); lastInput = 0;
      const result = formatSelection(text.value, el.selectionStart, el.selectionEnd, action);
      text.value = result.text;
      await nextTick(); el.focus(); el.setSelectionRange(result.start, result.end);
    }
    function undoEdit(reverse = false) {
      if (opening.value || !selected.value) return;
      const from = reverse ? redo : undo, to = reverse ? undo : redo;
      if (!from.length) return;
      to.push(text.value); text.value = from.pop(); lastInput = 0;
    }
    function keys(e) {
      if (!props.active || !(e.ctrlKey || e.metaKey) || document.querySelector('.overlay')) return;
      const key = e.key.toLowerCase();
      if (key === 's') { e.preventDefault(); save(); }
      else if (e.target === editor.value && ['b', 'i', 'z', 'y'].includes(key)) {
        e.preventDefault();
        if (key === 'b' || key === 'i') format(key === 'b' ? 'bold' : 'italic');
        else undoEdit(key === 'y' || e.shiftKey);
      }
    }
    function beforeUnload(e) { if (dirty.value || saving.value) { e.preventDefault(); e.returnValue = ''; } }
    async function showHistory() {
      if (!selected.value || historyBusy.value) return;
      if (history.value) { history.value = null; return; }
      const id = selected.value.id;
      historyBusy.value = true;
      try {
        const result = await api('GET', `/api/journals/history?id=${encodeURIComponent(id)}`);
        if (selected.value?.id === id) history.value = result.revisions;
      } catch (e) { error.value = e.message; }
      finally { historyBusy.value = false; }
    }
    async function restore(revision) {
      if (!canReplace()) return;
      const id = selected.value.id, seq = ++request;
      opening.value = true;
      try {
        const result = await api('GET', `/api/journals/history?id=${encodeURIComponent(id)}&revision=${revision.id}`);
        if (seq !== request || selected.value?.id !== id) return;
        remember(); text.value = result.markdown; history.value = null;
        message.value = L('历史版本已放入编辑器，检查后保存即可恢复。', 'Version loaded into the editor. Save after reviewing.');
      } catch (e) { error.value = e.message; }
      finally { if (seq === request) opening.value = false; }
    }
    function onPreviewClick(e) {
      if (e.target.closest('sup.fn a')) e.currentTarget.querySelector('.fns')?.setAttribute('open', '');
    }
    watch(text, (v) => { clearTimeout(previewTimer); previewTimer = setTimeout(() => { previewText.value = v; }, 180); });
    watch(() => props.active, (v) => { if (v) refresh(); });
    watch(() => props.today, (v) => { if (!newDate.value) newDate.value = v; });
    onMounted(() => { if (props.active) refresh(); document.addEventListener('keydown', keys); window.addEventListener('beforeunload', beforeUnload); window.addEventListener('miztrace-before-update', beforeUnload); });
    onBeforeUnmount(() => { clearTimeout(previewTimer); request++; listRequest++; document.removeEventListener('keydown', keys); window.removeEventListener('beforeunload', beforeUnload); window.removeEventListener('miztrace-before-update', beforeUnload); });
    expose({ openSaved, refresh });
    return { L, documents, warnings, search, filter, filtered, selected, text, editor, loading, opening, saving, error, message,
      directories, managing, listCollapsed, toggleList, directoriesChanged, canChangeDirectories: () => !dirty.value && !saving.value && !opening.value,
      mode, newDate, showCreate, history, conflict, historyBusy, dirty, html, charCount, kindName, timeLabel,
      refresh, openDocument, create, save, download, input, format, undoEdit, showHistory, restore, onPreviewClick };
  },
  template: `
  <section class="journal-library" :aria-label="L('日记库', 'Journal library')">
    <header class="library-heading">
      <div><p class="eyebrow">YOUR PERSONAL ARCHIVE</p><h1>{{ L('日记库', 'Journal library') }} <span>{{ documents.length }}</span></h1><p>{{ L('让每一天的记录，都能被重新找到和继续书写。', 'Find your past days. Keep the story going.') }}</p></div>
      <div class="library-actions"><button class="btn" @click="refresh" :disabled="loading">{{ L('刷新列表', 'Refresh') }}</button><button class="btn primary" @click="showCreate = !showCreate">＋ {{ L('新建日记', 'New entry') }}</button></div>
    </header>
    <form v-if="showCreate" class="create-journal" @submit.prevent="create"><label>{{ L('日记日期', 'Date') }} <input type="date" v-model="newDate" required></label><button class="btn primary" :disabled="opening || saving">{{ L('创建 / 打开', 'Create / Open') }}</button><span class="fine">{{ L('同一天已有记录时直接打开。新日记先保存在本机。', 'Existing dates open directly. New entries are stored locally.') }}</span></form>
    <p v-for="warning in warnings" :key="warning" class="library-notice">{{ warning }}</p>
    <journal-directories v-if="managing" :directories="directories" :can-change="canChangeDirectories" @close="managing=false" @changed="directoriesChanged"></journal-directories>
    <div class="library-layout" :class="{'list-collapsed':listCollapsed}">
      <aside class="journal-list" :aria-label="L('历史日记', 'Past entries')">
        <div class="journal-list-heading"><strong v-if="!listCollapsed">{{ L('全部记录', 'All entries') }}</strong><button class="btn small quiet" @click="toggleList" :aria-expanded="!listCollapsed" :aria-label="listCollapsed ? L('展开日记列表', 'Expand journal list') : L('收起日记列表', 'Collapse journal list')" :title="listCollapsed ? L('展开日记列表', 'Expand journal list') : L('收起日记列表', 'Collapse journal list')">{{ listCollapsed ? '›' : '‹' }}</button></div>
        <button v-if="listCollapsed" class="btn small quiet collapsed-folders" @click="managing=true" :title="L('管理日记目录', 'Journal folders')" :aria-label="L('管理日记目录', 'Journal folders')">▤</button>
        <template v-if="!listCollapsed">
        <div class="journal-search"><input type="search" v-model="search" :placeholder="L('搜索标题、日期或文件名…', 'Search title, date or filename…')" :aria-label="L('搜索日记', 'Search journals')"><select v-model="filter" :aria-label="L('日记类型', 'Entry type')"><option value="all">{{ L('全部记录', 'All entries') }}</option><option value="file">{{ kindName('file') }}</option><option value="journal">{{ kindName('journal') }}</option><option value="draft">{{ kindName('draft') }}</option></select></div>
        <div class="journal-entries" :aria-busy="loading">
          <p class="fine list-empty" v-if="loading && !documents.length">{{ L('正在读取日记…', 'Loading entries…') }}</p>
          <p class="fine list-empty" v-else-if="!filtered.length">{{ documents.length ? L('没有匹配的记录。', 'No matching entries.') : L('这里还没有日记。新建第一篇，或点击下面的「管理日记目录」选择文件夹。', 'Create an entry or choose folders below.') }}</p>
          <button v-for="doc in filtered" :key="doc.id" class="journal-entry" :class="{selected: selected?.id === doc.id}" :aria-current="selected?.id === doc.id ? 'true' : undefined" :disabled="saving || opening" @click="openDocument(doc.id)">
            <span class="entry-date">{{ doc.date || L('未标注日期', 'Undated') }}<i v-if="selected?.id === doc.id && dirty" :title="L('未保存', 'Unsaved')"></i></span><strong>{{ doc.title }}</strong><span class="entry-source">{{ kindName(doc.kind) }}</span><small v-if="doc.relativePath">{{ doc.relativePath }}</small>
          </button>
        </div>
        <footer class="journal-list-footer"><span class="fine">{{ directories.length }} {{ L('个目录 · Markdown + 本地记录', 'folders · Markdown + local entries') }}</span><button class="btn small quiet" @click="managing=true">{{ L('管理日记目录', 'Journal folders') }} ↗</button></footer>
        </template>
      </aside>
      <section class="journal-workspace" :aria-busy="opening">
        <p v-if="error" class="library-error" role="alert">{{ error }}</p>
        <div v-if="conflict && selected" class="conflict-actions"><button class="btn small" @click="download">{{ L('导出我的编辑', 'Export my edits') }}</button><button class="btn small" @click="openDocument(selected.id)">{{ L('重新打开最新版本', 'Reopen latest version') }}</button></div>
        <div v-if="!selected" class="journal-welcome"><span class="archive-icon" aria-hidden="true">▤</span><h2>{{ L('留住记录，也留出修改的余地', 'A place for your daily story') }}</h2><p>{{ L('从左侧打开一篇日记，或开始今天的记录。', 'Open an entry on the left, or start writing today.') }}</p><button class="btn primary" @click="showCreate = true">＋ {{ L('写一篇日记', 'Write an entry') }}</button><p class="fine">{{ L('无需配置模型。支持 Markdown 编辑和预览。', 'No AI setup required. Edit and preview Markdown.') }}</p></div>
        <template v-else>
          <header class="editor-heading"><div><h2>{{ selected.title }}</h2><p :title="selected.path || ''">{{ kindName(selected.kind) }} · {{ selected.kind === 'file' ? selected.relativePath : L('保存在本地数据库', 'Stored in local database') }}</p></div><button class="btn primary" @click="save" :disabled="!dirty || saving || opening">{{ saving ? L('保存中…', 'Saving…') : L('保存', 'Save') }} <kbd>⌘ / Ctrl S</kbd></button></header>
          <div class="editor-options"><div class="seg" :aria-label="L('编辑器视图', 'Editor view')"><button :class="{on:mode==='source'}" @click="mode='source'">{{ L('编辑', 'Edit') }}</button><button :class="{on:mode==='split'}" @click="mode='split'">{{ L('分栏', 'Split') }}</button><button :class="{on:mode==='preview'}" @click="mode='preview'">{{ L('预览', 'Preview') }}</button></div><span class="spacer"></span><button class="btn small quiet" @click="showHistory" :disabled="historyBusy || opening">{{ L('历史版本', 'Versions') }}</button><button class="btn small quiet" @click="download">{{ L('导出 .md', 'Export .md') }}</button></div>
          <div v-if="history" class="version-list"><p class="fine">{{ L('最近 50 个修改前版本。载入后需要手动保存。', 'Up to 50 previous versions. Save manually after loading.') }}</p><p v-if="!history.length">{{ L('还没有历史版本。首次修改保存后会保留旧版。', 'The original version is kept when you first save an edit.') }}</p><button v-for="revision in history" :key="revision.id" class="btn small" @click="restore(revision)" :disabled="saving || opening">{{ timeLabel(revision.createdAt) }} · #{{ revision.id }}</button></div>
          <div class="markdown-toolbar" v-if="mode !== 'preview'" :aria-label="L('Markdown 格式', 'Markdown formatting')">
            <button @click="format('heading')" :title="L('标题', 'Heading')">H2</button><button @click="format('bold')" :title="L('粗体 Ctrl/⌘ B', 'Bold Ctrl/⌘ B')"><b>B</b></button><button @click="format('italic')" :title="L('斜体 Ctrl/⌘ I', 'Italic Ctrl/⌘ I')"><i>I</i></button><button @click="format('strike')" :title="L('删除线', 'Strikethrough')"><s>S</s></button><span></span><button @click="format('list')" :title="L('无序列表', 'Bullet list')">≡</button><button @click="format('ordered')" :title="L('有序列表', 'Numbered list')">1.</button><button @click="format('task')" :title="L('待办', 'Task list')">☑</button><button @click="format('quote')" :title="L('引用', 'Quote')">❞</button><button @click="format('code')" :title="L('行内代码', 'Inline code')">&lt;/&gt;</button><button @click="format('block')" :title="L('代码块', 'Code block')">{ }</button><button @click="format('link')" :title="L('链接', 'Link')">↗</button><button @click="format('table')" :title="L('表格', 'Table')">▦</button><span></span><button @click="undoEdit()" :title="L('撤销', 'Undo')">↶</button><button @click="undoEdit(true)" :title="L('重做', 'Redo')">↷</button>
          </div>
          <div class="editor-panes" :class="mode"><textarea v-show="mode !== 'preview'" ref="editor" :value="text" @input="input" :disabled="opening" spellcheck="false" :aria-label="L('Markdown 正文', 'Markdown source')" :placeholder="L('从一行文字开始…', 'Start with a line…')"></textarea><article v-show="mode !== 'source'" class="md editor-preview" v-html="html" @click="onPreviewClick"></article></div>
          <footer class="editor-status" aria-live="polite"><span :class="{unsaved:dirty}">{{ dirty ? L('● 有未保存修改', '● Unsaved changes') : L('✓ 已保存', '✓ Saved') }}</span><span>{{ charCount }} {{ L('字符', 'characters') }}</span><span class="spacer"></span><span>{{ message }}</span></footer>
          <p class="editor-note">{{ L('手动编辑的内容需重新核对事实；图片语法仅显示说明，不加载远程图片。', 'Manually edited facts need review. Image syntax displays a label without loading remote images.') }}</p>
        </template>
      </section>
    </div>
  </section>`,
};
