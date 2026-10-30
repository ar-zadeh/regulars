import { timingSafeEqual } from 'node:crypto';

export const TWITCH_SCOPES = Object.freeze([
  'user:read:chat',
  'moderator:manage:chat_messages',
  'moderator:read:chatters',
  'moderator:read:followers',
]);

const AUTH = 'https://id.twitch.tv/oauth2';
const HELIX = 'https://api.twitch.tv/helix';
const EVENTSUB = 'wss://eventsub.wss.twitch.tv/ws';
const SUBSCRIPTIONS = [
  'channel.chat.message', 'stream.online', 'stream.offline',
  'channel.chat.message_delete', 'channel.chat.clear_user_messages',
  'channel.chat.clear',
];

function required(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function awaitAbortable(work, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(work).then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

// State must be generated cryptographically, stored per browser session, and
// consumed once by the caller. It is deliberately not stored by this module.
export function authorizationUrl({ clientId, redirectUri, state }) {
  const url = new URL(`${AUTH}/authorize`);
  url.search = new URLSearchParams({
    client_id: required(clientId, 'clientId'),
    redirect_uri: required(redirectUri, 'redirectUri'),
    response_type: 'code', scope: TWITCH_SCOPES.join(' '),
    state: required(state, 'state'),
  });
  return url.toString();
}

export function parseOAuthCallback(callbackUrl, expectedState) {
  const url = new URL(callbackUrl, 'http://localhost');
  const actual = Buffer.from(url.searchParams.get('state') ?? '');
  const expected = Buffer.from(required(expectedState, 'expectedState'));
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('OAuth state mismatch');
  }
  if (url.searchParams.has('error')) throw new Error('Twitch authorization denied');
  return required(url.searchParams.get('code'), 'authorization code');
}

async function tokenRequest(fetchImpl, fields) {
  const response = await fetchImpl(`${AUTH}/token`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  });
  if (!response.ok) throw new Error(`Twitch token request failed (${response.status})`);
  return response.json();
}

export function exchangeCode({ clientId, clientSecret, redirectUri, code, fetchImpl = fetch }) {
  return tokenRequest(fetchImpl, {
    client_id: required(clientId, 'clientId'), client_secret: required(clientSecret, 'clientSecret'),
    redirect_uri: required(redirectUri, 'redirectUri'), code: required(code, 'code'),
    grant_type: 'authorization_code',
  });
}

export function refreshAccessToken({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  return tokenRequest(fetchImpl, {
    client_id: required(clientId, 'clientId'), client_secret: required(clientSecret, 'clientSecret'),
    refresh_token: required(refreshToken, 'refreshToken'), grant_type: 'refresh_token',
  });
}

export async function validateAccessToken({ accessToken, clientId, userId, fetchImpl = fetch, timeoutMs = 10000, signal }) {
  if(!Number.isSafeInteger(timeoutMs) || timeoutMs<=0) throw new Error('Invalid Twitch validation timeout');
  const requestSignal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
  if(requestSignal.aborted) throw requestSignal.reason;
  const response = await awaitAbortable(fetchImpl(`${AUTH}/validate`, {
    headers: { authorization: `OAuth ${required(accessToken, 'accessToken')}` }, signal: requestSignal,
  }),requestSignal);
  if (!response.ok) throw new Error(`Twitch token validation failed (${response.status})`);
  const token = await awaitAbortable(response.json(),requestSignal);
  if (clientId && token.client_id !== clientId) throw new Error('Twitch token client ID mismatch');
  if (!token.user_id || (userId && token.user_id !== userId)) throw new Error('Twitch token user ID mismatch');
  const missing = TWITCH_SCOPES.filter(scope => !token.scopes?.includes(scope));
  if (missing.length) throw new Error(`Missing Twitch scopes: ${missing.join(', ')}`);
  return token;
}

function reconnectUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'wss:' || url.hostname !== 'eventsub.wss.twitch.tv' ||
      url.username || url.password || url.port || url.pathname !== '/ws' || url.hash) {
    throw new Error('Invalid EventSub reconnect URL');
  }
  return url.toString();
}

