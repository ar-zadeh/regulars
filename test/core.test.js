import test from 'node:test';
import assert from 'node:assert/strict';
import {Regulars,repeatKey,discussions} from '../src/core.js';
import {createSanitizer} from '../src/ai.js';
import {seedDemo} from '../src/demo.js';
import {randomUUID} from 'node:crypto';
import {unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const ai={classify:async ({text,blockedTopics})=>({category:text.includes('?')?'question':'other',addressesAI:0,topics:blockedTopics.map(r=>({id:r.id,score:text.includes('politics')?0.9:0.1})),subjects:[]}),nameSubjects:async()=>[],scoreSubject:async()=>0,summarize:async()=>''};
const event=(id,text,viewerId='a',seconds=0)=>({id,eventId:'event-'+id,viewerId,name:viewerId,text,timestamp:new Date(1700000000000+seconds*1000).toISOString()});
test('deduplicates messages and collapses fixed ten-second windows',async()=>{
  const app=new Regulars({ai});app.startSession();
  for(let i=0;i<20;i++) await app.ingest(event(String(i),i%2?'lol LOL':'LOL',String(i),i/2));
  await app.ingest(event('0','LOL','0'));await app.ingest(event('next','LOL','x',10));
  assert.deepEqual(app.rows().map(r=>r.count),[20,1]);assert.equal(repeatKey('lol\u200b LOL'),'\0lol');app.close();
});
test('current subject IDs include each cleared message even when display rows are collapsed',async()=>{
  const app=new Regulars({ai});app.startSession();
  await app.ingest(event('first','same text','one',0));
  await app.ingest(event('second','same text','two',1));
  await app.ingest(event('held','different text','three',2));
  app.run("UPDATE messages SET subject_id='s1' WHERE id='first'");
  app.run("UPDATE messages SET subject_id='s2' WHERE id='second'");
  app.run("UPDATE messages SET subject_id='held-topic',moderation='held' WHERE id='held'");
  const state=app.state();
  assert.equal(state.messages.length,1);
  assert.deepEqual(new Set(state.currentSubjectIds),new Set(['s1','s2']));
  app.close();
});
test('chat rows mark bot, command, and AI-addressed messages as ineligible sticker sources',async()=>{
  const model={...ai,classify:async input=>({...await ai.classify(input),addressesAI:input.text==='ask the assistant'?0.9:0})};
  const app=new Regulars({ai:model});app.startSession();
  await app.ingest(event('human-source','bridge jump','human'));
  await app.ingest({...event('bot-source','bot update','bot'),bot:true});
  await app.ingest(event('command-source','!help','command'));
  await app.ingest(event('ai-source','ask the assistant','viewer'));
  assert.deepEqual(Object.fromEntries(app.rows().map(row=>[row.id,row.selectable])),{'human-source':true,'bot-source':false,'command-source':false,'ai-source':false});
  app.close();
});
test('failed moderation is retried after backoff and forgotten messages stay deleted',async()=>{
  let now=Date.parse('2026-01-01T12:00:00Z'),calls=0;
  const model={...ai,classify:async args=>{calls++;if(calls===1) throw new Error('unavailable');return ai.classify(args);}};
  const app=new Regulars({ai:model,now:()=>now});app.startSession();
  await app.ingest({id:'held',viewerId:'v',name:'V',text:'Hello',timestamp:new Date(now).toISOString()});
  assert.equal(app.one('SELECT job_status FROM messages WHERE id=?','held').job_status,'failed');app.retryHeld();assert.equal(calls,1);
  now+=30000;app.retryHeld();await Promise.allSettled([...app.pending]);assert.equal(app.one('SELECT moderation FROM messages WHERE id=?','held').moderation,'cleared');assert.equal(calls,2);
  app.forget('v');now+=30000;app.retryHeld();assert.equal(calls,2);assert.equal(app.one('SELECT id FROM messages WHERE id=?','held'),undefined);app.close();
});
test('held recovery uses only one retry per message',async()=>{
  let now=Date.parse('2026-01-01T12:00:00Z'),calls=0;
  const model={...ai,classify:async()=>{calls++;throw new Error('unavailable');}};
  const app=new Regulars({ai:model,now:()=>now});app.startSession();
  await app.ingest({id:'held',viewerId:'v',name:'V',text:'Hello',timestamp:new Date(now).toISOString()});
  now+=30000;app.retryHeld();app.retryHeld();await Promise.allSettled([...app.pending]);
  assert.equal(calls,2);assert.equal(app.one('SELECT retry_at FROM messages WHERE id=?','held').retry_at,null);
  now+=600000;app.retryHeld();assert.equal(calls,2);app.close();
});
test('restart recovers initial held work but does not repeat a claimed retry',async()=>{
  const path=join(tmpdir(),`regulars-retry-${randomUUID()}.sqlite`);let now=Date.parse('2026-01-01T12:00:00Z');
  try {
    const first=new Regulars({dbPath:path,ai:{...ai,classify:async()=>{throw new Error('unavailable');}},now:()=>now});first.startSession();
    await first.ingest({id:'held',viewerId:'v',name:'V',text:'Hello',timestamp:new Date(now).toISOString()});first.close();
    now+=30000;const second=new Regulars({dbPath:path,ai,now:()=>now});second.retryHeld();await Promise.allSettled([...second.pending]);
    assert.equal(second.one('SELECT moderation FROM messages WHERE id=?','held').moderation,'cleared');
    second.run("INSERT INTO messages (id,session_id,viewer_id,name,timestamp,text,moderation,organizer,job_status,retry_count) VALUES (?,?,?,?,?,'text','held','new','queued',2)",'claimed',second.currentSession().id,'v','V',new Date(now).toISOString());second.close();
    const third=new Regulars({dbPath:path,ai,now:()=>now});now+=600000;third.retryHeld();await Promise.allSettled([...third.pending]);
    assert.equal(third.one('SELECT moderation FROM messages WHERE id=?','claimed').moderation,'held');assert.equal(third.one('SELECT retry_at FROM messages WHERE id=?','claimed').retry_at,null);third.close();
  } finally {unlinkSync(path);}
});
test('commands are moderated and deletion is guarded by sender metadata',async()=>{
  const deletes=[];const app=new Regulars({ai,deleteMessage:async data=>deletes.push(data)});app.startSession();app.addRule({name:'politics',action:'delete'});
  await app.ingest(event('1','!politics','viewer'));await app.ingest({...event('2','politics','mod'),moderator:true});
  assert.equal(app.rows().length,0);assert.deepEqual(deletes,[{messageId:'1',senderId:'viewer',isModerator:false}]);app.close();
});
test('failed Twitch deletion retries once without repeating a successful action',async()=>{
  let now=1700000100000,calls=0;
  const app=new Regulars({ai,now:()=>now,deleteMessage:async()=>{calls++;if(calls===1)throw new Error('Twitch unavailable');return true;}});app.startSession();app.addRule({name:'politics',action:'delete'});
  await app.ingest(event('blocked','politics','viewer'));
  assert.equal(app.one('SELECT status FROM moderation_actions WHERE message_id=?','blocked').status,'failed');
  app.retryHeld();assert.equal(calls,1);now+=30000;app.retryHeld();await Promise.allSettled([...app.pending]);
  assert.equal(calls,2);assert.equal(app.one('SELECT status FROM moderation_actions WHERE message_id=?','blocked').status,'done');
  await app.guardedDelete('blocked','viewer',false);assert.equal(calls,2);app.close();
});
test('opted-out deletion retry retains only text-free identifiers and waits for live access',async()=>{
  let now=1700000100000,calls=0;const app=new Regulars({ai,now:()=>now});app.startSession();app.addRule({name:'politics',action:'delete'});app.forget('private');
  await app.ingest(event('private-blocked','politics','private'));
  assert.equal(app.one('SELECT * FROM messages WHERE id=?','private-blocked'),undefined);
  assert.deepEqual(Object.keys(app.one('SELECT * FROM moderation_actions WHERE message_id=?','private-blocked')).sort(),['message_id','retry_at','retry_count','sender_id','status']);
  now+=30000;app.retryHeld();assert.equal(calls,0);
  app.deleteMessage=async()=>{calls++;return true;};app.deleteMessageAvailable=true;app.retryHeld();await Promise.allSettled([...app.pending]);
  assert.equal(calls,1);assert.equal(app.one('SELECT status FROM moderation_actions WHERE message_id=?','private-blocked').status,'done');app.close();
});
test('Twitch removal cancels a pending deletion retry',async()=>{
  let now=1700000100000,calls=0;const app=new Regulars({ai,now:()=>now,deleteMessage:async()=>{calls++;throw new Error('unavailable');}});app.startSession();app.addRule({name:'politics',action:'delete'});
  await app.ingest(event('blocked','politics','viewer'));app.removeMessage('blocked');now+=30000;app.retryHeld();
  assert.equal(calls,1);assert.equal(app.one('SELECT status FROM moderation_actions WHERE message_id=?','blocked').status,'done');app.close();
});
test('forget removes existing content and future messages are not stored',async()=>{
  const app=new Regulars({ai});app.startSession();await app.ingest(event('1','hello','a'));app.forget('a');await app.ingest(event('2','private later','a'));
  assert.equal(app.all('SELECT * FROM messages').length,0);assert.equal(app.one('SELECT opted_out FROM viewers WHERE id=?','a').opted_out,1);app.close();
});
test('opted-out messages are moderated transiently and guarded before deletion',async()=>{
  const deletes=[];const app=new Regulars({ai,deleteMessage:async data=>deletes.push(data)});app.startSession();app.addRule({name:'politics',action:'delete'});app.forget('a');app.forget('mod');
  await app.ingest(event('1','politics','a'));await app.ingest({...event('2','politics','mod'),moderator:true});
  assert.deepEqual(deletes,[{messageId:'1',senderId:'a',isModerator:false}]);
  assert.equal(app.all('SELECT * FROM messages').length,0);assert.equal(app.all('SELECT * FROM nudges').length,0);app.close();
});
test('opted-out moderation timeout aborts queued model work without retaining text',async()=>{
  let aborted=false,dispatched=false;
  const model={...ai,classify:({signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>{aborted=true;reject(new Error('aborted'));},{once:true});
    setTimeout(()=>{if(!signal.aborted){dispatched=true;resolve({topics:[]});}},25);
  })};
  const app=new Regulars({ai:model,transientModerationTimeout:5});app.startSession();app.forget('private');
  await app.ingest(event('private-line','secret text','private'));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(aborted,true);assert.equal(dispatched,false);assert.equal(app.one('SELECT * FROM messages WHERE id=?','private-line'),undefined);app.close();
});
test('opted-out ingestion releases text while a Twitch deletion is in flight',async()=>{
  let finish;const deletion=new Promise(resolve=>finish=resolve);
  const app=new Regulars({ai,deleteMessage:async()=>deletion});app.startSession();app.addRule({name:'politics',action:'delete'});app.forget('private');
  const ingestion=app.ingest(event('private-blocked','politics','private'));
  await Promise.race([ingestion,new Promise((_,reject)=>setTimeout(()=>reject(new Error('ingestion held by Twitch deletion')),50))]);
  assert.equal(app.pending.size,1);assert.equal(app.one('SELECT * FROM messages WHERE id=?','private-blocked'),undefined);
  finish(true);await Promise.allSettled([...app.pending]);assert.equal(app.pending.size,0);app.close();
});
test('privacy change immediately aborts an opted-out queued classification',async()=>{
  let signal;const model={...ai,classify:input=>{signal=input.signal;return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}};
  const app=new Regulars({ai:model,transientModerationTimeout:1000});app.startSession();app.forget('private');
  const ingestion=app.ingest(event('private-line','secret text','private'));
  app.forget('private');await ingestion;
  assert.equal(signal.aborted,true);assert.equal(app.one('SELECT * FROM messages WHERE id=?','private-line'),undefined);app.close();
});
test('wrap fixes the received-message cutoff and concurrent requests share finalization',async()=>{
  let finish;const gate=new Promise(resolve=>finish=resolve);
  const topicAI={...ai,classify:async()=>({category:'opinion',addressesAI:0,topics:[],subjects:[{id:'topic',score:0.9}]})};
  const app=new Regulars({ai:topicAI,now:()=>1700000100000});app.startSession();app.run("INSERT INTO subjects (id,name,description) VALUES ('topic','Topic','A topic')");
  for(let i=0;i<3;i++) await app.ingest(event(String(i),'topic',String(i),i*10));
  app.discover=async()=>gate;
  const first=app.wrap({play:false,timeout:1000});const second=app.wrap({play:false,timeout:1000});
  await app.ingest(event('late','topic','late',30));finish();
  const [firstCard,secondCard]=await Promise.all([first,second]);
  assert.deepEqual(firstCard,secondCard);assert.deepEqual(firstCard,[{title:'Hype Engine',recipients:['0','1','2'],subject:'Topic',durationMs:20000}]);
  assert.equal(app.currentSession().cutoff_rowid,3);app.close();
});
test('forget invalidates in-flight summaries',async()=>{
  let finish;const gate=new Promise(resolve=>finish=resolve);
  let signal;const app=new Regulars({ai:{...ai,summarize:async input=>(signal=input.signal,gate)}});app.startSession();await app.ingest(event('1','private detail','a'));
  const summary=app.refreshSummary();app.forget('a');finish('private detail summary');await summary;
  assert.equal(signal.aborted,true);assert.equal(app.summary,'');app.close();
});
test('regular arrival starter uses a subject from two prior sessions, not past chat quotes',()=>{
  const now=Date.parse('2026-01-10T12:00:00Z');const app=new Regulars({ai,now:()=>now});assert.equal(seedDemo(app,now),true);
  app.startSession();app.sight({id:'demo-Ben',name:'Ben'});app.sight({id:'demo-Sam',name:'Sam'});
  const ben=app.one("SELECT text FROM nudges WHERE viewer_id='demo-Ben'"),sam=app.one("SELECT text FROM nudges WHERE viewer_id='demo-Sam'");
  assert.match(ben.text,/Topic to bring up: Bridge jump/);assert.ok(!ben.text.includes('The bridge jump was a fun moment'));
  assert.ok(!sam.text.includes('Topic to bring up'));assert.equal(app.overlayEvent,null);app.close();
});
test('generated summaries are screened against blocked topics',async()=>{
  const app=new Regulars({ai:{...ai,summarize:async()=> 'politics is the topic'}});app.startSession();app.addRule({name:'politics',action:'hide'});
  await app.ingest(event('1','hello','a'));await app.refreshSummary();
  assert.equal(app.summary,'');app.close();
});
test('nudge pause is scoped to the session',()=>{
  const app=new Regulars({ai});app.startSession();app.pauseNudges();app.addNudge('a',null,'arrival');
  assert.equal(app.state().nudgesPaused,true);assert.equal(app.state().nudges.length,0);
  app.run('UPDATE sessions SET end=? WHERE id=?',new Date().toISOString(),app.currentSession().id);app.startSession();
  assert.equal(app.state().nudgesPaused,false);app.close();
});
test('a cleared !lurk updates a private nudge and suppresses future nudges for the session',async()=>{
  const app=new Regulars({ai});const session=app.startSession();
  app.sight({id:'viewer',name:'Viewer'});app.addNudge('viewer',null,'Viewer is here');await app.ingest(event('lurk','!lurk','viewer'));
  assert.match(app.state().nudges[0].text,/chosen to lurk/);
  app.run("UPDATE nudges SET status='done'");app.addNudge('viewer',null,'Another nudge');assert.equal(app.state().nudges.length,0);
  app.run('UPDATE sessions SET end=? WHERE id=?',new Date().toISOString(),session.id);app.startSession();app.addNudge('viewer',null,'Next session');assert.equal(app.state().nudges.length,1);app.close();
});
test('a cleared !lurk keeps nudges suppressed after a same-session restart',async()=>{
  const path=join(tmpdir(),`regulars-lurk-${randomUUID()}.sqlite`);
  try{
    const first=new Regulars({ai,dbPath:path});first.startSession();
    await first.ingest(event('lurk-restart','!lurk   ','viewer'));
    const sessionId=first.currentSession().id;first.close();
    const second=new Regulars({ai,dbPath:path});
    assert.equal(second.currentSession().id,sessionId);
    second.addNudge('viewer',null,'A new arrival');
    assert.equal(second.all('SELECT * FROM nudges WHERE viewer_id=?','viewer').length,0);
    second.close();
  } finally {unlinkSync(path);}
});
test('first-message nudges use the first eligible classified line per viewer and session',async()=>{
  const app=new Regulars({ai});app.startSession();
  await app.ingest(event('a1','hello','a'));await app.ingest(event('a2','question?','a'));
  await app.ingest(event('b1','question?','b'));await app.ingest(event('b2','another question?','b'));
  await app.ingest({...event('vip1','question?','vip'),vip:true});await app.ingest(event('vip2','question?','vip'));
  await app.ingest({...event('mod1','question?','mod'),moderator:true});await app.ingest(event('mod2','question?','mod'));
  await app.ingest(event('repeat1','yes yes','repeat'));await app.ingest(event('repeat2','question?','repeat'));
  await app.ingest(event('command1','!help','command'));await app.ingest(event('command2','question?','command'));
  assert.deepEqual(app.all('SELECT viewer_id FROM first_messages ORDER BY viewer_id').map(r=>r.viewer_id),['a','b','command','mod','repeat','vip']);
  assert.deepEqual(app.all('SELECT message_id FROM nudges').map(n=>n.message_id).sort(),['b1','command2','mod2','repeat2','vip2']);
  assert.equal(app.state().nudges.length,1);
  app.close();
});
test('later sessions nudge on a first eligible non-question only once',async()=>{
  const app=new Regulars({ai});
  for(let i=0;i<2;i++){const session=app.startSession();app.run('UPDATE sessions SET end=? WHERE id=?',new Date().toISOString(),session.id);}
  app.startSession();await app.ingest(event('first','hello','new-viewer'));app.run("UPDATE nudges SET status='done'");
  await app.ingest(event('second','question?','new-viewer'));
  assert.equal(app.all('SELECT * FROM nudges WHERE viewer_id=?','new-viewer').length,1);
  assert.equal(app.one('SELECT message_id FROM first_messages WHERE viewer_id=?','new-viewer').message_id,'first');app.close();
});
test('nudge queue enforces priority, one per minute, three open, and private display',()=>{
  let now=Date.parse('2026-01-01T12:00:00Z');const app=new Regulars({ai,now:()=>now});app.startSession();
  app.addNudge('first',null,'First arrival');app.addNudge('arrival',null,'Another arrival');
  app.addNudge('message','message-id','A first message',{kind:'message'});app.addNudge('return',null,'A return',{kind:'return'});
  app.addNudge('question','question-id','A question',{kind:'question'});
  assert.deepEqual(app.state().nudges.map(n=>n.viewer_id),['first']);assert.equal(app.overlayEvent,null);
  now+=59999;assert.equal(app.state().nudges.length,1);
  now+=1;assert.deepEqual(new Set(app.state().nudges.map(n=>n.viewer_id)),new Set(['first','question']));
  now+=60000;assert.deepEqual(new Set(app.state().nudges.map(n=>n.viewer_id)),new Set(['first','question','return']));
  now+=60000;assert.equal(app.state().nudges.length,3);assert.equal(app.one('SELECT status FROM nudges WHERE viewer_id=?','message').status,'expired');
  assert.equal(app.overlayEvent,null);app.close();
});
test('nudges expire by type and later messages update the existing private nudge',()=>{
  let now=Date.parse('2026-01-01T12:00:00Z');const app=new Regulars({ai,now:()=>now});app.startSession();
  app.addNudge('viewer',null,'Viewer arrived');
  now+=30000;app.addNudge('viewer','m','Viewer asked a question',{kind:'question'});
  const nudge=app.one('SELECT * FROM nudges WHERE viewer_id=?','viewer');assert.equal(nudge.message_id,'m');assert.equal(nudge.priority,4);assert.match(nudge.text,/Viewer arrived.*Viewer asked a question/);assert.equal(app.all('SELECT * FROM nudges').length,1);
  now+=180000;assert.equal(app.state().nudges.length,0);assert.equal(app.one('SELECT status FROM nudges WHERE id=?',nudge.id).status,'expired');
  app.addNudge('viewer',null,'No second nudge');assert.equal(app.all('SELECT * FROM nudges').length,1);app.close();
});
test('nudge pause and opt-out prevent queued reminders from appearing',()=>{
  let now=Date.parse('2026-01-01T12:00:00Z');const app=new Regulars({ai,now:()=>now});app.startSession();
  app.addNudge('one',null,'One');app.addNudge('two',null,'Two');app.forget('two');now+=60000;
  assert.deepEqual(app.state().nudges.map(n=>n.viewer_id),['one']);app.pauseNudges();assert.equal(app.state().nudges.length,0);app.close();
});
test('muted viewers receive no nudge in later sessions',()=>{
  const app=new Regulars({ai});const first=app.startSession();
  app.sight({id:'viewer',name:'Viewer'});app.addNudge('viewer',null,'Viewer arrived');
  app.run('UPDATE viewers SET muted=1 WHERE id=?','viewer');
  app.run('UPDATE sessions SET end=? WHERE id=?',new Date().toISOString(),first.id);
  app.startSession();app.addNudge('viewer',null,'Viewer returned');
  assert.equal(app.all('SELECT * FROM nudges WHERE viewer_id=?','viewer').length,1);
  assert.equal(app.state().nudges.length,0);app.close();
});
test('discussion selects longest and splits after a sixty-second gap',()=>{
  const rows=[0,10,20,90,100,110].map((s,i)=>({id:String(i),timestamp:new Date(1700000000000+s*1000).toISOString(),subject_id:'topic',viewer_id:String(i%3)}));
  assert.equal(discussions(rows).length,2);assert.equal(discussions(rows)[0].end-discussions(rows)[0].start,20000);
});

