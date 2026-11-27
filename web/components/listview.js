/** 列表视图：给不想看图的人。 */
import { timeRange, statsWords, catVar, CAT_WORD, projectWords } from '../lib/format.js';
import { t, lang } from '../lib/i18n.js';

export const ListView = {
  name: 'ListView',
  props: { modules: Array },
  emits: ['open', 'toggle'],
  setup() {
    const L = (zh, en) => (lang.value === 'en' ? en : zh);
    return { timeRange, statsWords, catVar, CAT_WORD, projectWords, t, L };
  },
  template: `
<table class="list">
  <thead><tr><th><span class="sr">{{ t('writeIn') }}</span></th><th>{{ L('模块', 'Module') }}</th><th>{{ L('项目', 'Project') }}</th><th>{{ L('时间', 'Time') }}</th><th>{{ t('evidence') }}</th><th>{{ L('类别', 'Type') }}</th><th class="num">{{ t('weight') }}</th></tr></thead>
  <tbody>
    <tr v-for="m in modules" :key="m.key" :class="{off: !m.selected}">
      <td><input type="checkbox" :checked="m.selected" :aria-label="t('writeIn') + ': ' + m.title" @change="$emit('toggle', m, $event.target.checked)"></td>
      <td class="title"><button class="linklike" @click="$emit('open', m)">{{ m.title }}</button>
        <small v-if="m.permanentlyExcluded" class="tag">{{ L('永久排除', 'excluded') }}</small><small v-if="m.burst" class="tag">{{ L('解压/复制', 'unzipped/copied') }}</small><small v-if="m.hint" class="tag">{{ L('有补充说明', 'has note') }}</small></td>
      <td>{{ projectWords(m.projectName) }}<small v-if="m.toolNames && m.toolNames.length" class="tag">{{ m.toolNames.join(L('、', ', ')) }}</small></td><td class="mono">{{ timeRange(m) }}</td><td>{{ statsWords(m.stats) || '—' }}</td>
      <td><span class="cat" :class="'c-' + catVar(m.category)">{{ CAT_WORD[m.category] || m.category }}</span></td><td class="num">{{ m.score }}</td>
    </tr>
  </tbody>
</table>`,
};
