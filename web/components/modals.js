/** 发送前确认与设置两个弹层。 */
import { num } from '../lib/format.js';
import { FolderPicker } from './folderpicker.js';
import { t, lang } from '../lib/i18n.js';

/** 设置页文案多、改得少：就地双语，L('中文', 'English')。 */
const L = (zh, en) => (lang.value === 'en' ? en : zh);

const { ref, reactive, computed, watch, onMounted, onBeforeUnmount } = window.Vue;

function useEscape(cb) {
  const onKey = (e) => {
    if (e.key === 'Escape') cb();
  };
  onMounted(() => document.addEventListener('keydown', onKey));
  onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
}

export const PreviewModal = {
  name: 'PreviewModal',
  props: { preview: Object, writing: Boolean },
  emits: ['close', 'confirm', 'settings', 'template'],
  setup(props, { emit }) {
    const showPayload = ref(false);
    const template = ref(props.preview.template?.id ?? '');
    watch(
      () => props.preview.template?.id,
      (id) => {
        template.value = id ?? '';
      },
    );
    useEscape(() => emit('close'));
    const blocked = computed(() => Boolean(props.preview.secretHits?.length || props.preview.managedDevice || !props.preview.aiConfigured));
    const overLimit = computed(() => Boolean(props.preview.dailyLimit && props.preview.usage?.calls >= props.preview.dailyLimit));
    const empty = computed(() => !props.preview.modules?.length);
    /** 按钮灰着的时候，旁边一句话说清为什么 —— 之前只有灰，用户以为坏了。 */
    const visionMissing = computed(() => Boolean(props.preview.hintImages?.length) && !props.preview.vision);
    const why = computed(() => {
      if (props.preview.secretHits?.length) return t('whySecret');
      if (props.preview.managedDevice) return t('whyManaged');
      if (!props.preview.aiConfigured) return t('whyNoAi');
      if (overLimit.value) return t('whyLimit');
      if (empty.value) return t('whyEmpty');
      if (visionMissing.value) return t('whyVision');
      if (props.writing) return t('whyWriting');
      return '';
    });
    return { showPayload, template, blocked, overLimit, empty, visionMissing, why, num, t, L, confirm: () => emit('confirm', template.value), pick: () => emit('template', template.value) };
  },
  template: `
<div class="overlay" @click.self="$emit('close')" role="dialog" aria-modal="true" aria-labelledby="pv-title">
  <div class="modal">
    <h2 id="pv-title">{{ t('confirmTitle') }}</h2>
    <p>{{ t('willSend') }} <strong>{{ preview.modules.length }}</strong> {{ t('modulesTo') }} <strong>{{ preview.model || t('yourModel') }}</strong>, {{ t('about') }} {{ num(preview.estTokens) }} tokens.</p>
    <p class="fine">{{ t('includes') }}: {{ preview.disclosure.includes.join(L('、', ', ')) }}.<br>{{ t('excludes') }}: {{ preview.disclosure.excludes.join(L('、', ', ')) }}.</p>
    <div class="picker" v-if="preview.templates && preview.templates.length">
      <label for="pv-tpl">{{ t('diaryTemplate') }}</label>
      <select id="pv-tpl" v-model="template" @change="pick"><option v-for="t in preview.templates" :key="t.id" :value="t.id">{{ t.name }}</option></select>
      <small>{{ t('tplNote') }}</small>
    </div>
    <p class="fine" v-if="preview.usage">{{ t('calledToday') }} {{ preview.usage.calls }}<template v-if="preview.dailyLimit">, {{ t('limit') }} {{ preview.dailyLimit }}</template>. <template v-if="preview.hintCount">{{ preview.hintCount }} {{ t('hintCount') }} </template><template v-if="preview.hasStyle">{{ t('hasStyle') }} </template><template v-if="preview.imageCount">{{ t('imgCount') }} {{ preview.imageCount }} {{ t('imgs') }}, {{ preview.vision ? t('imgSend') : t('imgNameOnly') }}.</template></p>
    <p class="fine" v-if="preview.hintImages && preview.hintImages.length && preview.vision">{{ t('hintImgs') }} {{ preview.hintImages.join(L('、', ', ')) }}</p>

    <div class="notice bad" v-if="preview.secretHits.length">
      {{ t('secretsFound') }}<strong>{{ t('blocked') }}</strong>: {{ preview.secretHits.map(h => h.kind + ' (' + h.module + ')').join(', ') }}. {{ t('secretsHow') }}
    </div>
    <div class="notice bad" v-else-if="preview.managedDevice">{{ t('managed') }}</div>
    <div class="notice bad" v-else-if="!preview.aiConfigured">{{ t('aiMissing') }}{{ preview.aiProblems.join(L('、', ', ')) }}. <button class="btn small" @click="$emit('settings')">{{ t('goSettings') }}</button></div>
    <div class="notice bad" v-else-if="overLimit">{{ t('overLimit', {n: preview.usage.calls}) }}</div>
    <div class="notice bad" v-else-if="visionMissing">{{ t('hintImgVisionOff') }} ({{ preview.hintImages.join(L('、', ', ')) }}) <button class="btn small" @click="$emit('settings')">{{ t('goSettings') }}</button></div>

    <div class="notice bad" v-if="!preview.modules.length">{{ t('nothingSelected') }}</div>
    <ul class="plain">
      <li v-for="m in preview.modules" :key="m.key">{{ m.title }}<small class="tag" v-if="m.toolNames && m.toolNames.length">{{ m.toolNames.join(L('、', ', ')) }}</small></li>
    </ul>
    <button class="btn small quiet" @click="showPayload = !showPayload">{{ showPayload ? t('hidePayload') : t('showPayload') }}</button>
    <pre class="payload" v-if="showPayload">{{ preview.system }}

{{ preview.user }}</pre>
    <div class="foot">
      <small class="why" v-if="why">{{ why }}</small>
      <button class="btn" @click="$emit('close')">{{ t('cancel') }}</button>
      <button class="btn primary" @click="confirm" :disabled="blocked || overLimit || empty || visionMissing || writing" :title="why">{{ writing ? t('generating') : t('confirmSend') }}</button>
    </div>
  </div>
</div>`,
};