test('summary samples recent messages across distinct viewers',async()=>{
  let captured;let now=Date.parse('2026-01-01T12:00:00Z');
  const model={...ai,summarize:async({messages})=>(captured=messages,'Chat is discussing a microphone.')};const app=new Regulars({ai:model,now:()=>now});app.startSession();
  await app.ingest({id:'old',viewerId:'old',name:'Old',text:'Old conversation',timestamp:new Date(now).toISOString()});now+=31000;
  for(let i=0;i<35;i++) await app.ingest({id:`a${i}`,viewerId:'a',name:'A',text:`Mic line ${i}`,timestamp:new Date(now).toISOString()});
  await app.ingest({id:'b',viewerId:'b',name:'B',text:'Another mic voice',timestamp:new Date(now).toISOString()});await app.refreshSummary();
  assert.ok(captured.includes('Another mic voice'));assert.ok(!captured.includes('Old conversation'));assert.equal(captured.length,30);app.close();
});
test('a burst of over 300 messages cannot crowd another recent viewer out of the summary',async()=>{
  let captured;const now=Date.parse('2026-01-01T12:00:00Z');
  const model={...ai,summarize:async({messages})=>(captured=messages,'A balanced conversation.')};const app=new Regulars({ai:model,now:()=>now});app.startSession();
  await app.ingest({id:'other',viewerId:'other',name:'Other',text:'Other perspective',timestamp:new Date(now).toISOString()});
  for(let i=0;i<301;i++) app.run("INSERT INTO messages (id,session_id,viewer_id,name,timestamp,received_at,text,moderation,organizer) VALUES (?,?,?,?,?,?,?,?,?)",`burst-${i}`,app.currentSession().id,'burst','Burst',new Date(now).toISOString(),new Date(now).toISOString(),`Burst ${i}`,'cleared','new');
  await app.refreshSummary();assert.ok(captured.includes('Other perspective'));app.close();
});
test('an older summary result cannot overwrite a newer selection',async()=>{
  let release;const first=new Promise(resolve=>release=resolve);let calls=0;
  const model={...ai,summarize:async()=>++calls===1?first:'New conversation.'};const now=Date.parse('2026-01-01T12:00:00Z');const app=new Regulars({ai:model,now:()=>now});app.startSession();
  await app.ingest({id:'first',viewerId:'a',name:'A',text:'First topic',timestamp:new Date(now).toISOString()});const older=app.refreshSummary();
  await app.ingest({id:'second',viewerId:'b',name:'B',text:'Second topic',timestamp:new Date(now).toISOString()});await app.refreshSummary();
  release('Old conversation.');await older;assert.equal(app.summary,'New conversation.');app.close();
});
test('Day One backfill checks viewers who chatted before the date was configured',async()=>{
  const app=new Regulars({ai,now:()=>Date.parse('2026-01-02T02:00:00Z'),getFollower:async()=>({followed_at:'2025-01-01T00:00:00Z'})});app.startSession();
  await app.ingest({id:'m',viewerId:'v',name:'V',text:'Hello everyone',timestamp:'2026-01-02T01:00:00Z'});app.dayOneDate='2025-12-31';app.backfillFollowers();await app.wrap();
  assert.ok(app.awards().some(a=>a.title==='Day One'));app.close();
});
test('backfill schedules one lookup per viewer and forget discards its result',async()=>{
  let release,started,calls=0;const began=new Promise(resolve=>started=resolve),lookup=new Promise(resolve=>release=resolve);
  const app=new Regulars({ai,now:()=>Date.parse('2026-01-02T02:00:00Z'),getFollower:()=>{calls++;started();return lookup;}});app.startSession();
  await app.ingest({id:'m',viewerId:'v',name:'V',text:'Hello everyone',timestamp:'2026-01-02T01:00:00Z'});app.dayOneDate='2025-12-31';
  app.backfillFollowers();app.backfillFollowers();await began;assert.equal(calls,1);
  app.forget('v');release({followed_at:'2025-01-01T00:00:00Z'});await Promise.allSettled([...app.pending]);
  assert.deepEqual(app.followDates,{});assert.deepEqual(app.awards(),[]);app.close();
});
test('forget deletes stickers derived from a viewer, including private briefs and images',async()=>{
  const app=new Regulars({ai});app.startSession();await app.ingest(event('source','hello','viewer'));
  app.run('INSERT INTO stickers (id,name,subject,brief,image,source_ids,contributor_ids) VALUES (?,?,?,?,?,?,?)','sticker','Sticker','topic','private brief','private image',JSON.stringify(['source']),JSON.stringify(['viewer']));
  app.forget('viewer');assert.equal(app.one('SELECT * FROM stickers WHERE id=?','sticker'),undefined);app.close();
});
test('wrap persists Night Owl and verified Day One once',async()=>{
  const now=Date.parse('2026-01-02T02:00:00Z');const app=new Regulars({ai,now:()=>now,timeZone:'UTC',dayOneDate:'2025-12-31',getFollower:async()=>({followed_at:'2025-12-30T12:00:00Z'})});
  const session=app.startSession('2026-01-02T00:00:00Z');
  await app.ingest({id:'first',viewerId:'viewer',name:'Viewer',text:'Hello everyone',timestamp:'2026-01-02T01:00:00Z'});await app.wrap();
  assert.deepEqual(app.awards().map(a=>a.title),['Day One','Night Owl']);
  app.run('UPDATE sessions SET end=? WHERE id=?','2026-01-02T03:00:00Z',session.id);app.startSession();
  await app.ingest({id:'second',viewerId:'viewer',name:'Viewer',text:'Hello again',timestamp:'2026-01-02T01:10:00Z'});await app.wrap();
  assert.deepEqual(app.awards().map(a=>a.title),['Night Owl']);app.close();
});