/**
 * Twitch transport. Callers persist/refresh tokens, enforce OAuth state and
 * owner authorization, and deduplicate notification IDs durably before action.
 * No user data or tokens are written to disk by this adapter.
 */
export class TwitchClient {
  constructor({ clientId, accessToken, broadcasterId, userId = broadcasterId,
    fetchImpl = fetch, WebSocketImpl = WebSocket, onEvent = () => {},
    onStream = () => {}, onStatus = () => {}, onError = () => {},
    retryDelayMs = 1000, welcomeTimeoutMs = 10000, requestTimeoutMs = 10000 } = {}) {
    this.clientId = required(clientId, 'clientId');
    this.accessToken = required(accessToken, 'accessToken');
    this.broadcasterId = required(broadcasterId, 'broadcasterId');
    this.userId = required(userId, 'userId');
    if(!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs<=0) throw new Error('Invalid Twitch request timeout');
    Object.assign(this, { fetchImpl, WebSocketImpl, onEvent, onStream, onStatus, onError, retryDelayMs, welcomeTimeoutMs, requestTimeoutMs });
    this.sockets = new Set();
    this.active = null;
    this.stopped = true;
    this.retryTimer = null;
    this.heartbeat = null;
    this.completedDeletes = new Set();
    this.inflightDeletes = new Map();
  }

  setAccessToken(token) { this.accessToken = required(token, 'accessToken'); }

