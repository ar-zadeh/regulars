'use strict';

const $ = (selector) => document.querySelector(selector);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
};
const arr = (value) => Array.isArray(value) ? value : [];
const pick = (...values) => values.find((value) => value !== undefined && value !== null && value !== '') ?? '';
let selected = new Set();
let searchMessages = [];
let lastState = {};
let busy = false;
const editedBriefs = new Map();
const expandedNudges = new Set();
const expandedMessages = new Set();
let settingsLoaded = false;
let searchSequence = 0;
let connectingTwitch = false;
let currentView = 'live';
let stickerStep = 'subject';
let dockSubjectKey = '';
let dockMessageId = '';
let renderedDockMessageId = '';
let dockSessionKey = null;
let dismissedMessages = new Set();
let lastDockDismissal = null;
let lastDockCommand = null;
let dockSection = 'chat';
let communityMemberId = '';
let communityActionPending = false;
const DOCK_HOLD_MS = 600;
let heldDockKey = null;
let liveTopicMetadata = [];
const dockTopicNodes = new Map();
const communityNodes = new Map();
const messageLabel = item => item ? pick(item.topic, arr(lastState.subjects).find(subject =>
  String(subject.id) === String(pick(item.subjectId, item.subject_id)))?.name, item.about) : '';
const dockTopicKey = name => `topic:${name.trim().replace(/\s+/g, ' ').toLocaleLowerCase()}`;
let nudgeCursor = 0;
let currentNudgeId = '';
let nudgeRenderKey = '';
function showNudgePage() {
  const list = $('#nudge-list');
  const nudges = arr(lastState.nudges);
  const previous = nudges.findIndex(item => String(item?.id || '') === currentNudgeId);
  if (currentNudgeId && previous >= 0) nudgeCursor = previous;
  nudgeCursor = Math.max(0, Math.min(nudgeCursor, nudges.length - 1));
  const nudge = nudges[nudgeCursor];
  currentNudgeId = String(nudge?.id || '');
  const linked = nudge?.message_id ? arr(lastState.messages).find(item => idOf(item) === String(nudge.message_id)) : null;
  const key = JSON.stringify([nudge || null, linked ? [idOf(linked), linked.text, nameOf(linked)] : null, !nudge && !!lastState.nudgesPaused]);
  // Unrelated queue updates leave the visible reminder and its focused controls intact.
  if (key !== nudgeRenderKey) {
    nudgeRenderKey = key;
    clear(list);
    if (!nudge) empty(list, lastState.nudgesPaused ? 'Reminders paused for this stream.' : 'No reminders right now.');
    else {
      const card = el('div', 'nudge');
      const nudgeText = String(typeof nudge === 'string' ? nudge : pick(nudge.text, nudge.message)).replace(/\s*Give it a quick (?:answer|welcome) when you can\./g, '');
      const arrival = nudgeText.match(/^(.+?) is (?:back after missing \d+ streams|here \([^)]+\))\./);
      const viewer = linked ? nameOf(linked) : arrival?.[1] || '';
      const brief = viewer && nudgeText.includes(`${viewer} asked a question.`) ? `${viewer} · Question` : viewer && nudgeText.includes(`${viewer} sent a first message.`) ? `${viewer} · First message` : arrival ? `${viewer} · ${nudgeText.includes(' is back after missing ') ? 'Returned' : 'Regular'}` : nudgeText;
      card.append(el('div', 'nudge-text', brief));
      if (nudge && typeof nudge === 'object' && nudge.id) {
        const actions = el('div', 'nudge-actions');
        for (const [label, action] of [['Done', 'done'], ['Dismiss', 'dismiss']])
          actions.append(button(label, () => act(() => post(`/api/nudges/${encodeURIComponent(nudge.id)}/action`, {action}), `${label} saved.`), 'button subtle'));
        card.append(actions);
      }
      if (nudge && typeof nudge === 'object' && nudge.message_id) {
        const hasContext = linked && typeof linked.text === 'string' && linked.text.trim();
        const content = hasContext ? linked.text : '';
        const contentChars = Array.from(content);
        const long = contentChars.length > 80;
        let preview = contentChars.slice(0, 80).join('').trimEnd();
        // Prefer a word boundary, while keeping unbroken strings strictly bounded.
        if (long && !/\s/u.test(contentChars[79]) && !/\s/u.test(contentChars[80])) {
          const boundary = preview.search(/\s+\S*$/u);
          if (boundary >= 40) preview = preview.slice(0, boundary);
        }
        card.append(el('div', hasContext ? 'nudge-context' : 'nudge-missing', hasContext ? (long ? preview + '…' : content) : 'Original message unavailable'));
        if (long) {
          const full = el('details', 'nudge-full');
          full.append(el('summary', '', 'Read full message'), el('div', '', content));
          const id = String(nudge.id || '');
          full.open = expandedMessages.has(id);
          full.addEventListener('toggle', () => { if (full.open) expandedMessages.add(id); else expandedMessages.delete(id); });
          card.append(full);
        }
      }
      if (nudge && typeof nudge === 'object' && nudge.id) {
        const more = el('details', 'nudge-more');
        more.append(el('summary', '', 'More'));
        if (brief !== nudgeText) more.append(el('div', '', nudgeText));
        more.append(button('Mute reminders', () => {
          if (confirm('Mute reminders for this viewer in future streams? This cannot be undone here.'))
            act(() => post(`/api/nudges/${encodeURIComponent(nudge.id)}/action`, {action: 'mute'}), 'Viewer muted.');
        }, 'button subtle'));
        const id = String(nudge.id);
        more.open = expandedNudges.has(id);
        more.addEventListener('toggle', () => { if (more.open) expandedNudges.add(id); else expandedNudges.delete(id); });
        card.append(more);
      }
      list.append(card);
    }
  }
  $('#nudge-queue').hidden = nudges.length < 2;
  $('#nudge-position').textContent = nudges.length ? `${nudgeCursor + 1} / ${nudges.length} reminders` : '';
  $('#nudge-prev').disabled = nudgeCursor <= 0;
  $('#nudge-next').disabled = nudgeCursor >= nudges.length - 1;
  updateCommunitySelection();
}
$('#nudge-prev').addEventListener('click', () => { nudgeCursor--; currentNudgeId = ''; showNudgePage(); });
$('#nudge-next').addEventListener('click', () => { nudgeCursor++; currentNudgeId = ''; showNudgePage(); });

const views = ['live', 'stickers', 'review', 'awards', 'settings'];
function showView(name) {
  if (!views.includes(name)) return;
  cancelDockHold();
  message('');
  currentView = name;
  if (name === 'stickers') { searchSequence++; setStickerStep('subject'); }
  for (const view of views) {
    const active = view === name;
    $(`#view-${view}`).hidden = !active;
    $(`#nav-${view}`).classList.toggle('active', active);
    $(`#nav-${view}`).setAttribute('aria-current', active ? 'page' : 'false');
  }
  $(`#heading-${name}`).focus?.({preventScroll: true});
  globalThis.scrollTo?.({top: 0, behavior: 'auto'});
}
for (const view of views) $(`#nav-${view}`).addEventListener('click', () => showView(view));
$('#open-review').addEventListener('click', () => showView('review'));
$('#open-stickers').addEventListener('click', () => showView('stickers'));

