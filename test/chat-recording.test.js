import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Regulars} from '../src/core.js';
import {recordChat,saveRecording,loadRecording,validateRecording} from '../src/chat-recording.js';

const start=Date.parse('2026-10-31T20:00:00Z');
const ai={classify:async()=>({category:'question',topics:[],subjects:[],addressesAI:0})};

test('recording keeps arrival gaps, Twitch timestamp precision, identities and message flags',async t=>{
  let now=start;
  const app=new Regulars({ai,now:()=>now});t.after(()=>app.close());
  app.startSession(new Date(start-5000).toISOString());
  const timestamps=['2026-10-31T19:59:59.987654321Z','2026-10-31T20:00:00.015Z','2026-10-31T20:00:03.250Z'];
  for(const [i,gap] of [0,37,4321].entries()){
    now=start+gap;
    await app.ingest({id:'m'+i,viewerId:'v'+i,name:'Viewer '+i,login:'viewer'+i,text:'A question?',timestamp:timestamps[i],
      parentId:i?'m0':null,moderator:i===1,vip:i===2});
  }
  app.run("UPDATE messages SET about='Tea choice' WHERE id='m0'");
  const recording=recordChat(app.db,{broadcasterId:'owner',name:'Timing test'});
  assert.equal(recording.messages[0].previousResult.about,'Tea choice');
  assert.deepEqual(recording.messages.map(m=>m.offsetMs),[0,37,4321]);
  assert.deepEqual(recording.messages.map(m=>m.delayMs),[0,37,4284]);
  assert.deepEqual(recording.messages.map(m=>m.timestamp),timestamps);
  assert.equal(recording.durationMs,4321);
  assert.equal(recording.messages[1].moderator,true);
  assert.equal(recording.messages[2].vip,true);
  assert.equal(recording.messages[1].parentId,'m0');
  assert.equal(recording.messages[0].previousResult.category,'question');
  assert.equal(recording.messages[0].category,'question');
  assert.equal(recording.broadcasterId,'owner');
  assert.equal(recording.messages[0].receivedAt,new Date(start).toISOString());
  const directory=mkdtempSync(join(tmpdir(),'regulars-recording-test-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const file=join(directory,'recording.json');saveRecording(file,recording);
  assert.deepEqual(loadRecording(file),recording);
  // Windows exposes writable files as 0666; POSIX permission bits apply there only on Unix.
  assert.equal(statSync(file).mode & 0o777,process.platform==='win32'?0o666:0o600);
  assert.throws(()=>saveRecording(file,recording),/EEXIST/);
});

test('export excludes removed, expired and opted-out chat while retaining gaps across omitted rows',async t=>{
  let now=start;
  const app=new Regulars({ai,now:()=>now});t.after(()=>app.close());app.startSession();
  for(let i=0;i<5;i++){
    now=start+i*1000;
    await app.ingest({id:'m'+i,viewerId:'v'+i,name:'Viewer',text:'hello?',timestamp:new Date(now).toISOString()});
  }
  app.removeMessage('m1');app.forget('v2');app.run("UPDATE messages SET text=NULL WHERE id='m3'");
  const recording=recordChat(app.db);
  assert.deepEqual(recording.messages.map(m=>m.id),['m0','m4']);
  assert.equal(recording.messages[1].delayMs,4000);
  app.run('UPDATE messages SET text=NULL');
  assert.throws(()=>recordChat(app.db),/no retained chat/);
});

test('invalid recordings reject corrupt timing and repeated message IDs',async t=>{
  const app=new Regulars({ai,now:()=>start});t.after(()=>app.close());app.startSession();
  await app.ingest({id:'m',viewerId:'v',name:'Viewer',text:'hello?',timestamp:new Date(start).toISOString()});
  const recording=recordChat(app.db);
  assert.throws(()=>validateRecording({...recording,durationMs:3}),/duration/);
  assert.throws(()=>validateRecording({...recording,messages:[...recording.messages,...recording.messages]}),/Invalid recorded message/);
  assert.throws(()=>validateRecording({...recording,messages:[{...recording.messages[0],delayMs:1}]}),/Invalid recorded message/);
  assert.throws(()=>validateRecording({...recording,version:2}),/Unsupported/);
});

test('recordings retain emote-only eligibility without excluding ordinary reaction sentences',async t=>{
  const app=new Regulars({ai,now:()=>start});t.after(()=>app.close());app.startSession();
  await app.ingest({id:'emote',viewerId:'v',name:'Viewer',text:'CustomWave',reaction:true});
  await app.ingest({id:'sentence',viewerId:'v',name:'Viewer',text:'That boss was scary'});
  assert.deepEqual(recordChat(app.db).messages.map(m=>m.reaction),[true,false]);
});
