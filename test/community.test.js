import test from 'node:test';
import assert from 'node:assert/strict';
import { Regulars } from '../src/core.js';

const base=Date.parse('2026-01-01T02:00:00Z');
const ai={classify:async()=>({category:'other',subjects:[{id:'space',score:1}]}),nameSubjects:async()=>[],scoreSubject:async()=>0,summarize:async()=>''};
function setup(options={}){
  const app=new Regulars({ai,now:()=>base+120000,...options});
  app.startSession(new Date(base).toISOString());
  app.run("INSERT INTO subjects (id,name,description) VALUES ('space','Space travel','Discussion'),('games','Games','Discussion')");
  return app;
}
const say=(app,id,viewer,seconds=0,extra={})=>app.ingest({id,viewerId:viewer,name:viewer,text:`Interesting topic ${id}`,timestamp:new Date(base+seconds*1000).toISOString(),...extra});
const labels=(app,id)=>app.state().community.find(v=>v.id===id)?.types.map(t=>t.label) || [];

test('nonregular eligible night chat and verified early followers appear without awarding or fetching',async()=>{
  const app=setup({dayOneDate:'2025-01-01'});
  try{
    await say(app,'a','early');await say(app,'b','unknown');
    app.followDates.early='2024-12-31T23:00:00Z';
    assert.deepEqual(labels(app,'early'),['Night Owl','Day One']);
    assert.deepEqual(labels(app,'unknown'),['Night Owl']);
    assert.deepEqual(app.state().presence,[]);
    assert.equal(app.one('SELECT COUNT(*) AS n FROM awards').n,0);
    app.removeMessage('a');assert.deepEqual(labels(app,'early'),[]);
    app.forget('unknown');assert.deepEqual(labels(app,'unknown'),[]);
  } finally{app.close();}
});

test('current longest Hype follows settings, contributor order and subject exclusion',async()=>{
  const app=setup();
  try{
    for(const [id,viewer,time] of [['a','first',0],['b','second',10],['c','third',20]]) await say(app,id,viewer,time);
    app.setConfig({...app.config,hypeMaxContributors:2});
    assert.ok(labels(app,'first').includes('Hype Engine'));
    assert.ok(!labels(app,'third').includes('Hype Engine'));
    assert.equal(app.state().community.find(v=>v.id==='first').types.find(t=>t.label==='Hype Engine').provisional,true);
    for(const [id,viewer,time] of [['d','newfirst',30],['e','newsecond',50],['f','newthird',80]]) {await say(app,id,viewer,time);app.run("UPDATE messages SET subject_id='games' WHERE id=?",id);}
    assert.ok(!labels(app,'first').includes('Hype Engine'));
    assert.ok(labels(app,'newfirst').includes('Hype Engine'));
    app.run("UPDATE subjects SET excluded=1 WHERE id='games'");
    assert.ok(labels(app,'first').includes('Hype Engine'));
    app.setConfig({...app.config,hypeMinContributors:4});
    assert.ok(!app.state().community.some(v=>v.types.some(t=>t.label==='Hype Engine')));
  } finally{app.close();}
});

test('history requires current attendance and active evidence; commands, bots and hidden chat do not qualify',async()=>{
  const app=setup();
  try{
    const old=app.currentSession();app.sight({id:'old',name:'old'});
    app.run("INSERT INTO awards (session_id,title,viewer_id,evidence) VALUES (?,'Day One','old','[]')",old.id);
    app.run('UPDATE sessions SET end=? WHERE id=?',new Date(base).toISOString(),old.id);app.startSession();
    assert.deepEqual(labels(app,'old'),[]);app.updatePresence([{id:'old',name:'old'}]);
    assert.deepEqual(labels(app,'old'),['Day One']);
    app.run("UPDATE awards SET active=0 WHERE viewer_id='old'");assert.deepEqual(labels(app,'old'),[]);
    await say(app,'cmd','command',0,{text:'!help'});await say(app,'bot','robot',0,{bot:true});await say(app,'hidden','hidden');
    app.run("UPDATE messages SET moderation='hidden' WHERE id='hidden'");
    for(const id of ['command','robot','hidden']) assert.deepEqual(labels(app,id),[]);
  } finally{app.close();}
});

test('wrapped community follows stored awards and retractions instead of recomputing leaders',async()=>{
  const app=setup();
  try{
    await say(app,'a','one',0);await say(app,'b','two',10);await say(app,'c','three',20);
    await app.wrap({play:false});
    const snapshot=app.state().community;
    assert.equal(snapshot.find(v=>v.id==='one').types.find(t=>t.label==='Hype Engine').provisional,false);
    app.setConfig({...app.config,hypeMinContributors:4,nightOwlStart:'10:00',nightOwlEnd:'11:00'});
    assert.deepEqual(app.state().community,snapshot);
    app.removeMessage('a');assert.ok(!app.state().community.some(v=>v.types.some(t=>t.label==='Hype Engine')));
    app.run("UPDATE sessions SET incomplete=1 WHERE id=?",app.currentSession().id);
    assert.ok(!app.state().community.some(v=>v.types.some(t=>t.label==='Hype Engine')));
  } finally{app.close();}
});

test('historical Day One remains visible for regular presence before a chatter poll',()=>{
  const app=setup();
  try{
    const first=app.currentSession();
    app.sight({id:'early',name:'Early'},first,{nudge:false});
    app.run("INSERT INTO awards (session_id,title,viewer_id,evidence) VALUES (?,'Day One','early','[]')",first.id);
    for(let i=0;i<2;i++){
      const previous=app.currentSession();
      app.run('UPDATE sessions SET end=? WHERE id=?',new Date(base).toISOString(),previous.id);
      app.startSession();app.sight({id:'early',name:'Early'},app.currentSession(),{nudge:false});
    }
    assert.equal(app.presentIds,null);
    assert.deepEqual(app.state().presence.map(v=>v.id),['early']);
    assert.deepEqual(labels(app,'early'),['Regular','Day One']);
    app.updatePresence([]);
    assert.deepEqual(labels(app,'early'),[]);
  } finally{app.close();}
});