function setStickerStep(step) {
  stickerStep = step;
  $('#sticker-subject-step').hidden = step !== 'subject';
  $('#sticker-manual-step').hidden = step !== 'manual';
  $('#sticker-editor').hidden = !['manual', 'editor'].includes(step);
  $('#sticker-back').hidden = step === 'subject';
  // Search results belong to subject search; manual selection has its own list.
  $('#search-results').hidden = step === 'manual';
  $('#search-status').hidden = step === 'manual';
}
$('#sticker-manual').addEventListener('click', () => {
  searchSequence++;
  searchMessages = [];
  selected = new Set();
  $('#sticker-subject').value = 'Chat moment';
  setStickerStep('manual');
  renderRecentMessages();
  renderSearch();
});
$('#sticker-back').addEventListener('click', () => {
  searchSequence++;
  setStickerStep('subject');
});

function updateCommunitySelection() {
  for (const [id, entry] of communityNodes)
    entry.button.setAttribute('aria-pressed', String(dockSection === 'community' && id === communityMemberId));
}
function renderCommunity() {
  const members = new Map();
  const typeOrder = ['Hype Engine','Night Owl','Day One','Regular'];
  for (const person of arr(lastState.community)) {
    const id = String(pick(person.id, person.viewerId, person.viewer_id));
    const types = arr(person.types).filter(type => type && typeOrder.includes(type.label))
      .sort((a,b) => typeOrder.indexOf(a.label) - typeOrder.indexOf(b.label));
    if (id && types.length) members.set(id, {name:nameOf(person), status:types[0].label, types, nudge:null});
  }
  for (const person of arr(lastState.presence)) {
    const id = String(pick(person.id, person.viewerId, person.viewer_id));
    if (id && !members.has(id)) members.set(id, {name:nameOf(person), status:'Regular', types:[], nudge:null});
  }
  for (const nudge of arr(lastState.nudges)) {
    if (!nudge || typeof nudge !== 'object' || !nudge.id) continue;
    const id = String(pick(nudge.viewer_id, nudge.viewerId, nudge.id));
    const linked = arr(lastState.messages).find(item => idOf(item) === String(nudge.message_id || ''));
    const text = String(pick(nudge.text, nudge.message));
    const suppliedName = text.match(/^(.+?) (?:is here\b|is back\b|asked a question\b|sent a first message\b|has chosen to lurk\b)/)?.[1];
    const known = members.get(id);
    const name = known?.name || (linked ? nameOf(linked) : pick(nudge.viewerName, suppliedName, 'Viewer'));
    const status = /asked a question\./.test(text) ? 'Question' : /is back after missing/.test(text) ? 'Returned' : /sent a first message\./.test(text) ? 'First chat' : /is here\b/.test(text) ? 'Say hi' : /has chosen to lurk\b/.test(text) ? 'Quiet mode' : 'Reminder';
    if (!known?.nudge) members.set(id, {name,status,types:known?.types || [],nudge});
  }
  for (const [id, entry] of communityNodes) if (!members.has(id)) { entry.button.remove(); communityNodes.delete(id); }
  for (const [id, member] of members) {
    let entry = communityNodes.get(id);
    if (!entry) {
      const node = button('', () => {
        const current = communityNodes.get(id);
        if (!current) return;
        communityMemberId = id;
        setDockSection('community');
      }, 'dock-topic community-chip');
      const label = el('span','dock-topic-name');
      const badge = el('span','community-badge');
      node.append(label,badge);
      entry = {button:node,label,badge,nudgeId:''};communityNodes.set(id,entry);
      $('#community-chip-list').append(node);
    }
    entry.nudgeId = String(member.nudge?.id || '');
    entry.member = member;
    entry.label.textContent = member.name;
    const primaryType = member.types.find(type => type.label === member.status);
    const primaryLabel = primaryType?.provisional ? `${member.status} · live` : member.status;
    const extraTypes = member.types.filter(type => type.label !== member.status && type.label !== 'Regular');
    entry.badge.textContent = primaryLabel + (extraTypes.length ? ` +${extraTypes.length}` : '');
    entry.badge.hidden = false;
    entry.button.disabled = false;
    const allLabels = [primaryLabel,...extraTypes.map(type => type.provisional ? `${type.label} · live` : type.label)].join(', ');
    entry.button.setAttribute('aria-label', `${member.name}, ${allLabels}, view community detail`);
    entry.button.setAttribute('title', `${member.name} · ${allLabels}`);
  }
  $('#community-empty').hidden = members.size > 0;
  if (!communityNodes.has(communityMemberId)) communityMemberId = [...communityNodes.keys()][0] || '';
  updateCommunitySelection();
}
$('#community-reminders').addEventListener('toggle', updateCommunitySelection);

function setDockSection(section) {
  dockSection = section;
  $('#community-reminders').open = false;
  renderDock();
  if (section === 'community') revealCommunityMember();
}
function revealCommunityMember() {
  communityNodes.get(communityMemberId)?.button.scrollIntoView?.({block:'nearest',inline:'nearest'});
}
function renderCommunityReader() {
  const ids = [...communityNodes.keys()];
  const entry = communityNodes.get(communityMemberId);
  const member = entry?.member;
  const linked = member?.nudge?.message_id ? arr(lastState.messages).find(item => idOf(item) === String(member.nudge.message_id)) : null;
  const prompts = {'Regular':'A regular is here.', 'Say hi':'Say a quick hello.', 'Returned':'Welcome them back.', 'First chat':'Welcome their first message.', 'Quiet mode':'Quiet mode is on.', 'Reminder':'A private reminder.'};
  const primaryType = member?.types.find(type => type.label === member.status);
  const text = linked?.text || (member?.status === 'Question' ? 'Original question unavailable.' : primaryType?.detail || prompts[member?.status] || '');
  $('#dock-subject-name').textContent = member ? `Community · ${member.status}${primaryType?.provisional ? ' · live' : ''}` : 'Community';
  const extras = arr(member?.types).filter(type => type.label !== member.status && type.label !== 'Regular');
  const typeList = $('#dock-community-types');
  const typeText = extras.map(type => type.label + (type.provisional ? ' · live' : '')).join(' · ');
  typeList.textContent = typeText;
  typeList.hidden = !extras.length;
  typeList.setAttribute('title', extras.map(type => type.detail).filter(Boolean).join('\n'));
  $('#dock-subject-position').textContent = '';
  $('#dock-message-author').textContent = member?.name || '';
  $('#dock-message-author').hidden = !member;
  renderMessageLabel(messageLabel(linked));
  $('#dock-message-text').textContent = text;
  $('#dock-message-text').hidden = !member;
  $('#dock-message-empty').hidden = !!member;
  $('#dock-message-empty').textContent = 'No community updates';
  $('#dock-message-position').textContent = member ? `${ids.indexOf(communityMemberId) + 1} / ${ids.length}` : '';
  $('#dock-message-dismiss').disabled = !entry?.nudgeId || communityActionPending;
  $('#dock-dismiss-label').textContent = entry?.nudgeId ? 'Dismiss' : 'No reminder';
  $('#dock-message-dismiss').setAttribute('aria-label', 'Dismiss current private reminder');
  $('#dock-subject-prev').disabled = ids.length < 2;
  $('#dock-subject-next').disabled = ids.length < 2;
  $('#dock-dismiss-undo').hidden = true;
  if (entry?.nudgeId) { currentNudgeId = entry.nudgeId; showNudgePage(); }
  const renderId = `community:${communityMemberId}:${entry?.nudgeId || ''}`;
  if (renderedDockMessageId !== renderId) $('.dock-message').scrollTop = 0;
  renderedDockMessageId = renderId;
}
function moveDockItem(direction) {
  if (dockSection === 'chat') return moveDockSubject(direction);
  const ids = [...communityNodes.keys()];
  if (!ids.length) return;
  const index = Math.max(0, ids.indexOf(communityMemberId));
  communityMemberId = ids[(index + direction + ids.length) % ids.length];
  renderDock();
  revealCommunityMember();
}
function dismissDockItem() {
  if (dockSection === 'chat') return dismissDockMessage();
  const entry = communityNodes.get(communityMemberId);
  if (!entry?.nudgeId || communityActionPending) return;
  const id = entry.nudgeId;
  communityActionPending = true;
  renderDock();
  act(() => post(`/api/nudges/${encodeURIComponent(id)}/action`, {action:'dismiss'}), '')
    .finally(() => { communityActionPending = false; renderDock(); });
}
$('#dock-section-chat').addEventListener('click', () => setDockSection('chat'));
$('#dock-section-community').addEventListener('click', () => setDockSection('community'));

