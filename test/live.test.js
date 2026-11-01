import test from 'node:test';
import assert from 'node:assert/strict';
import {connectLive} from '../src/live.js';
import {Regulars} from '../src/core.js';

test('live bridge routes messages, presence, removals and broadcaster wrap',async()=>{
  const calls=[],app={currentSession:()=>({id:'session'}),startSession:()=>calls.push('start'),ingest:async e=>calls.push(e),sight:v=>calls.push(v),removeMessage:id=>calls.push(['remove',id]),wrap:async()=>calls.push('wrap'),all:()=>[],run:()=>{}};
  let options;const bridge=await connectLive({app,clientId:'client',accessToken:'token',broadcasterId:'owner',validate:async()=>{},clientFactory:o=>(options=o,{start(){},stop(){},getChatters:async()=>[{user_id:'v',user_name:'Viewer'}],deleteMessage:async()=>true,getStream:async()=>null}),pollMs:999999});
  await options.onEvent({metadata:{message_id:'evt',message_timestamp:'2026-01-01T00:00:00Z'},payload:{subscription:{type:'channel.chat.message'},event:{message_id:'m',chatter_user_id:'owner',chatter_user_name:'Owner',message:{text:'!wrap'},badges:[]}}});
  await options.onEvent({payload:{subscription:{type:'channel.chat.message_delete'},event:{message_id:'m'}}});
  assert.ok(calls.some(c=>c.id==='m' && c.eventId==='evt'));assert.ok(calls.includes('wrap'));assert.deepEqual(calls.at(-1),['remove','m']);bridge.stop();
});

test('live emote fragments skip topic discovery while mixed text still participates',async t=>{
  const inputs=[];
  const app=new Regulars({ai:{classify:async input=>{inputs.push(input);return {category:'other',addressesAI:0,topics:[],subjects:[]};}}});
  app.startSession();
  let options;
  const bridge=await connectLive({app,clientId:'client',accessToken:'token',broadcasterId:'owner',validate:async()=>{},
    clientFactory:o=>(options=o,{start(){},stop(){},getChatters:async()=>[],deleteMessage:async()=>true}),pollMs:999999});
  t.after(()=>{bridge.stop();app.close();});
  const send=async(id,text,fragments)=>options.onEvent({metadata:{message_id:`event-${id}`},payload:{subscription:{type:'channel.chat.message'},
    event:{message_id:id,chatter_user_id:'viewer',chatter_user_name:'Viewer',message:{text,fragments},badges:[]}}});
  await send('emote','CustomWave CustomDance',[{type:'emote',text:'CustomWave'},{type:'text',text:' '},{type:'emote',text:'CustomDance'}]);
  await send('emote-emoji','CustomWave 😂',[{type:'emote',text:'CustomWave'},{type:'text',text:' 😂'}]);
  await send('mixed','CustomWave nice camera',[{type:'emote',text:'CustomWave'},{type:'text',text:' nice camera'}]);
  await send('plain','My camera is new',[{type:'text',text:'My camera is new'}]);
  assert.deepEqual(inputs.map(input=>input.organize),[false,false,true,true]);
  assert.equal(app.one("SELECT organizer FROM messages WHERE id='emote'").organizer,'reaction');
  assert.equal(app.rows().find(m=>m.id==='emote-emoji').topicEligible,false);
  assert.equal(app.one("SELECT organizer FROM messages WHERE id='mixed'").organizer,'new');
});

test('presence snapshot replaces the previous successful poll and clears on stop', async () => {
  const app = {
    currentSession: () => ({id: 'session'}), sight() {}, startSession() {},
  };
  let options, chatters = [{user_id: 'first', user_name: 'First'}];
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, clientFactory: o => (options = o, {
      start() {}, stop() {}, getChatters: async () => chatters, deleteMessage: async () => true,
    }), pollMs: 999999,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...app.presentIds], ['first']);
  chatters = [{user_id: 'second', user_name: 'Second'}];
  options.onStream({started_at: '2026-01-01T00:00:00Z'});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...app.presentIds], ['second']);
  bridge.stop();
  assert.deepEqual([...app.presentIds], []);
});