export const SettingsModal = {
  name: 'SettingsModal',
  components: { FolderPicker },
  props: { config: Object, sources: Object, home: String, platform: String, configPath: String, testing: Boolean, testResult: Object, saving: Boolean },
  emits: ['close', 'save', 'test', 'install-shell'],
  setup(props, { emit }) {
    useEscape(() => emit('close'));
    const c = props.config || {};
    const shell = computed(() => props.sources?.shell ?? null);
    const showSnippet = ref('');
    const picking = ref(''); // 'roots' | 'out' | ''
    function pickedDir(p) {
      const which = picking.value;
      picking.value = '';
      if (!p) return;
      if (which === 'out') f.out = p;
      else {
        const lines = f.roots.split('\n').map((x) => x.trim()).filter(Boolean);
        if (!lines.includes(p)) lines.push(p);
        f.roots = lines.join('\n');
      }
    }
    const templates = ref((props.sources?.templates ?? []).map((t) => ({ ...t })));
    const builtin = props.sources?.builtinTemplates ?? [];
    const editingTpl = ref(false); // 模板文字默认收起：四个模板全铺开太长，下拉选、要改再展开
    const currentTpl = computed(() => templates.value.find((t) => t.id === f.ai.template) ?? templates.value[0] ?? null);
    function resetTemplate(t) {
      const b = builtin.find((x) => x.id === t.id);
      if (b) {
        t.name = b.name;
        t.text = b.text;
      }
    }
    function addTemplate() {
      let n = 1;
      while (templates.value.some((t) => t.id === `custom-${n}`)) n += 1;
      templates.value.push({ id: `custom-${n}`, name: `我的模板 ${n}`, text: '', builtin: false });
      f.ai.template = `custom-${n}`;
      editingTpl.value = true;
    }
    function removeTemplate(t) {
      templates.value = templates.value.filter((x) => x !== t);
      if (f.ai.template === t.id) f.ai.template = templates.value[0]?.id ?? 'summary';
    }
    async function copySnippet(text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        /* 浏览器不给剪贴板就让用户手动选 */
      }
    }
    const f = reactive({
      roots: (c.roots || []).join('\n'),
      out: c.out || '',
      cutoffHour: c.cutoffHour ?? 4,
      gapMinutes: c.gapMinutes ?? 90,
      excludeProjects: (c.excludeProjects || []).join('\n'),
      authorFilter: c.authorFilter || '',
      files: c.fileScan?.enabled !== false,
      outline: c.fileScan?.outline !== false,
      replies: c.sessions?.replies !== false,
      browserOn: c.browser?.enabled === true,
      browserOnly: Object.fromEntries((props.sources?.browsers ?? []).map((b) => [b.id, !c.browser?.only?.length || c.browser.only.includes(b.id)])),
      excludeDomains: (c.browser?.excludeDomains || []).join('\n'),
      shellOn: c.shell?.enabled === true,
      ai: { ...(c.ai || {}), apiKey: '', template: c.ai?.template || 'summary' },
    });
    const readableBrowsers = computed(() => (props.sources?.browsers ?? []).filter((b) => b.profiles.some((p) => p.readable)));
    const deniedBrowsers = computed(() => (props.sources?.browsers ?? []).filter((b) => !b.profiles.some((p) => p.readable)));
    const providers = computed(() => props.sources?.providers ?? []);
    watch(
      () => f.browserOn,
      (on) => {
        if (on && !Object.values(f.browserOnly).some(Boolean)) for (const b of readableBrowsers.value) f.browserOnly[b.id] = true;
      },
    );

    function aiPayload() {
      const a = { ...f.ai };
      if (!a.apiKey) delete a.apiKey;
      a.maxTokens = Number(a.maxTokens) || 2000;
      a.dailyLimit = Number(a.dailyLimit) || 0;
      delete a.hasApiKey;
      delete a.configured;
      delete a.problems;
      a.templates = templates.value.filter((t) => t.text && t.text.trim()).map((t) => ({ id: t.id, name: t.name, text: t.text }));
      return a;
    }
    function payload() {
      const only = Object.entries(f.browserOnly).filter(([, v]) => v).map(([k]) => k);
      return {
        roots: f.roots,
        out: f.out,
        cutoffHour: Number(f.cutoffHour),
        gapMinutes: Number(f.gapMinutes),
        excludeProjects: f.excludeProjects,
        authorFilter: f.authorFilter,
        fileScan: { enabled: f.files, outline: f.outline },
        sessions: { replies: f.replies },
        browser: { enabled: f.browserOn && only.length > 0, only, excludeDomains: f.excludeDomains },
        shell: { enabled: f.shellOn },
        ai: aiPayload(),
        setupDone: true,
      };
    }
    const keyPlaceholder = computed(() => (c.ai?.hasApiKey ? L(`已保存（${c.ai.apiKey}），留空不改`, `Saved (${c.ai.apiKey}); leave empty to keep`) : 'sk-…'));
    return { f, shell, showSnippet, picking, pickedDir, templates, editingTpl, currentTpl, resetTemplate, addTemplate, removeTemplate, copySnippet, readableBrowsers, deniedBrowsers, providers, keyPlaceholder, t, L, save: () => emit('save', payload()), test: () => emit('test', aiPayload()), installShell: () => emit('install-shell', []) };
  },
  template: `
<div class="overlay" @click.self="$emit('close')" role="dialog" aria-modal="true" aria-labelledby="st-title">
  <div class="modal wide">
    <h2 id="st-title">{{ t('settings') }}</h2>

    <h3>{{ L('去哪里找痕迹', 'Where to look for traces') }}</h3>
    <div class="form">
      <label for="f-roots">{{ L('扫描目录', 'Scan folders') }}</label>
      <div><textarea id="f-roots" v-model="f.roots" rows="3" :placeholder="platform === 'win32' ? '一行一个，例如 D:\\\\code' : '一行一个，例如 ~/code'"></textarea><div class="pickrow"><button class="btn small" @click="picking = 'roots'">{{ L('浏览目录…', 'Browse…') }}</button><small>{{ L('改动过的文件、git 仓库都从这些目录找。一行一个，也可以点进去选。', 'Changed files and git repos are found under these folders. One per line, or pick with the browser.') }}</small></div></div>
      <label>{{ L('来源', 'Sources') }}</label>
      <div class="toggles">
        <label class="toggle"><input type="checkbox" v-model="f.files"> <span>{{ L('文件改动', 'File changes') }}<small>{{ L('只记路径、时间、大小。', 'Only path, time and size.') }}</small></span></label>
        <label class="toggle"><input type="checkbox" v-model="f.outline" :disabled="!f.files"> <span>{{ L('文档大纲', 'Document outlines') }}<small>{{ L('Word 标题、Excel 工作表名、PPT 页标题、Markdown 标题；不读正文。', 'Word headings, Excel sheet names, PPT slide titles, Markdown headings; never the body.') }}</small></span></label>
        <label class="toggle"><input type="checkbox" v-model="f.replies"> <span>{{ L('AI 工具的最终回复', 'Final replies of AI tools') }}<small>{{ providers.filter(p => p.found).map(p => p.generic ? p.name + L('（通用格式）', ' (generic)') : p.name).join(L('、', ', ')) || L('这台电脑上没找到 AI 编码工具的会话', 'No AI coding tool sessions found on this computer') }}. {{ L('每轮最后一段的前 300 字。', 'First 300 chars of the last reply of each turn.') }}</small></span></label>
        <label class="toggle"><input type="checkbox" v-model="f.browserOn" :disabled="!readableBrowsers.length"> <span>{{ L('浏览记录', 'Browser history') }}<small v-if="readableBrowsers.length">{{ L('页面标题、去掉参数的地址、搜索词。', 'Page titles, URLs without parameters, search terms.') }}</small><small v-else>{{ L('没有检测到能读的浏览器。', 'No readable browser detected.') }}</small></span></label>
        <div class="indent" v-if="f.browserOn">
          <label class="toggle inline" v-for="b in readableBrowsers" :key="b.id"><input type="checkbox" v-model="f.browserOnly[b.id]"> <span>{{ b.name }}</span></label>
          <p class="hint" v-for="b in deniedBrowsers" :key="b.id">{{ b.name }}：{{ b.profiles[0].error }}</p>
          <textarea v-model="f.excludeDomains" rows="2" :placeholder="L('不记这些域名，一行一个，例如 bilibili.com', 'Skip these domains, one per line, e.g. youtube.com')"></textarea>
        </div>
        <label class="toggle"><input type="checkbox" v-model="f.shellOn"> <span>{{ L('终端命令', 'Shell commands') }}<small>{{ L('你在终端敲的命令和所在目录。不记输出；带凭据的命令不记。要在 shell 配置文件里装一段钩子，装完开新终端才生效。', 'Commands you type and their folder. No output; commands with credentials are skipped. Needs a hook in your shell profile; open a new terminal after installing.') }}</small></span></label>
        <div class="indent" v-if="f.shellOn && shell">
          <p class="shellrow">日志：<code>{{ shell.file }}</code><span v-if="shell.exists">已有 {{ shell.lines }} 条</span><span v-else>还没有记录</span></p>
          <p class="shellrow" v-for="h in shell.shells" :key="h.id">
            <span>{{ h.installed ? '●' : '○' }} {{ h.name }}：{{ h.installed ? '钩子已装' : (h.profileExists ? '未装' : '未装，配置文件也还没有') }}</span>
            <code>{{ h.profile }}</code>
            <button class="btn small quiet" @click="showSnippet = showSnippet === h.id ? '' : h.id">{{ showSnippet === h.id ? '收起' : '看片段' }}</button>
          </p>
          <template v-for="h in shell.shells" :key="'s' + h.id">
            <div v-if="showSnippet === h.id"><pre class="snippet">{{ h.snippet }}</pre><button class="btn small" @click="copySnippet(h.snippet)">复制片段</button></div>
          </template>
          <p class="shellrow" v-if="shell.shells.some(h => !h.installed)"><button class="btn small primary" @click="installShell" :disabled="saving">一键装上钩子</button><small>只往配置文件末尾追加，不改你原来的内容。</small></p>
        </div>
      </div>
    </div>

    <h3>{{ L('日记', 'Diary') }}</h3>
    <div class="form">
      <label for="f-out">{{ L('日记目录', 'Diary folder') }}</label>
      <div><div class="inline-fields"><input id="f-out" v-model="f.out" :placeholder="platform === 'win32' ? '例如 D:\\\\journal，或 Obsidian 库' : '例如 ~/journal，或 Obsidian 库'"><button class="btn small" @click="picking = 'out'">{{ L('浏览…', 'Browse…') }}</button></div><small>{{ L('「保存到日记目录」写到这里，文件名是日期。', '"Save to diary folder" writes here; file name is the date.') }}</small></div>
      <label for="f-cutoff">{{ L('日界', 'Day boundary') }}</label>
      <div class="inline-fields"><input id="f-cutoff" type="number" min="0" max="23" v-model.number="f.cutoffHour" class="short"><small>{{ L('凌晨 ' + f.cutoffHour + ' 点之前的活动算前一天。', 'Activity before ' + f.cutoffHour + ':00 counts as the previous day.') }}</small></div>
      <label for="f-gap">{{ L('切块间隔', 'Split gap') }}</label>
      <div class="inline-fields"><input id="f-gap" type="number" min="5" v-model.number="f.gapMinutes" class="short"><small>{{ L('同一项目里停顿超过这么多分钟，算两段工作。', 'A pause longer than this (minutes) in one project splits the work in two.') }}</small></div>
      <label for="f-author">{{ L('只统计我的提交', 'Only my commits') }}</label>
      <div><input id="f-author" v-model="f.authorFilter" :placeholder="L('git 作者名或邮箱片段，留空 = 全部', 'git author name or email fragment; empty = all')"></div>
      <label for="f-excl">{{ L('永久排除项目', 'Excluded projects') }}</label>
      <div><textarea id="f-excl" v-model="f.excludeProjects" rows="2" :placeholder="L('一行一个项目名或路径片段', 'One project name or path fragment per line')"></textarea></div>
    </div>

    <h3>{{ L('模型服务', 'Model service') }}</h3>
    <div class="form">
      <label for="f-proto">{{ L('协议', 'Protocol') }}</label>
      <div><select id="f-proto" v-model="f.ai.protocol"><option value="auto">{{ L('自动（按 URL 判断）', 'Auto (by URL)') }}</option><option value="openai">{{ L('OpenAI 兼容', 'OpenAI-compatible') }}</option><option value="anthropic">Anthropic</option></select></div>
      <label for="f-url">Base URL</label>
      <div><input id="f-url" v-model="f.ai.baseUrl" placeholder="https://api.deepseek.com/v1 或 https://api.anthropic.com"><small>{{ L('DeepSeek、智谱、Moonshot、通义、OpenRouter、Ollama（http://localhost:11434/v1）都是 OpenAI 兼容，填到 /v1 为止。', 'DeepSeek, OpenRouter, Ollama (http://localhost:11434/v1) and most others are OpenAI-compatible; end the URL at /v1.') }}</small></div>
      <label for="f-key">API Key</label>
      <div><input id="f-key" type="password" v-model="f.ai.apiKey" :placeholder="keyPlaceholder" autocomplete="off"></div>
      <label for="f-model">{{ L('模型名', 'Model') }}</label>
      <div><input id="f-model" v-model="f.ai.model" placeholder="deepseek-chat / glm-4-flash / claude-sonnet-5 …"><small>{{ L('用服务商的稳定名字；名字里带 expires / preview 的限时模型下线后常常只回空内容。', 'Use the stable model name from your provider; time-limited names with expires / preview often return empty content once retired.') }}</small></div>
      <label for="f-max">{{ L('最大输出', 'Max output') }}</label>
      <div class="inline-fields"><input id="f-max" type="number" v-model.number="f.ai.maxTokens" class="short"><small>{{ L('tokens。推理模型会先把它花在思考上，报「截断」就调大。', 'tokens. Reasoning models spend it on thinking first; raise it if you see a truncation error.') }}</small></div>
      <label for="f-limit">{{ L('每日上限', 'Daily limit') }}</label>
      <div class="inline-fields"><input id="f-limit" type="number" v-model.number="f.ai.dailyLimit" class="short"><small>{{ L('次，防手滑；0 = 不限。', 'calls; 0 = unlimited.') }}</small></div>
      <label>{{ L('能看图', 'Vision') }}</label>
      <div><label class="toggle"><input type="checkbox" v-model="f.ai.vision"> <span>{{ L('模型支持图片', 'Model supports images') }}<small>{{ L('开了以后，你在手记和补充说明里传的图片会作为原图一起发给模型（GPT-4o、Claude、Gemini、通义 VL、GLM-4V 这类多模态模型才行；纯文本模型开了会报错）。', 'When on, images from your notes and bubble notes are sent as originals (needs a multimodal model such as GPT-4o, Claude, Gemini; text-only models will error).') }}</small></span></label></div>
      <label for="f-style">{{ L('写作要求', 'Writing instructions') }}</label>
      <div><textarea id="f-style" v-model="f.ai.style" rows="2" :placeholder="L('模板之外的附加要求（可选），例如：口语一点、多写卡点和解决办法', 'Extra instructions beyond the template (optional), e.g. casual tone, focus on blockers and fixes')"></textarea></div>
      <label for="f-tpl">{{ t('diaryTemplate') }}</label>
      <div>
        <div class="inline-fields">
          <select id="f-tpl" v-model="f.ai.template" class="tpl-select"><option v-for="t in templates" :key="t.id" :value="t.id">{{ t.name }}{{ t.builtin ? '' : L('（自定义）', ' (custom)') }}</option></select>
          <button class="btn small" @click="editingTpl = !editingTpl">{{ editingTpl ? L('收起', 'Hide') : L('改这个模板的文字', 'Edit this template') }}</button>
          <button class="btn small" @click="addTemplate">{{ L('加一个模板', 'Add template') }}</button>
        </div>
        <p class="tpl-preview" v-if="currentTpl && !editingTpl">{{ currentTpl.text || L('（还没写模板文字）', '(no template text yet)') }}</p>
        <div class="tpl on" v-if="currentTpl && editingTpl">
          <div class="head">
            <input type="text" v-model="currentTpl.name" aria-label="模板名">
            <small class="tag" v-if="currentTpl.builtin">{{ L('内置', 'built-in') }}</small>
            <span class="spacer"></span>
            <button class="btn small quiet" v-if="currentTpl.builtin" @click="resetTemplate(currentTpl)">{{ L('恢复默认文字', 'Restore default') }}</button>
            <button class="btn small quiet danger" v-else @click="removeTemplate(currentTpl)">{{ L('删除', 'Delete') }}</button>
          </div>
          <textarea v-model="currentTpl.text" rows="4" placeholder="告诉模型这篇日记长什么样：分几段、按什么顺序、多长、什么口吻。铁律（只写证据里有的、每段带引用）不受模板影响。"></textarea>
        </div>
        <small>{{ L('下拉里选的是默认模板；生成前的确认弹窗里也能临时换。', 'The selected one is the default; you can switch in the confirm dialog too.') }}</small>
      </div>
      <label></label>
      <div class="inline-fields">
        <button class="btn" @click="test" :disabled="testing">{{ testing ? L('测试中…', 'Testing…') : L('测试连接', 'Test connection') }}</button>
        <span v-if="testResult" class="result" :class="testResult.ok ? 'ok' : 'bad'">{{ testResult.ok ? (L('连通：', 'OK: ') + testResult.model + ', ' + testResult.latencyMs + ' ms') : (L('失败：', 'Failed: ') + testResult.error) }}</span>
      </div>
    </div>
    <p class="fine">{{ L('填齐 URL、key、模型名就能用，没有别的开关。key 只保存在本机', 'Fill in URL, key and model and it works; no other switch. The key is stored only on this machine at') }} <code>{{ configPath }}</code>{{ L('（POSIX 下权限 600），页面只显示后 4 位，发送预览里不会出现 key。', ' (mode 600 on POSIX); only the last 4 chars are shown and it never appears in the preview.') }}</p>

    <div class="foot">
      <button class="btn" @click="$emit('close')">{{ t('cancel') }}</button>
      <button class="btn primary" @click="save" :disabled="saving">{{ saving ? t('saving') : t('save') }}</button>
    </div>
  </div>
  <folder-picker v-if="picking" :title="picking === 'out' ? L('选日记目录', 'Pick the diary folder') : L('选一个要扫描的目录', 'Pick a folder to scan')" :start="picking === 'out' && f.out ? f.out : home" @close="picking = ''" @pick="pickedDir"></folder-picker>
</div>`,
};
