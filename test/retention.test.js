import test from 'node:test';
import assert from 'node:assert/strict';
import {Regulars} from '../src/core.js';
import {expireChatText} from '../src/retention.js';

test('expired sessions lose chat text except approved sources, without retracting awards', async () => {
  const ai={classify:async()=>({category:'other',topics:[],subjects:[]})};
  const app=new Regulars({ai});const session=app.startSession('2026-01-01T00:00:00Z');
  for(const id of ['keep','expire']) await app.ingest({id,viewerId:id,name:id,text:'hello',timestamp:'2026-01-01T00:01:00Z'});
  app.run("INSERT INTO stickers(id,name,subject,brief,image,approved,source_ids,contributor_ids) VALUES ('s','s','s','b','image',1,?,?)",JSON.stringify(['keep']),JSON.stringify(['keep']));
  app.run("INSERT INTO awards(session_id,title,viewer_id,evidence) VALUES (?,'Night Owl','expire',?)",session.id,JSON.stringify(['expire']));
  app.run('UPDATE sessions SET end=? WHERE id=?','2026-01-01T01:00:00Z',session.id);
  assert.equal(expireChatText(app,Date.parse('2026-01-02T02:00:00Z')),1);
  assert.equal(app.one('SELECT text FROM messages WHERE id=?','expire').text,null);
  assert.equal(app.one('SELECT text FROM messages WHERE id=?','keep').text,'hello');
  assert.equal(app.one('SELECT active FROM awards WHERE title=?','Night Owl').active,1);app.close();
});

test('retention waits 24 hours after closure and does not revive removed sticker sources', async () => {
  const app = new Regulars({ai: {classify: async () => ({category: 'other', topics: [], subjects: []})}});
  const session = app.startSession('2026-01-01T00:00:00Z');
  app.run("INSERT INTO viewers(id,name) VALUES ('viewer','Viewer')");
  app.run("INSERT INTO messages(id,session_id,viewer_id,name,timestamp,text,moderation,organizer) VALUES ('m',?,'viewer','Viewer','2026-01-01T00:01:00Z','hello','cleared','new')", session.id);
  app.run("INSERT INTO stickers(id,name,subject,brief,approved,source_ids,contributor_ids) VALUES ('s','s','s','brief',1,'[\"m\"]','[\"viewer\"]')");
  app.run('UPDATE sessions SET end=? WHERE id=?', '2026-01-01T01:00:00Z', session.id);
  assert.equal(expireChatText(app, Date.parse('2026-01-02T00:59:59Z')), 0);
  assert.equal(app.one("SELECT text FROM messages WHERE id='m'").text, 'hello');
  assert.equal(expireChatText(app, Date.parse('2026-01-02T01:00:00Z')), 0);
  app.removeMessage('m');
  assert.equal(app.one("SELECT text FROM messages WHERE id='m'").text, null);
  assert.equal(app.one("SELECT approved FROM stickers WHERE id='s'").approved, 0);
  assert.equal(expireChatText(app, Date.parse('2026-01-03T01:00:00Z')), 0);
  app.close();
});