test('updated polling interval takes effect without reconnecting and stops cleanly', async () => {
  let polls=0;
  const app={currentSession:()=>({id:'session'}),sight(){}};
  const bridge=await connectLive({app,clientId:'client',accessToken:'token',broadcasterId:'owner',
    validate:async()=>{},clientFactory:()=>({start(){},stop(){},getChatters:async()=>{polls++;return [];},deleteMessage:async()=>true}),pollMs:999999});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(polls,1);
  bridge.updateSettings({chatterPollSeconds:0.01,stickerViewerCooldownSeconds:60,stickerChannelCooldownSeconds:10});
  await new Promise(resolve=>setTimeout(resolve,35));
  assert.ok(polls>=2);
  bridge.stop();
  const stopped=polls;
  bridge.updateSettings({chatterPollSeconds:0.001});
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(polls,stopped);
});

test('cooldown-only settings change keeps the current presence polling interval', async () => {
  let polls = 0;
  const app = {currentSession: () => ({id: 'session'}), sight() {}};
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, clientFactory: () => ({
      start() {}, stop() {}, getChatters: async () => {polls++; return [];},
      deleteMessage: async () => true,
    }), pollMs: 5,
  });
  bridge.updateSettings({stickerViewerCooldownSeconds: 30});
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(polls >= 2);
  bridge.stop();
});

test('room clear erases text and sticker source while preserving award eligibility', async () => {
  const app = new Regulars({ai: {classify: async () => ({category: 'other', topics: [], subjects: []})}});
  const session = app.startSession('2026-01-01T00:00:00Z');
  app.run("INSERT INTO viewers(id,name) VALUES ('viewer','Viewer')");
  app.run("INSERT INTO messages(id,session_id,viewer_id,name,timestamp,text,moderation,organizer) VALUES ('m',?,'viewer','Viewer','2026-01-01T00:01:00Z','private text','cleared','new')", session.id);
  app.run("INSERT INTO awards(session_id,title,viewer_id,evidence) VALUES (?,'Night Owl','viewer','[\"m\"]')", session.id);
  app.run("INSERT INTO stickers(id,name,subject,brief,approved,source_ids,contributor_ids) VALUES ('s','s','s','brief',1,'[\"m\"]','[\"viewer\"]')");
  let options;
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, clientFactory: o => (options = o, {
      start() {}, stop() {}, getChatters: async () => [], deleteMessage: async () => true,
    }), pollMs: 999999,
  });
  await options.onEvent({payload: {subscription: {type: 'channel.chat.clear'}, event: {}}});
  assert.equal(app.one("SELECT text FROM messages WHERE id='m'").text, null);
  assert.equal(app.one("SELECT active FROM awards WHERE title='Night Owl'").active, 1);
  assert.equal(app.one("SELECT approved FROM stickers WHERE id='s'").approved, 0);
  bridge.stop();
  app.close();
});

test('a live stream cancels pending offline confirmation', async () => {
  let active = true, options, checks = 0, wraps = 0;
  const app = {
    currentSession: () => active ? {id: 'session'} : null,
    startSession() { active = true; }, sight() {}, all: () => [], run() { active = false; },
    async wrap() { wraps++; },
  };
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, clientFactory: o => (options = o, {
      start() {}, stop() {}, getChatters: async () => [], deleteMessage: async () => true,
      getStream: async () => { checks++; return {started_at: '2026-01-01T00:00:00Z'}; },
    }), pollMs: 999999, offlineMs: 1,
  });
  await options.onEvent({payload: {subscription: {type: 'stream.offline'}, event: {}}});
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(checks, 1);
  assert.equal(wraps, 0);
  assert.equal(active, true);
  bridge.stop();
});

