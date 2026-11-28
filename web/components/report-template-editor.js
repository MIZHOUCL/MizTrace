import { lang } from '../lib/i18n.js';
const { ref, computed, onMounted, onBeforeUnmount } = window.Vue;

export const ReportTemplateEditor = {
  props: { item: Object, builtin: Object, isNew: Boolean, saving: Boolean, error: String },
  emits: ['save', 'close', 'remove', 'reset'],
  setup(props, { emit }) {
    const L = (zh, en) => lang.value === 'en' ? en : zh;
    const form = ref({ ...props.item, layout: props.item.layout || 'narrative', sections: props.item.sections.join('\n') });
    const initial = JSON.stringify(form.value), nameInput = ref(null);
    const dirty = computed(() => JSON.stringify(form.value) !== initial);
    function close() {
      if (!dirty.value || window.confirm(L('放弃尚未保存的模板修改？', 'Discard unsaved template changes?'))) emit('close');
    }
    function save() { emit('save', { ...form.value, sections: form.value.sections.split('\n').map((s) => s.trim()).filter(Boolean) }); }
    function guard(e) { if (dirty.value || props.saving) { e.preventDefault(); if (e.type === 'beforeunload') e.returnValue = ''; } }
    function key(e) { if (e.key === 'Escape' && !props.saving) { e.stopPropagation(); close(); } }
    onMounted(() => { nameInput.value?.focus(); window.addEventListener('beforeunload', guard); window.addEventListener('miztrace-before-update', guard); });
    onBeforeUnmount(() => { window.removeEventListener('beforeunload', guard); window.removeEventListener('miztrace-before-update', guard); });
    return { L, form, nameInput, close, save, key, remove: () => emit('remove'), reset: () => emit('reset') };
  },
  template: `
  <div class="report-overlay" @click.self="!saving && close()" @keydown="key">
    <section class="report-preview-modal report-template-editor" role="dialog" aria-modal="true" aria-labelledby="report-template-title">
      <header><h2 id="report-template-title">{{ isNew ? L('新建报告模板', 'New report template') : L('编辑报告模板与提示词', 'Edit report template and prompt') }}</h2><button class="btn quiet" @click="close" :disabled="saving" :aria-label="L('关闭模板编辑', 'Close template editor')">×</button></header>
      <p class="fine">{{ L('提示词会用于 AI 提炼和汇总报告。你可以指定汇报对象、重点、语气和详略；章节标题决定报告的组织方式。内置模板也可以修改或恢复。', 'The prompt guides extraction and review. Set the audience, focus, tone and detail; section titles organize the report. Built-in templates can be edited or restored.') }}</p>
      <form @submit.prevent="save">
        <fieldset :disabled="saving">
          <label>{{ L('模板名称', 'Template name') }}<input ref="nameInput" v-model="form.name" maxlength="40" required :placeholder="L('例如：给主管的每周汇报', 'For example: Weekly update for my manager')"></label>
          <label>{{ L('模板说明', 'Description') }}<input v-model="form.description" maxlength="300" :placeholder="L('例如：突出交付和解决方案，简短直接', 'For example: Focus on deliveries and solutions')"></label>
          <label>{{ L('展示方式', 'Presentation') }}<select v-model="form.layout" :aria-label="L('展示方式', 'Presentation')"><option value="narrative">{{ L('按项目分段', 'Project paragraphs') }}</option><option value="5w2h">{{ L('5W2H 事项表', '5W2H item tables') }}</option></select><small v-if="form.layout === '5w2h'">{{ L('每项工作用字段表展示；缺失信息显示“未记录”。提示词和章节仍可编辑，至少两个章节，最后一章用于未来计划，其他章节用于本期总结。', 'Each work item uses a field table; missing values show Not recorded. Prompts and sections remain editable. Use at least two sections; the last holds future plans, the others summarize this period.') }}</small></label>
          <label>{{ L('章节标题（每行一个）', 'Section titles (one per line)') }}<textarea v-model="form.sections" rows="4" maxlength="809" required :placeholder="L('本期产出 / 问题与后续（每行一个）', 'Outcomes / Issues and next steps (one per line)')"></textarea></label>
          <label>{{ L('报告提示词', 'Report prompt') }}<textarea class="report-prompt-input" v-model="form.prompt" rows="9" maxlength="6000" required :placeholder="L('例如：面向主管，按项目总结本周产出。重点说明解决了什么问题、形成了什么方案，省略重复排查过程。仅在明确受阻时列出问题，不因缺少完成反馈写成推进中。每项控制在两句话。', 'For example: Write for my manager, grouped by project. Focus on solutions and outcomes. List issues only when explicitly unresolved. Use two sentences per item.')"></textarea></label>
          <p class="fine">{{ form.prompt.length }}/6000 · {{ L('模板不会允许编造事实或数字。生成前可查看完整提示词和所选素材。', 'Templates cannot invent facts or metrics. Preview full instructions and sources before generating.') }}</p>
        </fieldset>
        <p v-if="error" class="library-error" role="alert">{{ error }}</p>
        <footer><button type="button" class="btn" v-if="builtin && !isNew" @click="reset" :disabled="saving">{{ L('恢复内置模板', 'Restore built-in template') }}</button><button type="button" class="btn danger" v-if="!builtin && !isNew" @click="remove" :disabled="saving">{{ L('删除模板', 'Delete template') }}</button><span class="spacer"></span><button type="button" class="btn" @click="close" :disabled="saving">{{ L('取消', 'Cancel') }}</button><button class="btn primary" type="submit" :disabled="saving">{{ saving ? L('保存中…', 'Saving…') : L('保存模板', 'Save template') }}</button></footer>
      </form>
    </section>
  </div>`,
};
