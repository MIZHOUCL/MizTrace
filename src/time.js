/**
 * 日界与时区。
 *
 * 规则（ADR-014）：
 * - 所有时间戳按 UTC 存储。
 * - 「属于哪一天」由本地日界决定，默认本地时间 04:00。
 * - 归属判定用半开区间 [start, end)。
 * - 换时区只影响 local_date 的折算，不改动原始时间戳。
 *
 * 半开区间与 UTC 存储的做法借鉴 temosy/devlog（MIT），见 THIRD_PARTY_NOTICES.md。
 */

export const DEFAULT_CUTOFF_HOUR = 4;

/** 本机时区（IANA 名，如 Asia/Shanghai）。取不到就返回 null。 */
export function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** 当前生效时区相对 UTC 的偏移，形如 +08:00。 */
export function utcOffsetLabel(date = new Date()) {
  const mins = -date.getTimezoneOffset();
  const sign = mins >= 0 ? '+' : '-';
  const abs = Math.abs(mins);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/**
 * 指定要用哪个时区跑。不传就用本机时区（默认行为）。
 *
 * 实现方式是设置 process.env.TZ —— Node 会让后续所有 Date 的本地时间行为
 * 都走这个时区，于是日界折算、归属日、会话时间戳解析全都自动一致，
 * 不需要把时区参数穿过每一个函数。
 *
 * @param {string|null|undefined} timeZone IANA 名，如 Asia/Shanghai
 * @returns {string|null} 实际生效的时区
 */
export function applyTimeZone(timeZone) {
  if (!timeZone) return systemTimeZone();
  try {
    // 非法名字必须立刻报错，不能静默退回 UTC 之类
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new Error(`无法识别的时区：${timeZone}\n请用 IANA 名字，例如 Asia/Shanghai、Asia/Tokyo、America/New_York、UTC。`);
  }
  process.env.TZ = timeZone;
  // 改 TZ 是否真的生效因运行时而异（ICU 在部分平台不读 TZ 环境变量）。
  // 用冬、夏两个时刻比对 Date 的偏移与 Intl 对该时区的偏移，不一致就明确报错 ——
  // 绝不能让用户以为在按 Asia/Shanghai 归属，实际却按系统时区在算。
  const probes = [new Date(Date.UTC(2026, 0, 15, 12)), new Date(Date.UTC(2026, 6, 15, 12))];
  const honored = probes.every((d) => -d.getTimezoneOffset() === offsetMinutesIn(timeZone, d));
  if (!honored) {
    const actual = systemTimeZone() ?? '系统时区';
    throw new Error(
      `当前运行环境不支持在运行时切换时区：要求 ${timeZone}，但 Date 仍按 ${actual} 计算。\n` +
        `请把系统时区设为 ${timeZone}，或去掉 --tz / config.json 里的 timezone（默认跟随本机）。`,
    );
  }
  return timeZone;
}

/**
 * 某时区在某一时刻相对 UTC 的偏移（分钟，东正西负）。
 * 用 Intl 直接算，不依赖 process.env.TZ，所以可以拿来核对 TZ 切换是否真的生效。
 * @param {string} timeZone IANA 名
 * @param {Date} [date]
 */
export function offsetMinutesIn(timeZone, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(date);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const m = name.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return 0; // 纯 "GMT" 即 UTC
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}


/** @param {Date} date @returns {string} 本地时区的 YYYY-MM-DD */
export function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 某个本地日期对应的 UTC 半开区间。
 * @param {string} localDate YYYY-MM-DD
 * @param {number} cutoffHour 本地日界小时，0-23
 * @returns {{localDate:string,startUtc:string,endUtc:string,timeZone:string|null}}
 */
export function dayRange(localDate, cutoffHour = DEFAULT_CUTOFF_HOUR) {
  const [y, m, d] = localDate.split('-').map(Number);
  if (!y || !m || !d) throw new Error(`日期格式应为 YYYY-MM-DD，收到：${localDate}`);
  // 走本地时间构造：生效时区由 applyTimeZone 决定（默认本机时区）。
  // 夏令时与月末溢出都由 Date 自己处理。
  const start = new Date(y, m - 1, d, cutoffHour, 0, 0, 0);
  const end = new Date(y, m - 1, d + 1, cutoffHour, 0, 0, 0);
  return { localDate, startUtc: start.toISOString(), endUtc: end.toISOString(), timeZone: systemTimeZone() };
}

/**
 * 某个瞬间属于哪个本地日期（按日界折算）。
 * @param {Date|string|number} instant
 * @param {number} cutoffHour
 * @returns {string|null} YYYY-MM-DD，无法解析时返回 null
 */
export function localDateOf(instant, cutoffHour = DEFAULT_CUTOFF_HOUR) {
  const t = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(t.getTime())) return null;
  return ymd(new Date(t.getTime() - cutoffHour * 3600_000));
}

/** 今天（按日界）。@param {number} cutoffHour @returns {string} */
export function todayLocalDate(cutoffHour = DEFAULT_CUTOFF_HOUR) {
  return localDateOf(new Date(), cutoffHour);
}

/**
 * 半开区间判定：start <= t < end。
 * @param {Date|string|number} instant
 * @param {string} startUtc
 * @param {string} endUtc
 */
export function inRange(instant, startUtc, endUtc) {
  const t = instant instanceof Date ? instant : new Date(instant);
  if (Number.isNaN(t.getTime())) return false;
  return t.getTime() >= Date.parse(startUtc) && t.getTime() < Date.parse(endUtc);
}

/**
 * 以 localDate 为最后一天的 N 天区间（默认 7 天），用于周报。
 * @param {string} localDate
 * @param {number} days
 * @param {number} cutoffHour
 */
export function multiDayRange(localDate, days = 7, cutoffHour = DEFAULT_CUTOFF_HOUR) {
  const [y, m, d] = localDate.split('-').map(Number);
  const first = ymd(new Date(y, m - 1, d - (days - 1)));
  const a = dayRange(first, cutoffHour);
  const b = dayRange(localDate, cutoffHour);
  return { localDate, startUtc: a.startUtc, endUtc: b.endUtc, days, timeZone: b.timeZone };
}

/** 把区间拆成逐日的 localDate 列表。 */
export function datesIn(range, cutoffHour = DEFAULT_CUTOFF_HOUR) {
  const out = [];
  let cursor = Date.parse(range.startUtc);
  const end = Date.parse(range.endUtc);
  while (cursor < end) {
    out.push(localDateOf(new Date(cursor + 3600_000), cutoffHour));
    cursor += 86_400_000;
  }
  return [...new Set(out)];
}


/** 本地时区的 HH:MM，用于日记里的时间段。解析失败返回 '--:--'。 */
export function hhmm(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