  async request(path, { method = 'GET', params = {}, body } = {}) {
    const url = new URL(`${HELIX}${path}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    const headers = { 'Client-Id': this.clientId, Authorization: `Bearer ${this.accessToken}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const signal=AbortSignal.timeout(this.requestTimeoutMs);
    const response = await awaitAbortable(this.fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal }),signal);
    if (!response.ok) throw new Error(`Twitch API ${path} failed (${response.status})`);
    return response.status === 204 ? null : awaitAbortable(response.json(),signal);
  }

  async getStream() {
    const result = await this.request('/streams', { params: { user_id: this.broadcasterId } });
    return result.data?.[0] ?? null;
  }

  async getChatters() {
    let cursor;
    const all = [];
    do {
      const result = await this.request('/chat/chatters', { params: {
        broadcaster_id: this.broadcasterId, moderator_id: this.userId, first: 1000, after: cursor,
      } });
      all.push(...(result.data ?? []));
      cursor = result.pagination?.cursor;
    } while (cursor);
    return all;
  }

  async getFollower(viewerId) {
    const result = await this.request('/channels/followers', { params: {
      broadcaster_id: this.broadcasterId, user_id: required(viewerId, 'viewerId'), first: 1,
    } });
    return result.data?.[0] ?? null;
  }

  // Safety-critical: Twitch interprets an absent message_id as clear-chat.
  // Permission to delete is decided by the caller, which must provide sender
  // identity and moderator status derived from the message's badges.
  async deleteMessage({ messageId, senderId, isModerator }) {
    messageId = required(messageId, 'messageId');
    senderId = required(senderId, 'senderId');
    if (typeof isModerator !== 'boolean') throw new Error('isModerator is required');
    if (senderId === this.broadcasterId || isModerator) return false;
    if (this.completedDeletes.has(messageId)) return false;
    if (this.inflightDeletes.has(messageId)) return this.inflightDeletes.get(messageId);
    const promise = this.request('/moderation/chat', { method: 'DELETE', params: {
      broadcaster_id: this.broadcasterId, moderator_id: this.userId, message_id: messageId,
    } }).then(() => { this.completedDeletes.add(messageId); return true; })
      .finally(() => this.inflightDeletes.delete(messageId));
    this.inflightDeletes.set(messageId, promise);
    return promise;
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect(EVENTSUB, false);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.heartbeat);
    this.retryTimer = this.heartbeat = null;
    this.active = null;
    for (const socket of this.sockets) socket.close();
    this.sockets.clear();
  }

  connect(url, migrating) {
    if (this.stopped) return;
    let socket;
    try { socket = new this.WebSocketImpl(url); }
    catch (error) { this.onError(error); this.scheduleReconnect(); return; }
    this.sockets.add(socket);
    let welcomed = false;
    const welcomeTimer = setTimeout(() => {
      if (!welcomed && this.sockets.has(socket)) {
        this.onError(new Error('EventSub welcome timed out'));
        socket.close();
      }
    }, this.welcomeTimeoutMs);
    welcomeTimer.unref?.();
    socket.addEventListener('message', event => {
      void this.handleMessage(socket, event.data, migrating, () => {
        welcomed = true;
        clearTimeout(welcomeTimer);
      }).then(welcome => {
        if (welcome) { welcomed = true; clearTimeout(welcomeTimer); }
      }).catch(error => { this.onError(error); socket.close(); });
    });
    socket.addEventListener('error', () => this.onError(new Error('EventSub WebSocket error')));
    socket.addEventListener('close', () => {
      clearTimeout(welcomeTimer);
      this.sockets.delete(socket);
      if (this.stopped) return;
      // An old socket closed during successful migration, so no restart.
      if (socket === this.active) { this.active = null; clearTimeout(this.heartbeat); this.scheduleReconnect(); }
      else if (!welcomed && (!this.active || migrating)) {
        if (migrating && this.active) { this.active.close(); this.active = null; }
        this.scheduleReconnect();
      }
    });
  }

  scheduleReconnect() {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect(EVENTSUB, false);
    }, this.retryDelayMs);
    this.retryTimer.unref?.();
  }

  resetHeartbeat(seconds) {
    clearTimeout(this.heartbeat);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    this.heartbeat = setTimeout(() => {
      this.onError(new Error('EventSub keepalive timed out'));
      this.active?.close();
    }, (seconds + 2) * 1000);
    this.heartbeat.unref?.();
  }

  async handleMessage(socket, data, migrating, onWelcome = () => {}) {
    const message = JSON.parse(typeof data === 'string' ? data : String(data));
    const type = message.metadata?.message_type;
    if (type === 'session_welcome') {
      if (this.stopped || !this.sockets.has(socket)) return false;
      const session = message.payload?.session;
      const sessionId = required(session?.id, 'EventSub session id');
      onWelcome();
      const previous = this.active;
      this.active = socket;
      this.keepaliveSeconds = session.keepalive_timeout_seconds;
      this.resetHeartbeat(this.keepaliveSeconds);
      if (migrating) {
        // Twitch transfers the subscriptions; creating them again duplicates work.
        if (previous && previous !== socket) previous.close();
      } else {
        await Promise.all(SUBSCRIPTIONS.map(subscription => {
          const condition = { broadcaster_user_id: this.broadcasterId };
          if (subscription.startsWith('channel.chat.')) condition.user_id = this.userId;
          return this.request('/eventsub/subscriptions', { method: 'POST', body: {
            type: subscription, version: '1', condition,
            transport: { method: 'websocket', session_id: sessionId },
          } });
        }));
      }
      if (this.stopped || this.active !== socket) return true;
      this.onStream(await this.getStream());
      this.onStatus({ connected: true, sessionId });
      return true;
    }
    if (socket !== this.active) return false;
    this.resetHeartbeat(this.keepaliveSeconds);
    if (type === 'session_reconnect') this.connect(reconnectUrl(message.payload?.session?.reconnect_url), true);
    else if (type === 'notification') await this.onEvent(message);
    else if (type === 'revocation') this.onStatus({ connected: true, revoked: message.payload?.subscription?.type });
    return false;
  }
}
