import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isoSeconds, parseISO } from '../app/engine/dates.js';

test('isoSeconds writes whole seconds with a Z', () => {
  assert.equal(isoSeconds(new Date('2026-09-02T14:36:12Z')), '2026-09-02T14:36:12Z');
});

test('isoSeconds truncates milliseconds rather than rounding', () => {
  assert.equal(isoSeconds(new Date('2026-09-02T14:36:12.999Z')), '2026-09-02T14:36:12Z');
});

test('isoSeconds refuses an invalid date', () => {
  assert.throws(() => isoSeconds(new Date(NaN)));
});

test('parseISO reads what the Mac writes', () => {
  assert.equal(parseISO('2026-09-02T14:36:12Z').getTime(), Date.UTC(2026, 8, 2, 14, 36, 12));
});

test('parseISO reads an offset', () => {
  assert.equal(parseISO('2026-09-02T16:36:12+02:00').getTime(), Date.UTC(2026, 8, 2, 14, 36, 12));
});

test('parseISO refuses what is not an ISO-8601 date-time', () => {
  for (const bad of ['', 'yesterday', '2026-09-02', '2026-09-02 14:36:12Z', '2026-13-02T14:36:12Z', 5]) {
    assert.throws(() => parseISO(bad), undefined, String(bad));
  }
});

test('a date survives a round trip at whole-second precision', () => {
  const d = new Date(1_700_000_000_000);
  assert.deepEqual(parseISO(isoSeconds(d)), d);
});
