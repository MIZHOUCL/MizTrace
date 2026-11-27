import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTimeZone, systemTimeZone, utcOffsetLabel, dayRange, localDateOf, offsetMinutesIn } from '../src/time.js';

const ORIGINAL_TZ = process.env.TZ;
function restore() {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
}

/**
 * 运行时改 process.env.TZ 在部分平台（例如 Windows 上的 ICU）不生效。
 * applyTimeZone 遇到这种情况会明确抛错；这里先探测一次，不支持就跳过依赖切换的用例，
 * 而不是让它们在那个平台上报一堆莫名其妙的时间差。探两个不同时区，避免恰好命中本机时区而误判为「支持」。
 */
const SWITCH_PROBLEM = (() => {
  try {
    applyTimeZone('Asia/Tokyo');
    applyTimeZone('America/New_York');
    return null;
  } catch (err) {
    return err.message.split('\n')[0];
  } finally {
    restore();
  }
})();
const SKIP = SWITCH_PROBLEM ? `当前运行时不支持切换时区，已由 applyTimeZone 明确报错：${SWITCH_PROBLEM}` : false;

test('不传时区时跟随本机，不改 TZ、不抛错', () => {
  const before = process.env.TZ;
  const tz = applyTimeZone(null);
  assert.equal(tz, systemTimeZone());
  // 名字长什么样由 ICU 决定：TZ=GMT 时它给的是「+00:00」而不是 IANA 名。程序只要求「拿得到、不抛」，这里也只断言这两点
  assert.ok(tz === null || (typeof tz === 'string' && tz.length > 0), `意外的时区值：${tz}`);
  assert.equal(process.env.TZ, before, '不传时区时不能碰 TZ');
});

test('非法时区名立刻报错，不静默退回 UTC', () => {
  assert.throws(() => applyTimeZone('Mars/Olympus_Mons'), /无法识别的时区/);
  assert.throws(() => applyTimeZone('UTC+8'), /无法识别的时区/);
  restore();
});

test('offsetMinutesIn 只靠 Intl 算偏移，不依赖 TZ 环境变量', () => {
  const winter = new Date('2026-01-15T00:00:00Z');
  const summer = new Date('2026-07-15T00:00:00Z');
  assert.equal(offsetMinutesIn('UTC', winter), 0);
  assert.equal(offsetMinutesIn('Asia/Shanghai', winter), 480);
  assert.equal(offsetMinutesIn('Asia/Kolkata', winter), 330, '半小时时区');
  assert.equal(offsetMinutesIn('America/New_York', winter), -300);
  assert.equal(offsetMinutesIn('America/New_York', summer), -240, '夏令时');
});

test('指定时区后日界折算随之改变', { skip: SKIP }, () => {
  try {
    applyTimeZone('UTC');
    const utc = dayRange('2026-09-04', 4);
    assert.equal(utc.startUtc, '2026-09-04T04:00:00.000Z', 'UTC 下日界 4 点就是 04:00Z');
    assert.equal(utc.timeZone, 'UTC');

    applyTimeZone('Asia/Shanghai');
    const sh = dayRange('2026-09-04', 4);
    assert.equal(sh.startUtc, '2026-09-03T20:00:00.000Z', 'UTC+8 下日界 4 点是前一天 20:00Z');
    assert.equal(sh.timeZone, 'Asia/Shanghai');
    assert.equal(utcOffsetLabel(new Date('2026-09-04T00:00:00Z')), '+08:00');

    applyTimeZone('Asia/Tokyo');
    assert.equal(dayRange('2026-09-04', 4).startUtc, '2026-09-03T19:00:00.000Z', 'UTC+9');
  } finally {
    restore();
  }
});

test('归属日按生效时区判定：同一瞬间在不同时区可能属于不同天', { skip: SKIP }, () => {
  try {
    // 2026-09-03T20:30:00Z：上海是 09-04 04:30（过了日界，算 09-04）
    applyTimeZone('Asia/Shanghai');
    assert.equal(localDateOf('2026-09-03T20:30:00.000Z', 4), '2026-09-04');
    // 同一瞬间在 UTC 是 09-03 20:30（还没到 09-04 的日界，算 09-03）
    applyTimeZone('UTC');
    assert.equal(localDateOf('2026-09-03T20:30:00.000Z', 4), '2026-09-03');
  } finally {
    restore();
  }
});

test('夏令时切换日的区间长度不是 24 小时', { skip: SKIP }, () => {
  try {
    applyTimeZone('America/New_York');
    // 2026-03-08 是美国东部夏令时开始日，当天只有 23 小时
    const spring = dayRange('2026-03-08', 0);
    const hours = (Date.parse(spring.endUtc) - Date.parse(spring.startUtc)) / 3_600_000;
    assert.equal(hours, 23, `夏令时开始日应为 23 小时，实际 ${hours}`);
    // 2026-11-01 是结束日，25 小时
    const fall = dayRange('2026-11-01', 0);
    const fallHours = (Date.parse(fall.endUtc) - Date.parse(fall.startUtc)) / 3_600_000;
    assert.equal(fallHours, 25, `夏令时结束日应为 25 小时，实际 ${fallHours}`);
  } finally {
    restore();
  }
});
