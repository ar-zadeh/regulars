import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TwitchClient, TWITCH_SCOPES, authorizationUrl, parseOAuthCallback,
  exchangeCode, validateAccessToken,
} from '../src/twitch.js';

const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const turn = () => new Promise(resolve => setTimeout(resolve, 10));

class Socket extends EventTarget {
  static instances = [];
  static created = new Set();
  constructor(url) {
    super(); this.url = url; this.closed = false; Socket.instances.push(this);
    for (const listener of Socket.created) listener(this);
  }
  message(data) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })); }
  close() { if (!this.closed) { this.closed = true; this.dispatchEvent(new Event('close')); } }
}

function nextSocket() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      Socket.created.delete(onCreate);
      reject(new Error('Timed out waiting for a socket'));
    }, 5000);
    function onCreate(socket) {
      clearTimeout(timer);
      Socket.created.delete(onCreate);
      resolve(socket);
    }
    Socket.created.add(onCreate);
  });
}

function welcome(socket, id = 'session') {
  socket.message({ metadata: { message_type: 'session_welcome' }, payload: { session: { id, keepalive_timeout_seconds: 10 } } });
}

test('OAuth URL, state validation, token exchange and missing scopes', async () => {
  const url = new URL(authorizationUrl({ clientId: 'client', redirectUri: 'http://localhost/callback', state: 'csrf' }));
  assert.equal(url.searchParams.get('scope'), TWITCH_SCOPES.join(' '));
  assert.equal(parseOAuthCallback('http://localhost/callback?code=abc&state=csrf', 'csrf'), 'abc');
  assert.throws(() => parseOAuthCallback('http://localhost/callback?code=abc&state=wrong', 'csrf'), /state mismatch/);
  assert.throws(() => parseOAuthCallback('http://localhost/callback?error=denied&state=csrf', 'csrf'), /denied/);
  let request;
  await exchangeCode({ clientId: 'client', clientSecret: 'secret', redirectUri: 'http://localhost/callback', code: 'abc', fetchImpl: async (url, options) => { request = { url, options }; return response({ access_token: 'token' }); } });
  assert.equal(request.url, 'https://id.twitch.tv/oauth2/token');
  assert.equal(request.options.body.get('grant_type'), 'authorization_code');
  assert.equal(request.options.body.get('client_secret'), 'secret');
  await assert.rejects(() => validateAccessToken({ clientId: 'client', accessToken: 'token', fetchImpl: async () => response({ client_id: 'client', user_id: 'viewer', scopes: ['user:read:chat'] }) }), /Missing Twitch scopes/);
  const valid = await validateAccessToken({ clientId: 'client', accessToken: 'token', fetchImpl: async () => response({ client_id: 'client', user_id: 'viewer', scopes: TWITCH_SCOPES }) });
  assert.equal(valid.user_id, 'viewer');
  await assert.rejects(() => validateAccessToken({ clientId: 'client', userId: 'owner', accessToken: 'token', fetchImpl: async () => response({ client_id: 'client', user_id: 'viewer', scopes: TWITCH_SCOPES }) }), /user ID mismatch/);
  await assert.rejects(() => validateAccessToken({ clientId: 'client', accessToken: 'token', fetchImpl: async () => response({ client_id: 'client', scopes: TWITCH_SCOPES }) }), /user ID mismatch/);
});

test('token validation times out or cancels stalled fetch and JSON parsing', async () => {
  const args={clientId:'client',accessToken:'synthetic',timeoutMs:5};
  await assert.rejects(validateAccessToken({...args,fetchImpl:()=>new Promise(()=>{})}),error=>error.name==='TimeoutError');
  await assert.rejects(validateAccessToken({...args,fetchImpl:async()=>({ok:true,json:()=>new Promise(()=>{})})}),error=>error.name==='TimeoutError');
  const controller=new AbortController();
  const work=validateAccessToken({...args,timeoutMs:1000,signal:controller.signal,fetchImpl:()=>new Promise(()=>{})});
  controller.abort();
  await assert.rejects(work,error=>error.name==='AbortError');
});