test('old follower lookup cannot populate the next session',async()=>{
  let release,started;const began=new Promise(resolve=>started=resolve),follower=new Promise(resolve=>release=resolve);
  let calls=0;const app=new Regulars({ai,dayOneDate:'2025-12-31',getFollower:()=>{calls++;started();return calls===1?follower:{followed_at:'2025-12-30T00:00:00Z'};}});
  const first=app.startSession();const ingest=app.ingest(event('first','hello','viewer'));await began;
  app.run('UPDATE sessions SET end=? WHERE id=?',new Date().toISOString(),first.id);app.startSession();release({followed_at:'2025-12-30T00:00:00Z'});await ingest;
  assert.deepEqual(app.followDates,{});
  await app.ingest(event('second','hello','viewer'));assert.equal(calls,2);assert.equal(app.followDates.viewer,'2025-12-30T00:00:00Z');app.close();
});

test('forget discards an in-flight follower result',async()=>{
  let release,started;const began=new Promise(resolve=>started=resolve),follower=new Promise(resolve=>release=resolve);
  const app=new Regulars({ai,dayOneDate:'2025-12-31',getFollower:()=>{started();return follower;}});app.startSession();
  const ingest=app.ingest(event('first','hello','viewer'));await began;app.forget('viewer');release({followed_at:'2025-12-30T00:00:00Z'});await ingest;
  assert.deepEqual(app.followDates,{});assert.deepEqual(app.awards(),[]);app.close();
});

