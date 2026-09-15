/**
 * Markdown 渲染：每条要点带 [^evN] 脚注，项目名写成 [[wiki-link]]（ADR-015）。
 * 输出里不含文件正文；助手回复只有每轮截断后的最后一段（ADR-022）。
 */

/** 外链图片降级为纯文本，避免会话/diff 里的内容在渲染时外发数据（PROJECT_PLAN §8.5）。 */
export function defuseMarkdown(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '[图片: $1 <$2>]')
    .replace(/\r/g, '')
    .replace(/\n/g, ' ');
}

/** SVN 证据的 source_ref 是 r814@a1b2c3d4，脚注里只显示 r814 那一半。 */
export function svnRef(sourceRef) {
  const m = String(sourceRef ?? '').match(/^(r\d+)/);
  return m ? m[1] : String(sourceRef ?? '');
}

export function footnoteLabel(ev) {
  if (!ev) return '（证据缺失）';
  const when = ev.occurred_at ? ev.occurred_at.replace('.000Z', 'Z') : '';
  switch (ev.source_type) {
    case 'commit':
      return `commit \`${ev.source_ref.slice(0, 7)}\` — ${defuseMarkdown(ev.excerpt || '')}${when ? `（${when}）` : ''}`;
    // SVN 的 source_ref 形如 r814@a1b2c3d4：revision 是给人看的，工作副本短 id 是给唯一性用的
    case 'svn-commit':
      return `SVN \`${svnRef(ev.source_ref)}\` — ${defuseMarkdown(ev.excerpt || '')}${when ? `（${when}）` : ''}`;
    case 'worktree': {
      const [status, outline] = String(ev.excerpt || '?').split('｜');
      return `工作树 \`${status}\` ${defuseMarkdown(ev.path_alias || ev.source_ref)}${outline ? `，${defuseMarkdown(outline)}` : ''}`;
    }
    case 'svn-worktree': {
      const [status, outline] = String(ev.excerpt || '?').split('｜');
      return `工作副本 \`${status}\` ${defuseMarkdown(ev.path_alias || ev.source_ref)}${outline ? `，${defuseMarkdown(outline)}` : ''}`;
    }
    case 'session': {
      const [sid, idx] = ev.source_ref.split('#');
      return `会话 \`${sid.slice(0, 8)}\` 第 ${idx} 条消息${when ? `（${when}）` : ''}：${defuseMarkdown((ev.excerpt || '').slice(0, 120))}`;
    }
    case 'session-reply': {
      const [sid, idx] = ev.source_ref.split('#');
      return `会话 \`${sid.slice(0, 8)}\` 第 ${idx} 条消息的回复${when ? `（${when}）` : ''}：${defuseMarkdown((ev.excerpt || '').slice(0, 160))}`;
    }
    case 'web': {
      const [title, ...rest] = String(ev.excerpt || '').split('｜');
      return `网页「${defuseMarkdown(title)}」（${defuseMarkdown(ev.path_alias || '')}）${rest.length ? `，${rest.join('，')}` : ''}${when ? `，首次打开 ${when}` : ''}：<${ev.path || ev.source_ref}>`;
    }
    case 'note': {
      // source_ref 是 `日期#条目 id`；脚注里只显示日期那一半，条目 id 只为唯一性存在
      const day = String(ev.source_ref ?? '').split('#')[0];
      return `手记（${defuseMarkdown(day)}${when ? `，写于 ${when}` : ''}）：${defuseMarkdown((ev.excerpt || '').slice(0, 200))}`;
    }
    case 'image':
      return `图片 \`${defuseMarkdown(ev.path_alias || ev.excerpt || ev.source_ref)}\`${when ? `（${when}）` : ''}`;
    case 'shell':
      return `终端 \`${defuseMarkdown(ev.excerpt || '')}\`${ev.path_alias ? `（在 ${defuseMarkdown(ev.path_alias)}/）` : ''}${when ? `（${when}）` : ''}`;
    case 'clone': {
      const name = defuseMarkdown(ev.path_alias || ev.source_ref);
      return ev.excerpt ? `仓库 \`${name}\` clone 自 ${defuseMarkdown(ev.excerpt)}${when ? `（${when}）` : ''}` : `仓库 \`${name}\` 在本机新建${when ? `（${when}）` : ''}`;
    }
    case 'session-action': {
      const [sid] = ev.source_ref.split('#');
      return `会话 \`${sid.slice(0, 8)}\` 的操作 — ${defuseMarkdown(ev.excerpt || '')}`;
    }
    case 'file': {
      const name = ev.path_alias || ev.source_ref.split(/[\\/]/).pop();
      const dir = ev.path ? ev.path.split(/[\\/]/).slice(-2, -1)[0] : '';
      const [sizePart, flag] = String(ev.excerpt || '').split('｜');
      const outline = sizePart && !/^\d+ bytes$/.test(sizePart) ? `，${defuseMarkdown(sizePart)}` : '';
      const fresh = flag === '新出现' ? '，新出现（创建于当天）' : '';
      return `文件 \`${defuseMarkdown(name)}\`${dir ? `（${defuseMarkdown(dir)}/）` : ''}${when ? `，${fresh ? '出现于' : '改于'} ${when}` : ''}${outline}${fresh}`;
    }
    default:
      return `${ev.source_type} \`${ev.source_ref}\``;
  }
}