test('first Get Chatters snapshot uses core presence handling without arrival nudges', async () => {
  const app = new Regulars({ai: {classify: async () => ({category: 'other', topics: [], subjects: []})}});
  app.startSession('2026-01-01T00:00:00Z');
  app.run("INSERT INTO viewers(id,name,seen,total,last_seen) VALUES ('regular','Regular','[1,2]',2,2)");
  // Make the current stream number 3 while retaining prior participation.
  app.run("UPDATE sessions SET idx=3 WHERE end IS NULL");
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, clientFactory: () => ({
      start() {}, stop() {}, getChatters: async () => [{user_id: 'regular', user_name: 'Regular'}],
      deleteMessage: async () => true,
    }), pollMs: 999999,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...app.presentIds], ['regular']);
  assert.equal(app.all('SELECT id FROM nudges').length, 0);
  bridge.stop();
  app.close();
});

test('broadcaster wrap runs only after moderation clears the command', async () => {
  let options, moderation = 'hidden', wraps = 0;
  const app = {
    currentSession: () => ({id: 'session'}), sight() {}, startSession() {},
    ingest: async () => {}, wrap: async () => {wraps++;},
    one: sql => sql.includes("moderation='cleared'") && moderation === 'cleared' ? {id: 'm'} : null,
    all: () => [], run() {},
  };
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, clientFactory: o => (options = o, {
      start() {}, stop() {}, getChatters: async () => [], deleteMessage: async () => true,
    }), pollMs: 999999,
  });
  const event = id => ({metadata: {message_id: id}, payload: {
    subscription: {type: 'channel.chat.message'}, event: {
      message_id: id, chatter_user_id: 'owner', chatter_user_name: 'Owner',
      message: {text: '!wrap'}, badges: [{set_id: 'broadcaster'}],
    },
  }});
  await options.onEvent(event('held'));
  assert.equal(wraps, 0);
  moderation = 'cleared';
  await options.onEvent(event('cleared'));
  assert.equal(wraps, 1);
  bridge.stop();
});

test('cleared sticker command queues an approved sticker once', async () => {
  let options, moderation = 'cleared';
  const sticker = {
    id: 'sticker', name: 'Wave', image: 'image-data', approved: 1,
    source_ids: '["source"]', contributor_ids: '["viewer"]',
  };
  const app = {
    currentSession: () => ({id: 'session'}), sight() {}, startSession() {},
    ingest: async () => {}, all: () => [], run() {},
    one(sql) {
      if (sql.includes("moderation='cleared'") && sql.includes('SELECT id FROM messages WHERE id=?')) {
        return moderation === 'cleared' ? {id: 'source'} : null;
      }
      if (sql.includes('SELECT * FROM stickers')) return sticker;
      if (sql.includes('SELECT id FROM viewers')) return {id: 'viewer'};
      return null;
    },
  };
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, clientFactory: o => (options = o, {
      start() {}, stop() {}, getChatters: async () => [], deleteMessage: async () => true,
    }), pollMs: 999999,
  });
  const send = id => options.onEvent({metadata: {message_id: id}, payload: {
    subscription: {type: 'channel.chat.message'}, event: {
      message_id: id, chatter_user_id: 'viewer', chatter_user_name: 'Viewer',
      message: {text: '!sticker Wave'}, badges: [],
    },
  }});
  moderation = 'hidden';
  await send('held');
  assert.equal(app.overlayEvent, undefined);
  moderation = 'cleared';
  await send('cleared');
  assert.equal(app.overlayEvent?.type, 'sticker');
  const firstId = app.overlayEvent.id;
  await send('duplicate');
  assert.equal(app.overlayEvent.id, firstId);
  bridge.stop();
});