test('incomplete Wrap saves verified Night Owl without late Day One',async()=>{
  let release,started;const began=new Promise(resolve=>started=resolve),follower=new Promise(resolve=>release=resolve);
  const now=Date.parse('2026-01-02T02:00:00Z');const app=new Regulars({ai,now:()=>now,timeZone:'UTC',dayOneDate:'2025-12-31',getFollower:()=>{started();return follower;}});app.startSession();
  const ingest=app.ingest({id:'first',viewerId:'viewer',name:'Viewer',text:'hello',timestamp:'2026-01-02T01:00:00Z'});await began;
  const card=await app.wrap({play:false,timeout:5});assert.deepEqual(card.map(a=>a.title),['Night Owl']);assert.equal(app.currentSession().incomplete,1);
  release({followed_at:'2025-12-30T00:00:00Z'});await ingest;assert.deepEqual(app.awards().map(a=>a.title),['Night Owl']);app.close();
});

test('presence uses the latest chatter poll and excludes forgotten viewers',()=>{
  const app=new Regulars({ai});
  for(let i=0;i<2;i++){const session=app.startSession();app.sight({id:'a',name:'A'},session,{nudge:false});app.sight({id:'b',name:'B'},session,{nudge:false});app.run('UPDATE sessions SET end=? WHERE id=?',new Date().toISOString(),session.id);}
  app.startSession();app.updatePresence([{id:'a',name:'A'},{id:'b',name:'B'},{id:'new',name:'New'}]);
  assert.deepEqual(app.state().presence.map(v=>[v.id,v.status]),[['a','Lurking'],['b','Lurking']]);
  app.updatePresence([{id:'b',name:'B'}]);assert.deepEqual(app.state().presence.map(v=>v.id),['b']);
  app.run("INSERT INTO messages (id,session_id,viewer_id,name,timestamp,text,moderation,organizer) VALUES (?,?,?,?,?,'hello','cleared','new')",'chat',app.currentSession().id,'b','B',new Date().toISOString());
  assert.equal(app.state().presence[0].status,'Chatting');
  app.forget('b');assert.deepEqual(app.state().presence,[]);app.close();
});

