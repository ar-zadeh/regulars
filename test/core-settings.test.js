import test from 'node:test';
import assert from 'node:assert/strict';
import {Regulars,discussions} from '../src/core.js';
import {DEFAULT_SETTINGS} from '../src/config.js';

const ai={classify:async({text,blockedTopics=[],subjects=[]})=>({category:text.includes('?')?'question':'other',addressesAI:0.1,nonEnglish:0.1,topics:blockedTopics.map(r=>({id:r.id,score:0.8})),subjects:subjects.map(s=>({id:s.id,score:0.95}))}),nameSubjects:async()=>[],scoreSubject:async()=>0,summarize:async()=>''};
const settings=(patch={})=>({...DEFAULT_SETTINGS,...patch});
const closeSession=app=>{const session=app.currentSession();app.run('UPDATE sessions SET end=? WHERE id=?',new Date().toISOString(),session.id);};

test('regular presence follows rolling or consecutive attendance and preserves configurable history',()=>{
  const app=new Regulars({ai,config:settings({regularWindow:8})});
  for(let index=1;index<=6;index++){
    const session=app.startSession();if([1,3,5,6].includes(index)) app.sight({id:'v',name:'Viewer'},session,{nudge:false});
    if(index<6) closeSession(app);
  }
  assert.deepEqual(JSON.parse(app.one('SELECT seen FROM viewers WHERE id=?','v').seen),[1,3,5,6]);
  assert.equal(app.state().presence.length,1);
  app.setConfig(settings({regularMode:'consecutive',regularMinimum:3,regularWindow:8}));
  assert.equal(app.state().presence.length,0);
  closeSession(app);app.startSession();app.sight({id:'v',name:'Viewer'},app.currentSession(),{nudge:false});
  assert.equal(app.state().presence.length,1);app.close();
});

test('repeat grouping and returning viewer thresholds use configured values',async()=>{
  const app=new Regulars({ai,config:settings({regularMinimum:5,returnMinPrevious:1,returnMissedSessions:2,repetitionWindowSeconds:5})});
  const first=app.startSession();app.sight({id:'v',name:'Viewer'},first,{nudge:false});closeSession(app);
  app.startSession();closeSession(app);app.startSession();closeSession(app);app.startSession();app.sight({id:'v',name:'Viewer'});
  assert.match(app.all('SELECT text FROM nudges')[0].text,/missing 2 streams/);
  const base=Date.parse('2026-01-01T12:00:00Z');
  for(const [id,seconds] of [['a',0],['b',4],['c',5]]) await app.ingest({id,viewerId:id,name:id,text:'LOL',timestamp:new Date(base+seconds*1000).toISOString()});
  assert.deepEqual(app.rows().map(row=>row.count),[2,1]);app.close();
});

test('moderation thresholds change future decisions without rewriting earlier messages',async()=>{
  const app=new Regulars({ai,config:settings({matchThreshold:0.9,maybeThreshold:0.2})});app.startSession();app.addRule({name:'spoilers',action:'hide'});
  await app.ingest({id:'before',viewerId:'v',name:'Viewer',text:'ending',timestamp:new Date().toISOString()});
  assert.equal(app.one('SELECT moderation FROM messages WHERE id=?','before').moderation,'maybe');
  app.setConfig(settings({matchThreshold:0.75,maybeThreshold:0.2}));
  await app.ingest({id:'after',viewerId:'v',name:'Viewer',text:'ending',timestamp:new Date().toISOString()});
  assert.equal(app.one('SELECT moderation FROM messages WHERE id=?','after').moderation,'hidden');
  assert.equal(app.one('SELECT moderation FROM messages WHERE id=?','before').moderation,'maybe');app.close();
});

test('raising the maybe score does not weaken the non-English moderation hold',async()=>{
  const deleted=[];
  const multilingual={...ai,classify:async({blockedTopics=[]})=>({category:'other',addressesAI:0,nonEnglish:0.5,topics:blockedTopics.map(rule=>({id:rule.id,score:0.95})),subjects:[]})};
  const app=new Regulars({ai:multilingual,deleteMessage:async action=>{deleted.push(action);},config:settings({matchThreshold:0.9,maybeThreshold:0.8})});
  app.startSession();app.addRule({name:'blocked',action:'delete'});
  await app.ingest({id:'stored',viewerId:'stored-viewer',name:'Stored',text:'a multilingual message',timestamp:new Date().toISOString()});
  assert.equal(app.one('SELECT moderation FROM messages WHERE id=?','stored').moderation,'maybe');
  app.forget('opted-out-viewer');
  await app.ingest({id:'transient',viewerId:'opted-out-viewer',name:'Opted Out',text:'a multilingual message',timestamp:new Date().toISOString()});
  assert.equal(app.one('SELECT id FROM messages WHERE id=?','transient'),undefined);
  assert.deepEqual(deleted,[]);app.close();
});

