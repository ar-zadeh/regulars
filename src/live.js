import { TwitchClient, validateAccessToken } from './twitch.js';
import { StickerQueue } from './sticker-queue.js';

// The bridge is opt-in and keeps the broadcaster token in memory only.
export async function connectLive({
  app, clientId, accessToken, broadcasterId, onStatus = () => {},
  clientFactory = options => new TwitchClient(options), validate = validateAccessToken,
  pollMs, offlineMs = 600000, validationMs = 3600000, botNames = [],
} = {}) {
  await validate({ clientId, accessToken, userId: broadcasterId });
  const bots = new Set(['nightbot', 'streamelements', 'moobot', 'commanderroot', 'sery_bot', ...botNames]
    .map(name => String(name).trim().toLowerCase()).filter(Boolean));
  const isBot = (login, name) => bots.has(String(login || '').trim().toLowerCase()) ||
    bots.has(String(name || '').trim().toLowerCase());
  let offlineTimer = null, offlineGeneration = 0, privateGeneration = 0, stopped = false, polling = false;
  let poll = null, validationTimer = null, validating = false, offlineSince = null, sawLiveStream = false;
  let streamTask = Promise.resolve(), lastStreamId = null, lastStreamStartedAt = null;
  let currentSettings = {...app.config};
  const createStickerQueue = () => new StickerQueue({app,
    viewerCooldownMs: (currentSettings.stickerViewerCooldownSeconds ?? 60) * 1000,
    channelCooldownMs: (currentSettings.stickerChannelCooldownSeconds ?? 10) * 1000});
  let stickerQueue = createStickerQueue();
  let lastStickerViewer = null;
  const removedIds = new Set(), userClearedAt = new Map();
  let roomClearedAt = 0;
  // Core treats null as the initial snapshot, suppressing arrival nudges for
  // viewers already present when the bridge connects.
  app.presentIds = null;

  const rememberRemoved = id => {
    if (!id) return;
    removedIds.add(id);
    if (removedIds.size > 10000) removedIds.delete(removedIds.values().next().value);
  };
  const eventTime = envelope => Date.parse(envelope.metadata?.message_timestamp || '') || 0;

  const clearOfflineTimer = () => {
    clearTimeout(offlineTimer);
    offlineTimer = null;
    offlineGeneration++;
  };
  const invalidateViewer = viewerId => {
    if (!viewerId) return;
    // Queued sticker IDs have no sender attached, so cancel pending displays
    // after an opt-out while retaining other viewers' cooldowns.
    const next = createStickerQueue();
    next.lastViewer = new Map(stickerQueue.lastViewer);
    next.lastViewer.delete(viewerId);
    next.lastChannel = lastStickerViewer === viewerId ? -Infinity : stickerQueue.lastChannel;
    stickerQueue.stop();
    stickerQueue = next;
    if (lastStickerViewer === viewerId) lastStickerViewer = null;
  };
  const clearPrivateState = () => {
    privateGeneration++;
    stickerQueue.stop();
    stickerQueue = createStickerQueue();
    lastStickerViewer = null;
    removedIds.clear();
    userClearedAt.clear();
    roomClearedAt = 0;
    app.presentIds = new Set();
    clearOfflineTimer();
    offlineSince = null;
    lastStreamId = null;
    lastStreamStartedAt = null;
    sawLiveStream = false;
  };
  const stopBridge = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(poll);
    clearInterval(validationTimer);
    clearOfflineTimer();
    privateGeneration++;
    app.presentIds = new Set();
    stickerQueue.stop();
    client.stop();
    app.deleteMessage = async () => {};
    app.deleteMessageAvailable = false;
  };
  const checkPresence = async () => {
    if (stopped || polling || !app.currentSession()) return;
    polling = true;
    const generation = privateGeneration;
    try {
      const chatters = await client.getChatters();
      if (stopped || generation !== privateGeneration || !app.currentSession()) return;
      if (app.updatePresence) app.updatePresence(chatters.map(viewer => ({id:viewer.user_id,name:viewer.user_name,login:viewer.user_login,bot:isBot(viewer.user_login,viewer.user_name)})));
      else {const eligible=chatters.filter(viewer=>!isBot(viewer.user_login,viewer.user_name));app.presentIds = new Set(eligible.map(viewer => viewer.user_id).filter(Boolean)); for (const viewer of eligible) app.sight({ id: viewer.user_id, name: viewer.user_name });}
    } catch {
      if (!stopped) onStatus({ connected: false, reason: 'Presence lookup failed' });
    } finally { polling = false; }
  };
  const endLater = ({grace = false} = {}) => {
    if (stopped || !app.currentSession()) return;
    if (grace) offlineSince ??= Date.now();
    clearOfflineTimer();
    const generation = offlineGeneration;
    offlineTimer = setTimeout(async () => {
      offlineTimer = null;
      if (stopped || generation !== offlineGeneration) return;
      try {
        const stream = await client.getStream();
        if (stopped || generation !== offlineGeneration || stream) return;
        const session = app.currentSession();
        if (!session) return;
        await app.wrap({ play: false });
        if (stopped || generation !== offlineGeneration || app.currentSession()?.id !== session.id) return;
        app.run('UPDATE sessions SET end=? WHERE id=?', new Date().toISOString(), session.id);
        app.presentIds = new Set();
        offlineSince = null;
        sawLiveStream = false;
        lastStreamId = null;
        lastStreamStartedAt = null;
      } catch {
        if (!stopped) onStatus({ connected: false, reason: 'Offline confirmation failed' });
      }
    }, offlineMs);
    offlineTimer.unref?.();
  };
  const handleStream = stream => {
    if (stopped) return streamTask;
    if (!stream) { endLater({grace: sawLiveStream}); return streamTask; }
    const generation = privateGeneration;
    const withinGrace = offlineSince !== null && Date.now() - offlineSince < offlineMs;
    offlineSince = null;
    clearOfflineTimer();
    streamTask = streamTask.then(async () => {
      if (stopped || generation !== privateGeneration) return;
      const session = app.currentSession();
      const startedAt = Date.parse(stream.started_at || '');
      const priorStart = Date.parse(session?.start || '');
      const comparisonStart = lastStreamStartedAt ?? priorStart;
      const streamId = stream.id || null;
      const differentStart = Number.isFinite(startedAt) && Number.isFinite(comparisonStart) &&
        Math.abs(startedAt - comparisonStart) > 1000;
      const differentId = !!(streamId && lastStreamId && streamId !== lastStreamId);
      if (session && (differentStart || differentId) && !withinGrace) {
        await app.wrap({ play: false });
        if (stopped || generation !== privateGeneration || app.currentSession()?.id !== session.id) return;
        const end = new Date(Math.max(Number.isFinite(priorStart) ? priorStart : 0,
          Number.isFinite(startedAt) ? startedAt : Date.now())).toISOString();
        app.run('UPDATE sessions SET end=? WHERE id=?', end, session.id);
        app.presentIds = null;
      }
      if (!stopped && generation === privateGeneration) {
        app.startSession(Number.isFinite(startedAt) ? new Date(startedAt).toISOString() : undefined);
        lastStreamId = streamId || lastStreamId;
        if (Number.isFinite(startedAt)) lastStreamStartedAt = startedAt;
        sawLiveStream = true;
        void checkPresence();
      }
    }).catch(() => {
      if (!stopped) onStatus({ connected: false, reason: 'Stream reconciliation failed' });
    });
    return streamTask;
  };
  const clearRoom = () => {
    const ids = new Set(app.all('SELECT id FROM messages WHERE text IS NOT NULL').map(m => m.id));
    if (!ids.size) return;
    // Room clears erase text but preserve awards based on non-text eligibility.
    app.run('UPDATE messages SET text=NULL WHERE text IS NOT NULL');
    for (const id of ids) app.run('DELETE FROM nudges WHERE message_id=?', id);
    for (const sticker of app.all('SELECT id,source_ids FROM stickers WHERE approved=1')) {
      if (JSON.parse(sticker.source_ids).some(id => ids.has(id))) {
        app.run('UPDATE stickers SET approved=0 WHERE id=?', sticker.id);
      }
    }
    app.revision++;
    app.abortClassifications?.();
    app.summary = '';
    app.overlayEvent = null;
  };
  const onEvent = async envelope => {
    if (stopped) return;
    const type = envelope.payload?.subscription?.type, event = envelope.payload?.event || {};
    const eventId = envelope.metadata?.message_id;
    if (type === 'stream.online') {
      await handleStream(event);
      return;
    }
    if (type === 'stream.offline') { endLater({grace: true}); return; }
    if (type === 'channel.chat.message') {
      const generation = privateGeneration;
      const timestamp = eventTime(envelope);
      if (removedIds.has(event.message_id) ||
          (timestamp && timestamp <= roomClearedAt) ||
          (timestamp && timestamp <= (userClearedAt.get(event.chatter_user_id) || 0))) return;
      if (eventId && app.one?.('SELECT id FROM events WHERE id=?',eventId)) return;
      if (event.message_id && app.one?.('SELECT id FROM messages WHERE id=?',event.message_id)) return;
      const badges = event.badges || [];
      const isModerator = badges.some(b => b.set_id === 'moderator' || b.set_id === 'broadcaster');
      const isVip = badges.some(b => b.set_id === 'vip');
      await app.ingest({
        id: event.message_id, eventId, viewerId: event.chatter_user_id,
        name: event.chatter_user_name, login:event.chatter_user_login, text: event.message?.text || '',
        timestamp: envelope.metadata?.message_timestamp,
        parentId: event.reply?.parent_message_id, moderator: isModerator, vip:isVip,
        shared: !!event.source_broadcaster_user_id,bot:isBot(event.chatter_user_login,event.chatter_user_name),
      });
      if (stopped || generation !== privateGeneration) return;
      if (/^!regulars\s+forget\s*$/i.test(event.message?.text || '')) {
        invalidateViewer(event.chatter_user_id);
        return;
      }
      const cleared=app.one ? app.one("SELECT id FROM messages WHERE id=? AND moderation='cleared'",event.message_id) : true;
      if (cleared && event.chatter_user_id === broadcasterId && /^!wrap\s*$/i.test(event.message?.text || '') && app.currentSession()) await app.wrap();
      const sticker=(event.message?.text || '').match(/^!sticker\s+(.{1,100}?)\s*$/i);
      if(cleared && sticker && stickerQueue.trigger(sticker[1],event.chatter_user_id)) lastStickerViewer=event.chatter_user_id;
      return;
    }
    if (type === 'channel.chat.message_delete') {
      rememberRemoved(event.message_id);
      app.removeMessage(event.message_id);
    }
    if (type === 'channel.chat.clear_user_messages' && event.target_user_id) {
      userClearedAt.set(event.target_user_id, eventTime(envelope));
      if (userClearedAt.size > 10000) userClearedAt.delete(userClearedAt.keys().next().value);
      for (const m of app.all('SELECT id FROM messages WHERE viewer_id=?', event.target_user_id)) app.removeMessage(m.id);
    }
    if (type === 'channel.chat.clear') {
      roomClearedAt = Math.max(roomClearedAt, eventTime(envelope));
      clearRoom();
    }
  };
  const client = clientFactory({
    clientId, accessToken, broadcasterId, onEvent,
    onStream: stream => {
      if (stream) void handleStream(stream);
      else endLater({grace: sawLiveStream});
    },
    onStatus: status => {
      if (stopped) return;
      if (status.revoked) {
        stopBridge();
        onStatus({ connected: false, reason: 'Twitch subscription revoked', revoked: status.revoked });
      } else onStatus(status);
    },
    onError: () => { if (!stopped) onStatus({ connected: false, reason: 'Twitch connection interrupted' }); },
  });
  app.broadcasterId = broadcasterId;
  app.deleteMessage = payload => client.deleteMessage(payload);
  app.deleteMessageAvailable = true;
  client.start();
  poll = setInterval(checkPresence, pollMs ?? (currentSettings.chatterPollSeconds ?? 30) * 1000);
  poll.unref?.();
  if (validationMs > 0) {
    validationTimer = setInterval(async () => {
      if (stopped || validating) return;
      validating = true;
      try { await validate({ clientId, accessToken: client.accessToken ?? accessToken, userId: broadcasterId }); }
      catch {
        if (!stopped) {
          stopBridge();
          onStatus({ connected: false, reason: 'Twitch token validation failed' });
        }
      } finally { validating = false; }
    }, validationMs);
    validationTimer.unref?.();
  }
  void checkPresence();
  return {
    client,
    updateSettings(settings) {
      if (stopped) return;
      const previousPollSeconds = currentSettings.chatterPollSeconds;
      currentSettings = {...currentSettings, ...settings};
      stickerQueue.updateCooldowns({
        viewerCooldownMs: (currentSettings.stickerViewerCooldownSeconds ?? 60) * 1000,
        channelCooldownMs: (currentSettings.stickerChannelCooldownSeconds ?? 10) * 1000,
      });
      if (currentSettings.chatterPollSeconds !== previousPollSeconds) {
        clearInterval(poll);
        poll = setInterval(checkPresence, (currentSettings.chatterPollSeconds ?? 30) * 1000);
        poll.unref?.();
      }
    },
    forget(viewerId) {
      app.forget(viewerId);
      invalidateViewer(viewerId);
    },
    clearPrivateState,
    reset: clearPrivateState,
    stop: stopBridge,
  };
}
