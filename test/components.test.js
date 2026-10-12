import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relativeDate, plural } from '../app/ui/components.js';

const now = new Date(2026, 9, 12, 15, 30); // 12 Oct 2026, 15:30 local
const daysAgo = (n, hour = 9) => new Date(2026, 9, 12 - n, hour);

test('relativeDate counts calendar days, not 24-hour spans', () => {
  assert.equal(relativeDate(new Date(2026, 9, 12, 0, 5), now), 'today');
  assert.equal(relativeDate(new Date(2026, 9, 11, 23, 55), now), 'yesterday');
  assert.equal(relativeDate(daysAgo(3), now), '3 days ago');
  assert.equal(relativeDate(daysAgo(6), now), '6 days ago');
});

test('relativeDate switches to weeks, then to a short date', () => {
  assert.equal(relativeDate(daysAgo(7), now), '1 week ago');
  assert.equal(relativeDate(daysAgo(14), now), '2 weeks ago');
  assert.equal(relativeDate(daysAgo(27), now), '3 weeks ago');
  const old = relativeDate(daysAgo(40), now);
  assert.ok(!/ago|today|yesterday/.test(old), old);
  assert.ok(/2/.test(old), old); // 2 September
  assert.ok(/2025/.test(relativeDate(new Date(2025, 0, 3), now)));
});

test('relativeDate takes ISO strings, treats the future as today, and passes null through', () => {
  assert.equal(relativeDate(new Date(2026, 9, 10, 12).toISOString(), now), '2 days ago');
  assert.equal(relativeDate(new Date(2026, 9, 13), now), 'today');
  assert.equal(relativeDate(null, now), null);
  assert.equal(relativeDate('not a date', now), null);
});

test('plural', () => {
  assert.equal(plural(1, 'bank'), '1 bank');
  assert.equal(plural(0, 'bank'), '0 banks');
  assert.equal(plural(12, 'question'), '12 questions');
});