test('room clear during classification cannot restore a held message',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const app=new Regulars({ai:{...ai,classify:async()=>gate}});app.startSession();
  const ingest=app.ingest(event('held','hello?','viewer'));app.run('UPDATE messages SET text=NULL WHERE id=?','held');
  release({category:'question',addressesAI:0,topics:[],subjects:[]});await ingest;
  assert.equal(app.one('SELECT moderation FROM messages WHERE id=?','held').moderation,'held');assert.equal(app.state().nudges.length,0);app.close();
});

test('forgetting a reply parent invalidates in-flight classification context',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),contexts=[],signals=[];let calls=0;
  const model={...ai,classify:async input=>{contexts.push(input.context);signals.push(input.signal);calls++;if(calls===2)return gate;return {category:'other',addressesAI:0,topics:[],subjects:[]};}};
  const app=new Regulars({ai:model});app.startSession();await app.ingest(event('parent','parent text','parent'));
  const reply=app.ingest({...event('reply','reply text','child'),parentId:'parent'});
  app.forget('parent');assert.equal(signals[1].aborted,true);release({category:'other',addressesAI:0,topics:[],subjects:[]});await reply;
  assert.equal(calls,3);assert.equal(contexts[1].reply,'parent text');assert.equal(contexts[2].reply,undefined);
  assert.equal(app.one('SELECT moderation FROM messages WHERE id=?','reply').moderation,'cleared');app.close();
});

