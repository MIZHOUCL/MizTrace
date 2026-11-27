/**
 * 右侧抽屉：一个模块背后的每一条证据，按时间排，回复挂在它答的那条提问下面。
 * 「补充说明」= 用户对这段的亲手说明（可配图），和手记一样是最高优先级 —— 之前叫「写法要求」，
 * 用户说它实际上是对事件的补充（「在这个网站看了某个技能的教学视频」），不是给模型的排版指令。
 */
import { hhmm, timeRange, statsWords, durationWords, stayWords, catVar, CAT_WORD, KIND_LABEL, OUTLINE_LABEL, projectWords } from '../lib/format.js';
import { t, lang } from '../lib/i18n.js';
import { TOKEN } from '../lib/api.js';

const { computed, ref, watch } = window.Vue;

export const Drawer = {
  name: 'Drawer',
  props: { module: Object, date: String, saving: Boolean, vision: Boolean },
  emits: ['close', 'pop', 'exclude', 'hint', 'upload', 'remove-image', 'delete-note'],
  setup(props, { emit }) {
    const hint = ref(props.module?.hint ?? '');
    watch(
      () => props.module,
      (m) => {
        hint.value = m?.hint ?? '';
      },
    );
    const dirty = computed(() => hint.value.trim() !== (props.module?.hint || ''));

    const timeline = computed(() => {
      const items = props.module?.items ?? [];
      const replies = new Map();
      for (const it of items) if (it.kind === 'reply' && it.promptSourceId) replies.set(it.promptSourceId, it);
      const used = new Set();
      const out = [];
      const rest = items.filter((i) => !(i.kind === 'reply' && i.promptSourceId && replies.get(i.promptSourceId) === i)).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      for (const it of rest) {
        out.push({ ...it, sub: false });
        const r = replies.get(it.sourceId);
        if (r && !used.has(r)) {
          used.add(r);
          out.push({ ...r, sub: true });
        }
      }
      for (const r of replies.values()) if (!used.has(r)) out.push({ ...r, sub: false });
      return out;
    });

    const en = computed(() => lang.value === 'en');
    const sep = computed(() => (en.value ? ', ' : '，'));
    const meta = computed(() => {
      const m = props.module;
      if (!m) return '';
      const bits = [projectWords(m.projectName)];
      if (m.toolNames?.length) bits.push(`${t('with')} ${m.toolNames.join(en.value ? ', ' : '、')}`);
      bits.push(timeRange(m));
      if (m.durationMin) bits.push(`${t('lasting')} ${durationWords(m.durationMin)}`);
      bits.push(CAT_WORD[m.category] ?? m.category);
      const s = statsWords(m.stats);
      return `${bits.join(sep.value)}${en.value ? '. ' : '。'}${s ? `${s}${sep.value}` : ''}${t('weight')} ${m.score}${en.value ? '.' : '。'}`;
    });
    /** 挂在这个模块上的配图（items 里 forKey 的 image） */
    const images = computed(() => (props.module?.items ?? []).filter((i) => i.kind === 'image' && i.forKey));
    const src = (im) => `/api/day/image?date=${encodeURIComponent(props.date)}&id=${encodeURIComponent(im.imageId)}&t=${encodeURIComponent(TOKEN)}`;
    function files(list) {
      const arr = [...(list ?? [])].filter((f) => /^image\//.test(f.type));
      if (arr.length) emit('upload', arr, props.module.key);
    }
    function onPaste(e) {
      const items = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === 'file' && /^image\//.test(i.type)).map((i) => i.getAsFile()).filter(Boolean);
      if (items.length) {
        e.preventDefault();
        emit('upload', items, props.module.key);
      }
    }

    function label(it) {
      if (it.kind === 'web') return it.term ? (en.value ? `Search "${it.term}"` : `搜索「${it.term}」`) : it.label;
      return it.label;
    }
    function extra(it) {
      if (it.kind === 'web') {
        const stay = stayWords(it.secs);
        return [it.host, it.repeats > 1 ? `${it.repeats} ${t('times')}` : '', stay ? `${t('stay')}${en.value ? ' ' : ''}${stay}` : ''].filter(Boolean).join(sep.value);
      }
      if (it.kind === 'shell') return [it.cwd ? `${t('at')} ${it.cwd}` : '', it.repeats > 1 ? `${t('typed')} ${it.repeats} ${t('times')}` : ''].filter(Boolean).join(sep.value);
      if (it.created) return t('newHere');
      if (it.repeats > 1) return `${t('repeat')} ${it.repeats} ${t('times')}`;
      return '';
    }
    function outlineOf(it) {
      if (!it.outline?.length) return '';
      return `${OUTLINE_LABEL[it.outlineKind] ?? (en.value ? 'outline' : '大纲')}${en.value ? ': ' : '：'}${it.outline.join(' ／ ')}`;
    }

    return { hint, dirty, timeline, meta, images, src, files, onPaste, label, extra, outlineOf, hhmm, catVar, KIND_LABEL, t, emit };
  },
  template: `
<aside class="drawer" v-if="module" :class="'c-' + catVar(module.category)" :aria-label="t('drawerLabel')">
  <div class="drawer-head">
    <h2>{{ module.title }}</h2>
    <button class="btn quiet" @click="$emit('close')" :title="t('closeEsc')" :aria-label="t('close')">×</button>
  </div>
  <p class="meta">{{ meta }}</p>
  <p class="why">{{ module.why }}<template v-if="module.permanentlyExcluded"> {{ t('excludedForeverNote') }}</template></p>
  <div class="actions">
    <button class="btn" :class="module.selected ? 'danger' : 'primary'" @click="$emit('pop', module)">{{ module.selected ? t('dontWrite') : t('writeIn') }}</button>
    <button class="btn" v-if="module.projectId && module.projectId !== 'web' && !module.permanentlyExcluded" @click="$emit('exclude', module)">{{ t('excludeProject') }}</button>
    <!-- 手记是自己写的，它没有「项目」可排除；要彻底不要就删掉这一条（时间板上那个泡泡也会跟着消失） -->
    <button class="btn danger" v-if="module.noteId" @click="$emit('delete-note', module.noteId)" :disabled="saving">{{ t('noteDelete') }}</button>
  </div>

  <section class="hintbox" @paste="onPaste">
    <label :for="'hint-' + module.key">{{ t('hintLabel') }}</label>
    <textarea :id="'hint-' + module.key" v-model="hint" rows="2" :placeholder="t('hintPh')"></textarea>
    <div class="hint-imgs" v-if="images.length">
      <figure v-for="im in images" :key="im.imageId"><img :src="src(im)" :alt="im.label" loading="lazy"><figcaption :title="im.label">{{ im.label }}</figcaption><button class="btn small quiet danger" @click="$emit('remove-image', im.imageId)" :title="t('removeImage')">×</button></figure>
    </div>
    <div class="row">
      <button class="btn small primary" @click="$emit('hint', module, hint)" :disabled="saving || !dirty">{{ saving ? t('saving') : t('saveHint') }}</button>
      <button class="btn small quiet" v-if="module.hint" @click="$emit('hint', module, '')" :disabled="saving">{{ t('clearHint') }}</button>
      <label class="btn small">{{ t('addImage') }}<input type="file" accept="image/*" multiple class="sr" @change="files($event.target.files); $event.target.value = ''"></label>
      <small>{{ t('hintNote') }}</small>
    </div>
    <p class="hint warn" v-if="images.length && !vision">{{ t('hintImgVisionOff') }}</p>
  </section>

  <ol class="evidence" :aria-label="t('evidence')">
    <li v-for="it in timeline" :key="it.sourceId" :class="['ev', 'k-' + it.kind, {sub: it.sub, file: it.path || it.kind === 'shell'}]" :title="it.path || it.url || it.cwd || it.sourceId">
      <time>{{ hhmm(it.ts) }}</time>
      <span class="k">{{ it.sub ? t('reply') : (KIND_LABEL[it.kind] || it.kind) }}</span>
      <span class="lb">
        {{ label(it) }}
        <small v-if="extra(it)" class="x">{{ extra(it) }}</small>
        <small v-if="outlineOf(it)" class="outline">{{ outlineOf(it) }}</small>
      </span>
    </li>
  </ol>
</aside>`,
};