test('deletion requires a message id and sender metadata; it is idempotent', async () => {
  const calls = [];
  const client = new TwitchClient({ clientId: 'client', accessToken: 'token', broadcasterId: 'owner', fetchImpl: async (url, options) => { calls.push({ url: new URL(url), options }); return response(null, 204); } });
  await assert.rejects(() => client.deleteMessage({ messageId: '', senderId: 'a', isModerator: false }), /messageId/);
  await assert.rejects(() => client.deleteMessage({ messageId: 'x', senderId: 'a' }), /isModerator/);
  assert.equal(await client.deleteMessage({ messageId: 'y', senderId: 'owner', isModerator: false }), false);
  assert.equal(await client.deleteMessage({ messageId: 'z', senderId: 'a', isModerator: true }), false);
  assert.equal(await client.deleteMessage({ messageId: 'x', senderId: 'a', isModerator: false }), true);
  assert.equal(await client.deleteMessage({ messageId: 'x', senderId: 'a', isModerator: false }), false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.searchParams.get('message_id'), 'x');
  assert.equal(calls[0].url.searchParams.get('moderator_id'), 'owner');
});

test('stalled Twitch DELETE and JSON parsing time out without retaining an in-flight delete', async () => {
  let calls=0,signal;
  const client=new TwitchClient({clientId:'client',accessToken:'token',broadcasterId:'owner',requestTimeoutMs:5,
    fetchImpl:(_url,options)=>{
      calls++;signal=options.signal;
      if(calls===1) return new Promise(()=>{});
      return response(null,204);
    },
  });
  const payload={messageId:'message-1',senderId:'viewer',isModerator:false};
  await assert.rejects(client.deleteMessage(payload),error=>error.name==='TimeoutError');
  assert.equal(signal.aborted,true);
  assert.equal(await client.deleteMessage(payload),true);
  assert.equal(calls,2);

  const bodyClient=new TwitchClient({clientId:'client',accessToken:'token',broadcasterId:'owner',requestTimeoutMs:5,
    fetchImpl:async()=>({ok:true,status:200,json:()=>new Promise(()=>{})}),
  });
  await assert.rejects(bodyClient.getStream(),error=>error.name==='TimeoutError');
});

test('chatters are paginated and follower lookups use the viewer ID', async () => {
  const calls = [];
  const fetchImpl = async url => {
    url = new URL(url); calls.push(url);
    if (url.pathname.endsWith('/chatters')) return response(url.searchParams.has('after')
      ? { data: [{ user_id: '2' }], pagination: {} }
      : { data: [{ user_id: '1' }], pagination: { cursor: 'next' } });
    return response({ data: [{ user_id: '2', followed_at: '2026-01-01T00:00:00Z' }] });
  };
  const client = new TwitchClient({ clientId: 'client', accessToken: 'token', broadcasterId: 'owner', fetchImpl });
  assert.deepEqual((await client.getChatters()).map(x => x.user_id), ['1', '2']);
  assert.equal((await client.getFollower('2')).user_id, '2');
  assert.equal(calls[2].searchParams.get('user_id'), '2');
});