test('AI identity aliases include broadcaster, bot, shared, and login names',async()=>{
  const app=new Regulars({ai,broadcasterId:'owner'});app.startSession();
  await app.ingest({...event('owner-message','hello','owner'),name:'Owner Display',login:'owner_login'});
  await app.ingest({...event('bot-message','hello','bot'),name:'Bot Display',login:'bot_login',bot:true});
  await app.ingest({...event('shared-message','hello','shared'),name:'Shared Display',login:'shared_login',shared:true});
  app.updatePresence([{id:'lurker',name:'Lurker Display',login:'lurker_login'},{id:'poll-bot',name:'Poll Bot',login:'poll_bot',bot:true}]);
  const sanitized=createSanitizer(app.identities())('owner_login Bot Display shared_login lurker_login Poll Bot');
  for(const name of ['owner_login','Bot Display','shared_login','lurker_login','Poll Bot']) assert.ok(!sanitized.includes(name));
  app.close();
});

test('overlapping Wrap tasks keep awards in their originating sessions',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  const app=new Regulars({ai,now:()=>Date.parse('2026-01-02T03:00:00Z'),timeZone:'UTC'});
  const firstSession=app.startSession();await app.ingest({id:'one',viewerId:'first',name:'First',text:'hello',timestamp:'2026-01-02T01:00:00Z'});
  app.discover=async()=>gate;const firstWrap=app.wrap({play:false,timeout:1000});
  app.run('UPDATE sessions SET end=? WHERE id=?','2026-01-02T03:00:00Z',firstSession.id);app.startSession();
  await app.ingest({id:'two',viewerId:'second',name:'Second',text:'hello',timestamp:'2026-01-02T01:01:00Z'});
  const secondWrap=app.wrap({play:false,timeout:1000});release();
  assert.deepEqual(await firstWrap,[{title:'Night Owl',recipients:['First']}]);
  assert.deepEqual(await secondWrap,[{title:'Night Owl',recipients:['Second']}]);app.close();
});

