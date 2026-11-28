import { api } from '../lib/api.js';
import { renderMd } from '../lib/md.js';
import { lang } from '../lib/i18n.js';
import { ReportTemplateEditor } from './report-template-editor.js';
const { ref, computed, watch, onBeforeUnmount } = window.Vue;

export const Reports = {
  components: { ReportTemplateEditor },
  props: { active: Boolean, today: String },
  emits: ['edit', 'settings'],
  setup(props, { emit }) {
    const L = (zh, en) => lang.value === 'en' ? en : zh;
    const kind = ref('week'), start = ref(''), end = ref(''), template = ref('work');
    const templates = ref([]), history = ref([]), sources = ref([]), warnings = ref([]), chosen = ref([]);
    const loadedPeriod = ref(''), loading = ref(false), previewing = ref(false), preview = ref(null);
    const busy = ref(false), phase = ref(''), error = ref(''), result = ref(null), message = ref('');
    const sourceCollapsed = ref(false), elapsed = ref(0);
    const templateEditor = ref(null), templateSaving = ref(false), templateError = ref(''), builtinTemplates = ref([]);
    let templateRevision = '', templatesLoaded = false;
    let pollTimer, clockTimer, pollFailures = 0, disposed = false, sourceRequest = 0;
    const period = computed(() => `${kind.value}:${start.value}:${end.value}`);
    const stale = computed(() => period.value !== loadedPeriod.value);
    const selectedDays = computed(() => new Set(sources.value.filter((s) => chosen.value.includes(s.id)).map((s) => s.date)).size);
    const currentTemplate = computed(() => templates.value.find((t) => t.id === template.value));
    const html = computed(() => renderMd(result.value?.markdown || ''));
    const aiBlocked = computed(() => preview.value && (preview.value.managedDevice || preview.value.secretHits.length || preview.value.aiProblems.length || (preview.value.dailyLimit && preview.value.usage.calls + preview.value.estimatedCalls > preview.value.dailyLimit)));
    const kindName = (v) => ({ file: L('文件', 'File'), journal: L('日记', 'Journal'), draft: L('草稿', 'Draft'), notes: L('手记', 'Notes') })[v] || v;
    const options = () => ({ kind: kind.value, start: start.value, end: end.value, template: template.value, lang: lang.value });
    const iso = (d) => d.toISOString().slice(0, 10);
    function preset(value) {
      if (busy.value) return;
      const now = new Date(`${props.today}T12:00:00Z`), a = new Date(now), b = new Date(now);
      if (value.includes('week')) {
        kind.value = 'week'; a.setUTCDate(a.getUTCDate() - (a.getUTCDay() + 6) % 7);
        if (value === 'last-week') { b.setTime(a.getTime() - 86400000); a.setUTCDate(a.getUTCDate() - 7); }
      } else {
        kind.value = 'month'; a.setUTCDate(1);
        if (value === 'last-month') { b.setTime(a.getTime() - 86400000); a.setUTCMonth(a.getUTCMonth() - 1); }
      }
      start.value = iso(a); end.value = iso(b);
    }
    async function refreshHistory() {
      const data = await api('GET', '/api/reports');
      templates.value = data.templates; history.value = data.reports;
      builtinTemplates.value = data.builtinTemplates; templateRevision = data.templateRevision;
      if (!templatesLoaded || !data.templates.some((t) => t.id === template.value)) template.value = data.templates.some((t) => t.id === data.template) ? data.template : 'work';
      templatesLoaded = true;
    }
    function editTemplate(mode = 'edit') {
      templateError.value = '';
      const base = currentTemplate.value;
      const isNew = mode !== 'edit';
      const item = mode === 'new' ? { id: '', name: '', description: '', sections: ['本期产出', '问题与后续'], prompt: '' } : JSON.parse(JSON.stringify(base));
      if (isNew) { item.id = 'report-' + crypto.randomUUID().slice(0, 20); if (mode === 'copy') item.name = (item.name + '（副本）').slice(0, 40); }
      templateEditor.value = { item, isNew, builtin: !isNew && builtinTemplates.value.find((t) => t.id === item.id), revision: templateRevision };
    }
    async function saveTemplate(item, action = 'save') {
      templateSaving.value = true; templateError.value = '';
      try {
        const list = templates.value.filter((t) => t.id !== templateEditor.value.item.id);
        if (action === 'save') list.push(item);
        const selected = action === 'delete' ? 'work' : templateEditor.value.item.id;
        const data = await api('PUT', '/api/reports/templates', { templates: list, template: selected, revision: templateEditor.value.revision });
        templates.value = data.templates; builtinTemplates.value = data.builtinTemplates; templateRevision = data.templateRevision;
        template.value = selected; templateEditor.value = null; preview.value = null;
        message.value = L('模板已保存', 'Template saved');
      } catch (e) { templateError.value = e.message; if (e.code === 'TEMPLATES_CHANGED') await refreshHistory().catch(() => {}); }
      finally { templateSaving.value = false; }
    }
    async function loadSources() {
      const seq = ++sourceRequest, requested = period.value;
      loading.value = true; error.value = ''; preview.value = null;
      try {
        const data = await api('POST', '/api/reports/sources', options());
        if (seq !== sourceRequest || requested !== period.value) return;
        sources.value = data.sources; warnings.value = data.warnings;
        chosen.value = data.sources.filter((s) => s.selected).map((s) => s.id); loadedPeriod.value = requested;
      } catch (e) { if (seq === sourceRequest) error.value = e.message; }
      finally { if (seq === sourceRequest) loading.value = false; }
    }
    async function prepare() {
      previewing.value = true; error.value = ''; preview.value = null;
      try { preview.value = await api('POST', '/api/reports/preview', { ...options(), sourceIds: [...chosen.value] }); }
      catch (e) { error.value = e.message; }
      finally { previewing.value = false; }
    }
    function finish() {
      busy.value = false; clearTimeout(pollTimer); clearInterval(clockTimer); sessionStorage.removeItem('mt_report_job');
    }
    async function poll(id) {
      if (disposed) return;
      try {
        const job = await api('GET', `/api/reports/job?id=${encodeURIComponent(id)}`);
        pollFailures = 0; phase.value = job.message || '';
        if (job.status === 'done') {
          result.value = job.document; finish(); await refreshHistory(); return;
        }
        if (job.status === 'error') { error.value = job.error; finish(); return; }
      } catch (e) {
        if (e.status === 404) { error.value = e.message; finish(); await refreshHistory().catch(() => {}); return; }
        pollFailures++;
        phase.value = L('连接中断，正在重新获取进度；服务恢复后会继续显示。', 'Reconnecting to retrieve progress…');
      }
      if (!disposed) pollTimer = setTimeout(() => poll(id), pollFailures ? 5000 : 1000);
    }
    function track(id) {
      busy.value = true; elapsed.value = 0; pollFailures = 0;
      sessionStorage.setItem('mt_report_job', id);
      clearInterval(clockTimer); clockTimer = setInterval(() => elapsed.value++, 1000);
      poll(id);
    }
    async function generate(mode) {
      if (!preview.value || busy.value) return;
      busy.value = true; error.value = ''; phase.value = L('正在开始生成…', 'Starting…');
      try {
        const job = await api('POST', '/api/reports/generate', { token: preview.value.token, mode });
        preview.value = null; track(job.id);
      } catch (e) { error.value = e.message; busy.value = false; }
    }
    async function recoverLocal() {
      await prepare();
      if (preview.value) await generate('local');
    }
    async function open(id) {
      try { result.value = await api('GET', `/api/reports/document?id=${encodeURIComponent(id)}`); error.value = ''; }
      catch (e) { error.value = e.message; }
    }
    function download() {
      const url = URL.createObjectURL(new Blob([result.value.markdown], { type: 'text/markdown;charset=utf-8' }));
      const a = document.createElement('a'); a.href = url;
      a.download = `${result.value.start}_${result.value.end}_${result.value.reportKind === 'week' ? '周报' : '月报'}.md`;
      a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async function copy() {
      try { await navigator.clipboard.writeText(result.value.markdown); message.value = L('已复制 Markdown', 'Markdown copied'); }
      catch { error.value = L('无法访问剪贴板，请导出 Markdown。', 'Clipboard unavailable. Please export Markdown.'); }
    }
    function guard(e) { if (busy.value) { e.preventDefault(); if (e.type === 'beforeunload') e.returnValue = ''; } }
    window.addEventListener('beforeunload', guard); window.addEventListener('miztrace-before-update', guard);
    watch([() => props.active, () => props.today], async ([active, today]) => {
      if (!active || !today) return;
      try {
        await refreshHistory();
        if (!start.value) { preset('this-week'); await loadSources(); }
        if (result.value) await open(result.value.id);
        const pending = sessionStorage.getItem('mt_report_job');
        if (pending && !busy.value) track(pending);
      } catch (e) { error.value = e.message; }
    }, { immediate: true });
    watch([period, template, chosen, lang], () => { if (!busy.value) preview.value = null; }, { deep: true });
    onBeforeUnmount(() => { disposed = true; clearTimeout(pollTimer); clearInterval(clockTimer); window.removeEventListener('beforeunload', guard); window.removeEventListener('miztrace-before-update', guard); });
    return { L, kind, start, end, template, templates, history, sources, warnings, chosen, loading, previewing, preview,
      busy, phase, error, result, message, sourceCollapsed, elapsed, stale, selectedDays, currentTemplate, html, aiBlocked,
      templateEditor, templateSaving, templateError, editTemplate, saveTemplate,
      kindName, preset, loadSources, prepare, generate, recoverLocal, open, download, copy, edit: () => emit('edit', result.value), settings: () => emit('settings') };
  },
  template: `
  <section class="reports-page">
    <header class="reports-heading"><div><span class="reports-eyebrow">MIZTRACE / REVIEW</span><h1>{{ L('把每天的进展，写成一份好报告', 'Turn daily progress into a clear report') }}</h1><p>{{ L('按项目讲清结果，让成果、问题和下一步各有位置。', 'Organize outcomes, open issues and next steps by project.') }}</p></div><span class="report-tag">{{ L('周报 / 月报', 'Weekly / Monthly') }}</span></header>
    <p v-if="error" class="library-error" role="alert">{{ error }}</p>
    <div v-if="error && !busy && !preview && !stale && chosen.length" class="report-recovery"><button class="btn small" @click="prepare" :disabled="previewing">{{ L('重新预览并重试', 'Preview and retry') }}</button><button class="btn small" @click="recoverLocal" :disabled="previewing">{{ L('保存本地资料整理版', 'Save an offline source draft') }}</button><span class="fine">{{ L('素材选择仍保留；本地整理不调用模型。', 'Your selection is retained. Offline drafting makes no model calls.') }}</span></div>
    <div v-if="busy" class="report-progress" role="status" aria-live="polite"><span class="spin"></span><div><strong>{{ phase }}</strong><small>{{ elapsed }}s · {{ L('可以切换模块，完成后自动保存在本机。请保持应用运行。', 'You can switch modules. Keep the app running; the result saves locally.') }}</small></div></div>
    <div class="report-layout">
      <section class="report-config">
        <div class="report-step"><b>01</b><h2>{{ L('确定汇报范围', 'Choose a period') }}</h2></div>
        <fieldset :disabled="busy || previewing">
          <div class="report-presets"><button class="btn small" @click="preset('this-week')">{{ L('本周', 'This week') }}</button><button class="btn small" @click="preset('last-week')">{{ L('上周', 'Last week') }}</button><button class="btn small" @click="preset('this-month')">{{ L('本月', 'This month') }}</button><button class="btn small" @click="preset('last-month')">{{ L('上月', 'Last month') }}</button></div>
          <div class="report-dates"><label>{{ L('类型', 'Type') }}<select v-model="kind"><option value="week">{{ L('周报', 'Weekly') }}</option><option value="month">{{ L('月报', 'Monthly') }}</option></select></label><label>{{ L('开始日期', 'Start') }}<input type="date" v-model="start"></label><label>{{ L('结束日期', 'End') }}<input type="date" v-model="end"></label></div>
          <label class="report-template-label">{{ L('报告模板', 'Template') }}<select v-model="template"><option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}</option></select></label>
          <p class="fine">{{ currentTemplate?.description }}</p>
          <div class="report-template-actions"><button class="btn small" @click="editTemplate()" :disabled="!currentTemplate">{{ L('查看 / 编辑提示词', 'View / edit prompt') }}</button><button class="btn small" @click="editTemplate('new')">{{ L('新建模板', 'New template') }}</button><button class="btn small quiet" @click="editTemplate('copy')" :disabled="!currentTemplate">{{ L('复制模板', 'Duplicate') }}</button></div>
          <div class="report-section-chips"><span v-for="s in currentTemplate?.sections" :key="s">{{ s }}</span></div>
          <div class="report-step"><b>02</b><h2>{{ L('选择事实素材', 'Select sources') }}</h2><button class="btn small quiet" @click="sourceCollapsed=!sourceCollapsed" :aria-expanded="!sourceCollapsed">{{ sourceCollapsed ? L('展开素材', 'Expand') : L('收起素材', 'Collapse') }}</button></div>
          <p class="fine">{{ L('读取日记库中带日期的记录和已保存手记，不重新扫描历史工作目录。', 'Uses dated library entries and saved notes without rescanning historical work.') }}</p>
          <div class="report-source-tools"><button class="btn small" @click="loadSources" :disabled="loading">{{ loading ? L('读取中…', 'Loading…') : L('加载 / 刷新素材', 'Load / refresh sources') }}</button><span>{{ chosen.length }} {{ L('份 · 覆盖', 'selected ·') }} {{ selectedDays }} {{ L('天', 'days') }}</span></div>
          <p v-if="stale" class="library-notice">{{ L('日期已更改，请加载当前范围的素材。', 'Period changed. Reload sources for this range.') }}</p>
          <template v-if="!sourceCollapsed">
            <p v-for="warning in warnings" :key="warning" class="fine">{{ warning }}</p>
            <div class="report-source-list" v-if="sources.length"><label v-for="s in sources" :key="s.id"><input type="checkbox" v-model="chosen" :value="s.id" :disabled="stale"><span><strong>{{ s.title }}</strong><small>{{ s.date }} · {{ kindName(s.kind) }} · {{ s.chars }} {{ L('字符', 'chars') }}</small></span></label></div>
            <p v-else-if="!loading" class="report-no-sources">{{ L('本期还没有可用素材。先在日记库保存记录，或在今日记录添加手记。外部 Markdown 文件名需以 YYYY-MM-DD 开头。', 'Save journals or notes first. External Markdown filenames must begin with YYYY-MM-DD.') }}</p>
          </template>
          <button class="btn primary report-generate" @click="prepare" :disabled="stale || !chosen.length || loading || previewing">{{ previewing ? L('准备预览…', 'Preparing…') : L('预览素材并生成报告', 'Preview sources and generate') }} →</button>
          <p class="fine">{{ L('先预览提示词和发送内容，AI 按所选模板提炼并汇总；不调用 AI 时可仅保存素材汇编。', 'Preview prompts and sources. AI follows your template; you can also save a source compilation without AI.') }}</p>
        </fieldset>
        <details class="report-history" open><summary>{{ L('报告历史', 'Report history') }} · {{ history.length }}</summary><p class="fine" v-if="!history.length">{{ L('生成后自动保存，也会出现在日记库。', 'Reports save automatically and appear in the library.') }}</p><button v-for="r in history" :key="r.id" :class="{selected:result?.id===r.id}" @click="open(r.id)"><strong>{{ r.title }}</strong><small>{{ r.updatedAt.slice(0, 10) }}</small></button></details>
      </section>
      <section class="report-output">
        <template v-if="result">
          <header class="report-output-tools"><strong>{{ result.metadata.quality === 'partial' ? L('已保存的待核对草稿', 'Saved draft for review') : result.metadata.source.startsWith('local') ? L('已保存的资料整理版', 'Saved source draft') : L('已保存的报告', 'Saved report') }}</strong><span class="spacer"></span><button class="btn small" @click="edit">{{ L('编辑报告', 'Edit report') }}</button><button class="btn small" @click="copy">{{ L('复制', 'Copy') }}</button><button class="btn small" @click="download">{{ L('导出 .md', 'Export .md') }}</button></header>
          <p class="fine report-result-meta" role="status">{{ result.metadata.source.startsWith('local') ? L('本地资料整理版 · 请根据原文编辑', 'Source draft · edit using the originals') : result.metadata.model }}<template v-if="result.metadata.usage"> · {{ result.metadata.calls }} {{ L('次调用', 'calls') }} · {{ result.metadata.usage.input + result.metadata.usage.output }} tokens</template><template v-if="result.metadata.edited"> · {{ L('已手动编辑，原引句供复核参考', 'Manually edited; original citations are for review') }}</template> {{ message }}</p>
          <aside v-if="result.metadata.warnings?.length" class="report-quality" role="status"><strong>{{ result.metadata.quality === 'fallback' ? L('AI 内容未通过检查，已保留原文', 'AI output could not be validated; sources are saved') : L('部分内容未能核对，请补充后再分享', 'Some content needs review before sharing') }}</strong><p>{{ result.metadata.quality === 'fallback' ? L('这是一份可编辑的资料整理版，不是已完成的 AI 报告。你可以直接编辑，也可以重新预览后重试。', 'This is an editable source draft, not a completed AI report. Edit it or preview again to retry.') : L('通过检查的内容已保留。未能核对的模型说法未放入正文，可能存在遗漏；请对照下方检查信息和原文编辑。', 'Validated content is retained. Unvalidated claims were excluded, so review the sources for omissions.') }}</p><details><summary>{{ L('查看生成检查与所选原文', 'Generation checks and selected sources') }}</summary><ul><li v-for="(w,i) in result.metadata.warnings" :key="i">{{ w.refs?.map(r=>r.toUpperCase()).join(' / ') }} · {{ w.message }}</li></ul><details v-for="s in result.metadata.sources" :key="s.ref"><summary>[{{ s.ref.toUpperCase() }}] {{ s.date }} · {{ s.title }}</summary><pre>{{ s.content }}</pre></details></details></aside>
          <article class="md report-document" v-html="html"></article>
          <details class="report-used-template" v-if="result.metadata.template"><summary>{{ L('本次模板与提示词', 'Template and prompts used') }} · {{ result.metadata.template.name }}</summary><pre>{{ result.metadata.template.prompt }}</pre><details v-if="result.metadata.instructions"><summary>{{ L('完整提炼提示词', 'Full extraction instructions') }}</summary><pre>{{ result.metadata.instructions.extract }}</pre></details><details v-if="result.metadata.instructions"><summary>{{ L('完整汇总提示词', 'Full review instructions') }}</summary><pre>{{ result.metadata.instructions.review }}</pre></details><p class="fine" v-if="result.metadata.source.startsWith('local')">{{ L('此版本仅汇集素材，未调用模型或执行上述提示词。', 'This draft only compiles sources; the prompts were not run.') }}</p></details>
          <details class="report-audit" v-if="result.metadata.facts?.length"><summary>{{ L('核对事实与原文引句', 'Review facts against source quotes') }} · {{ result.metadata.facts.length }}</summary><div v-for="(f,i) in result.metadata.facts" :key="i"><strong>{{ f.project }} / {{ f.topic }}</strong><p>{{ f.text }}</p><blockquote v-for="(q,j) in f.quotes" :key="j">[{{ q.ref.toUpperCase() }}] {{ q.text }}</blockquote></div><p class="fine">{{ L('引用匹配不等于语义完全正确；分享前请核对成果状态和敏感内容。', 'Quote matching cannot guarantee semantic accuracy. Review before sharing.') }}</p></details>
        </template>
        <div v-else class="report-welcome"><span aria-hidden="true">▥</span><h2>{{ L('一份有依据、有重点的汇报', 'A focused report with traceable sources') }}</h2><p>{{ L('写清做了什么、形成了什么方案与结果。只有明确仍在处理的问题才列为后续事项。', 'Describe actions, solutions and outcomes. List ongoing work only when the records say it remains open.') }}</p><ol><li>{{ L('选择日期，查看或编写模板提示词', 'Choose a period and edit your template prompt') }}</li><li>{{ L('勾选本期日记与手记', 'Select journals and notes') }}</li><li>{{ L('预览、生成，核对后分享', 'Preview, generate and review before sharing') }}</li></ol><p class="fine">{{ L('不补写缺失的成果数字，不用套话填满空白。', 'No invented metrics or filler for missing information.') }}</p></div>
      </section>
    </div>
    <div class="report-overlay" v-if="preview" @click.self="!busy && (preview=null)"><section class="report-preview-modal" role="dialog" aria-modal="true" aria-labelledby="report-preview-title">
      <header><h2 id="report-preview-title">{{ L('确认本次报告素材', 'Review report sources') }}</h2><button class="btn quiet" @click="preview=null" :disabled="busy" :aria-label="L('关闭素材预览', 'Close source preview')">×</button></header>
      <p>{{ preview.options.start }} ~ {{ preview.options.end }} · {{ preview.daysCovered }}/{{ preview.options.days }} {{ L('天有素材', 'days covered') }}</p>
      <p>{{ L('AI 会向你配置的模型服务发送下方选中正文（含日记 / Markdown 内容），进行事实提炼和整篇审核。不会发送未选记录和图片。', 'AI sends the selected journal / Markdown text below to your configured model for extraction and review. Unselected records and images are excluded.') }}</p>
      <p class="fine">{{ preview.model || L('尚未配置模型', 'No model configured') }} · {{ L('预计至少', 'At least') }} {{ preview.estimatedCalls }} {{ L('次调用；校验不通过时每步最多重试一次。提炼输入约', 'calls; each step may retry once. Extraction input approximately') }} {{ preview.estTokens }} tokens{{ L('，另计审核与输出。', '; review and output are additional.') }}</p>
      <p v-if="aiBlocked" class="library-error">{{ preview.managedDevice ? L('受管设备已禁用 AI 外发。', 'AI disabled on managed device.') : preview.secretHits.length ? L('素材中检测到疑似密钥，已阻止发送。请修改原文后重新预览。', 'Possible secrets detected. Edit sources and preview again.') : preview.aiProblems.length ? preview.aiProblems.join('、') : L('今日剩余调用次数不足。', 'Insufficient daily call allowance.') }}</p>
      <details v-for="s in preview.sources" :key="s.ref"><summary>[{{ s.ref.toUpperCase() }}] {{ s.date }} · {{ s.title }}</summary><pre>{{ s.content }}</pre></details>
      <details class="report-prompt-preview"><summary>{{ L('查看本次提示词', 'View prompts for this report') }} · {{ preview.template.name }}</summary><p>{{ L('模板提示词会用于两个步骤。汇总时的事实卡片由提炼结果产生；校验失败重试时会附加具体纠错信息。', 'The template is applied to both stages. Review receives extracted fact cards; retries append validation feedback.') }}</p><h3>{{ L('模板要求', 'Template prompt') }}</h3><pre>{{ preview.template.prompt }}</pre><details><summary>{{ L('完整提炼提示词', 'Full extraction instructions') }}</summary><pre>{{ preview.instructions.extract }}</pre></details><details><summary>{{ L('完整汇总提示词', 'Full review instructions') }}</summary><pre>{{ preview.instructions.review }}</pre></details></details>
      <p v-if="error" class="library-error" role="alert">{{ error }}</p>
      <p class="fine">{{ L('“保存素材汇编”只按日期汇集所选正文，不调用 AI，不执行模板提示词。', 'Saving a source compilation collects selected text by date, without AI or template instructions.') }}</p>
      <footer><button class="btn" @click="generate('local')" :disabled="busy">{{ L('保存素材汇编（不调用AI）', 'Save sources without AI') }}</button><button class="btn" v-if="preview.aiProblems.length" @click="preview=null;settings()">{{ L('配置模型', 'Configure model') }}</button><span class="spacer"></span><button class="btn primary" @click="generate('ai')" :disabled="busy || aiBlocked">{{ busy ? L('正在开始…', 'Starting…') : L('确认发送并生成', 'Send and generate') }}</button></footer>
    </section></div>
    <report-template-editor v-if="templateEditor" :item="templateEditor.item" :builtin="templateEditor.builtin" :is-new="templateEditor.isNew" :saving="templateSaving" :error="templateError" @close="templateEditor=null" @save="saveTemplate" @remove="saveTemplate(null, 'delete')" @reset="saveTemplate(null, 'reset')"></report-template-editor>
  </section>`,
};
