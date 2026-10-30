'use strict';
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
const arr = (value) => Array.isArray(value) ? value : [];
const name = (value) => typeof value === 'string' ? value : value?.name || value?.viewerName || value?.displayName || '';
function hypeDetails(award) {
  if (award.title !== 'Hype Engine' || typeof award.subject !== 'string' || !Number.isFinite(award.durationMs) || award.durationMs < 0) return '';
  const seconds = Math.floor(award.durationMs / 1000), minutes = Math.floor(seconds / 60);
  return `${award.subject} · ${minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`}`;
}
function imageSource(value) {
  if (!value) return '';
  try { const url = new URL(value, location.href); if (url.origin === location.origin && /^https?:$/.test(url.protocol)) return url.href; if (/^data:image\/(?:png|webp|jpeg);base64,[a-z0-9+/=]+$/i.test(value)) return value; } catch { /* Invalid URL. */ }
  return '';
}
async function load() {
  const error = document.querySelector('#public-error');
  try {
    const response = await fetch('/api/public', {credentials: 'same-origin'});
    if (!response.ok) throw new Error('The collection is temporarily unavailable.');
    const data = await response.json();
    const stickers = document.querySelector('#public-stickers'); stickers.replaceChildren();
    const items = arr(data.stickers).filter((item) => item.status === 'approved');
    if (!items.length) stickers.append(el('p', 'empty', 'Approved stickers will appear here.'));
    for (const item of items) {
      const card = el('article', 'public-sticker'), src = imageSource(item.imageUrl || item.image_url);
      if (src) { const image = el('img'); image.src = src; image.alt = item.name || 'Community sticker'; card.append(image); }
      card.append(el('h3', '', item.name || 'Community sticker'));
      const credits = arr(item.credits).map(name).filter(Boolean).join(', ');
      if (credits) card.append(el('p', '', `Inspired by ${credits}`));
      stickers.append(card);
    }
    const awards = document.querySelector('#public-awards'); awards.replaceChildren();
    if (!arr(data.awards).length) awards.append(el('p', 'empty', 'Crew awards will appear here after a stream.'));
    for (const item of arr(data.awards)) {
      const row = el('div', 'award'), body = el('div');
      body.append(el('strong', '', item.title || item.name || 'Award'));
      body.append(el('small', '', [hypeDetails(item), arr(item.recipients).map(name).filter(Boolean).join(', '), item.date].filter(Boolean).join(' · ')));
      row.append(el('span', 'large-icon', '✦'), body); awards.append(row);
    }
    error.hidden = true;
  } catch (exception) { error.textContent = exception.message; error.hidden = false; }
}
load(); setInterval(load, 10000);