function persistDockDismissals() {
  try { globalThis.localStorage?.setItem('regulars-dock-dismissed', JSON.stringify({session: dockSessionKey, ids: [...dismissedMessages].slice(-10000)})); }
  catch { /* The dock also works when local storage is unavailable. */ }
}
function syncDockSession() {
  const session = String(lastState.session?.id || '');
  if (session === dockSessionKey) return;
  dockSessionKey = session;
  dismissedMessages = new Set();
  dockSubjectKey = ''; dockMessageId = ''; lastDockDismissal = null;
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem('regulars-dock-dismissed') || 'null');
    if (saved?.session === session && Array.isArray(saved.ids))
      dismissedMessages = new Set(saved.ids.filter(id => typeof id === 'string').slice(-10000));
  } catch { /* Ignore corrupt or disabled local storage. */ }
}
function dockGroups({includeDismissed = false} = {}) {
  const subjects = new Map(arr(lastState.subjects).map(subject => [String(subject.id), subject]));
  const groups = new Map();
  for (const item of arr(lastState.messages)) {
    const id = idOf(item), text = String(pick(item.text, item.message));
    if (!id || item.topicEligible === false || item.selectable === false || !text.trim() || text.startsWith('!') || (!includeDismissed && dismissedMessages.has(id))) continue;
    const subject = subjects.get(String(pick(item.subjectId, item.subject_id)));
    const name = subject ? String(pick(subject.name, 'Chat')) : 'Ungrouped';
    const key = subject ? dockTopicKey(name) : 'ungrouped';
    if (!groups.has(key)) groups.set(key, {key, name, messages: []});
    groups.get(key).messages.push(item);
  }
  for (const group of groups.values()) group.messages.sort((a,b) =>
    Number(b.category === 'question') - Number(a.category === 'question') ||
    (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0));
  const order = new Map();
  for (const key of [...dockTopicNodes.keys(), ...liveTopicMetadata.map(topic => dockTopicKey(topic.name)), 'ungrouped'])
    if (!order.has(key)) order.set(key, order.size);
  return [...groups.values()].sort((a,b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity));
}
function selectDockSubject(key) {
  if (!dockGroups().some(group => group.key === key)) return;
  dockSection = 'chat';
  $('#community-reminders').open = false;
  updateCommunitySelection();
  if (dockSubjectKey !== key) dockMessageId = '';
  dockSubjectKey = key;
  renderDock();
}
function renderDockTopics(groups) {
  const allGroups = dockGroups({includeDismissed:true});
  const names = new Map(liveTopicMetadata.map(topic => [dockTopicKey(topic.name), topic.name]));
  for (const group of allGroups) if (!names.has(group.key)) names.set(group.key, group.name);
  const ungroupedCount = allGroups.find(group => group.key === 'ungrouped')?.messages.length || 0;
  $('#dock-section-chat').textContent = 'Chat topics';
  $('#ungrouped-overview').hidden = !ungroupedCount;
  $('#ungrouped-overview').textContent = `${ungroupedCount} ungrouped${liveTopicMetadata.length ? ' · ' : ''}`;
  $('#topic-overview').hidden = ungroupedCount > 0 && !liveTopicMetadata.length;
  const pending = new Map(groups.map(group => [group.key, group.messages.length]));
  for (const [key, entry] of dockTopicNodes) {
    if (!names.has(key)) { entry.button.remove(); dockTopicNodes.delete(key); }
  }
  // Preserve existing controls while polling; new topics append without moving
  // a button that the streamer may already be targeting.
  for (const [key, name] of names) {
    let entry = dockTopicNodes.get(key);
    if (!entry) {
      const node = button('', () => selectDockSubject(key), 'dock-topic');
      const label = el('span', 'dock-topic-name', name);
      const count = el('span', 'dock-topic-count');
      node.append(label, count);
      node.setAttribute('data-subject-key', key);
      entry = {button:node, label, count}; dockTopicNodes.set(key,entry);
      $('#dock-topic-list').append(node);
    }
    const remaining = pending.get(key) || 0;
    entry.label.textContent = name;
    entry.count.textContent = remaining ? String(remaining) : '✓';
    entry.button.disabled = !remaining;
    entry.button.setAttribute('aria-pressed', String(dockSection === 'chat' && remaining > 0 && key === dockSubjectKey));
    entry.button.setAttribute('aria-label', `${name}, ${remaining ? `${remaining} queued ${remaining === 1 ? 'message' : 'messages'}` : 'caught up'}`);
    entry.button.classList.toggle('is-complete', !remaining);
  }
  $('#dock-topics-empty').hidden = names.size > 0;
}
function renderMessageLabel(label) {
  const badge = $('#dock-message-category');
  badge.hidden = !label;
  badge.textContent = label || '';
  badge.setAttribute('aria-label', label ? `Message topic: ${label}` : '');
}
function renderDock() {
  syncDockSession();
  const groups = dockGroups();
  const community = dockSection === 'community';
  $('#dock-section-chat').setAttribute('aria-pressed', String(!community));
  $('#dock-section-community').setAttribute('aria-pressed', String(community));
  $('#dock-message-stage').classList.toggle('community-reader', community);
  $('#dock-message-stage').setAttribute('aria-label', community ? 'Current community update' : 'Current chat message');
  $('#dock-prev-label').textContent = community ? 'Previous person' : 'Previous group';
  $('#dock-next-label').textContent = community ? 'Next person' : 'Next group';
  $('#dock-subject-prev').setAttribute('aria-label', community ? 'Previous person' : 'Previous group');
  $('#dock-subject-next').setAttribute('aria-label', community ? 'Next person' : 'Next group');
  $('#dock-keyboard-hint').textContent = `Hold F7 / F8 → ${community ? 'Chat' : 'Community'}`;
  updateCommunitySelection();
  if (community) { renderDockTopics(groups); renderCommunityReader(); return; }
  // A naming pass can move the visible message from Ungrouped into a topic.
  let subjectIndex = groups.findIndex(group => group.messages.some(item => idOf(item) === dockMessageId));
  if (subjectIndex < 0) subjectIndex = groups.findIndex(group => group.key === dockSubjectKey);
  if (subjectIndex < 0) subjectIndex = 0;
  const group = groups[subjectIndex];
  dockSubjectKey = group?.key || '';
  let item = group?.messages.find(item => idOf(item) === dockMessageId);
  if (!item) item = group?.messages[0];
  dockMessageId = item ? idOf(item) : '';
  $('#dock-subject-name').textContent = group?.name || 'Chat';
  $('#dock-subject-position').textContent = group ? `${subjectIndex + 1} / ${groups.length}` : '';
  $('#dock-message-author').textContent = item ? nameOf(item) : '';
  renderMessageLabel(group?.key === 'ungrouped' ? item?.about : '');
  $('#dock-community-types').hidden = true;
  const repetitions = Number(item?.count || 1);
  const text = item ? String(pick(item.text, item.message)) + (repetitions > 1 ? ` (×${repetitions})` : '') : '';
  if ($('#dock-message-text').textContent !== text) $('#dock-message-text').textContent = text;
  $('#dock-message-author').hidden = !item;
  $('#dock-message-text').hidden = !item;
  $('#dock-message-empty').hidden = !!item;
  $('#dock-message-empty').textContent = arr(lastState.messages).length ? 'You’re caught up.' : 'Waiting for chat';
  $('#dock-message-position').textContent = group ? `${group.messages.findIndex(message => idOf(message) === dockMessageId) + 1} / ${group.messages.length}` : '';
  $('#dock-message-dismiss').disabled = !item;
  $('#dock-dismiss-label').textContent = 'Dismiss';
  $('#dock-message-dismiss').setAttribute('aria-label', 'Dismiss current message');
  $('#dock-subject-prev').disabled = groups.length < 2;
  $('#dock-subject-next').disabled = groups.length < 2;
  $('#dock-dismiss-undo').hidden = !lastDockDismissal;
  renderDockTopics(groups);
  if (renderedDockMessageId !== dockMessageId) $('.dock-message').scrollTop = 0;
  renderedDockMessageId = dockMessageId;
}
function moveDockSubject(direction) {
  const groups = dockGroups();
  if (groups.length < 2) return;
  $('#community-reminders').open = false;
  updateCommunitySelection();
  const current = Math.max(0, groups.findIndex(group => group.key === dockSubjectKey));
  dockSubjectKey = groups[(current + direction + groups.length) % groups.length].key;
  dockMessageId = '';
  renderDock();
}
function dismissDockMessage() {
  if (!dockMessageId) return;
  lastDockDismissal = {id: dockMessageId, subject: dockSubjectKey};
  dismissedMessages.add(dockMessageId);
  dockMessageId = '';
  persistDockDismissals();
  renderDock();
}
function handleDockCommand(command, source = 'local') {
  if (currentView !== 'live') return;
  const target = document.activeElement;
  if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/i.test(target?.tagName || '')) return;
  const now = Date.now();
  // OBS can deliver the same press that the focused browser already received.
  if (lastDockCommand?.command === command && lastDockCommand.source !== source && now - lastDockCommand.time < 350) return;
  lastDockCommand = {command, source, time: now};
  if (command === 'prev_subject') moveDockItem(-1);
  else if (command === 'next_subject') moveDockItem(1);
  else if (command === 'dismiss_message') dismissDockItem();
  else if (command === 'toggle_section') setDockSection(dockSection === 'chat' ? 'community' : 'chat');
}
function cancelDockHold() {
  if (heldDockKey) clearTimeout(heldDockKey.timer);
  heldDockKey = null;
}
function handleDockKey(event) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) { cancelDockHold(); return; }
  const command = {F7:'prev_subject', F8:'next_subject', F9:'dismiss_message'}[event.key];
  if (!command || currentView !== 'live') return;
  const target = event.target || document.activeElement;
  if (target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/i.test(target?.tagName || '')) return;
  if (event.repeat) { if (heldDockKey?.key === event.key) event.preventDefault(); return; }
  event.preventDefault();
  if (event.key === 'F9') { handleDockCommand(command); return; }
  if (heldDockKey) return;
  const hold = {key:event.key, command, started:Date.now(), fired:false, timer:null};
  heldDockKey = hold;
  hold.timer = setTimeout(() => {
    if (heldDockKey !== hold) return;
    hold.fired = true;
    handleDockCommand('toggle_section');
  }, DOCK_HOLD_MS);
}
function releaseDockKey(event) {
  const hold = heldDockKey;
  if (!hold || hold.key !== event.key) return;
  event.preventDefault();
  cancelDockHold();
  if (!hold.fired && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey)
    handleDockCommand(Date.now() - hold.started >= DOCK_HOLD_MS ? 'toggle_section' : hold.command);
}
document.addEventListener?.('keydown', handleDockKey);
document.addEventListener?.('keyup', releaseDockKey);
document.addEventListener?.('focusin', event => {
  if (event.target?.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/i.test(event.target?.tagName || '')) cancelDockHold();
});
globalThis.addEventListener?.('blur', cancelDockHold);
document.addEventListener?.('visibilitychange', () => { if (document.hidden) cancelDockHold(); });
$('#dock-subject-prev').addEventListener('click', () => moveDockItem(-1));
$('#dock-subject-next').addEventListener('click', () => moveDockItem(1));
$('#dock-message-dismiss').addEventListener('click', dismissDockItem);
$('#dock-dismiss-undo').addEventListener('click', () => {
  if (!lastDockDismissal) return;
  dismissedMessages.delete(lastDockDismissal.id);
  dockSubjectKey = lastDockDismissal.subject; dockMessageId = lastDockDismissal.id;
  lastDockDismissal = null;
  persistDockDismissals(); renderDock();
});

