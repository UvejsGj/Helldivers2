/** Presentation helpers. Everything here is pure and display-only. */

const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 });
const FULL = new Intl.NumberFormat('en-US');

/** 1,204,553 */
export const full = (n) => FULL.format(Math.round(Number(n) || 0));

/** 1.2M — for headline figures where the exact digits are noise. */
export const compact = (n) => COMPACT.format(Number(n) || 0);

/** 61.4% */
export const percent = (n, digits = 1) => `${(Number(n) || 0).toFixed(digits)}%`;

/**
 * A countdown as D:HH:MM:SS, or "EXPIRED".
 * `ms` is a duration, not a timestamp.
 */
export function countdown(ms) {
  if (!Number.isFinite(ms)) return '--:--:--';
  if (ms <= 0) return 'EXPIRED';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return days > 0
    ? `${days}D ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** "4h ago", "just now" — for the dispatch feed and freshness readouts. */
export function relativeTime(epoch) {
  if (!epoch) return 'unknown';
  const delta = Date.now() - epoch;
  if (delta < 0) return 'incoming';
  const seconds = Math.floor(delta / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(epoch).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Absolute timestamp, in the viewer's locale. */
export function timestamp(epoch) {
  if (!epoch) return '—';
  return new Date(epoch).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Seconds of playtime as a human-scale figure. */
export function duration(seconds) {
  const s = Number(seconds) || 0;
  const years = s / (365.25 * 86400);
  if (years >= 1) return `${compact(years)} years`;
  const days = s / 86400;
  if (days >= 1) return `${compact(days)} days`;
  return `${compact(s / 3600)} hours`;
}

/** Escape untrusted text before it goes anywhere near innerHTML. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Dispatches arrive with in-game markup: <i=1>…</i> and <i=3>…</i> highlight
 * terms, and the feed is plain text otherwise. Escape everything first, then
 * re-introduce only the tags we actually support.
 */
export function formatDispatch(message) {
  const escaped = escapeHtml(message);
  return escaped
    .replace(/&lt;i=(\d)&gt;/g, (_, level) => `<em class="dispatch-em dispatch-em--${level}">`)
    .replace(/&lt;\/i&gt;/g, '</em>')
    .replace(/\r?\n/g, '<br>');
}
