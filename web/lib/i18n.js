/**
 * 界面文案：中文默认，一键切英文。所有可见文字都从这里取，t('key') 拿当前语言。
 * 存 localStorage 的 mt_lang；切换后整页文案立刻换，日记正文的语言也跟着发给模型。
 * 只做 zh / en 两种：推广到国外用户够用了，再多就该抽成文件。
 */
const { ref, computed } = window.Vue;

export const LANGS = [
  { id: 'zh', label: '中文', flag: 'CN' },
  { id: 'en', label: 'English', flag: 'US' },
];

const ZH = {
  brand: 'MizTrace',
  prevDay: '前一天', nextDay: '后一天', backToday: '回到今天', refresh: '刷新', refreshTitle: '重新采集这一天的痕迹', pickDate: '选择日期',
  collecting: '采集中…', modelWriting: '模型正在写…', boardView: '时间板', listView: '列表', resetDefault: '恢复默认', resetTitle: '清除这一天的手动选择',
  rulesJournal: '规则版日记', rulesTitleBusy: '还在采集，稍等', genJournal: '生成日记', generating: '生成中…', preparing: '准备中…',
  genTitleBusy: '还在采集今天的痕迹，稍等', genTitleNone: '没有一段写进日记，先恢复几个泡泡', genTitleNoAi: '还没配置模型服务，点开会告诉你差什么',
  settings: '设置', close: '关闭', undo: '撤销', cancel: '取消', save: '保存', saving: '保存中…', view: '视图', lang: '语言',
  checkSources: '检查扫描目录和来源', noTraces: '这一天没有留下痕迹。', notCollected: '还没有采集。',
  legendHow: '时间从上往下，泡泡越大权重越高，泡泡上的小字是项目。点一滴痕迹看证据，点它右上角的 × 就不写进日记。键盘：Tab 选中，空格戳破，回车看详情。',
  aiDiary: 'AI 写的日记', rulesDiary: '规则版日记', template: '模板', input: '输入', output: '输出', downgraded: '条引用无效已降级',
  copyMd: '复制 Markdown', saveToDir: '保存到日记目录', collapse: '收起', backToAi: '回到 AI 写的那篇', backToRules: '看规则版', regenerate: '重新生成',
  copied: '已复制 Markdown', copyFailed: '复制失败：浏览器不允许剪贴板访问', savedTo: '已保存到', sentToModel: '已发给模型，通常要一两分钟，写好会显示在下面。',
  writeBack: '重新写进日记', dontWrite: '不写进日记', resetDone: '已恢复默认选择', excludeForever: '以后每天都不把「{p}」写进日记？（可在设置里改回）', excluded: '已永久排除项目「{p}」',
  hintSaved: '已保存补充说明，生成日记时会和手记一样优先采信', hintCleared: '已清除补充说明', settingsSaved: '设置已保存',
  // 手记
  notesTitle: '我的手记', notesOpen: '✎ 自己写几句今天做了什么，或者贴张图', notesHint: '你亲手写的最可信，模型会优先采信，甚至可以写证据里没有的事。空着也没关系。',
  notesPh: '例如：上午跟客户对了需求，下午把导出功能写完了，还剩分页没做。', notesSaving: '保存中…', notesUnsaved: '未保存', notesSaved: '已保存',
  pickImage: '贴图 / 选图', removeImage: '删掉这张图', visionOn: '开了「能看图」：生成日记时图片会发给模型。', visionOff: '图片只会以文件名进日记；要让模型看图，去设置里勾「模型支持图片」。也可以直接把图粘贴或拖到这里。',
  // 抽屉
  drawerLabel: '模块详情', closeEsc: '关闭（Esc）', excludedForeverNote: '该项目在设置里被永久排除。', writeIn: '写进日记', excludeProject: '永久排除此项目',
  hintLabel: '补充说明（可选）：这段实际在做什么', hintPh: '例如：在这个站看了一小时 Vue 的教程。',
  hintNote: '和手记一样是最高优先级，模型会优先采信；也可以贴一两张图。', saveHint: '保存说明', clearHint: '清除', addImage: '附一张图', hintImgVisionOff: '附了图就必须用能看图的模型（设置里勾「模型支持图片」），否则生成时会报错。',
  evidence: '证据', reply: '回复', with: '用', lasting: '持续', weight: '权重', at: '在', typed: '敲了', times: '次', repeat: '重复', newHere: '新出现（今天才落到这里，修改时间是旧的）', stay: '停留',
  minutes: '分钟', hours: '小时', hour: '小时',
  // 弹窗
  confirmTitle: '发送前确认', willSend: '将把', modulesTo: '个模块的证据发给', yourModel: '你配置的模型', about: '约', includes: '包含', excludes: '不含',
  diaryTemplate: '日记模板', tplNote: '决定日记长什么样；模板文字在「设置」里可以改、可以加。', calledToday: '今天已调用', limit: '上限', hintCount: '个模块带你写的补充说明。', hasStyle: '附整篇写作要求。',
  imgCount: '手记里有', imgs: '张图', imgSend: '会随请求发原图', imgNameOnly: '模型没开「能看图」，只发图片名', hintImgs: '这些泡泡附了图，会发原图：',
  secretsFound: '检测到疑似密钥，', blocked: '已熔断，不会发送', secretsHow: '先排除对应模块，或清理证据里的密钥。', managed: '这台电脑是受管设备（config.json 里 managedDevice=true）：AI 写作已永久禁用，请用「规则版日记」。',
  aiMissing: '模型服务还差：', goSettings: '去设置', overLimit: '今天已经调用 {n} 次，达到每日上限。设置里可以调高。', nothingSelected: '没有一段痕迹被选中：先在时间板上把要写的泡泡恢复（点 ↺）。',
  showPayload: '查看将发送的全文', hidePayload: '收起全文', confirmSend: '确认发送并生成',
  whySecret: '证据里有疑似密钥，已熔断', whyManaged: '受管设备，AI 写作已禁用', whyNoAi: '模型服务还没配好', whyLimit: '今天已达调用上限', whyEmpty: '没有一段写进日记', whyWriting: '上一篇还在生成', whyVision: '有泡泡附了图，但模型没开「能看图」',
  // 首屏句子
  today: '今天', yesterday: '昨天', dayBefore: '前天', tomorrow: '明天',
};