if (typeof EventSource === 'function') {
  const dockEvents = new EventSource('/api/dock/events');
  let lastEventId = '';
  dockEvents.addEventListener('ready', () => { lastEventId = ''; });
  dockEvents.addEventListener('command', event => {
    try {
      const data = JSON.parse(event.data);
      if (!data.id || String(data.id) === lastEventId) return;
      lastEventId = String(data.id);
      if (!Number.isFinite(data.timestamp) || Math.abs(Date.now() - data.timestamp) > 2000) return;
      handleDockCommand(data.command, 'obs');
    } catch { /* Ignore malformed integration events. */ }
  });
}
$('#obs-pair-button').addEventListener('click', async () => {
  try {
    const data = await request('/api/dock/pairing');
    $('#obs-pair-code').value = data.token || '';
    $('#obs-pair-code').hidden = false;
    $('#obs-pair-endpoint').value = data.endpoint || '';
    $('#obs-pair-endpoint').hidden = false;
    $('#obs-script-link').href = '/api/dock/script';
    $('#obs-pair-status').textContent = 'Load the script in OBS → Tools → Scripts, then paste this endpoint and pairing code.';
  } catch (error) { $('#obs-pair-status').textContent = error.message || 'Pairing unavailable.'; }
});

function message(text, isError = false) {
  const box = $('#notice');
  box.textContent = text;
  box.classList.toggle('error', isError);
  box.hidden = !text;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  let body = {};
  try { body = await response.json(); } catch { /* An empty response is allowed. */ }
  if (!response.ok) throw new Error(pick(body.error, body.message, `Request failed (${response.status})`));
  return body;
}