test('forget command invalidates queued stickers and releases its channel cooldown', async () => {
  let options, forgotten = false;
  const sticker = {id: 'sticker', name: 'Wave', image: 'image-data', approved: 1,
    source_ids: '["source"]', contributor_ids: '["contributor"]'};
  const app = {
    currentSession: () => ({id: 'session'}), sight() {}, startSession() {},
    forget() { forgotten = true; this.overlayEvent = null; },
    async ingest(event) {
      if (/^!regulars\s+forget$/i.test(event.text)) this.forget(event.viewerId);
    },
    all: () => [], run() {},
    one(sql, id) {
      if (sql.includes('SELECT opted_out FROM viewers')) return id === 'first' && forgotten ? {opted_out: 1} : null;
      if (sql.includes("moderation='cleared'")) return {id};
      if (sql.includes('SELECT * FROM stickers')) return sticker;
      if (sql.includes('SELECT id FROM viewers')) return {id};
      return null;
    },
  };
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, clientFactory: o => (options = o, {
      start() {}, stop() {}, getChatters: async () => [], deleteMessage: async () => true,
    }), pollMs: 999999,
  });
  const send = (id, viewer, text) => options.onEvent({metadata: {message_id: id}, payload: {
    subscription: {type: 'channel.chat.message'}, event: {
      message_id: id, chatter_user_id: viewer, chatter_user_name: viewer,
      message: {text}, badges: [],
    },
  }});
  await send('one', 'first', '!sticker Wave');
  assert.equal(app.overlayEvent?.type, 'sticker');
  await send('two', 'first', '!regulars forget');
  assert.equal(forgotten, true);
  assert.equal(app.overlayEvent, null);
  await send('three', 'second', '!sticker Wave');
  assert.equal(app.overlayEvent?.type, 'sticker');
  bridge.stop();
});

test('bridge forget and reset clear private queue state without disconnecting', async () => {
  let options, stops = 0, forgot = null;
  const app = {
    currentSession: () => ({id: 'session'}), sight() {}, startSession() {},
    forget(id) { forgot = id; }, all: () => [], run() {}, removeMessage() {},
  };
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, clientFactory: o => (options = o, {
      start() {}, stop() {stops++;}, getChatters: async () => [], deleteMessage: async () => true,
    }), pollMs: 999999,
  });
  bridge.forget('viewer');
  assert.equal(forgot, 'viewer');
  await options.onEvent({payload: {subscription: {type: 'channel.chat.message_delete'}, event: {message_id: 'm'}}});
  bridge.reset();
  assert.equal(stops, 0);
  assert.deepEqual([...app.presentIds], []);
  bridge.clearPrivateState();
  assert.equal(stops, 0);
  bridge.stop();
  assert.equal(stops, 1);
});

test('reset discards a chat command that finishes ingesting afterward', async () => {
  let options, finishIngest, wraps = 0;
  const app = {
    currentSession: () => ({id: 'session'}), sight() {}, startSession() {},
    ingest: () => new Promise(resolve => {finishIngest = resolve;}),
    wrap: async () => {wraps++;}, all: () => [], run() {},
    one: sql => sql.includes("moderation='cleared'") ? {id: 'm'} : null,
  };
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, clientFactory: o => (options = o, {
      start() {}, stop() {}, getChatters: async () => [], deleteMessage: async () => true,
    }), pollMs: 999999,
  });
  const pending = options.onEvent({payload: {subscription: {type: 'channel.chat.message'},
    event: {message_id: 'm', chatter_user_id: 'owner', chatter_user_name: 'Owner',
      message: {text: '!wrap'}, badges: [{set_id: 'broadcaster'}]}}});
  bridge.reset();
  finishIngest();
  await pending;
  assert.equal(wraps, 0);
  bridge.stop();
});