const EN = {
  brand: 'MizTrace',
  prevDay: 'Previous day', nextDay: 'Next day', backToday: 'Back to today', refresh: 'Refresh', refreshTitle: 'Re-collect traces for this day', pickDate: 'Pick a date',
  collecting: 'Collecting…', modelWriting: 'Model is writing…', boardView: 'Board', listView: 'List', resetDefault: 'Reset', resetTitle: "Clear this day's manual choices",
  rulesJournal: 'Rules-based', rulesTitleBusy: 'Still collecting, hold on', genJournal: 'Write with AI', generating: 'Writing…', preparing: 'Preparing…',
  genTitleBusy: "Still collecting today's traces", genTitleNone: 'Nothing is selected — restore a few bubbles first', genTitleNoAi: 'No model configured yet; open it to see what is missing',
  settings: 'Settings', close: 'Close', undo: 'Undo', cancel: 'Cancel', save: 'Save', saving: 'Saving…', view: 'View', lang: 'Language',
  checkSources: 'Check scan folders and sources', noTraces: 'No traces on this day.', notCollected: 'Nothing collected yet.',
  legendHow: 'Time runs top to bottom; bigger bubbles carry more weight; the small text is the project. Click a bubble for its evidence, or its × to keep it out of the diary. Keyboard: Tab to focus, Space to pop, Enter for details.',
  aiDiary: 'AI-written diary', rulesDiary: 'Rules-based diary', template: 'template', input: 'in', output: 'out', downgraded: 'references invalid and downgraded',
  copyMd: 'Copy Markdown', saveToDir: 'Save to diary folder', collapse: 'Hide', backToAi: 'Back to the AI version', backToRules: 'Show rules version', regenerate: 'Write again',
  copied: 'Markdown copied', copyFailed: 'Copy failed: clipboard access denied', savedTo: 'Saved to', sentToModel: 'Sent to the model. It usually takes a minute or two; the diary will appear below.',
  writeBack: 'back in the diary', dontWrite: 'left out of the diary', resetDone: 'Selection reset', excludeForever: 'Always leave "{p}" out of the diary? (You can undo this in Settings)', excluded: 'Project "{p}" excluded permanently',
  hintSaved: 'Note saved. Like your own notes, the model will trust it first.', hintCleared: 'Note cleared', settingsSaved: 'Settings saved',
  notesTitle: 'My notes', notesOpen: '✎ Write a few lines about your day, or paste an image', notesHint: 'What you write yourself is the most trusted evidence; the model follows it first, even for things no trace shows. Leaving it empty is fine.',
  notesPh: 'e.g. Aligned requirements with the client in the morning, finished the export feature in the afternoon, pagination still pending.', notesSaving: 'Saving…', notesUnsaved: 'Unsaved', notesSaved: 'Saved',
  pickImage: 'Paste / pick image', removeImage: 'Remove this image', visionOn: 'Vision is on: images are sent to the model when writing.', visionOff: 'Images only reach the diary by file name. To let the model see them, enable "Model supports images" in Settings. You can also paste or drop images here.',
  drawerLabel: 'Module details', closeEsc: 'Close (Esc)', excludedForeverNote: 'This project is permanently excluded in Settings.', writeIn: 'Put in diary', excludeProject: 'Exclude project forever',
  hintLabel: 'Your note (optional): what this was really about', hintPh: 'e.g. Watched an hour of Vue tutorials on this site.',
  hintNote: 'Highest priority, same as your notes; the model follows it first. You can also attach an image or two.', saveHint: 'Save note', clearHint: 'Clear', addImage: 'Attach image', hintImgVisionOff: 'Attached images require a vision-capable model ("Model supports images" in Settings); otherwise writing will fail.',
  evidence: 'Evidence', reply: 'reply', with: 'with', lasting: 'lasting', weight: 'weight', at: 'in', typed: 'typed', times: 'times', repeat: 'repeated', newHere: 'new here today (old modification time)', stay: 'stayed',
  minutes: 'min', hours: 'h', hour: 'h',
  confirmTitle: 'Confirm before sending', willSend: 'Send evidence of', modulesTo: 'modules to', yourModel: 'your model', about: 'about', includes: 'Includes', excludes: 'Excludes',
  diaryTemplate: 'Diary template', tplNote: 'Shapes the diary; edit or add templates in Settings.', calledToday: 'Calls today', limit: 'limit', hintCount: 'modules carry your notes.', hasStyle: 'Global writing instructions attached.',
  imgCount: 'Notes have', imgs: 'images', imgSend: 'sent as originals', imgNameOnly: 'vision is off, only file names are sent', hintImgs: 'These bubbles have images attached (sent as originals):',
  secretsFound: 'Possible secrets detected, ', blocked: 'blocked, nothing will be sent', secretsHow: 'Exclude the module or clean the secret from the evidence.', managed: 'This is a managed device (managedDevice=true in config.json): AI writing is disabled. Use the rules-based diary.',
  aiMissing: 'Model service still needs: ', goSettings: 'Open settings', overLimit: 'Already called {n} times today, daily limit reached. Raise it in Settings.', nothingSelected: 'Nothing selected: restore bubbles on the board first (click ↺).',
  showPayload: 'Show full payload', hidePayload: 'Hide payload', confirmSend: 'Send and write',
  whySecret: 'possible secret in evidence, blocked', whyManaged: 'managed device, AI writing disabled', whyNoAi: 'model service not configured', whyLimit: 'daily limit reached', whyEmpty: 'nothing selected', whyWriting: 'previous diary still writing', whyVision: 'a bubble has images but vision is off',
  today: 'today', yesterday: 'yesterday', dayBefore: 'two days ago', tomorrow: 'tomorrow',
};

const DICT = { zh: ZH, en: EN };
export const lang = ref(localStorage.getItem('mt_lang') === 'en' ? 'en' : 'zh');

export function setLang(id) {
  lang.value = DICT[id] ? id : 'zh';
  localStorage.setItem('mt_lang', lang.value);
  document.documentElement.lang = lang.value === 'en' ? 'en' : 'zh-CN';
}

/** t('key') / t('key', {p: 'x'})：{p} 用参数替换；缺的键退回中文再退回键名。 */
export function t(key, params) {
  let s = DICT[lang.value]?.[key] ?? ZH[key] ?? key;
  if (params) for (const [k, v] of Object.entries(params)) s = s.replace(`{${k}}`, String(v));
  return s;
}

export const isEn = computed(() => lang.value === 'en');
