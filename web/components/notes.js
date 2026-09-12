/**
 * 手记：自己写几句今天做了什么，配几张图。写的东西是最可信的证据，模型会优先采信。
 * 文字失焦或停顿一秒自动保存；图片拖进来或点选，传完立刻显示缩略图。
 */
import { TOKEN } from '../lib/api.js';
import { t } from '../lib/i18n.js';

const { ref, watch, computed } = window.Vue;

export const NotesBox = {
  name: 'NotesBox',
  props: { notes: Object, date: String, saving: Boolean, vision: Boolean },
  emits: ['save', 'upload', 'remove'],
  setup(props, { emit }) {
    const text = ref(props.notes?.text ?? '');
    // 默认就是展开的：之前折成一行小字，用户说「别人都看不到，意识不到还可以自己填写」
    const open = ref(true);
    const dragging = ref(false);
    let timer = null;
    watch(
      () => props.notes,
      (n) => {
        if ((n?.text ?? '') !== text.value && !timer) text.value = n?.text ?? '';
        if (n?.text || n?.images?.length) open.value = true;
      },
    );
    const dirty = computed(() => text.value.trim() !== (props.notes?.text ?? '').trim());
    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        if (dirty.value) emit('save', text.value);
      }, 1000);
    }
    function saveNow() {
      clearTimeout(timer);
      timer = null;
      if (dirty.value) emit('save', text.value);
    }
    function files(list) {
      const arr = [...(list ?? [])].filter((f) => /^image\//.test(f.type));
      if (arr.length) emit('upload', arr);
    }
    function onDrop(e) {
      dragging.value = false;
      files(e.dataTransfer?.files);
    }
    function onPaste(e) {
      const items = [...(e.clipboardData?.items ?? [])].filter((i) => i.kind === 'file' && /^image\//.test(i.type)).map((i) => i.getAsFile()).filter(Boolean);
      if (items.length) {
        e.preventDefault();
        emit('upload', items);
      }
    }
    const src = (im) => `/api/day/image?date=${encodeURIComponent(props.date)}&id=${encodeURIComponent(im.id)}&t=${encodeURIComponent(TOKEN)}`;
    // 只显示手记自己的图；给泡泡补的图（forKey）在抽屉里
    const ownImages = computed(() => (props.notes?.images ?? []).filter((im) => !im.forKey));
    return { text, open, dragging, dirty, schedule, saveNow, files, onDrop, onPaste, src, ownImages, t };
  },
  template: `
<section class="notes" :class="{open, dragging}" :aria-label="t('notesTitle')" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
  <button class="notes-toggle linklike" v-if="!open" @click="open = true">{{ t('notesOpen') }}</button>
  <template v-else>
    <div class="notes-head"><strong>✎ {{ t('notesTitle') }}</strong><small>{{ t('notesHint') }}</small><span class="spacer"></span><span class="fine" v-if="saving">{{ t('notesSaving') }}</span><span class="fine" v-else-if="dirty">{{ t('notesUnsaved') }}</span><span class="fine" v-else-if="notes && notes.updatedAt">{{ t('notesSaved') }}</span></div>
    <textarea v-model="text" rows="3" :placeholder="t('notesPh')" @input="schedule" @blur="saveNow" @paste="onPaste"></textarea>
    <div class="notes-imgs" v-if="ownImages.length">
      <figure v-for="im in ownImages" :key="im.id"><img :src="src(im)" :alt="im.name" loading="lazy"><figcaption :title="im.name">{{ im.name }}</figcaption><button class="btn small quiet danger" @click="$emit('remove', im.id)" :title="t('removeImage')">×</button></figure>
    </div>
    <div class="notes-foot">
      <label class="btn small">{{ t('pickImage') }}<input type="file" accept="image/*" multiple class="sr" @change="files($event.target.files); $event.target.value = ''"></label>
      <small v-if="vision">{{ t('visionOn') }}</small>
      <small v-else>{{ t('visionOff') }}</small>
    </div>
  </template>
</section>`,
};
