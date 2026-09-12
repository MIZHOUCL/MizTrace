/**
 * MizTrace 前端。Vue 3 运行时模板，无构建步骤，ES 模块直接由本地服务提供。
 * 交互模型：一天是一张时间板，模块是落在上面的一滴墨迹。默认全部写进日记，戳破不想写的；戳破可撤销。
 */
import { api } from './lib/api.js';
import { renderMd } from './lib/md.js';
import { dateWords, relativeDay, shiftIso, daySentence, sourcesSentence, catVar, CAT_WORD, CATS, num } from './lib/format.js';
import { t, lang, setLang, LANGS } from './lib/i18n.js';
import { DayBoard } from './components/dayboard.js';
import { Drawer } from './components/drawer.js';
import { SetupPanel } from './components/setup.js';
import { PreviewModal, SettingsModal } from './components/modals.js';
import { ListView } from './components/listview.js';
import { NotesBox } from './components/notes.js';

const { createApp, ref, computed, reactive, watch, onMounted, nextTick } = window.Vue;

createApp({
  components: { DayBoard, Drawer, SetupPanel, PreviewModal, SettingsModal, ListView, NotesBox },
  setup() {
    const state = reactive({ today: '', tz: '', utcOffset: '', config: null, rootsConfigured: false, setupDone: false, platform: '', home: '', dataDir: '', configPath: '', disclosure: null });
    const date = ref('');
    const loading = ref(false);
    const error = ref('');
    const modules = ref([]);
    const notes = ref({ text: '', updatedAt: null, images: [] });
    const notesSaving = ref(false);
    const meta = reactive({ sources: null, usage: null, excludeProjects: [] });
    const view = ref(localStorage.getItem('dt_view') || 'board');
    const drawer = ref(null);
    const popping = ref({});
    const risen = ref(false);
    const toast = ref(null);
    let toastTimer = null;
    const undoStack = [];

    const draft = ref(null); // 正在显示的那篇
    const aiDraft = ref(null); // 最近一次 AI 写的：看完规则版还能切回来，不用再花一次 token
    const rulesDraft = ref(null); // 最近一次规则版
    const writing = ref(false); // 模型正在写
    const rulesBusy = ref(false); // 规则版正在生成 —— 跟 writing 分开：之前共用一个开关，规则版没回来时确认弹窗的按钮就是灰的
    const previewing = ref(false); // 正在准备发送前确认
    const preview = ref(null);
    const showSettings = ref(false);
    const sources = ref(null);
    const testResult = ref(null);
    const testing = ref(false);
    const saving = ref(false);
    const hintSaving = ref(false);
    const setupNeeded = computed(() => state.config && !state.setupDone && !state.rootsConfigured);

    const selectedCount = computed(() => modules.value.filter((m) => m.selected).length);
    const headline = computed(() => daySentence(modules.value, date.value, state.today));
    const subline = computed(() => sourcesSentence(meta.sources));
    const legend = computed(() => CATS.filter((c) => modules.value.some((m) => m.category === c)));
    const dateLabel = computed(() => {
      const rel = relativeDay(date.value, state.today);
      return rel ? `${dateWords(date.value)}${lang.value === 'en' ? ', ' : '，'}${rel}` : dateWords(date.value);
    });
    const aiReady = computed(() => Boolean(state.config?.ai?.configured));

    function showToast(text, undo) {
      toast.value = { text, undo };
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (toast.value = null), 6000);
    }

    async function loadState() {
      const s = await api('GET', '/api/state');
      Object.assign(state, s);
      if (!date.value) date.value = s.today;
    }
    async function loadSources() {
      sources.value = await api('GET', '/api/sources');
    }
    /** refresh = 重新采集；不带就复用服务端两分钟内的采集结果（保存手记、戳泡泡之后不必再扫一遍）。 */
    async function loadDay({ refresh = false } = {}) {
      loading.value = true;
      error.value = '';
      try {
        const d = await api('GET', `/api/day?date=${encodeURIComponent(date.value)}${refresh ? '&refresh=1' : ''}`);
        modules.value = d.modules;
        notes.value = d.notes ?? { text: '', updatedAt: null, images: [] };
        Object.assign(meta, { sources: d.sources, usage: d.usage, excludeProjects: d.excludeProjects });
        aiDraft.value = null;
        rulesDraft.value = null;
        draft.value = d.draft ? { markdown: d.draft.markdown, clean: d.draft.clean, ...(d.draft.meta || {}) } : null;
        if (draft.value?.source === 'ai') aiDraft.value = draft.value;
        if (drawer.value) drawer.value = modules.value.find((m) => m.key === drawer.value.key) || null;
        risen.value = true;
        setTimeout(() => (risen.value = false), 600);
      } catch (e) {
        error.value = e.message;
      } finally {
        loading.value = false;
      }
    }
    function shiftDate(days) {
      date.value = shiftIso(date.value, days);
      loadDay({ refresh: true });
    }
    function pickDate(e) {
      const el = e.currentTarget.querySelector('input');
      try {
        el.showPicker();
      } catch {
        el.focus();
      }
    }

    async function setSelected(m, selected, { silent } = {}) {
      const before = m.selected;
      m.selected = selected;
      try {
        await api('POST', '/api/day/override', { date: date.value, key: m.key, selected });
        m.overridden = true;
        if (!silent) {
          undoStack.push({ key: m.key, before });
          showToast(lang.value === 'en' ? `"${m.title}" ${selected ? t('writeBack') : t('dontWrite')}` : `「${m.title}」${selected ? t('writeBack') : t('dontWrite')}`, () => undo());
        }
      } catch (e) {
        m.selected = before;
        error.value = e.message;
      }
    }
    async function pop(m) {
      if (!m.selected) return setSelected(m, true);
      popping.value = { ...popping.value, [m.key]: true };
      await new Promise((r) => setTimeout(r, 360));
      popping.value = { ...popping.value, [m.key]: false };
      await setSelected(m, false);
    }
    async function undo() {
      const last = undoStack.pop();
      if (!last) return;
      const m = modules.value.find((x) => x.key === last.key);
      if (m) await setSelected(m, last.before, { silent: true });
      toast.value = null;
    }
    async function resetDay() {
      await api('POST', '/api/day/reset', { date: date.value });
      await loadDay();
      showToast(t('resetDone'));
    }
    async function excludeProject(m) {
      if (!confirm(t('excludeForever', { p: m.projectName }))) return;
      await api('POST', '/api/project/exclude', { project: m.projectName });
      await loadDay();
      showToast(t('excluded', { p: m.projectName }));
    }
    async function saveHint(m, text) {
      hintSaving.value = true;
      try {
        const r = await api('POST', '/api/day/hint', { date: date.value, key: m.key, hint: text });
        m.hint = r.hints[m.key] ?? '';
        showToast(m.hint ? t('hintSaved') : t('hintCleared'));
      } catch (e) {
        error.value = e.message;
      } finally {
        hintSaving.value = false;
      }
    }

    async function rulesJournal() {
      rulesBusy.value = true;
      error.value = '';
      try {
        const r = await api('GET', `/api/journal?date=${encodeURIComponent(date.value)}&lang=${lang.value}`);
        rulesDraft.value = { markdown: r.markdown, clean: r.clean, source: 'rules' };
        draft.value = rulesDraft.value;
        await nextTick();
        document.querySelector('.sheet')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) {
        error.value = e.message;
      } finally {
        rulesBusy.value = false;
      }
    }
    async function openPreview(templateId) {
      if (previewing.value) return;
      error.value = '';
      previewing.value = true;
      try {
        preview.value = await api('POST', '/api/write/preview', { date: date.value, template: templateId ?? preview.value?.template?.id, lang: lang.value });
      } catch (e) {
        error.value = e.message;
      } finally {
        previewing.value = false;
      }
    }
    async function confirmWrite(templateId) {
      preview.value = null;
      writing.value = true;
      error.value = '';
      showToast(t('sentToModel'));
      try {
        const r = await api('POST', '/api/write', { date: date.value, template: templateId, lang: lang.value });
        if (r.blocked) {
          error.value = r.error;
          return;
        }
        aiDraft.value = { markdown: r.markdown, clean: r.clean, source: 'ai', usage: r.usage, model: r.model, latencyMs: r.latencyMs, downgraded: r.downgraded, template: r.template };
        draft.value = aiDraft.value;
        meta.usage = (await api('GET', `/api/day?date=${encodeURIComponent(date.value)}`)).usage;
        await nextTick();
        document.querySelector('.sheet')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (e) {
        error.value = e.message;
      } finally {
        writing.value = false;
      }
    }
    async function saveDraft() {
      if (!draft.value) return;
      saving.value = true;
      try {
        const r = await api('POST', '/api/save', { date: date.value, markdown: draft.value.markdown, source: draft.value.source });
        showToast(`${t('savedTo')} ${r.path}`);
      } catch (e) {
        error.value = e.message;
      } finally {
        saving.value = false;
      }
    }
    async function copyDraft() {
      try {
        // 复制的是干净版：没有 [^evN] 上标和脚注，贴到哪里都是一篇日记
        await navigator.clipboard.writeText(draft.value.clean ?? draft.value.markdown);
        showToast(t('copied'));
      } catch {
        showToast(t('copyFailed'));
      }
    }

    async function saveNote(text) {
      notesSaving.value = true;
      try {
        const r = await api('POST', '/api/day/note', { date: date.value, text });
        notes.value = r.notes;
        await loadDay(); // 手记是一个模块，板子上要立刻出现
      } catch (e) {
        error.value = e.message;
      } finally {
        notesSaving.value = false;
      }
    }
    function readAsDataUrl(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(new Error('读不了这个文件'));
        fr.readAsDataURL(file);
      });
    }
    /** key 给了就是某个泡泡的配图（挂在那个模块上），不给就是手记的图。 */
    async function uploadImages(files, key) {
      notesSaving.value = true;
      hintSaving.value = Boolean(key);
      try {
        for (const f of files) {
          const data = await readAsDataUrl(f);
          const r = await api('POST', '/api/day/image', { date: date.value, name: f.name, mime: f.type, data, key: key || undefined });
          notes.value = r.notes;
        }
        await loadDay();
      } catch (e) {
        error.value = e.message;
      } finally {
        notesSaving.value = false;
        hintSaving.value = false;
      }
    }
    async function removeImage(id) {
      try {
        const r = await api('POST', '/api/day/image/delete', { date: date.value, id });
        notes.value = r.notes;
        await loadDay();
      } catch (e) {
        error.value = e.message;
      }
    }
    /** 点日记里的上标：先展开折叠的脚注，再让浏览器跳过去。 */
    function onMdClick(e) {
      const a = e.target.closest('sup.fn a');
      if (!a) return;
      const details = e.currentTarget.querySelector('details.fns');
      if (details && !details.open) details.open = true;
    }
    async function installShell(shells) {
      saving.value = true;
      try {
        const r = await api('POST', '/api/shell/install', { shells, enable: true });
        await loadSources();
        state.config = await api('GET', '/api/config');
        const done = r.results.filter((x) => x.status === 'installed').map((x) => x.id);
        const already = r.results.filter((x) => x.status === 'already').map((x) => x.id);
        const failed = r.results.filter((x) => x.status === 'failed');
        if (failed.length) error.value = `钩子写入失败：${failed.map((f) => `${f.id}（${f.error}）`).join('、')}`;
        else if (done.length) showToast(`已装到 ${done.join('、')}。开一个新终端后敲的命令才会被记下。`);
        else if (already.length) showToast('钩子早就装好了。开一个新终端试试。');
        else showToast('没有找到可写的 shell 配置文件，请复制片段手动加。');
      } catch (e) {
        error.value = e.message;
      } finally {
        saving.value = false;
      }
    }
    async function openSettings() {
      testResult.value = null;
      try {
        await loadSources();
        showSettings.value = true;
      } catch (e) {
        error.value = e.message;
      }
    }
    async function testAi(ai) {
      testing.value = true;
      testResult.value = null;
      try {
        testResult.value = await api('POST', '/api/ai/test', { ai });
      } catch (e) {
        testResult.value = { ok: false, error: e.message };
      } finally {
        testing.value = false;
      }
    }
    async function saveSettings(payload) {
      saving.value = true;
      try {
        state.config = await api('PUT', '/api/config', payload);
        state.setupDone = true;
        state.rootsConfigured = Boolean(payload.roots && String(payload.roots).trim());
        showSettings.value = false;
        showToast(t('settingsSaved'));
        await loadDay({ refresh: true });
      } catch (e) {
        error.value = e.message;
      } finally {
        saving.value = false;
      }
    }
    async function finishSetup(payload) {
      try {
        state.config = await api('PUT', '/api/config', payload);
        state.setupDone = true;
        state.rootsConfigured = true;
        await loadDay({ refresh: true });
      } catch (e) {
        error.value = e.message;
      }
    }
    async function skipSetup() {
      await finishSetup({ setupDone: true });
      state.rootsConfigured = false;
    }

    function onGlobalKey(e) {
      if (e.key === 'Escape') {
        if (preview.value) preview.value = null;
        else if (showSettings.value) showSettings.value = false;
        else if (drawer.value) drawer.value = null;
      }
    }

    const langMenu = ref(false);
    function pickLang(id) {
      setLang(id);
      langMenu.value = false;
      document.title = 'MizTrace';
    }
    onMounted(async () => {
      setLang(lang.value);
      document.addEventListener('keydown', onGlobalKey);
      document.addEventListener('click', (e) => {
        if (!e.target.closest('.langpick')) langMenu.value = false;
      });
      try {
        await loadState();
        if (setupNeeded.value) await loadSources();
        else await loadDay({ refresh: true });
      } catch (e) {
        error.value = e.message;
      }
    });
    watch(setupNeeded, (v) => {
      if (v && !sources.value) loadSources().catch((e) => (error.value = e.message));
    });

    return {
      state, date, loading, error, modules, notes, notesSaving, meta, view, drawer, popping, risen, toast, draft, aiDraft, rulesDraft, writing, rulesBusy, previewing, preview, showSettings, sources, testResult, testing, saving, hintSaving, setupNeeded,
      selectedCount, headline, subline, legend, dateLabel, aiReady,
      renderMd, catVar, CAT_WORD, num, t, lang, LANGS, langMenu, pickLang,
      showAi: () => (draft.value = aiDraft.value),
      showRules: () => (draft.value = rulesDraft.value),
      loadDay, shiftDate, pickDate, pop, setSelected, undo, resetDay, excludeProject, saveHint,
      rulesJournal, openPreview, confirmWrite, saveDraft, copyDraft, openSettings, testAi, saveSettings, finishSetup, skipSetup, onMdClick, installShell, saveNote, uploadImages, removeImage,
      setView: (v) => {
        view.value = v;
        localStorage.setItem('dt_view', v);
      },
    };
  },
  template: `
<div class="app">
  <header class="topbar">
    <span class="brand"><img src="./logo.png" alt="" width="26" height="26">MizTrace</span>
    <nav class="datenav" :aria-label="t('pickDate')">
      <button class="btn quiet" @click="shiftDate(-1)" :title="t('prevDay')" :aria-label="t('prevDay')">‹</button>
      <label class="datepick" @click.prevent="pickDate"><span>{{ dateLabel }}</span><input type="date" v-model="date" @change="loadDay({refresh: true})" :aria-label="t('pickDate')"></label>
      <button class="btn quiet" @click="shiftDate(1)" :title="t('nextDay')" :aria-label="t('nextDay')" :disabled="date >= state.today">›</button>
      <button class="btn quiet" v-if="date !== state.today" @click="date = state.today; loadDay({refresh: true})">{{ t('backToday') }}</button>
      <button class="btn quiet" @click="loadDay({refresh: true})" :disabled="loading" :title="t('refreshTitle')">{{ t('refresh') }}</button>
    </nav>
    <span class="status" v-if="loading" aria-live="polite"><span class="spin"></span> {{ t('collecting') }}</span>
    <span class="status" v-else-if="writing" aria-live="polite"><span class="spin"></span> {{ t('modelWriting') }}</span>
    <span class="spacer"></span>
    <span class="seg" role="group" :aria-label="t('view')" v-if="modules.length">
      <button :class="{on: view==='board'}" @click="setView('board')">{{ t('boardView') }}</button>
      <button :class="{on: view==='list'}" @click="setView('list')">{{ t('listView') }}</button>
    </span>
    <button class="btn quiet" @click="resetDay" :title="t('resetTitle')" v-if="modules.some(m => m.overridden)">{{ t('resetDefault') }}</button>
    <button class="btn" @click="rulesJournal" :disabled="rulesBusy || loading || !modules.length" :title="loading ? t('rulesTitleBusy') : ''"><span v-if="rulesBusy" class="spin"></span> {{ t('rulesJournal') }}</button>
    <button class="btn primary" @click="openPreview()" :disabled="writing || previewing || loading || !selectedCount" :title="loading ? t('genTitleBusy') : (!selectedCount ? t('genTitleNone') : (aiReady ? '' : t('genTitleNoAi')))">
      <span v-if="writing || previewing" class="spin light"></span> {{ writing ? t('generating') : (previewing ? t('preparing') : t('genJournal')) }}
    </button>
    <span class="langpick">
      <button class="btn quiet lang" @click="langMenu = !langMenu" :aria-label="t('lang')" aria-haspopup="listbox" :aria-expanded="langMenu"><b>{{ lang === 'en' ? 'US' : 'CN' }}</b> {{ lang === 'en' ? 'EN' : '中' }} <i>⌄</i></button>
      <ul class="langmenu" v-if="langMenu" role="listbox">
        <li v-for="l in LANGS" :key="l.id" role="option" :aria-selected="l.id === lang" :class="{on: l.id === lang}" @click="pickLang(l.id)"><b>{{ l.flag }}</b> {{ l.label }}<span v-if="l.id === lang">✓</span></li>
      </ul>
    </span>
    <button class="btn" @click="openSettings">{{ t('settings') }}</button>
  </header>

  <p v-if="error" class="banner" role="alert">{{ error }} <button class="btn small quiet" @click="error=''">{{ t('close') }}</button></p>

  <main v-if="setupNeeded && sources">
    <setup-panel :sources="sources" :home="state.home" :platform="state.platform" @done="finishSetup" @skip="skipSetup" @lang="pickLang"></setup-panel>
  </main>

  <template v-else>
    <section class="hero">
      <h1>{{ headline }}</h1>
      <p class="sub" v-if="subline">{{ subline }}</p>
      <notes-box :notes="notes" :date="date" :saving="notesSaving" :vision="state.config && state.config.ai && state.config.ai.vision === true" @save="saveNote" @upload="uploadImages" @remove="removeImage"></notes-box>
      <p class="legend" v-if="legend.length"><span v-for="c in legend" :key="c" class="chip" :class="'c-' + catVar(c)"><i></i>{{ CAT_WORD[c] }}</span><span class="how">{{ t('legendHow') }}</span></p>
    </section>

    <div class="stage" :class="{withdrawer: drawer}">
      <section class="canvas">
        <div v-if="!loading && !modules.length" class="empty">
          <p>{{ t('noTraces') }}</p>
          <p class="fine">{{ subline || t('notCollected') }}</p>
          <button class="btn" @click="openSettings">{{ t('checkSources') }}</button>
        </div>
        <day-board v-else-if="view==='board'" :modules="modules" :date="date" :today="state.today" :popping="popping" :risen="risen" @open="drawer = $event" @pop="pop"></day-board>
        <list-view v-else :modules="modules" @open="drawer = $event" @toggle="setSelected"></list-view>
      </section>
      <drawer v-if="drawer" :module="drawer" :date="date" :saving="hintSaving" :vision="state.config && state.config.ai && state.config.ai.vision === true" @close="drawer = null" @pop="pop" @exclude="excludeProject" @hint="saveHint" @upload="uploadImages" @remove-image="removeImage"></drawer>
    </div>

    <section class="sheet" v-if="draft" aria-label="diary">
      <div class="tools">
        <strong>{{ draft.source==='ai' ? t('aiDiary') : t('rulesDiary') }}</strong>
        <span class="u" v-if="draft.usage">{{ draft.model }}<template v-if="draft.template">, {{ t('template') }} "{{ draft.template }}"</template>, {{ t('input') }} {{ num(draft.usage.input) }} / {{ t('output') }} {{ num(draft.usage.output) }} tokens<template v-if="draft.downgraded">, {{ draft.downgraded }} {{ t('downgraded') }}</template></span>
        <span class="spacer"></span>
        <button class="btn small" v-if="draft.source !== 'ai' && aiDraft" @click="showAi">{{ t('backToAi') }}</button>
        <button class="btn small" v-if="draft.source === 'ai' && rulesDraft" @click="showRules">{{ t('backToRules') }}</button>
        <button class="btn small" v-if="draft.source === 'ai'" @click="openPreview()" :disabled="writing || previewing || loading || !selectedCount">{{ t('regenerate') }}</button>
        <button class="btn small" @click="copyDraft">{{ t('copyMd') }}</button>
        <button class="btn small primary" @click="saveDraft" :disabled="saving">{{ saving ? t('saving') : t('saveToDir') }}</button>
        <button class="btn small quiet" @click="draft=null">{{ t('collapse') }}</button>
      </div>
      <article class="md" v-html="renderMd(draft.markdown)" @click="onMdClick"></article>
    </section>
  </template>

  <preview-modal v-if="preview" :preview="preview" :writing="writing" @close="preview=null" @confirm="confirmWrite" @template="openPreview" @settings="preview=null; openSettings()"></preview-modal>
  <settings-modal v-if="showSettings && sources" :config="state.config" :sources="sources" :home="state.home" :platform="state.platform" :config-path="state.configPath" :testing="testing" :test-result="testResult" :saving="saving" @close="showSettings=false" @save="saveSettings" @test="testAi" @install-shell="installShell"></settings-modal>

  <div class="toast" v-if="toast" role="status">{{ toast.text }} <button v-if="toast.undo" @click="toast.undo()">{{ t('undo') }}</button></div>
</div>`,
}).mount('#app');