test('a threshold update cancels an in-flight opted-out deletion',async()=>{
  let release,started;
  const running=new Promise(resolve=>{started=resolve;});
  const model={...ai,classify:async({blockedTopics=[]})=>{
    started();
    await new Promise(resolve=>{release=resolve;});
    return {category:'other',addressesAI:0,nonEnglish:0.1,topics:blockedTopics.map(rule=>({id:rule.id,score:0.95})),subjects:[]};
  }};
  const deleted=[],app=new Regulars({ai:model,deleteMessage:async action=>{deleted.push(action);},config:settings({matchThreshold:0.9})});
  app.startSession();app.addRule({name:'blocked',action:'delete'});app.forget('v');
  const ingest=app.ingest({id:'transient',viewerId:'v',name:'Viewer',text:'potentially blocked',timestamp:new Date().toISOString()});
  await running;app.setConfig(settings({matchThreshold:0.98}));release();await ingest;
  assert.deepEqual(deleted,[]);app.close();
});

test('changing score thresholds cancels an in-flight decision and uses the new rule',async()=>{
  let calls=0,started;
  const running=new Promise(resolve=>{started=resolve;});
  const model={...ai,classify:({blockedTopics=[],signal})=>{
    calls++;if(calls===1)return new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('Canceled','AbortError')),{once:true});started();});
    return Promise.resolve({category:'other',addressesAI:0.1,nonEnglish:0.1,topics:blockedTopics.map(r=>({id:r.id,score:0.8})),subjects:[]});
  }};
  const app=new Regulars({ai:model,config:settings({matchThreshold:0.9,maybeThreshold:0.2})});app.startSession();app.addRule({name:'spoilers',action:'hide'});
  const ingest=app.ingest({id:'m',viewerId:'v',name:'Viewer',text:'ending',timestamp:new Date().toISOString()});await running;
  app.setConfig(settings({matchThreshold:0.75,maybeThreshold:0.2}));await ingest;
  assert.equal(calls,2);assert.equal(app.one('SELECT moderation FROM messages WHERE id=?','m').moderation,'hidden');app.close();
});

test('discovery retries the same candidate messages after a threshold update',async()=>{
  let calls=0,started;
  const running=new Promise(resolve=>{started=resolve;});
  const model={...ai,nameSubjects:({signal})=>{
    calls++;
    if(calls===1)return new Promise((_,reject)=>{signal.addEventListener('abort',()=>reject(new DOMException('Canceled','AbortError')),{once:true});started();});
    return Promise.resolve([{name:'Microphones',description:'A discussion about microphones'}]);
  },scoreSubject:async()=>0.8};
  const now=Date.parse('2026-01-01T12:00:00Z');
  const app=new Regulars({ai:model,now:()=>now,config:settings({matchThreshold:0.9})});app.startSession();
  for(const [id,viewerId] of [['a','first'],['b','second'],['c','first']]) await app.ingest({id,viewerId,name:viewerId,text:'Microphones',timestamp:new Date(now).toISOString()});
  const first=app.discover();await running;
  app.setConfig(settings({matchThreshold:0.7}));await assert.rejects(first,/Canceled/);
  await app.discover();
  assert.equal(calls,2);
  assert.equal(app.one("SELECT COUNT(*) AS n FROM messages WHERE organizer='assigned'").n,3);
  app.close();
});

test('discussion gap and minimum participants alter the winning candidate',()=>{
  const rows=[0,8,20].map((seconds,index)=>({id:String(index),timestamp:new Date(1700000000000+seconds*1000).toISOString(),subject_id:'s',viewer_id:String(index)}));
  assert.equal(discussions(rows,new Set(),{gapSeconds:10,minContributors:2})[0].contributors.length,2);
  assert.equal(discussions(rows,new Set(),{gapSeconds:10,minContributors:3}).length,0);
  assert.equal(discussions(rows,new Set(),{gapSeconds:15,minContributors:3})[0].contributors.length,3);
});

