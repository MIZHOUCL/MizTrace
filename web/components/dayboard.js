/**
 * 一天的板子：时间从上往下，一条时间轴，模块是落在起始时刻的一滴墨迹，
 * 大小随权重，尾巴拖到结束时刻。位置由时间决定，不飘。
 *
 * 为什么不再按项目分泳道：一个人一天碰七八个文件夹很平常，每个文件夹一条道就把板子撑爆了 ——
 * 实测八条道在 1180 像素的页面里直接溢出，右边的泡泡看不见。项目改用泡泡上的小字和颜色区分。
 *
 * 时间轴是「有弹性」的：什么都没发生的整点小时折叠成一条窄带（标 ‥），
 * 否则早上八点到晚上八点的一天里，两段工作会被十个小时的空白隔得老远。
 * 同一时刻挨得太近的几滴，横向错开到几条轨；再不行才往下推。
 *
 * 宽度监听挂在**始终存在**的外层容器上。之前挂在 v-if 的 .board 上：页面首次渲染时模块还没到、
 * 元素不存在，监听没挂上，宽度永远停在默认值 —— 抽屉一打开画布变窄，泡泡却还按老宽度排，
 * 最右一条轨直接压到抽屉上。实测就是用户看到的「泡泡盖在记录上」。
 */
import { hhmm, timeRange, statsWords, blobRadius, catVar, blobTitle, toolWords, projectWords } from '../lib/format.js';
import { t, lang } from '../lib/i18n.js';

const { computed, ref, watch, onMounted, onBeforeUnmount } = window.Vue;

const HOUR = 3_600_000;
const PX_ACTIVE = 76; // 有事发生的一小时
const PX_IDLE = 22; // 折叠掉的一小时
const PAD = 16;
const GAP = 10;
const RULER = 44;
const TRACK_W = 170; // 每条轨大约这么宽；板子越宽轨越多
const MAX_TRACKS = 6;

