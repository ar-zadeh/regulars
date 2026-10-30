import test from 'node:test';
import assert from 'node:assert/strict';
import {Regulars} from '../src/core.js';
import {DEMO_PERSONAS, seedDemo} from '../src/demo.js';

const now = Date.parse('2026-10-29T12:00:00Z');
const day = 86400000;

test('demo seed creates accurate, isolated six-day history without outbound actions', t => {
  const app = new Regulars({
    ai: {},
    deleteMessage: () => { throw new Error('Demo attempted a Twitch deletion'); },
    getFollower: () => { throw new Error('Demo attempted a follower lookup'); },
  });
  t.after(() => app.close());

  assert.equal(seedDemo(app, now), true);
  const sessions = app.all('SELECT id,idx,start,end FROM sessions ORDER BY idx');
  assert.equal(sessions.length, 6);
  for (const [i, session] of sessions.entries()) {
    const start = new Date(now - (6 - i) * day).toISOString();
    assert.equal(session.idx, i + 1);
    assert.equal(session.start, start);
    assert.equal(session.end, new Date(Date.parse(start) + 3600000).toISOString());
    const messages = app.all('SELECT viewer_id,timestamp,moderation,subject_id FROM messages WHERE session_id=? ORDER BY timestamp', session.id);
    assert.equal(messages.length, 50);
    assert.ok(messages.every(message => message.moderation === 'cleared' && message.subject_id === 'demo-history-subject'));
    assert.ok(messages.every(message => message.timestamp >= session.start && message.timestamp <= session.end));
    assert.ok(messages.every(message => message.viewer_id !== 'demo-Sam'));
    assert.equal(messages.some(message => message.viewer_id === 'demo-Rae'), i < 3);
  }
  assert.equal(app.one('SELECT COUNT(*) AS n FROM messages').n, 300);
  assert.equal(app.one('SELECT COUNT(*) AS n FROM viewers').n, DEMO_PERSONAS.length);
  assert.equal(app.one('SELECT COUNT(*) AS n FROM nudges').n, 0);
  assert.equal(app.one('SELECT COUNT(*) AS n FROM awards').n, 0);
  assert.equal(app.one('SELECT COUNT(*) AS n FROM events').n, 0);
  assert.equal(app.one('SELECT total FROM viewers WHERE id=?', 'demo-Sam').total, 6);
  const rae = app.one('SELECT total,last_seen FROM viewers WHERE id=?', 'demo-Rae');
  assert.equal(rae.total, 3);
  assert.equal(rae.last_seen, 3);
  assert.equal(seedDemo(app, now), false);
  assert.equal(app.one('SELECT COUNT(*) AS n FROM messages').n, 300);
});

test('demo seed leaves existing channel data untouched', t => {
  const app = new Regulars({ai: {}});
  t.after(() => app.close());
  app.addRule({name: 'existing rule', action: 'hide'});
  assert.equal(seedDemo(app, now), false);
  assert.equal(app.one('SELECT COUNT(*) AS n FROM rules').n, 1);
  assert.equal(app.one('SELECT COUNT(*) AS n FROM sessions').n, 0);
  assert.equal(app.one('SELECT COUNT(*) AS n FROM subjects').n, 0);
  assert.equal(app.one('SELECT COUNT(*) AS n FROM messages').n, 0);
});