test('EventSub subscribes, delivers metadata, and migrates without resubscribing', async () => {
  Socket.instances = [];
  const calls = [], received = [], streams = [], errors = [];
  const fetchImpl = async (url, options) => {
    url = new URL(url); calls.push({ path: url.pathname, options });
    return url.pathname.endsWith('/streams') ? response({ data: [{ id: 'live' }] }) : response({ data: [] }, 202);
  };
  const client = new TwitchClient({ clientId: 'client', accessToken: 'token', broadcasterId: 'owner', WebSocketImpl: Socket, fetchImpl, onEvent: e => received.push(e), onStream: e => streams.push(e), onError: e => errors.push(e) });
  client.start();
  const original = Socket.instances[0]; welcome(original); await turn();
  const subs = calls.filter(x => x.path.endsWith('/subscriptions')).map(x => JSON.parse(x.options.body));
  assert.equal(subs.length, 6);
  assert.deepEqual(subs.find(s => s.type === 'channel.chat.message').condition, { broadcaster_user_id: 'owner', user_id: 'owner' });
  assert.deepEqual(subs.find(s => s.type === 'stream.online').condition, { broadcaster_user_id: 'owner' });
  original.message({ metadata: { message_type: 'notification', message_id: 'event-1', message_timestamp: '2026-01-01T00:00:00Z' }, payload: { event: { message_id: 'chat-1' } } });
  await turn();
  assert.equal(received[0].metadata.message_id, 'event-1');
  original.message({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?reconnect=abc' } } });
  assert.equal(Socket.instances.length, 2);
  welcome(Socket.instances[1], 'migrated'); await turn();
  assert.equal(original.closed, true);
  assert.equal(calls.filter(x => x.path.endsWith('/subscriptions')).length, 6);
  assert.equal(streams.length, 2);
  assert.deepEqual(errors, []);
  client.stop();
});

test('untrusted EventSub reconnect URLs are rejected', async () => {
  Socket.instances = [];
  const errors = [];
  const client = new TwitchClient({ clientId: 'client', accessToken: 'token', broadcasterId: 'owner', WebSocketImpl: Socket, fetchImpl: async url => new URL(url).pathname.endsWith('/streams') ? response({ data: [] }) : response({ data: [] }, 202), onError: e => errors.push(e) });
  client.start(); welcome(Socket.instances[0]); await turn();
  Socket.instances[0].message({ metadata: { message_type: 'session_reconnect' }, payload: { session: { reconnect_url: 'wss://attacker.example/ws' } } });
  await turn();
  assert.match(errors[0].message, /Invalid EventSub reconnect URL/);
  assert.equal(Socket.instances.length, 1);
  client.stop();
});

test('EventSub reconnect URL rejects credentials on the trusted host', async () => {
  Socket.instances = [];
  const errors = [];
  const client = new TwitchClient({ clientId: 'client', accessToken: 'token', broadcasterId: 'owner', WebSocketImpl: Socket,
    fetchImpl: async url => new URL(url).pathname.endsWith('/streams') ? response({ data: [] }) : response({ data: [] }, 202),
    onError: error => errors.push(error) });
  client.start(); welcome(Socket.instances[0]); await turn();
  Socket.instances[0].message({ metadata: { message_type: 'session_reconnect' }, payload: { session: {
    reconnect_url: 'wss://attacker@eventsub.wss.twitch.tv/ws?reconnect=abc',
  } } });
  await turn();
  assert.match(errors[0].message, /Invalid EventSub reconnect URL/);
  assert.equal(Socket.instances.length, 1);
  client.stop();
});

test('a socket without Welcome times out and reconnects', async () => {
  Socket.instances = [];
  const errors = [];
  const client = new TwitchClient({ clientId: 'client', accessToken: 'token', broadcasterId: 'owner', WebSocketImpl: Socket,
    welcomeTimeoutMs: 15, retryDelayMs: 5, onError: error => errors.push(error) });
  client.start();
  const first = Socket.instances[0];
  try {
    const second = await nextSocket();
    assert.equal(first.closed, true);
    assert.match(errors[0].message, /welcome timed out/);
    assert.notEqual(second, first);
    assert.equal(second.url, first.url);
  } finally {
    client.stop();
  }
});

test('Welcome timer ends before slow subscription requests complete', async () => {
  Socket.instances = [];
  const calls = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const client = new TwitchClient({ clientId: 'client', accessToken: 'token', broadcasterId: 'owner', WebSocketImpl: Socket,
    welcomeTimeoutMs: 15, fetchImpl: async url => {
      calls.push(new URL(url).pathname);
      if (new URL(url).pathname.endsWith('/subscriptions')) await held;
      return new URL(url).pathname.endsWith('/streams') ? response({ data: [] }) : response({ data: [] }, 202);
    } });
  client.start();
  const socket = Socket.instances[0];
  welcome(socket);
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(calls.filter(path => path.endsWith('/subscriptions')).length, 6);
  assert.equal(socket.closed, false);
  release();
  await turn();
  client.stop();
});
