'use strict';
const card = document.querySelector('#overlay-card');
const token = new URLSearchParams(location.search).get('token') || '';
let shown = '';
let hideTimer;
const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
function name(value) { return typeof value === 'string' ? value : value?.name || value?.viewerName || value?.displayName || ''; }
function hypeDetails(award) {
  if (award.title !== 'Hype Engine' || typeof award.subject !== 'string' || !Number.isFinite(award.durationMs) || award.durationMs < 0) return '';
  const seconds = Math.floor(award.durationMs / 1000), minutes = Math.floor(seconds / 60);
  return `${award.subject} · ${minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`}`;
}
function safeImage(value) {
  if (!value) return '';
  try { const url = new URL(value, location.href); if (url.origin === location.origin && /^https?:$/.test(url.protocol)) return url.href; if (/^data:image\/(?:png|webp|jpeg);base64,[a-z0-9+/=]+$/i.test(value)) return value; } catch { /* Invalid URL. */ }
  return '';
}
async function poll() {
  if (!token) return;
  try {
    const response = await fetch(`/api/overlay?token=${encodeURIComponent(token)}`, {cache:'no-store'});
    if (!response.ok) { card.classList.remove('visible'); return; }
    const result = await response.json();
    const event = result.event;
    if (!event) { card.classList.remove('visible'); return; }
    const eventId = String(event.id || event.eventId || JSON.stringify(event));
    if (eventId === shown) return;
    shown = eventId; card.replaceChildren(); clearTimeout(hideTimer);
    if (event.type === 'sticker') {
      const src = safeImage(event.imageUrl || event.image_url);
      if (src) { const img = el('img'); img.src = src; img.alt = event.name || 'Sticker'; card.append(img); }
      card.append(el('h1', '', event.name || 'Community sticker'));
    } else if (event.type === 'awards' || event.type === 'wrap') {
      card.append(el('h1', '', 'Tonight’s crew ✦'));
      for (const award of Array.isArray(event.awards) ? event.awards : []) {
        const names = (Array.isArray(award.recipients) ? award.recipients : []).map(name).filter(Boolean);
        const isLoyalty = award.title === 'Night Owl' || award.title === 'Day One';
        const recipients = isLoyalty && names.length > 5 ? `${names.slice(0, 5).join(', ')} +${names.length - 5} more` : names.join(', ');
        const details = hypeDetails(award);
        card.append(el('p', '', `${award.title || award.name || 'Award'}${details ? ` (${details})` : ''}: ${recipients}`));
      }
    } else return;
    card.classList.add('visible');
    hideTimer = setTimeout(() => card.classList.remove('visible'), Math.max(1000, Math.min(Number(event.durationMs) || 6000, 30000)));
  } catch { card.classList.remove('visible'); }
}
poll(); setInterval(poll, 1000);
