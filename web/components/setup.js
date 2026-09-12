/** 首次引导：告诉 MizTrace 去哪里找痕迹、读哪些来源。只在还没配过扫描目录时出现。 */
import { FolderPicker } from './folderpicker.js';
import { t, lang } from '../lib/i18n.js';

const { ref, reactive, computed, onMounted } = window.Vue;
const L = (zh, en) => (lang.value === 'en' ? en : zh);

export const SetupPanel = {
  name: 'SetupPanel',
  components: { FolderPicker },
  props: { sources: Object, home: String, platform: String },
  emits: ['done', 'skip', 'lang'],
  setup(props, { emit }) {
    const picked = reactive({});
    const extra = ref('');
    const outline = ref(props.sources?.fileScan?.outline !== false);
    const replies = ref(props.sources?.sessions?.replies !== false);
    const browsers = reactive({});
    const shellOn = ref(false);
    const picking = ref(false);
    function pickedDir(p) {
      picking.value = false;
      if (!p) return;
      if (Object.prototype.hasOwnProperty.call(picked, p)) {
        picked[p] = true; // 候选里本来就有：直接勾上
        return;
      }
      const lines = extra.value.split('\n').map((x) => x.trim()).filter(Boolean);
      if (!lines.includes(p)) lines.push(p);
      extra.value = lines.join('\n');
    }
    const saving = ref(false);
    const err = ref('');

    onMounted(() => {
      const cands = props.sources?.candidates ?? [];
      // 默认勾上：有会话在里面工作的、以及当前配置里的；「常见目录」只勾前两个，免得一口气扫半个家目录
      let common = 0;
      for (const c of cands) {
        if (c.sessions || c.reason === '当前配置') picked[c.path] = true;
        else if (common < 2) {
          picked[c.path] = true;
          common += 1;
        } else picked[c.path] = false;
      }
      for (const b of props.sources?.browsers ?? []) browsers[b.id] = b.profiles.some((p) => p.readable);
    });

    const roots = computed(() => [...Object.entries(picked).filter(([k, v]) => v && !coveredBy(k)).map(([k]) => k), ...extra.value.split('\n').map((s) => s.trim()).filter(Boolean)]);
    const readableBrowsers = computed(() => (props.sources?.browsers ?? []).filter((b) => b.profiles.some((p) => p.readable)));
    const deniedBrowsers = computed(() => (props.sources?.browsers ?? []).filter((b) => !b.profiles.some((p) => p.readable)));
    const foundProviders = computed(() => (props.sources?.providers ?? []).filter((p) => p.found).map((p) => (p.generic ? `${p.name}${L('（通用格式）', ' (generic)')}` : p.name)));
    const supportedCount = computed(() => (props.sources?.providers ?? []).length);
    const anyBrowser = computed(() => Object.values(browsers).some(Boolean));

    function short(p) {
      const home = props.home || '';
      return home && p.startsWith(home) ? `~${p.slice(home.length)}` : p;
    }
    const sep = computed(() => (props.platform === 'win32' ? '\\' : '/'));
    /** 已经被另一个勾选的父目录包含：不必再勾，勾了也只会重复扫。 */
    function coveredBy(p) {
      return Object.entries(picked).find(([q, v]) => v && q !== p && p.startsWith(q + sep.value))?.[0] ?? null;
    }
    async function done() {
      if (!roots.value.length) {
        err.value = L('至少选一个目录，不然 MizTrace 不知道去哪里找文件。', 'Pick at least one folder, otherwise MizTrace has nowhere to look.');
        return;
      }
      saving.value = true;
      err.value = '';
      const only = Object.entries(browsers).filter(([, v]) => v).map(([k]) => k);
      try {
        emit('done', {
          roots: roots.value,
          fileScan: { enabled: true, outline: outline.value },
          sessions: { replies: replies.value },
          browser: { enabled: only.length > 0, only },
          shell: { enabled: shellOn.value, install: shellOn.value },
          setupDone: true,
        });
      } finally {
        saving.value = false;
      }
    }

    const shellNames = computed(() => (props.sources?.shell?.shells ?? []).map((h) => h.name).join(' / '));
    return { picked, extra, outline, replies, browsers, shellOn, shellNames, picking, pickedDir, saving, err, roots, readableBrowsers, deniedBrowsers, foundProviders, supportedCount, anyBrowser, short, coveredBy, done, t, L, lang };
  },
  template: `
<section class="setup" aria-label="setup">
  <div class="setup-lang"><button class="btn small" :class="{primary: lang !== 'en'}" @click="$emit('lang', 'zh')">中文</button><button class="btn small" :class="{primary: lang === 'en'}" @click="$emit('lang', 'en')">English</button></div>
  <h1>{{ L('先告诉 MizTrace 去哪里找你今天的痕迹。', 'First, tell MizTrace where to look for today’s traces.') }}</h1>
  <p class="lead">{{ L('它只读你在这里选中的位置，不扫全盘；读到的东西都留在这台电脑上，只有你点「生成日记」并确认之后，选中模块的证据才会发给你配的模型。', 'It only reads the places you pick here, never the whole disk. Everything stays on this computer; only when you click "Write with AI" and confirm is the selected evidence sent to the model you configured.') }}</p>

  <div class="setup-grid">
    <section class="block">
      <h3>{{ L('扫描哪些目录', 'Folders to scan') }}</h3>
      <p class="hint">{{ L('改动过的文件、git 提交都从这里找。推荐的是最近 AI 会话工作过的父目录。', 'Changed files and git commits are found here. Suggested: parent folders of recent AI sessions.') }}</p>
      <ul class="cands">
        <li v-for="c in sources.candidates" :key="c.path" :class="{covered: coveredBy(c.path)}">
          <label><input type="checkbox" v-model="picked[c.path]" :disabled="!!coveredBy(c.path)"> <span class="p">{{ short(c.path) }}</span><small>{{ coveredBy(c.path) ? L('已包含在 ', 'already inside ') + short(coveredBy(c.path)) + L(' 里', '') : c.reason }}</small></label>
        </li>
      </ul>
      <div class="pickrow"><button class="btn small" @click="picking = true">{{ L('浏览目录…', 'Browse…') }}</button><small>{{ L('一层层点进去选；也可以在下面直接输路径。', 'Click through folders, or type paths below.') }}</small></div>
      <textarea v-model="extra" rows="2" :placeholder="platform === 'win32' ? L('其他目录，一行一个，例如 D:\\\\code', 'Other folders, one per line, e.g. D:\\\\code') : L('其他目录，一行一个，例如 ~/code', 'Other folders, one per line, e.g. ~/code')"></textarea>
    </section>
    <folder-picker v-if="picking" :title="L('选一个要扫描的目录', 'Pick a folder to scan')" :start="home" @close="picking = false" @pick="pickedDir"></folder-picker>

    <section class="block">
      <h3>{{ L('读哪些来源', 'Sources to read') }}</h3>
      <p class="hint" v-if="foundProviders.length">{{ L('找到了 ', 'Found sessions from ') }}{{ foundProviders.join(L('、', ', ')) }}{{ L(' 的会话记录。', '.') }}</p>
      <p class="hint" v-else>{{ L('这台电脑上没有找到 AI 编码工具的会话记录（支持 ' + supportedCount + ' 种），日记先靠文件、浏览器与终端。', 'No AI coding tool sessions found on this computer (' + supportedCount + ' tools supported); the diary will rely on files, browser and shell.') }}</p>
      <label class="toggle"><input type="checkbox" v-model="replies"> <span>{{ L('AI 工具每一轮的最终回复', 'Final reply of each AI turn') }}<small>{{ L('知道它实际做了什么，而不只是你问了什么。只记每轮最后一段的前 300 字。', 'Know what it actually did, not only what you asked. First 300 chars of the last reply per turn.') }}</small></span></label>
      <label class="toggle"><input type="checkbox" v-model="outline"> <span>{{ L('文档大纲', 'Document outlines') }}<small>{{ L('Word 的标题层级、Excel 的工作表名、PPT 每页标题、Markdown 标题。只读结构，不读正文。', 'Word headings, Excel sheet names, PPT slide titles, Markdown headings. Structure only, never the body.') }}</small></span></label>
      <template v-if="readableBrowsers.length">
        <label class="toggle" v-for="b in readableBrowsers" :key="b.id"><input type="checkbox" v-model="browsers[b.id]"> <span>{{ b.name }} {{ L('的浏览记录', 'history') }}<small>{{ L('页面标题、去掉参数的地址、搜索词。登录页与你排除的域名不记。', 'Page titles, URLs without parameters, search terms. Login pages and excluded domains are skipped.') }}</small></span></label>
      </template>
      <p class="hint" v-for="b in deniedBrowsers" :key="b.id">{{ b.name }}：{{ b.profiles[0].error }}</p>
      <p class="hint" v-if="!sources.browsers || !sources.browsers.length">{{ L('没有检测到浏览器的历史记录文件。', 'No browser history files detected.') }}</p>
      <label class="toggle"><input type="checkbox" v-model="shellOn"> <span>{{ L('终端命令', 'Shell commands') }}<small>{{ L('你在终端敲的命令和所在目录，不记输出，带凭据的不记。需要往 ' + (shellNames || 'shell') + ' 的配置文件末尾加几行钩子，勾上就替你加；开新终端后生效。', 'Commands you type and their folder; no output, no credentials. Adds a small hook to the end of your ' + (shellNames || 'shell') + ' profile; takes effect in a new terminal.') }}</small></span></label>
    </section>
  </div>

  <p class="err" v-if="err">{{ err }}</p>
  <div class="foot">
    <button class="btn primary" @click="done" :disabled="saving">{{ L('开始采集', 'Start collecting') }}</button>
    <button class="btn quiet" @click="$emit('skip')" :disabled="saving">{{ L('先跳过，用当前目录', 'Skip, use current folder') }}</button>
    <small>{{ L('随时可以在右上角「设置」里改。', 'You can change all of this later in Settings.') }}</small>
  </div>
</section>`,
};
