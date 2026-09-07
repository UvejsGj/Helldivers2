/** Formatting and escaping. The escaping tests are the security-relevant ones. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  compact, countdown, duration, escapeHtml, formatDispatch, full, percent, relativeTime,
} from '../js/format.js';

test('countdown renders days only when there are days', () => {
  assert.equal(countdown(3 * 3600_000 + 25 * 60_000 + 6000), '03:25:06');
  assert.equal(countdown(26 * 3600_000), '1D 02:00:00');
  assert.equal(countdown(0), 'EXPIRED');
  assert.equal(countdown(-5), 'EXPIRED');
  assert.equal(countdown(NaN), '--:--:--');
});

test('number formatting', () => {
  assert.equal(full(1234567), '1,234,567');
  assert.equal(full(undefined), '0');
  assert.equal(compact(74_000_000_000), '74B');
  assert.equal(percent(37.456), '37.5%');
  assert.equal(percent(37.456, 0), '37%');
});

test('duration scales to the largest sensible unit', () => {
  assert.match(duration(3600), /hours/);
  assert.match(duration(5 * 86400), /days/);
  assert.match(duration(3 * 365.25 * 86400), /years/);
});

test('relativeTime handles the near and far past', () => {
  assert.equal(relativeTime(Date.now() - 5000), 'just now');
  assert.equal(relativeTime(Date.now() - 5 * 60_000), '5m ago');
  assert.equal(relativeTime(Date.now() - 3 * 3600_000), '3h ago');
  assert.equal(relativeTime(null), 'unknown');
});

test('escapeHtml neutralises every delimiter', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'),
    '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
});

test('formatDispatch escapes first and only then re-adds the markup it allows', () => {
  // Dispatch text is API-supplied, so this is the boundary that matters.
  assert.equal(formatDispatch('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(formatDispatch('<script>alert(1)</script>'),
    '&lt;script&gt;alert(1)&lt;/script&gt;');

  const mixed = formatDispatch('<i=1>Bold</i> and <b onclick="x">raw</b>');
  assert.match(mixed, /<em class="dispatch-em dispatch-em--1">Bold<\/em>/);
  // The <b> and its handler survive only as inert text. Asserting the escaped
  // form is the real check: the substring "onclick=" is still *present*, it is
  // just no longer an attribute, so asserting its absence would test nothing.
  assert.ok(mixed.includes('&lt;b onclick=&quot;x&quot;&gt;'), 'the raw tag is escaped whole');
  assert.ok(!/<b[\s>]/.test(mixed), 'no live tag survives except the em we inserted');
  assert.equal((mixed.match(/</g) || []).length, (mixed.match(/<\/?em[ >]/g) || []).length,
    'every remaining < belongs to an em tag we inserted');
});

test('formatDispatch turns newlines into breaks', () => {
  assert.equal(formatDispatch('a\nb'), 'a<br>b');
});
