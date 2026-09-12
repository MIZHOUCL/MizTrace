import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayRange, localDateOf, inRange, multiDayRange, ymd } from '../src/time.js';

test('dayRange 是半开区间，且长度为一天', () => {
  const r = dayRange('2026-09-03', 4);
  const span = Date.parse(r.endUtc) - Date.parse(r.startUtc);
  // 夏令时切换日会是 23 或 25 小时，其余为 24
  assert.ok([23, 24, 25].includes(span / 3_600_000), `span=${span / 3_600_000}h`);
  assert.equal(r.localDate, '2026-09-03');
});

test('日界之前的时刻算前一天', () => {
  // 本地 02:30，日界 04:00 => 归到前一天
  const local = new Date(2026, 8, 3, 2, 30, 0);
  assert.equal(localDateOf(local, 4), '2026-09-02');
});

test('日界之后的时刻算当天', () => {
  const local = new Date(2026, 8, 3, 4, 0, 0);
  assert.equal(localDateOf(local, 4), '2026-09-03');
  const later = new Date(2026, 8, 3, 23, 59, 0);
  assert.equal(localDateOf(later, 4), '2026-09-03');
});

test('日界为 0 时等价于自然日', () => {
  const local = new Date(2026, 8, 3, 0, 1, 0);
  assert.equal(localDateOf(local, 0), '2026-09-03');
});

test('区间端点：start 含，end 不含', () => {
  const r = dayRange('2026-09-03', 4);
  assert.equal(inRange(r.startUtc, r.startUtc, r.endUtc), true);
  assert.equal(inRange(r.endUtc, r.startUtc, r.endUtc), false);
});

test('无法解析的时间不落在任何区间内', () => {
  const r = dayRange('2026-09-03', 4);
  assert.equal(inRange('not-a-date', r.startUtc, r.endUtc), false);
  assert.equal(localDateOf('not-a-date', 4), null);
});

test('multiDayRange 覆盖 7 天且以指定日结尾', () => {
  const r = multiDayRange('2026-09-03', 7, 4);
  const days = (Date.parse(r.endUtc) - Date.parse(r.startUtc)) / 86_400_000;
  assert.ok(days >= 6.9 && days <= 7.1, `days=${days}`);
  assert.equal(r.endUtc, dayRange('2026-09-03', 4).endUtc);
});

test('月末与年末溢出由 Date 处理', () => {
  assert.equal(dayRange('2026-01-31', 4).endUtc, dayRange('2026-02-01', 4).startUtc);
  assert.equal(dayRange('2026-12-31', 4).endUtc, dayRange('2027-01-01', 4).startUtc);
  assert.equal(ymd(new Date(2026, 0, 5)), '2026-01-05');
});
