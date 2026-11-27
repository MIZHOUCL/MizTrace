/**
 * 手记：写几句今天做了什么，配几张图。你亲手写的是最可信的证据，模型会优先采信。
 *
 * 交互：**写完点「保存手记」**，这一条就成为时间板上的一个独立泡泡，输入框随即清空，
 * 可以接着写第二条 —— 一天可以有很多条，每条各占一个泡泡。
 *
 * 这里刻意**没有自动保存**：只有「保存」这一个动作，用户看得见自己按了什么、也知道哪一刻算数。
 * （之前是失焦或停顿一秒自动写回，用户找不到「发送」按钮，还担心没记下来。）
 * 删掉某一条不在这个框里 —— 去下面时间板上那个泡泡里点「删掉这条手记」。
 */
import { TOKEN } from '../lib/api.js';
import { t } from '../lib/i18n.js';

const { ref, watch, computed } = window.Vue;

export const NotesBox = {
  name: 'NotesBox',
  props: { notes: Object, date: String, saving: Boolean, vision: Boolean },
  emits: ['save', 'upload', 'remove'],
  setup(props, { emit }) {
    // 正在写的那条。只有输入框里的字 + 还没归属到某条手记的图；保存成功后服务端把图认领走，这里自然回到空。
    const text = ref('');
    // 默认就是展开的：之前折成一行小字，用户说「别人都看不到，意识不到还可以自己填写」
    const open = ref(true);
    const dragging = ref(false);
    const draftImages = computed(() => (props.notes?.images ?? []).filter((im) => !im.forKey && !im.entryId));
    const canSave = computed(() => text.value.trim() !== '' || draftImages.value.length > 0);
    const savedCount = computed(() => (props.notes?.entries ?? []).length);
    watch(
      () => savedCount.value,
      (n, was) => {
        // 多了一条 = 刚才那次保存成功了 → 清空输入框，接着写下一条
        if (n > (was ?? 0)) text.value = '';
      },
    );
    watch(
      () => props.date,
      () => {
        text.value = '';
      },
    );
    function save() {
      if (!canSave.value || props.saving) return;
      emit('save', text.value.trim());
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
    return { text, open, dragging, draftImages, canSave, savedCount, save, files, onDrop, onPaste, src, t };
  },
  template: `
<section class="notes" :class="{open, dragging}" :aria-label="t('notesTitle')" @dragover.prevent="dragging = true" @dragleave="dragging = false" @drop.prevent="onDrop">
  <button class="notes-toggle linklike" v-if="!open" @click="open = true">{{ t('notesOpen') }}</button>
  <template v-else>
    <div class="notes-head"><strong>✎ {{ t('notesTitle') }}</strong><small>{{ t('notesHint') }}</small><span class="spacer"></span><span class="fine" v-if="saving">{{ t('notesSaving') }}</span></div>
    <textarea v-model="text" rows="3" :placeholder="t('notesPh')" @paste="onPaste" @keydown.ctrl.enter.prevent="save" @keydown.meta.enter.prevent="save"></textarea>
    <div class="notes-imgs" v-if="draftImages.length">
      <figure v-for="im in draftImages" :key="im.id"><img :src="src(im)" :alt="im.name" loading="lazy"><figcaption :title="im.name">{{ im.name }}</figcaption><button class="btn small quiet danger" @click="$emit('remove', im.id)" :title="t('removeImage')">×</button></figure>
    </div>
    <div class="notes-foot">
      <button class="btn small primary" @click="save" :disabled="saving || !canSave">{{ saving ? t('notesSaving') : t('notesSave') }}</button>
      <label class="btn small">{{ t('pickImage') }}<input type="file" accept="image/*" multiple class="sr" @change="files($event.target.files); $event.target.value = ''"></label>
      <small v-if="vision">{{ t('visionOn') }}</small>
      <small v-else>{{ t('visionOff') }}</small>
    </div>
    <p class="notes-msg">{{ t('notesHow') }}</p>
    <p class="notes-msg" v-if="savedCount">{{ t('notesCount', { n: savedCount }) }}</p>
  </template>
</section>`,
};