export const DayBoard = {
  name: 'DayBoard',
  props: { modules: { type: Array, default: () => [] }, date: String, today: String, popping: { type: Object, default: () => ({}) }, risen: Boolean },
  emits: ['open', 'pop'],
  setup(props, { emit }) {
    const el = ref(null);
    const width = ref(1000);
    let ro = null;
    function observe(node) {
      ro?.disconnect();
      ro = null;
      if (!node) return;
      width.value = node.clientWidth || width.value;
      ro = new ResizeObserver(() => {
        width.value = node.clientWidth || width.value;
      });
      ro.observe(node);
    }
    onMounted(() => observe(el.value));
    watch(el, (node) => observe(node));
    onBeforeUnmount(() => ro?.disconnect());

    const layout = computed(() => {
      const mods = props.modules;
      if (!mods.length) return null;
      const spans = mods.map((m) => [Date.parse(m.startTs), Date.parse(m.endTs || m.startTs)]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
      if (!spans.length) return null;
      const d0 = new Date(Math.min(...spans.map((s) => s[0])));
      d0.setMinutes(0, 0, 0);
      const t0 = d0.getTime() - HOUR;
      const d1 = new Date(Math.max(...spans.map((s) => s[1])));
      d1.setMinutes(0, 0, 0);
      let t1 = d1.getTime() + 2 * HOUR;
      if (t1 - t0 < 5 * HOUR) t1 = t0 + 5 * HOUR;

      // 每个小时：有没有任何模块覆盖到它（起点前后各留半小时的呼吸）
      const hours = [];
      for (let t = t0; t < t1; t += HOUR) {
        const active = spans.some(([a, b]) => a - HOUR / 2 < t + HOUR && b + HOUR / 2 > t);
        hours.push({ t, active, px: active ? PX_ACTIVE : PX_IDLE });
      }
      let acc = PAD;
      for (const h of hours) {
        h.y = acc;
        acc += h.px;
      }
      const total = acc;
      const pos = (t) => {
        if (t <= t0) return PAD;
        const i = Math.min(hours.length - 1, Math.floor((t - t0) / HOUR));
        const h = hours[i];
        return h.y + ((t - h.t) / HOUR) * h.px;
      };
      // 折叠的小时连成一段，只在中间标一次 ‥
      const ticks = [];
      for (let i = 0; i < hours.length; i += 1) {
        const h = hours[i];
        if (h.active) ticks.push({ t: h.t, y: h.y, label: String(new Date(h.t).getHours()).padStart(2, '0'), idle: false });
        else {
          let j = i;
          while (j + 1 < hours.length && !hours[j + 1].active) j += 1;
          const y0 = h.y;
          const y1 = hours[j].y + hours[j].px;
          ticks.push({ t: h.t, y: (y0 + y1) / 2, label: '‥', idle: true, from: String(new Date(h.t).getHours()).padStart(2, '0'), to: String(new Date(hours[j].t + HOUR).getHours()).padStart(2, '0'), y0, y1 });
          i = j;
        }
      }

      const maxScore = Math.max(1, ...mods.map((m) => m.score || 0));
      const laneW = Math.max(160, width.value - RULER);
      const tracks = Math.max(1, Math.min(MAX_TRACKS, Math.floor(laneW / TRACK_W)));
      const trackW = laneW / tracks;
      // 泡泡统一小一号：点开有详情，太大反而挤（用户原话「不需要这么大，太大了不太美观」）
      const maxSize = Math.max(64, Math.min(118, trackW - 28));
      const sizeOf = (m) => (m.selected ? Math.round(Math.min(maxSize, 66 + 52 * Math.sqrt((m.score || 0) / maxScore))) : 52);

      let height = total;
      const items = [...mods].sort((a, b) => String(a.startTs).localeCompare(String(b.startTs)) || (b.score || 0) - (a.score || 0));
      const bottoms = Array.from({ length: tracks }, () => -Infinity);
      const blobs = items.map((m) => {
        const size = sizeOf(m);
        const want = pos(Date.parse(m.startTs)) - size * 0.35; // 起点落在泡泡上三分之一处
        let track = bottoms.findIndex((bottom) => want >= bottom + GAP);
        let y;
        if (track >= 0) y = want;
        else {
          track = bottoms.indexOf(Math.min(...bottoms));
          y = bottoms[track] + GAP;
        }
        bottoms[track] = y + size;
        const endY = pos(Date.parse(m.endTs || m.startTs));
        const tail = endY > y + size + 6 ? Math.round(endY - (y + size)) : 0;
        height = Math.max(height, y + size + tail + 24);
        const x = Math.round(Math.min(Math.max(trackW * track + trackW / 2, size / 2 + 4), laneW - size / 2 - 4));
        return { m, size, y: Math.round(y), tail, x, label: blobTitle(m), project: projectWords(m.projectName), tool: toolWords(m) };
      });
      const now = Date.now();
      const nowY = props.date === props.today && now >= t0 && now <= t1 ? pos(now) : null;
      const bands = ticks.filter((k) => k.idle).map((k) => ({ y: k.y0, h: k.y1 - k.y0 }));
      return { blobs, ticks, bands, height: Math.ceil(height), nowY, cols: `${RULER}px minmax(0, 1fr)` };
    });

    function onKey(e, m) {
      if (e.code === 'Space') {
        e.preventDefault();
        emit('pop', m);
      } else if (e.key === 'Enter') emit('open', m);
    }

    return { el, layout, onKey, hhmm, timeRange, statsWords, blobRadius, catVar, t, lang };
  },
  template: `
<div class="boardwrap" ref="el">
<div class="board" v-if="layout">
  <div class="grid" :style="{gridTemplateColumns: layout.cols, height: layout.height + 'px'}">
    <div class="band" v-for="(b, i) in layout.bands" :key="'b' + i" :style="{top: b.y + 'px', height: b.h + 'px'}" aria-hidden="true"></div>
    <div class="ruler">
      <span v-for="k in layout.ticks" :key="k.t" class="hour" :class="{idle: k.idle}" :style="{top: k.y + 'px'}" :title="k.idle ? (lang === 'en' ? 'nothing between ' + k.from + ':00 and ' + k.to + ':00' : k.from + ':00 到 ' + k.to + ':00 没有痕迹') : ''">{{ k.label }}</span>
    </div>
    <div class="lane">
      <div v-for="b in layout.blobs" :key="b.m.key"
           class="trace" :class="['c-' + catVar(b.m.category), {off: !b.m.selected, popping: popping[b.m.key], rising: risen && b.m.selected, small: b.size < 96, tiny: b.size < 76}]"
           :style="{top: b.y + 'px', left: b.x + 'px', '--size': b.size + 'px', '--tail': b.tail + 'px', borderRadius: b.m.selected ? blobRadius(b.m.key) : '50%'}"
           tabindex="0" role="button"
           :aria-label="(b.tool ? b.tool + ', ' : '') + b.project + ': ' + b.m.title + (b.m.selected ? '' : ' (' + (lang === 'en' ? 'excluded' : '已排除') + ')')"
           @click="$emit('open', b.m)" @keydown="onKey($event, b.m)">
        <div class="p" v-if="b.size >= 76"><span class="tool" v-if="b.tool">{{ b.tool }} · </span>{{ b.project }}</div>
        <div class="t">{{ b.label }}</div>
        <div class="s">
          <template v-if="b.m.selected">{{ timeRange(b.m) }}<template v-if="b.size >= 104 && statsWords(b.m.stats, {short:true})"><br>{{ statsWords(b.m.stats, {short:true}) }}</template></template>
          <template v-else>{{ lang === 'en' ? 'excluded' : '已排除' }}{{ b.m.permanentlyExcluded ? (lang === 'en' ? ' (forever)' : '（永久）') : '' }}</template>
          <span v-if="b.m.hint" class="hintmark" :title="t('hintLabel')">✎</span>
        </div>
        <button class="pop" :title="b.m.selected ? t('dontWrite') : t('writeIn')" :aria-label="b.m.selected ? t('dontWrite') : t('writeIn')" @click.stop="$emit('pop', b.m)">{{ b.m.selected ? '×' : '↺' }}</button>
        <i class="tail" v-if="b.tail" aria-hidden="true"></i>
      </div>
    </div>
    <div class="now" v-if="layout.nowY != null" :style="{top: layout.nowY + 'px'}" title="现在"><i></i></div>
  </div>
</div>
</div>`,
};