test('non-English topic matches go to Maybe without automatic deletion, including opt-outs',async()=>{
  const deletes=[];const multilingual={...ai,classify:async ({blockedTopics})=>({category:'other',addressesAI:0,nonEnglish:0.5,topics:blockedTopics.map(r=>({id:r.id,score:0.9})),subjects:[]})};
  const app=new Regulars({ai:multilingual,deleteMessage:async item=>deletes.push(item)});app.startSession();app.addRule({name:'politics',action:'delete'});
  await app.ingest(event('held','politics','viewer'));app.forget('private');await app.ingest(event('transient','politics','private'));
  assert.equal(app.one('SELECT moderation FROM messages WHERE id=?','held').moderation,'maybe');
  assert.equal(app.one('SELECT * FROM messages WHERE id=?','transient'),undefined);assert.deepEqual(deletes,[]);app.close();
});

test('New pool ages from receipt time',async()=>{
  let now=1700000100000,naming=0;
  const app=new Regulars({ai:{...ai,nameSubjects:async()=>{naming++;return []; }},now:()=>now});app.startSession();
  for(let i=0;i<3;i++) await app.ingest(event(`old-${i}`,'conversation',String(i%2),-100000+i));
  await app.discover();assert.equal(naming,1);assert.equal(app.one('SELECT organizer FROM messages WHERE id=?','old-0').organizer,'new');
  now+=300000;await app.discover();assert.equal(app.one('SELECT organizer FROM messages WHERE id=?','old-0').organizer,'unassigned');app.close();
});

