/**
 * High Command bulletins — the game's Steam patch notes.
 *
 * Posts arrive as Steam markup, which normalize.js has already reduced to plain
 * text; all this does is escape it and turn blank lines and bullet marks back
 * into structure. Nothing from the feed reaches the DOM as markup.
 */

import { state, subscribe } from '../state.js';
import { escapeHtml, relativeTime, timestamp } from '../format.js';

const root = document.getElementById('bulletin-feed');
const MAX_ITEMS = 12;
let signature = null;

function render() {
  if (!root) return;
  const posts = state.bulletins.slice(0, MAX_ITEMS);

  // Rebuilding on every poll would collapse whatever the reader had expanded.
  const next = posts.map((p) => p.id).join(',');
  if (next === signature) {
    updateAges();
    return;
  }
  signature = next;

  if (!posts.length) {
    root.innerHTML = `
      <li class="panel__empty">
        <p>${state.sources.steam && !state.sources.steam.ok
          ? 'Bulletin archive unreachable.'
          : 'No bulletins on record.'}</p>
      </li>`;
    return;
  }

  root.innerHTML = posts.map((post, i) => `
    <li class="bulletin">
      <details ${i === 0 ? 'open' : ''}>
        <summary class="bulletin__head">
          <span class="bulletin__title">${escapeHtml(post.title)}</span>
          <time class="bulletin__time mono" data-epoch="${post.published || ''}"
                title="${timestamp(post.published)}">${relativeTime(post.published)}</time>
        </summary>
        <div class="bulletin__body">${paragraphs(post.content)}</div>
        ${post.url ? `<a class="bulletin__link" href="${escapeHtml(post.url)}"
              target="_blank" rel="noopener">Read in full ↗</a>` : ''}
      </details>
    </li>`).join('');
}

/** Blank lines become paragraphs; leading bullets keep their hanging indent. */
function paragraphs(text) {
  const blocks = String(text || '').split(/\n{2,}/).filter(Boolean);
  if (!blocks.length) return '<p class="bulletin__line">No detail provided.</p>';
  return blocks.map((block) => {
    const lines = block.split('\n').map((line) => escapeHtml(line.trim())).filter(Boolean);
    const bulleted = lines.every((line) => line.startsWith('•'));
    if (bulleted) {
      return `<ul class="bulletin__list">${lines
        .map((line) => `<li>${line.replace(/^•\s*/, '')}</li>`).join('')}</ul>`;
    }
    return `<p class="bulletin__line">${lines.join('<br>')}</p>`;
  }).join('');
}

function updateAges() {
  if (!root) return;
  for (const node of root.querySelectorAll('[data-epoch]')) {
    const epoch = Number(node.dataset.epoch);
    if (epoch) node.textContent = relativeTime(epoch);
  }
}

export function initBulletins() {
  if (!root) return;
  subscribe(render);
  render();
  setInterval(updateAges, 60_000);
}