test('default and configured bots receive topic checks but no presence or award eligibility', async () => {
  const checks = [];
  const app = new Regulars({ai: {classify: async input => {
    checks.push({text: input.text, organize: input.organize});
    return {category: 'other', topics: input.text.includes('blocked')
      ? [{id: ruleId, score: 0.9}] : [], subjects: []};
  }}});
  const ruleId = app.addRule({name: 'blocked', action: 'hide'});
  app.startSession('2026-01-01T00:00:00Z');
  let options;
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    botNames: ['  CustomBot  '], validate: async () => {},
    clientFactory: o => (options = o, {
      start() {}, stop() {}, getChatters: async () => [
        {user_id: 'default', user_login: 'nightbot', user_name: 'Nightbot'},
        {user_id: 'custom', user_login: 'custombot', user_name: 'CustomBot'},
        {user_id: 'person', user_login: 'person', user_name: 'Person'},
      ], deleteMessage: async () => true,
    }), pollMs: 999999,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual([...app.presentIds], ['person']);
  assert.equal(app.one("SELECT id FROM viewers WHERE id='default'"), undefined);
  assert.equal(app.one("SELECT id FROM viewers WHERE id='custom'"), undefined);
  const send = (id, user, login, name, text) => options.onEvent({
    metadata: {message_id: 'evt-' + id, message_timestamp: '2026-01-01T00:01:00Z'},
    payload: {subscription: {type: 'channel.chat.message'}, event: {
      message_id: id, chatter_user_id: user, chatter_user_login: login,
      chatter_user_name: name, message: {text}, badges: [],
    }},
  });
  await send('one', 'default', 'nightbot', 'Nightbot', 'blocked topic');
  await send('two', 'custom', 'custombot', 'CustomBot', 'ordinary message');
  assert.deepEqual(checks.map(check => check.organize), [false, false]);
  assert.equal(app.one("SELECT moderation FROM messages WHERE id='one'").moderation, 'hidden');
  assert.equal(app.one("SELECT bot FROM messages WHERE id='two'").bot, 1);
  assert.equal(app.one("SELECT organizer FROM messages WHERE id='two'").organizer, 'reaction');
  assert.equal(app.one("SELECT id FROM viewers WHERE id='custom'"), undefined);
  await app.wrap({play: false});
  assert.deepEqual(app.awards(), []);
  bridge.stop();
  app.close();
});

test('revocation stops ingestion and polling and reports disconnected', async () => {
  let options, stops = 0, ingests = 0, polls = 0;
  const statuses = [];
  const app = {
    currentSession: () => ({id: 'session'}), sight() {}, startSession() {},
    ingest: async () => {ingests++;}, all: () => [], run() {},
  };
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, onStatus: status => statuses.push(status),
    clientFactory: o => (options = o, {
      start() {}, stop() {stops++;}, getChatters: async () => {polls++; return [];},
      deleteMessage: async () => true,
    }), pollMs: 1,
  });
  const pollsAtRevocation = polls;
  options.onStatus({connected: true, revoked: 'channel.chat.message'});
  await options.onEvent({payload: {subscription: {type: 'channel.chat.message'}, event: {
    message_id: 'm', chatter_user_id: 'viewer', message: {text: 'hello'},
  }}});
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(stops, 1);
  assert.equal(ingests, 0);
  assert.equal(polls, pollsAtRevocation);
  assert.equal(statuses.at(-1).connected, false);
  assert.equal(statuses.at(-1).revoked, 'channel.chat.message');
  bridge.stop();
});

test('periodic token validation stops the bridge when authorization fails', async () => {
  let validations = 0, stops = 0;
  const statuses = [];
  const app = {currentSession: () => null};
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {if (++validations > 1) throw new Error('secret details');},
    onStatus: status => statuses.push(status),
    clientFactory: () => ({
      start() {}, stop() {stops++;}, getChatters: async () => [], deleteMessage: async () => true,
    }), pollMs: 999999, validationMs: 1,
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(validations, 2);
  assert.equal(stops, 1);
  assert.deepEqual(statuses.at(-1), {connected: false, reason: 'Twitch token validation failed'});
  bridge.stop();
});

test('periodic validation uses the refreshed client token', async () => {
  const tokens = [];
  let client;
  const bridge = await connectLive({
    app: {currentSession: () => null}, clientId: 'client', accessToken: 'initial-token',
    broadcasterId: 'owner', validate: async ({accessToken}) => {tokens.push(accessToken);},
    clientFactory: () => (client = {
      accessToken: 'initial-token', setAccessToken(token) {this.accessToken = token;},
      start() {}, stop() {}, getChatters: async () => [], deleteMessage: async () => true,
    }), pollMs: 999999, validationMs: 1,
  });
  bridge.client.setAccessToken('refreshed-token');
  await new Promise(resolve => setTimeout(resolve, 10));
  bridge.stop();
  assert.equal(tokens[0], 'initial-token');
  assert.ok(tokens.slice(1).length > 0);
  assert.ok(tokens.slice(1).every(token => token === 'refreshed-token'));
});

