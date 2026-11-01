import test from 'node:test';
import assert from 'node:assert/strict';
import {Regulars} from '../src/core.js';
import {ChatReplay} from '../src/chat-replay.js';
import {DEFAULT_SETTINGS} from '../src/config.js';

const start=Date.parse('2026-10-31T20:00:00Z');
const fixture=()=>({format:'regulars-chat',version:1,name:'Recorded chat',startedAt:new Date(start).toISOString(),
  settings:{...DEFAULT_SETTINGS},rules:[],durationMs:1037,messages:[0,37,1037].map((offsetMs,index)=>({
    id:'m'+index,viewerId:'viewer'+index,name:'Viewer '+index,login:'viewer'+index,text:'Question '+index+'?',
    timestamp:new Date(start+offsetMs-20).toISOString(),receivedAt:new Date(start+offsetMs).toISOString(),
    offsetMs,delayMs:index===0?0:index===1?37:1000,bot:false,moderator:false,vip:false,parentId:index?'m0':null,
    category:'opinion',previousResult:{category:'opinion',topic:null,moderation:'cleared'},
  }))});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
class Clock {
  time=0;timers=new Map();id=0;
  now=()=>this.time;
  setTimer=(fn,delay)=>{const id=++this.id;this.timers.set(id,{fn,at:this.time+delay});return id;};
  clearTimer=id=>this.timers.delete(id);
  async advance(ms){
    const end=this.time+ms;
    for(;;){
      const next=[...this.timers].filter(([,timer])=>timer.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!next)break;
      this.time=next[1].at;this.timers.delete(next[0]);next[1].fn();await settle();
    }
    this.time=end;await settle();
  }
}
function setup(t,{classify}={}){
  const clock=new Clock(),arrivals=[];
  const app=new Regulars({ai:{classify:classify || (async()=>({category:'question',addressesAI:0,subjects:[],topics:[]})),
    nameSubjects:async()=>[],summarize:async()=>''}});
  const ingest=app.ingest.bind(app);
  app.ingest=event=>{arrivals.push({time:clock.time,event});return ingest(event);};
  const replay=new ChatReplay({app,recording:fixture(),now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer});
  t.after(async()=>{await replay.close();app.close();});
  return {clock,app,replay,arrivals};
}

test('1x playback preserves exact arrival gaps and reclassifies original messages',async t=>{
  const {clock,replay,app,arrivals}=setup(t);
  await replay.play();await settle();
  await clock.advance(36);assert.equal(arrivals.length,1);
  await clock.advance(1);assert.equal(arrivals.length,2);
  await clock.advance(1000);
  assert.deepEqual(arrivals.map(a=>a.time),[0,37,1037]);
  assert.deepEqual(arrivals.map(a=>a.event.timestamp),fixture().messages.map(m=>m.timestamp));
  assert.equal(app.now(),start+1037);
  assert.deepEqual(replay.results().messages.map(m=>m.result.category),['question','question','question']);
  assert.equal(replay.results().messages[0].previousResult.category,'opinion');
  assert.equal(replay.results().messages[0].recordedCategory,'opinion');
  assert.equal(replay.state().recent[0].originalCategory,'opinion');
  await clock.advance(12000);
  assert.equal(replay.state().status,'completed');
});

test('slow AI work does not add delay to later arrivals',async t=>{
  let release;
  const waiting=new Promise(resolve=>{release=resolve;});
  const {clock,replay,arrivals}=setup(t,{classify:async({text})=>{
    if(text==='Question 0?')await waiting;
    return {category:'question',topics:[],subjects:[]};
  }});
  try{
    await replay.play();await clock.advance(1037);
    assert.deepEqual(arrivals.map(a=>a.time),[0,37,1037]);
    assert.equal(replay.state().held,1);
  }finally{release();await settle();}
});

test('replay preserves recorded emote-only eligibility',async t=>{
  const {replay,app}=setup(t);
  replay.recording.messages[0].text='CustomWave';replay.recording.messages[0].reaction=true;
  await replay.play();await settle();
  assert.equal(app.one("SELECT organizer FROM messages WHERE id='m0'").organizer,'reaction');
});

test('pause, resume and speed changes preserve the remaining interval without duplicates',async t=>{
  const {clock,replay,arrivals,app}=setup(t);
  await replay.play();await clock.advance(17);replay.pause();
  const frozen=app.now();await clock.advance(5000);
  assert.equal(app.now(),frozen);assert.equal(arrivals.length,1);
  replay.setSpeed(2);await replay.play();await clock.advance(9);
  assert.equal(arrivals.length,1);await clock.advance(1);
  assert.equal(arrivals[1].time,5027);assert.equal(app.now(),start+37);
  replay.setSpeed(4);await clock.advance(250);
  assert.equal(arrivals[2].time,5277);
  assert.throws(()=>replay.setSpeed(0),/speed/);
});

test('reset creates a fresh categorization run and keeps chosen settings',async t=>{
  const {clock,replay,app}=setup(t);
  await replay.play();await clock.advance(1037);
  const previous=app.currentSession().id;
  app.setConfig({...app.config,matchThreshold:0.8});
  await replay.reset();assert.equal(replay.state().status,'ready');
  assert.equal(app.one('SELECT COUNT(*) AS n FROM messages').n,0);
  assert.equal(app.one('SELECT COUNT(*) AS n FROM events').n,0);
  assert.equal(app.one('SELECT COUNT(*) AS n FROM subjects').n,0);
  assert.equal(app.config.matchThreshold,0.8);
  await replay.play();await settle();
  assert.notEqual(app.currentSession().id,previous);
  assert.equal(app.one('SELECT COUNT(*) AS n FROM messages').n,1);
  assert.equal(replay.state().sent,1);
});

test('reset cancels in-flight classifications before clearing the run',async t=>{
  let canceled=false;
  const {replay,app}=setup(t,{classify:({signal})=>new Promise((_,reject)=>{
    signal.addEventListener('abort',()=>{canceled=true;reject(new Error('aborted'));},{once:true});
  })});
  await replay.play();await settle();await replay.reset();
  assert.equal(canceled,true);
  assert.equal(app.pending.size,0);
  assert.equal(app.one('SELECT COUNT(*) AS n FROM messages').n,0);
  assert.equal(replay.state().sent,0);
});