const post = (url, body = {}) => request(url, { method: 'POST', body: JSON.stringify(body) });
const clear = (node) => node.replaceChildren();
function empty(node, text) { node.append(el('div', 'empty', text)); }
function button(text, handler, className = 'text-button') {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', handler);
  return node;
}
async function act(fn, success) {
  try {
    message('');
    await fn();
    if (success) message(success);
    await refresh();
    return true;
  } catch (error) { message(error.message || 'Something went wrong.', true); return false; }
}
function safeImage(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url, location.href);
    if (parsed.origin === location.origin && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) return parsed.href;
    if (/^data:image\/(?:png|webp|jpeg);base64,[a-z0-9+/=]+$/i.test(url)) return url;
  } catch { /* Invalid URL. */ }
  return '';
}
function safeOverlayUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value, location.href);
    if (url.origin === location.origin && url.pathname === '/overlay.html' && url.searchParams.get('token')) return url.href;
  } catch { /* Invalid URL. */ }
  return '';
}
function safeTwitchAuthUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    const redirect = new URL(url.searchParams.get('redirect_uri'));
    if (url.origin !== 'https://id.twitch.tv' || url.pathname !== '/oauth2/authorize') return '';
    if (url.username || url.password || url.hash || redirect.username || redirect.password || redirect.search || redirect.hash) return '';
    if (['response_type', 'client_id', 'state', 'redirect_uri', 'scope'].some((key) => url.searchParams.getAll(key).length !== 1)) return '';
    if (url.searchParams.get('response_type') !== 'code' || !url.searchParams.get('client_id') || !url.searchParams.get('state')) return '';
    if (url.searchParams.get('scope') !== 'user:read:chat moderator:manage:chat_messages moderator:read:chatters moderator:read:followers') return '';
    if (redirect.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname) || redirect.pathname !== '/twitch/callback') return '';
    if (redirect.port !== location.port) return '';
    return url.href;
  } catch { return ''; }
}
function setImage(parent, url, alt) {
  const safe = safeImage(url);
  if (!safe) return;
  const image = el('img');
  image.src = safe;
  image.alt = alt;
  parent.append(image);
}
function idOf(item) { return String(pick(item.id, item.messageId, item.message_id)); }
function nameOf(item) { return pick(item.viewerName, item.displayName, item.name, item.userName, 'Viewer'); }
function formatList(value) {
  return arr(value).map((item) => typeof item === 'string' ? item : pick(item.name, item.viewerName, item.displayName, item.id)).filter(Boolean).join(', ');
}
function addMessage(parent, item, selectable = false) {
  const row = el('div', selectable ? 'selection' : 'message');
  const id = idOf(item);
  if (selectable) {
    const checkbox = el('input');
    checkbox.type = 'checkbox';
    checkbox.disabled = !id || item.selectable === false || String(pick(item.text, item.message)).startsWith('!');
    if (checkbox.disabled) selected.delete(id);
    checkbox.checked = !checkbox.disabled && selected.has(id);
    checkbox.setAttribute('aria-label', `Select message from ${nameOf(item)}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.disabled) { checkbox.checked = false; return; }
      if (checkbox.checked) selected.add(id); else selected.delete(id);
      if (checkbox.checked && !$('#sticker-subject').value.trim() && item.subjectId) {
        $('#sticker-subject').value = arr(lastState.subjects).find((subject) => subject.id === item.subjectId)?.name || 'Chat moment';
      } else if (checkbox.checked && !$('#sticker-subject').value.trim()) {
        $('#sticker-subject').value = 'Chat moment';
      }
      renderRecentMessages();
      renderSearch();
    });
    row.append(checkbox);
  } else {
    row.append(el('div', 'avatar', String(nameOf(item)).charAt(0).toUpperCase()));
  }
  const body = el('div', 'message-body');
  body.append(el('div', 'message-name', nameOf(item)));
  const count = Number(pick(item.count, 1));
  body.append(el('div', 'message-text', `${pick(item.text, item.message, '')}${count > 1 ? ` (X${count})` : ''}`));
  const meta = [messageLabel(item), item.match === 'maybe' ? 'Maybe' : '', item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''].filter(Boolean).join(' · ');
  if (meta) body.append(el('div', 'message-meta', meta));
  row.append(body);
  parent.append(row);
}
function renderRecentMessages() {
  const messageList = $('#message-list'); clear(messageList);
  $('#open-stickers').textContent = 'Make a sticker';
  const messages = arr(lastState.messages);
  if (!messages.length) empty(messageList, 'Cleared chat messages will appear here.');
  for (const item of messages.slice(-30).reverse()) addMessage(messageList, item, true);
}

function render(state) {
  lastState = state;
  renderPlayback(state);
  if (!settingsLoaded && state.settings) {
    $('#award-timezone').value = state.settings.timeZone || 'UTC';
    $('#day-one-date').value = state.settings.dayOneDate || '';
    settingsLoaded = true;
  }
  const overlay = $('#overlay-link');
  const overlayUrl = safeOverlayUrl(state.overlayUrl);
  overlay.hidden = !overlayUrl;
  overlay.href = overlayUrl || '#';
  const session = state.session || {};
  const mode = String(pick(session.mode, state.mode, 'offline')).toLowerCase();
  const status = String(pick(session.status, 'waiting'));
  $('#connect-twitch').hidden = !state.oauthAvailable || !!state.liveStatus?.connected;
  $('#connect-twitch').disabled = connectingTwitch;
  $('#connection-label').textContent = state.playback ? 'Recorded replay' : state.liveStatus?.connected ? 'Twitch connected' : state.oauthAvailable ? 'Twitch disconnected' : mode === 'demo' || mode === 'replay' ? 'Demo replay' : 'Not connected';
  $('#connection-label').hidden = false;
  $('#session-label').textContent = state.playback ? `Recorded replay · ${state.playback.status}` : mode === 'demo' || mode === 'replay' ? `Demo replay · ${status}` : mode === 'live' ? `Live · ${status}` : 'Waiting for a stream';
  const presence = arr(state.presence), subjects = arr(state.subjects), stickers = arr(state.stickers);
  // Subjects persist across streams; only show topics backed by a cleared
  // message in the current session, as supplied by the state endpoint.
  const subjectEvidence = Array.isArray(state.currentSubjectIds) ? state.currentSubjectIds : arr(state.messages).filter(item => item.topicEligible !== false).map(item => pick(item.subjectId, item.subject_id));
  const activeSubjectIds = new Set(subjectEvidence.filter(Boolean).map(String));
  const topicGroups = new Map();
  for (const subject of subjects.filter(item => activeSubjectIds.has(String(item.id)))) {
    const label = String(pick(subject.name, 'Untitled subject')).trim() || 'Untitled subject';
    const key = label.replace(/\s+/g, ' ').toLocaleLowerCase();
    if (!topicGroups.has(key)) topicGroups.set(key, {name: label, subjects: []});
    topicGroups.get(key).subjects.push(subject);
  }
  const topics = [...topicGroups.values()];
  liveTopicMetadata = topics;
  $('#presence-count').textContent = String(presence.length);
  $('#subject-count').textContent = String(topics.length);
  $('#subject-count-label').textContent = topics.length === 1 ? 'topic' : 'topics';
  $('#sticker-count').textContent = String(stickers.filter((sticker) => sticker.status === 'approved').length);
  const reviewCount = arr(state.maybe).length;
  $('#review-count').textContent = String(reviewCount);
  $('#review-total').textContent = String(reviewCount);
  $('#review-label').textContent = reviewCount === 1 ? 'message' : 'messages';
  $('#open-review').textContent = reviewCount ? 'Review →' : 'Open →';
  $('.review-card').classList.toggle('is-attention', reviewCount > 0);
  $('#nav-review').classList.toggle('attention', reviewCount > 0);
  const summary = typeof state.summary === 'string' ? state.summary : state.summary?.text;
  const summaryText = typeof summary === 'string' ? summary.trim() : '';
  const genericSummary = /^chat is discussing (?:the )?(?:latest stream moments|stream moments)\.?$/i.test(summaryText);
  const hasSummary = !!summaryText && !genericSummary;
  $('#summary').textContent = hasSummary ? summaryText : 'Waiting for chat.';
  // Topic chips already provide the fallback; avoid showing the same words twice.
  $('#summary').hidden = !hasSummary && topics.length > 0;

  const subjectList = $('#subject-list'); clear(subjectList);
  if (!topics.length) empty(subjectList, 'No current topics yet.');
  for (const topic of topics) {
    const item = button(topic.name, () => {
      $('#sticker-subject').value = topic.name;
      showView('stickers');
      setStickerStep('editor');
      // Same-name subjects may have different IDs and descriptions. A name search
      // considers all cleared messages rather than choosing one arbitrary ID.
      search(topic.name, topic.subjects.length === 1 ? topic.subjects[0].id : undefined);
    }, 'subject');
    if (topic.subjects.every(subject => Number.isFinite(Number(subject.count)))) {
      item.append(el('small', '', topic.subjects.reduce((total, subject) => total + Number(subject.count), 0)));
    }
    subjectList.append(item);
  }
  renderRecentMessages();
  showNudgePage();
  $('#pause-nudges').disabled = !session.id || !!state.nudgesPaused;
  $('#pause-nudges').textContent = state.nudgesPaused ? 'Paused' : 'Pause';
  $('#pause-nudges').setAttribute('aria-label', state.nudgesPaused ? 'Reminders paused for this stream' : 'Pause reminders for this stream');
  const presenceList = $('#presence-list'); clear(presenceList);
  if (!presence.length) empty(presenceList, 'People with chat open will appear here when presence is available.');
  for (const person of presence) {
    const row = el('div', 'person'); row.append(el('div', 'avatar', String(nameOf(person)).charAt(0).toUpperCase()));
    const body = el('div'); body.append(el('strong', '', nameOf(person))); body.append(el('small', '', pick(person.detail, person.status, 'Here now'))); row.append(body); presenceList.append(row);
  }
  renderCommunity();
  renderDock();
  const ruleList = $('#rule-list'); clear(ruleList);
  if (!arr(state.rules).length) empty(ruleList, 'No topics added yet.');
  for (const rule of arr(state.rules)) {
    const row = el('div', 'rule'), body = el('div');
    body.append(el('strong', '', pick(rule.topic, rule.name)), el('small', '', rule.action === 'delete' || rule.action === 'keep_out' ? 'Keep out of chat' : 'Hide from me'));
    row.append(body, button('Remove', () => act(() => post(`/api/rules/${encodeURIComponent(rule.id)}/delete`), 'Topic removed.'))); ruleList.append(row);
  }
  const maybe = $('#maybe-list'); clear(maybe);
  if (!arr(state.maybe).length) empty(maybe, 'Nothing waiting for review.');
  for (const item of arr(state.maybe)) {
    const row = el('div', 'rule'), body = el('div');
    body.append(el('strong', '', pick(item.text, 'Message')), el('small', '', nameOf(item)));
    row.append(body, button('Allow', () => act(() => post(`/api/maybe/${encodeURIComponent(item.id)}/review`, {action: 'allow'}), 'Message allowed.'), 'button secondary'),
      button('Hide from me', () => act(() => post(`/api/maybe/${encodeURIComponent(item.id)}/review`, {action: 'hide'}), 'Message hidden.'), 'button subtle'));
    maybe.append(row);
  }
  const awardList = $('#award-list'); clear(awardList);
  if (!arr(state.awards).length) empty(awardList, 'Awards will appear when the stream is wrapped.');
  for (const award of arr(state.awards)) {
    const row = el('div', 'award'), body = el('div');
    body.append(el('strong', '', pick(award.title, award.name)), el('small', '', formatList(award.recipients) || 'No recipients yet'));
    row.append(el('span', 'large-icon', '✦'), body); awardList.append(row);
  }
  const stickerList = $('#sticker-list'); clear(stickerList);
  for (const sticker of stickers) {
    const row = el('div', sticker.status === 'brief' ? 'sticker brief-sticker' : 'sticker'); setImage(row, pick(sticker.imageUrl, sticker.image_url), pick(sticker.name, 'Sticker preview'));
    const body = el('div', 'sticker-body'); body.append(el('strong', '', pick(sticker.name, 'Sticker preview')));
    const hasImage = !!safeImage(pick(sticker.imageUrl, sticker.image_url));
    const status = sticker.status === 'preview' && !hasImage ? 'Image unavailable' : pick(sticker.status, 'Generating');
    body.append(el('small', '', `${status}${formatList(sticker.credits) ? ` · ${formatList(sticker.credits)}` : ''}`)); row.append(body);
    if (sticker.status === 'brief') {
      const label = el('label', '', 'Review the sticker brief');
      const input = el('textarea'); input.rows = 3; input.maxLength = 1000;
      input.value = editedBriefs.get(sticker.id) ?? sticker.brief ?? '';
      input.addEventListener('input', () => editedBriefs.set(sticker.id, input.value));
      label.append(input); body.append(label);
      const renderButton = button('Approve brief and make image', async () => {
        const brief = input.value.trim();
        if (!brief) { message('Enter a sticker brief before making an image.', true); return; }
        renderButton.disabled = true;
        const succeeded = await act(() => post(`/api/stickers/${encodeURIComponent(sticker.id)}/render`, {brief}), 'Image created. Review it before publishing.');
        if (succeeded) editedBriefs.delete(sticker.id);
        else renderButton.disabled = false;
      }, 'button secondary');
      row.append(renderButton);
    }
    if (sticker.status === 'preview' && hasImage) row.append(button('Approve', () => act(() => post(`/api/stickers/${encodeURIComponent(sticker.id)}/approve`), 'Sticker approved.'), 'button secondary'));
    stickerList.append(row);
  }
  $('#generate-button').disabled = !selected.size || !$('#sticker-subject').value.trim();
}

const playbackTime = milliseconds => {
  const seconds=Math.max(0,Math.floor(Number(milliseconds || 0)/1000));
  return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
};
function renderPlayback(state) {
  const playback=state.playback;
  $('#playback-panel').hidden=!playback;
  $('#chat-recordings').hidden=!!playback || !state.recordingAvailable;
  $('#privacy').hidden=!!playback;
  $('#obs-hotkey-settings').hidden=!!playback;
  $('#replay-button').hidden=!!playback;
  if(!playback)return;
  const active=['playing','processing'].includes(playback.status),resetting=playback.status==='resetting';
  $('#playback-name').textContent=playback.name;
  const labels={ready:'Ready to replay',playing:'Playing',paused:'Paused',processing:'Finishing classification and topic discovery',completed:'Replay complete',resetting:'Resetting replay'};
  $('#playback-status').textContent=`${labels[playback.status] || playback.status} · ${playback.sent} / ${playback.total} messages`;
  $('#playback-progress').max=Math.max(1,playback.durationMs);
  $('#playback-progress').value=playback.status==='completed'?Math.max(1,playback.durationMs):playback.elapsedMs;
  $('#playback-position').textContent=`${playbackTime(playback.elapsedMs)} / ${playbackTime(playback.durationMs)}${playback.nextInMs==null?'':` · Next arrival in ${(playback.nextInMs/1000).toFixed(3)}s of recorded time`}`;
  $('#playback-clock').textContent=`Recorded time: ${new Date(playback.originalTime).toLocaleString()}`;
  $('#playback-play').disabled=active || resetting;
  $('#playback-play').textContent=playback.status==='paused'?'Resume':playback.status==='completed'?'Replay again':'Play';
  $('#playback-pause').disabled=!active;
  $('#playback-restart').disabled=resetting;
  $('#playback-reset').disabled=resetting || playback.status==='ready';
  if(document.activeElement!==$('#playback-speed'))$('#playback-speed').value=String(playback.speed);
  $('#playback-ai').textContent=state.aiMode==='live'?'Live AI · uses OpenRouter credits. Each run classifies the chat again.':'Offline heuristics · for testing playback, not AI classification quality.';
  $('#playback-error').hidden=!playback.error && !playback.held;
  $('#playback-error').textContent=[playback.error,playback.held?`${playback.held} messages awaiting classification.`:''].filter(Boolean).join(' ');
  const log=$('#playback-log');clear(log);
  for(const message of arr(playback.recent)){
    const item=el('li');
    const label=messageLabel(message) || (message.moderation==='held'?'Awaiting classification':message.moderation==='cleared'?'Ungrouped':message.moderation || 'Not retained');
    const original=message.originalTopic || message.originalAbout || '';
    item.append(el('small','',`${playbackTime(message.offsetMs)} · +${(message.delayMs/1000).toFixed(3)}s · ${message.name} · ${original?`Original: ${original} → Replay: `:''}${label}`),el('span','',message.text));
    log.append(item);
  }
}
for(const action of ['play','pause','restart','reset'])$('#playback-'+action).addEventListener('click',()=>act(()=>post('/api/playback/'+action),''));
$('#playback-speed').addEventListener('change',()=>act(()=>post('/api/playback/speed',{speed:Number($('#playback-speed').value)}),''));

async function refresh() {
  if (busy) return;
  if (document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.closest('#sticker-list')) return;
  busy = true;
  try {
    render(await request('/api/state'));
    $('#updated-label').textContent = `Updated ${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit', second: '2-digit'})}`;
  }
  catch (error) { $('#connection-label').textContent = 'Disconnected'; $('#updated-label').textContent = 'Updates unavailable'; message(error.message || 'Could not reach Regulars.', true); }
  finally { busy = false; }
}
function renderSearch() {
  const parent = $('#search-results'); clear(parent);
  if (!searchMessages.length) empty(parent, 'No eligible comments found. Try a different subject.');
  for (const item of searchMessages) addMessage(parent, item, true);
  $('#generate-button').disabled = !selected.size || !$('#sticker-subject').value.trim();
}
const stickerTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'device local time';
$('#sticker-time-zone').textContent = `Times use your device time zone (${stickerTimeZone}).`;
function localDateTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const pad = number => String(number).padStart(2, '0');
  const actual = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return actual === value ? date : null;
}
async function search(subject, subjectId) {
  if (!subject.trim()) return;
  const fromInput = $('#sticker-from').value, toInput = $('#sticker-to').value;
  const fromTime = fromInput ? localDateTime(fromInput) : null, toTime = toInput ? localDateTime(toInput) : null;
  if ((fromInput && !fromTime) || (toInput && !toTime) || (fromTime && toTime && fromTime > toTime)) {
    message('Choose a valid time range with the start before the end.', true); return;
  }
  setStickerStep('editor');
  const sequence = ++searchSequence;
  searchMessages = [];
  selected = new Set();
  renderRecentMessages();
  clear($('#search-results'));
  $('#search-status').textContent = 'Finding related comments…';
  $('#generate-button').disabled = true;
  try {
    const data = await post('/api/stickers/search', { subject, subjectId,
      ...(fromTime ? {from: fromTime.toISOString()} : {}), ...(toTime ? {to: toTime.toISOString()} : {}) });
    if (sequence !== searchSequence) return;
    const selectedMessages = arr(data.selected);
    const maybeMessages = arr(data.maybe).map((item) => ({...item, match: 'maybe'}));
    searchMessages = selectedMessages.length || maybeMessages.length ? [...selectedMessages, ...maybeMessages] : arr(data.messages);
    selected = new Set((selectedMessages.length ? selectedMessages : searchMessages.filter((item) => item.selected)).map(idOf).filter(Boolean));
    renderRecentMessages();
    $('#search-status').textContent = `${searchMessages.length} related comments. Review the selection before creating a preview.`;
    renderSearch();
  } catch (error) {
    if (sequence !== searchSequence) return;
    $('#search-status').textContent = error.message || 'Search failed.';
    message(error.message || 'Search failed.', true);
  }
}

$('#search-form').addEventListener('submit', (event) => { event.preventDefault(); search($('#sticker-subject').value); });
$('#sticker-subject').addEventListener('input', () => { $('#generate-button').disabled = !selected.size || !$('#sticker-subject').value.trim(); });
$('#generate-button').addEventListener('click', async () => {
  const subject = $('#sticker-subject').value.trim();
  if (!selected.size || !subject) return;
  $('#generate-button').disabled = true;
  const succeeded = await act(() => post('/api/stickers/generate', { subject, messageIds: [...selected] }), 'Review the sticker brief before creating an image.');
  if (succeeded) { selected = new Set(); renderRecentMessages(); renderSearch(); }
  else $('#generate-button').disabled = !selected.size || !$('#sticker-subject').value.trim();
});
$('#replay-button').addEventListener('click', () => act(() => post('/api/replay'), 'Demo replay started.'));
$('#connect-twitch').addEventListener('click', async () => {
  if (connectingTwitch || $('#connect-twitch').hidden) return;
  connectingTwitch = true;
  $('#connect-twitch').disabled = true;
  let navigating = false;
  try {
    message('');
    const data = await post('/api/twitch/connect');
    const url = safeTwitchAuthUrl(data.url);
    if (!url) throw new Error('Invalid Twitch sign-in address.');
    location.assign(url);
    navigating = true;
  } catch (error) { message(error.message || 'Could not start Twitch sign-in.', true); }
  finally { if (!navigating) { connectingTwitch = false; $('#connect-twitch').disabled = false; } }
});
$('#wrap-button').addEventListener('click', () => {
  if (confirm('Wrap this stream and share the awards on your overlay?')) act(() => post('/api/wrap'), 'Wrap requested.');
});
$('#pause-nudges').addEventListener('click', () => {
  if (confirm('Pause and clear reminders for the rest of this stream? You cannot resume them during this stream.'))
    act(() => post('/api/nudges/pause'), 'Reminders paused for this stream.');
});
const ruleExamples = (selector) => $(selector).value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 3);
const ruleDraft = () => ({ topic: $('#rule-topic').value.trim(), definition: $('#rule-definition').value.trim(),
  positiveExamples: ruleExamples('#rule-positive'), negativeExamples: ruleExamples('#rule-negative') });