test('live message forwards login and VIP badge for core eligibility rules', async () => {
  const app = new Regulars({ai: {classify: async () => ({category: 'other', topics: [], subjects: []})}});
  app.startSession('2026-01-01T00:00:00Z');
  let options;
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, clientFactory: o => (options = o, {
      start() {}, stop() {}, getChatters: async () => [], deleteMessage: async () => true,
    }), pollMs: 999999,
  });
  await options.onEvent({metadata: {message_id: 'event', message_timestamp: '2026-01-01T00:01:00Z'},
    payload: {subscription: {type: 'channel.chat.message'}, event: {
      message_id: 'message', chatter_user_id: 'viewer', chatter_user_login: 'viewer_login',
      chatter_user_name: 'Viewer', badges: [{set_id: 'vip'}], message: {text: 'hello'},
    }}});
  const message = app.one("SELECT login,vip,moderator FROM messages WHERE id='message'");
  assert.deepEqual({...message}, {login: 'viewer_login', vip: 1, moderator: 0});
  bridge.stop();
  app.close();
});

test('restart stream check closes a stale open session but preserves same-stream reconnect', async () => {
  let options, wraps = 0;
  const sessions = [{id: 'old', start: '2026-01-01T00:00:00.000Z', end: null}];
  const app = {
    currentSession: () => sessions.find(s => !s.end) || null,
    startSession(start) {
      if (!this.currentSession()) sessions.push({id: 'new', start, end: null});
      return this.currentSession();
    },
    wrap: async ({play}) => {assert.equal(play, false); wraps++;},
    run(sql, end, id) {sessions.find(s => s.id === id).end = end;},
    sight() {}, all: () => [],
  };
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, clientFactory: o => (options = o, {
      start() {}, stop() {}, getChatters: async () => [], deleteMessage: async () => true,
    }), pollMs: 999999,
  });
  options.onStream({id: 'fresh-stream', started_at: '2026-01-02T00:00:00Z'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wraps, 1);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].end, '2026-01-02T00:00:00.000Z');
  assert.equal(app.currentSession().start, '2026-01-02T00:00:00.000Z');
  options.onStream({id: 'fresh-stream', started_at: '2026-01-02T00:00:00Z'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wraps, 1);
  assert.equal(sessions.length, 2);
  bridge.stop();
});

test('a different stream within the offline grace stays in one session', async () => {
  let options, wraps = 0;
  const session = {id: 'old', start: '2026-01-01T00:00:00Z'};
  const app = {
    currentSession: () => session, startSession: () => session,
    wrap: async () => {wraps++;}, sight() {}, all: () => [], run() {},
  };
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, clientFactory: o => (options = o, {
      start() {}, stop() {}, getChatters: async () => [], deleteMessage: async () => true,
      getStream: async () => null,
    }), pollMs: 999999, offlineMs: 100000,
  });
  await options.onEvent({payload: {subscription: {type: 'stream.offline'}, event: {}}});
  await options.onEvent({payload: {subscription: {type: 'stream.online'},
    event: {id: 'new-id', started_at: '2026-01-01T01:00:00Z'}}});
  options.onStream({id: 'new-id', started_at: '2026-01-01T01:00:00Z'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wraps, 0);
  bridge.stop();
});

test('startup offline lookup does not grant grace to a different stream', async () => {
  let options, wraps = 0;
  const sessions = [{id: 'old', start: '2026-01-01T00:00:00Z', end: null}];
  const app = {
    currentSession: () => sessions.find(s => !s.end) || null,
    startSession(start) {
      if (!this.currentSession()) sessions.push({id: 'new', start, end: null});
      return this.currentSession();
    },
    wrap: async () => {wraps++;},
    run(sql, end, id) {sessions.find(s => s.id === id).end = end;},
    sight() {}, all: () => [],
  };
  const bridge = await connectLive({
    app, clientId: 'client', accessToken: 'token', broadcasterId: 'owner',
    validate: async () => {}, clientFactory: o => (options = o, {
      start() {}, stop() {}, getChatters: async () => [], deleteMessage: async () => true,
    }), pollMs: 999999, offlineMs: 100000,
  });
  options.onStream(null);
  options.onStream({id: 'new-stream', started_at: '2026-01-02T00:00:00Z'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wraps, 1);
  assert.equal(sessions.length, 2);
  bridge.stop();
});
