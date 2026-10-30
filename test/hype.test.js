import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Regulars } from '../src/core.js';

const ai = {
  classify: async () => ({ category:'other', addressesAI:0, topics:[], subjects:[{id:'topic',score:0.9}] }),
  nameSubjects: async () => [], scoreSubject: async () => 0, summarize: async () => ''
};
const base = Date.parse('2026-01-01T12:00:00Z');
const event = (id, viewer, seconds) => ({id,viewerId:viewer,name:viewer,text:`discussion line ${id}`,timestamp:new Date(base+seconds*1000).toISOString()});

test('Hype subject, duration, and starter order survive restart and replay; a removed source retracts the card', async () => {
  const dir=mkdtempSync(join(tmpdir(),'regulars-hype-')), path=join(dir,'db.sqlite');
  try {
    let app=new Regulars({dbPath:path,ai,now:()=>base+100000});
    const session=app.startSession(new Date(base).toISOString());
    app.run("INSERT INTO subjects (id,name,description) VALUES ('topic','Space travel','A discussion')");
    for(let i=10;i>=0;i--) await app.ingest(event(`m${i}`,`user${i}`,i*5));
    const awards=await app.wrap({play:true});
    assert.deepEqual(awards,[{title:'Hype Engine',recipients:Array.from({length:10},(_,i)=>`user${i}`),subject:'Space travel',durationMs:50000}]);
    assert.deepEqual(app.overlayEvent.awards,awards);
    app.close();
    app=new Regulars({dbPath:path,ai,now:()=>base+100000});
    assert.deepEqual(app.awards(session.id),awards);
    assert.deepEqual(await app.wrap({play:true}),awards);
    app.removeMessage('m10');
    assert.deepEqual(app.awards(session.id),[]);
    assert.equal(app.overlayEvent,null);
    assert.deepEqual(await app.wrap({play:true}),[]);
    app.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('opt-out retracts all Hype metadata and sanitizes labels at creation', async () => {
  const app=new Regulars({ai,now:()=>base+100000});app.startSession(new Date(base).toISOString());
  app.run("INSERT INTO subjects (id,name,description) VALUES ('topic','Alice and @Someone https://example.com','A discussion')");
  await app.ingest(event('a','Alice',0));await app.ingest(event('b','Bob',5));await app.ingest(event('c','Charlie',10));
  const [award]=await app.wrap();
  assert.equal(award.durationMs,10000);
  assert.doesNotMatch(award.subject,/Alice|@Someone|https?:/i);
  app.forget('Alice');assert.deepEqual(app.awards(),[]);assert.equal(app.overlayEvent,null);app.close();
});

test('legacy award table is migrated without inventing historical Hype details', () => {
  const dir=mkdtempSync(join(tmpdir(),'regulars-hype-migration-')), path=join(dir,'db.sqlite');
  try {
    const db=new DatabaseSync(path);
    db.exec("CREATE TABLE awards (session_id TEXT NOT NULL,title TEXT NOT NULL,viewer_id TEXT NOT NULL,evidence TEXT NOT NULL,active INTEGER DEFAULT 1,PRIMARY KEY(session_id,title,viewer_id))");db.close();
    const app=new Regulars({dbPath:path,ai});app.startSession();
    app.sight({id:'a',name:'A'});
    app.run("INSERT INTO awards (session_id,title,viewer_id,evidence) VALUES (?,'Hype Engine','a','[]')",app.currentSession().id);
    assert.deepEqual(app.awards(),[{title:'Hype Engine',recipients:['A']}]);app.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('overlay caps loyalty names, keeps ten Hype starters, and renders no source text', async () => {
  const children=[];
  const card={
    append(...nodes){children.push(...nodes);},
    replaceChildren(){children.length=0;},
    classList:{add(){},remove(){}}
  };
  const awards=[
    {title:'Night Owl',recipients:Array.from({length:7},(_,i)=>`owl${i+1}`)},
    {title:'Day One',recipients:Array.from({length:6},(_,i)=>`day${i+1}`)},
    {title:'Hype Engine',recipients:Array.from({length:10},(_,i)=>`starter${i+1}`),subject:'Space travel',durationMs:50000,evidence:['secret-source-id'],text:'private chat quote'}
  ];
  const context=vm.createContext({
    document:{querySelector:()=>card,createElement:tagName=>({tagName,textContent:'',className:''})},
    location:{search:'?token=test',href:'http://localhost/overlay',origin:'http://localhost'},
    fetch:async()=>({ok:true,json:async()=>({event:{id:'wrap-1',type:'awards',awards}})}),
    URL,URLSearchParams,setInterval:()=>0,setTimeout:()=>0,clearTimeout
  });
  vm.runInContext(readFileSync(new URL('../public/overlay.js',import.meta.url),'utf8'),context);
  await vm.runInContext('poll()',context);
  const rows=children.filter(node=>node.tagName==='p').map(node=>node.textContent);
  assert.deepEqual(rows,[
    'Night Owl: owl1, owl2, owl3, owl4, owl5 +2 more',
    'Day One: day1, day2, day3, day4, day5 +1 more',
    'Hype Engine (Space travel · 50s): '+Array.from({length:10},(_,i)=>`starter${i+1}`).join(', ')
  ]);
  assert.doesNotMatch(children.map(node=>node.textContent).join(' '),/owl6|owl7|day6|secret-source-id|private chat quote/);
});