const resetRuleTest = () => { $('#rule-test-result').textContent = 'Testing does not enable the topic.'; };
for (const selector of ['#rule-topic', '#rule-definition', '#rule-positive', '#rule-negative', '#rule-test-text']) $(selector).addEventListener('input', resetRuleTest);
$('#rule-draft').addEventListener('click', async () => {
  const before = JSON.stringify(ruleDraft());
  const topic = $('#rule-topic').value.trim();
  if (!topic) { message('Enter a topic first.', true); return; }
  const button = $('#rule-draft'); if (button.disabled) return;
  button.disabled = true;
  try {
    message('');
    const draft = await post('/api/rules/draft', { topic });
    if (JSON.stringify(ruleDraft()) !== before) { message('The topic changed while the draft was loading. Your edits were kept.'); return; }
    if (typeof draft.definition !== 'string' || !Array.isArray(draft.positiveExamples) || !Array.isArray(draft.negativeExamples)) throw new Error('Could not draft this topic.');
    $('#rule-definition').value = draft.definition;
    $('#rule-positive').value = draft.positiveExamples.filter(value => typeof value === 'string').slice(0, 3).join('\n');
    $('#rule-negative').value = draft.negativeExamples.filter(value => typeof value === 'string').slice(0, 3).join('\n');
    resetRuleTest();
  } catch (error) { message(error.message || 'Could not draft this topic.', true); }
  finally { button.disabled = false; }
});
$('#rule-test').addEventListener('click', async () => {
  const draft = ruleDraft(), text = $('#rule-test-text').value.trim();
  if (!draft.topic || !draft.definition || !text) { message('Enter a topic, definition, and test message.', true); return; }
  const button = $('#rule-test'); if (button.disabled) return;
  button.disabled = true; $('#rule-test-result').textContent = 'Testing…';
  try {
    message('');
    const result = await post('/api/rules/test', { ...draft, text });
    if (JSON.stringify(ruleDraft()) !== JSON.stringify(draft) || $('#rule-test-text').value.trim() !== text) { resetRuleTest(); return; }
    if (!Number.isFinite(result.score) || result.score < 0 || result.score > 1 || !Number.isFinite(result.nonEnglish)) throw new Error('Invalid test result.');
    const label = result.nonEnglish >= 0.3 ? 'Needs review: message may be non-English' : result.score >= 0.7 ? 'Likely match' : result.score >= 0.3 ? 'Uncertain match' : 'Unlikely match';
    $('#rule-test-result').textContent = `${label} (${Math.round(result.score * 100)}% topic score). Testing does not enable the topic.`;
  } catch (error) { resetRuleTest(); message(error.message || 'Could not test this topic.', true); }
  finally { button.disabled = false; }
});
$('#rule-form').addEventListener('submit', (event) => {
  event.preventDefault(); const draft = ruleDraft(); if (!draft.topic || !draft.definition) return;
  return act(async () => {
    await post('/api/rules', { ...draft, action: $('#rule-action').value });
    for (const selector of ['#rule-topic', '#rule-definition', '#rule-positive', '#rule-negative', '#rule-test-text']) $(selector).value = '';
    resetRuleTest();
  }, 'Topic enabled.');
});
$('#awards-settings').addEventListener('submit', (event) => {
  event.preventDefault();
  act(() => post('/api/settings', {timeZone: $('#award-timezone').value.trim(), dayOneDate: $('#day-one-date').value}), 'Award settings saved.');
});
$('#forget-form').addEventListener('submit', (event) => {
  event.preventDefault(); const viewerId = $('#forget-id').value.trim(); if (!viewerId) return;
  if (confirm('Forget this viewer and remove their stored activity and credits?')) act(async () => { await post('/api/privacy/forget', {viewerId}); $('#forget-id').value = ''; }, 'Viewer forgotten.');
});
$('#delete-channel').addEventListener('click', () => {
  if (confirm('Delete all data for this channel? This cannot be undone.')) act(async () => {
    await post('/api/privacy/delete-channel');
    settingsLoaded = false;
    editedBriefs.clear();
    try { globalThis.localStorage?.removeItem?.('regulars-dock-dismissed'); } catch { /* Storage may be disabled. */ }
  }, 'Channel data deleted.');
});