/**
 * @param {{localDate:string, projects:any[], facts:any[], evidenceIndex:Map<string,any>,
 *          report:any[], cutoffHour:number, repoCount:number}} input
 */
export function renderMarkdown(input) {
  const { localDate, projects, facts, evidenceIndex, report, cutoffHour, repoCount, fileScan, timeZone, utcOffset } = input;
  const lines = [];
  lines.push(`# ${localDate}`, '');

  if (!facts.length) {
    lines.push('无可记录活动。', '');
    lines.push('已检查的来源：');
    lines.push(`- git 仓库 ${repoCount} 个`);
    if (fileScan) lines.push(`- 文件扫描：${fileScan.dirs} 个目录、${fileScan.scanned} 个文件，其中 ${fileScan.skippedInRepo} 个在 git 仓库内已交给 git 处理`);
    for (const r of report) {
      if (r.status === 'absent') continue; // 没装的工具不列：「0 个会话」没有信息量
      const label = r.status === 'ok' ? `${r.count} 个会话${r.generic ? '（通用格式）' : ''}` : `降级（${r.error ?? '解析失败'}）`;
      lines.push(`- ${r.name ?? r.id}：${label}`);
    }
    lines.push('', `> 时区 ${timeZone ?? '本机'}（UTC${utcOffset ?? ''}），日界为本地时间 ${String(cutoffHour).padStart(2, '0')}:00，跨零点的工作会归到前一天。`, '');
    return lines.join('\n');
  }

  /** source_id -> 脚注编号，按出现顺序分配 */
  const noteNo = new Map();
  const noteOrder = [];
  const refOf = (sid) => {
    if (!noteNo.has(sid)) {
      noteNo.set(sid, noteNo.size + 1);
      noteOrder.push(sid);
    }
    return noteNo.get(sid);
  };

  const byProject = new Map();
  for (const f of facts) {
    if (!byProject.has(f.project_id)) byProject.set(f.project_id, []);
    byProject.get(f.project_id).push(f);
  }

  for (const project of projects) {
    const list = byProject.get(project.id);
    if (!list?.length) continue;
    lines.push(`## [[${project.name}]]`, '');
    for (const f of list) {
      const refs = f.source_ids.slice(0, 6).map((sid) => `[^ev${refOf(sid)}]`).join('');
      const mark = f.confidence === 'confirmed' ? '' : ` \`${f.confidence}\``;
      const hint = f.confidence === 'unverified' ? '（无法关联来源，请确认或删除）' : '';
      const indent = '  '.repeat(f.depth ?? 0);
      lines.push(`${indent}- ${defuseMarkdown(f.text)}${refs}${mark}${hint}`);
    }
    lines.push('');
  }

  lines.push('---', '');
  for (const sid of noteOrder) {
    lines.push(`[^ev${noteNo.get(sid)}]: ${footnoteLabel(evidenceIndex.get(sid))}`);
  }
  lines.push('');

  const counts = facts.reduce((acc, f) => {
    acc[f.confidence] = (acc[f.confidence] ?? 0) + 1;
    return acc;
  }, {});
  const scanned = [`git 仓库 ${repoCount} 个`];
  if (fileScan) {
    scanned.push(`文件扫描 ${fileScan.dirs} 个目录${fileScan.truncated ? '（已截断）' : ''}`);
  } else {
    scanned.push('文件扫描 已关闭');
  }
  for (const r of report) {
    if (r.status === 'absent') continue;
    scanned.push(`${r.name ?? r.id} ${r.status === 'ok' ? `${r.count} 个会话` : '降级'}`);
  }
  lines.push(
    `> 扫描范围：${scanned.join('｜')}。` +
      `${facts.length} 条事实：confirmed ${counts.confirmed ?? 0}，inferred ${counts.inferred ?? 0}，unverified ${counts.unverified ?? 0}。` +
      `时区 ${timeZone ?? '本机'}（UTC${utcOffset ?? ''}），日界 ${String(cutoffHour).padStart(2, '0')}:00，全部时间戳按 UTC 存储。`,
    '',
  );
  return lines.join('\n');
}