test('naming waits for pool growth and the ten-second interval',async()=>{
  let now=1700000100000,naming=0;
  const app=new Regulars({ai:{...ai,nameSubjects:async()=>{naming++;return []; }},now:()=>now});app.startSession();
  for(let i=0;i<3;i++) await app.ingest(event(`n-${i}`,'conversation',String(i%2),i));
  await app.discover();await app.discover();assert.equal(naming,1);
  await app.ingest(event('n-3','another line','3',3));await app.discover();assert.equal(naming,1);
  now+=10000;await app.discover();assert.equal(naming,2);app.close();
});
test('forget aborts a queued subject naming job before it can publish a subject',async()=>{
  let signal;const model={...ai,nameSubjects:({signal:received})=>{signal=received;return new Promise((_,reject)=>received.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));}};
  const app=new Regulars({ai:model,now:()=>1700000100000});app.startSession();
  for(let i=0;i<3;i++) await app.ingest(event(`name-${i}`,'topic line',String(i%2),i));
  const naming=app.discover();app.forget('0');await assert.rejects(naming,/aborted/);
  assert.equal(signal.aborted,true);assert.equal(app.all('SELECT * FROM subjects').length,0);app.close();
});

test('Wrap lookback assigns earlier unassigned lines without including late arrivals',async()=>{
  let release;const gate=new Promise(resolve=>release=resolve),now=1700000100000;
  const organizerAI={...ai,nameSubjects:async()=>gate,scoreSubject:async()=>0.9};
  const app=new Regulars({ai:organizerAI,now:()=>now});app.startSession();
  await app.ingest(event('opening','topic opening','opening',0));app.run("UPDATE messages SET organizer='unassigned' WHERE id='opening'");
  for(let i=0;i<3;i++) await app.ingest(event(`p-${i}`,'topic line',`viewer-${i%2}`,10+i));
  const wrapping=app.wrap({play:false,timeout:1000});await app.ingest(event('late','topic late','late',20));
  release([{name:'Topic',description:'A conversation about topic'}]);await wrapping;
  assert.equal(app.one('SELECT organizer FROM messages WHERE id=?','opening').organizer,'assigned');
  assert.equal(app.one('SELECT organizer FROM messages WHERE id=?','late').organizer,'new');app.close();
});

test('Wrap marks failed held cutoff work incomplete and omits Hype Engine',async()=>{
  const model={...ai,classify:async ({text})=>{if(text==='model failure')throw new Error('model unavailable');return {category:'opinion',addressesAI:0,topics:[],subjects:[{id:'topic',score:0.9}]};}};
  const app=new Regulars({ai:model,now:()=>1700000100000});app.startSession();app.run("INSERT INTO subjects (id,name,description) VALUES ('topic','Topic','A topic')");
  for(let i=0;i<3;i++) await app.ingest(event(`eligible-${i}`,'topic line',`viewer-${i}`,i*10));
  await app.ingest(event('failed','model failure','fourth',35));
  const card=await app.wrap({play:false});assert.deepEqual(card,[]);assert.equal(app.currentSession().incomplete,1);app.close();
});