test('Wrap snapshots award limits and the Night Owl time window',async()=>{
  const now=Date.parse('2026-01-01T12:30:00Z'),app=new Regulars({ai,now:()=>now,config:settings({hypeMinContributors:2,hypeMaxContributors:2,nightOwlStart:'12:00',nightOwlEnd:'13:00'})});
  app.startSession();app.run('INSERT INTO subjects(id,name,description,last_active) VALUES (?,?,?,?)','s','Microphone','Mic',new Date(now).toISOString());
  for(const [index,name] of ['A','B','C'].entries()) await app.ingest({id:String(index),viewerId:name,name,text:'Microphone discussion',timestamp:new Date(now-3000+index*1000).toISOString()});
  let release;app.discover=()=>new Promise(resolve=>{release=resolve;});const wrapped=app.wrap();await new Promise(resolve=>setImmediate(resolve));
  app.setConfig(settings({hypeMinContributors:4,hypeMaxContributors:1,nightOwlStart:'00:00',nightOwlEnd:'05:00'}));release();
  const awards=await wrapped;assert.equal(awards.find(a=>a.title==='Hype Engine').recipients.length,2);assert.equal(awards.find(a=>a.title==='Night Owl').recipients.length,3);app.close();
});

test('summary window excludes messages outside the configured period',async()=>{
  let now=Date.parse('2026-01-01T12:00:00Z'),selected;
  const model={...ai,summarize:async({messages})=>(selected=messages,'Chat is discussing a topic.')};
  const app=new Regulars({ai:model,now:()=>now,config:settings({summaryWindowSeconds:5})});app.startSession();
  await app.ingest({id:'old',viewerId:'a',name:'A',text:'Old topic',timestamp:new Date(now).toISOString()});now+=6000;
  await app.ingest({id:'new',viewerId:'b',name:'B',text:'New topic',timestamp:new Date(now).toISOString()});await app.refreshSummary();
  assert.deepEqual(selected,['New topic']);app.close();
});

test('reminder timing and active limit use configured settings',()=>{
  let now=Date.parse('2026-01-01T12:00:00Z');const app=new Regulars({ai,now:()=>now,config:settings({nudgeCooldownSeconds:5,maxOpenNudges:1,messageNudgeExpirySeconds:8})});app.startSession();
  app.addNudge('a','m1','First');app.addNudge('b','m2','Second');assert.equal(app.state().nudges.length,1);
  now+=5000;app.pumpNudges();assert.equal(app.state().nudges.length,1);
  now+=3000;app.pumpNudges();assert.equal(app.state().nudges.length,0);
  assert.deepEqual(app.all("SELECT status FROM nudges ORDER BY viewer_id").map(row=>row.status),['expired','expired']);app.close();
});

test('arrival reminder expiry is set when queued and is not retroactive',()=>{
  let now=Date.parse('2026-01-01T12:00:00Z');
  const app=new Regulars({ai,now:()=>now,config:settings({arrivalNudgeExpirySeconds:7,maxOpenNudges:1})});app.startSession();
  app.addNudge('a',null,'First arrival');
  const expiry=app.one('SELECT expires_at FROM nudges WHERE viewer_id=?','a').expires_at;
  assert.equal(Date.parse(expiry)-now,7000);
  app.setConfig(settings({arrivalNudgeExpirySeconds:30,maxOpenNudges:1}));
  assert.equal(app.one('SELECT expires_at FROM nudges WHERE viewer_id=?','a').expires_at,expiry);
  app.addNudge('b',null,'Second arrival');
  assert.equal(Date.parse(app.one('SELECT expires_at FROM nudges WHERE viewer_id=?','b').expires_at)-now,30000);
  now+=7000;app.pumpNudges();
  assert.equal(app.one('SELECT status FROM nudges WHERE viewer_id=?','a').status,'expired');
  app.close();
});

test('lowering the open reminder limit moves excess reminders back to the queue',()=>{
  const app=new Regulars({ai,config:settings({nudgeCooldownSeconds:0,maxOpenNudges:3})});app.startSession();
  for(const id of ['a','b','c']) app.addNudge(id,`m-${id}`,`Reminder ${id}`);
  assert.equal(app.state().nudges.length,3);
  app.setConfig(settings({nudgeCooldownSeconds:0,maxOpenNudges:1}));
  assert.equal(app.state().nudges.length,1);assert.equal(app.one("SELECT COUNT(*) AS n FROM nudges WHERE status='waiting'").n,2);app.close();
});