const configBounds = {
  regularMinimum:[1,100], regularWindow:[1,100], returnMinPrevious:[1,100], returnMissedSessions:[1,100],
  repetitionWindowSeconds:[1,120], discussionGapSeconds:[1,3600], hypeMinContributors:[2,100], hypeMaxContributors:[1,50],
  nudgeCooldownSeconds:[0,3600], maxOpenNudges:[1,20], messageNudgeExpirySeconds:[1,3600], arrivalNudgeExpirySeconds:[1,86400],
  matchThreshold:[0,1], maybeThreshold:[0,1], summaryIntervalSeconds:[1,300], summaryWindowSeconds:[1,3600],
  chatterPollSeconds:[10,300], stickerViewerCooldownSeconds:[0,3600], stickerChannelCooldownSeconds:[0,3600],
};
const configKeys = ['regularMode', ...Object.keys(configBounds), 'nightOwlStart', 'nightOwlEnd'];
let savedConfig = null, configBusy = false;
function configStatus(text, error = false) {
  $('#config-status').textContent = text;
  $('#config-status').classList.toggle('error', error);
}
function writeConfig(settings) {
  for (const key of configKeys) $('#config-' + key).value = String(settings[key] ?? '');
}
function configFieldValues() {
  return configKeys.map((key) => $('#config-' + key).value);
}
function readConfig() {
  const result = {};
  for (const key of configKeys) {
    const input = $('#config-' + key), raw = input.value.trim();
    if (configBounds[key]) {
      const [min,max] = configBounds[key], value = Number(raw);
      if (!raw || !Number.isFinite(value) || value < min || value > max ||
          (!['matchThreshold','maybeThreshold'].includes(key) && !Number.isInteger(value))) {
        const label = document.querySelector(`label[for="config-${key}"]`)?.textContent || key;
        throw new Error(`${label}: enter a number from ${min} to ${max}.`);
      }
      result[key] = value;
    } else result[key] = raw;
  }
  if (!['rolling','consecutive'].includes(result.regularMode)) throw new Error('Choose an attendance rule.');
  if (result.regularMode === 'rolling' && result.regularMinimum > result.regularWindow) throw new Error('Required streams cannot exceed the rolling window.');
  if (result.maybeThreshold >= result.matchThreshold) throw new Error('The possible match score must be lower than the match score.');
  for (const key of ['nightOwlStart','nightOwlEnd']) if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(result[key])) throw new Error('Enter valid night owl start and end times.');
  if (result.nightOwlStart === result.nightOwlEnd) throw new Error('Night owl start and end times must differ.');
  return result;
}
function configControls() {
  $('#config-save').disabled = !savedConfig || configBusy;
  $('#config-revert').disabled = !savedConfig || configBusy;
}
async function loadConfig() {
  if (configBusy) return;
  configBusy = true; configControls(); $('#config-reload').hidden = true;
  configStatus('Loading settings…');
  try {
    const data = await request('/api/config');
    if (!data.settings || configKeys.some((key) => data.settings[key] === undefined)) throw new Error('Settings are unavailable.');
    savedConfig = {...data.settings}; writeConfig(savedConfig);
    configStatus('Changes apply after you save.');
  } catch (error) {
    configStatus(error.message || 'Could not load settings.', true); $('#config-reload').hidden = false;
  } finally { configBusy = false; configControls(); }
}
$('#config-reload').addEventListener('click', loadConfig);
$('#config-revert').addEventListener('click', () => {
  if (!savedConfig || configBusy) return;
  writeConfig(savedConfig); configStatus('Reverted to saved settings.');
});
$('#config-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!savedConfig || configBusy) return;
  let next;
  try { next = readConfig(); } catch (error) { configStatus(error.message, true); return; }
  const submittedValues = configFieldValues();
  configBusy = true; configControls(); configStatus('Saving settings…');
  try {
    const response = await post('/api/config', {settings: next});
    if (!response.settings || configKeys.some((key) => response.settings[key] === undefined)) throw new Error('The server did not confirm the saved settings. Reload the page to check them.');
    savedConfig = {...response.settings};
    if (configFieldValues().every((value, index) => value === submittedValues[index])) {
      writeConfig(savedConfig); configStatus('Settings saved.');
    } else configStatus('Settings saved. Your newer edits have not been saved.');
  } catch (error) { configStatus(error.message || 'Could not save settings.', true); }
  finally { configBusy = false; configControls(); }
});
loadConfig();

refresh();
const twitchResult = new URLSearchParams(location.search).get('twitch');
if (twitchResult === 'failed' || twitchResult === 'unavailable') {
  message(twitchResult === 'failed' ? 'Twitch sign-in failed. Try connecting again.' : 'Twitch sign-in is unavailable. Check the local app configuration.', true);
}
if (twitchResult && history.replaceState) {
  const url = new URL(location.href);
  url.searchParams.delete('twitch');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
setInterval(refresh, 2500);
