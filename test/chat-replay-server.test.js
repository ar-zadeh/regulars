import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {saveRecording} from '../src/chat-recording.js';
import {DEFAULT_SETTINGS} from '../src/config.js';

const fixture=()=>({format:'regulars-chat',version:1,name:'Replay server test',startedAt:'2026-10-31T20:00:00.000Z',
  settings:{...DEFAULT_SETTINGS},rules:[],durationMs:60000,messages:[0,60000].map((offsetMs,index)=>({
    id:'recorded-'+index,viewerId:'viewer-'+index,name:'Test viewer',text:'What is the new microphone?',
    timestamp:new Date(Date.parse('2026-10-31T20:00:00Z')+offsetMs).toISOString(),
    receivedAt:new Date(Date.parse('2026-10-31T20:00:00Z')+offsetMs).toISOString(),
    offsetMs,delayMs:offsetMs,bot:false,moderator:false,vip:false,
    previousResult:{category:'other',moderation:'cleared',topic:null},
  }))});

async function start(directory,recording){
  const file=join(directory,'recording.json');if(recording)saveRecording(file,recording);
  const changes={REGULARS_REPLAY_FILE:recording?file:'',PORT:'0',REGULARS_DATA_DIR:directory,REGULARS_AI:'offline',OPENROUTER_API_KEY:'',
    TWITCH_CLIENT_ID:recording?'synthetic-client':'',TWITCH_ACCESS_TOKEN:recording?'synthetic-token':'',
    TWITCH_BROADCASTER_ID:recording?'synthetic-owner':'',TWITCH_CLIENT_SECRET:''};
  const before=new Map(Object.keys(changes).map(key=>[key,process.env[key]]));Object.assign(process.env,changes);
  try{
    const running=await import(`../src/server.js?recording-test=${randomUUID()}`);
    if(!running.server.listening)await once(running.server,'listening');
    return {...running,base:`http://127.0.0.1:${running.server.address().port}`};
  }finally{for(const [key,value] of before)if(value===undefined)delete process.env[key];else process.env[key]=value;}
}

test('recorded replay uses the real dashboard in an isolated database and never starts Twitch',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'regulars-replay-server-test-'));
  const OriginalWebSocket=globalThis.WebSocket;let sockets=0,running;
  globalThis.WebSocket=class {constructor(){sockets++;throw new Error('Unexpected Twitch connection');}};
  try{
    running=await start(directory,fixture());const {app,base}=running;
    assert.equal((await fetch(base+'/api/playback/results')).status,401);
    const page=await fetch(base+'/');const cookie=page.headers.get('set-cookie').split(';')[0];
    assert.match(await page.text(),/id="playback-panel"/);
    const get=path=>fetch(base+path,{headers:{Cookie:cookie}});
    const post=(path,body={},origin=base)=>fetch(base+path,{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
    let state=await (await get('/api/state')).json();
    assert.equal(state.playback.status,'ready');assert.equal(state.playback.total,2);
    assert.equal(state.oauthAvailable,false);assert.equal(state.liveStatus.connected,false);
    assert.equal(state.session,null);assert.equal(sockets,0);
    assert.equal((await post('/api/playback/play',{},'https://example.com')).status,403);
    assert.equal((await post('/api/playback/speed',{speed:0})).status,400);
    assert.equal((await post('/api/playback/play')).status,200);
    assert.equal((await post('/api/playback/pause')).status,200);
    state=await (await get('/api/state')).json();
    assert.equal(state.playback.status,'paused');assert.equal(state.playback.sent,1);
    assert.equal(state.session.mode,'recorded-replay');
    assert.equal(app.one("SELECT category FROM messages WHERE id='recorded-0'").category,'question');
    const firstSession=state.session.id;
    const result=await get('/api/playback/results');
    assert.match(result.headers.get('content-disposition'),/attachment/);
    const report=await result.json();
    assert.equal(report.messages[0].result.category,'question');
    assert.equal(report.messages[0].previousResult.category,'other');
    assert.equal(report.messages[1].result,null);
    assert.equal(report.messages[1].delayMs,60000);
    assert.equal((await post('/api/replay')).status,400);
    assert.equal((await post('/api/twitch/connect')).status,400);
    assert.equal((await post('/api/playback/restart')).status,200);
    assert.equal((await post('/api/playback/pause')).status,200);
    state=await (await get('/api/state')).json();assert.notEqual(state.session.id,firstSession);
    assert.equal(state.playback.sent,1);assert.equal(app.one('SELECT COUNT(*) AS n FROM messages').n,1);
    assert.equal((await post('/api/playback/reset')).status,200);
    assert.equal((await (await get('/api/state')).json()).playback.sent,0);
    assert.equal(sockets,0);
    assert.equal(readdirSync(directory).some(name=>name.endsWith('.sqlite')),false);
  }finally{
    if(running)await new Promise(resolve=>running.server.close(resolve));
    globalThis.WebSocket=OriginalWebSocket;rmSync(directory,{recursive:true,force:true});
  }
});

test('the private recording download preserves the current session timing',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'regulars-save-server-test-'));let running;
  try{
    running=await start(directory);const {app,base}=running;
    assert.equal((await fetch(base+'/api/chat/recording')).status,401);
    const cookie=(await fetch(base+'/')).headers.get('set-cookie').split(';')[0];
    let now=Date.parse('2026-10-31T20:00:00Z');app.now=()=>now;app.startSession();
    await app.ingest({id:'one',viewerId:'one',name:'One',text:'Hello?',timestamp:new Date(now).toISOString()});
    now+=1876;
    await app.ingest({id:'two',viewerId:'two',name:'Two',text:'What microphone?',timestamp:new Date(now).toISOString()});
    const response=await fetch(base+'/api/chat/recording',{headers:{Cookie:cookie}});
    assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);
    const recording=await response.json();
    assert.deepEqual(recording.messages.map(m=>m.delayMs),[0,1876]);
    assert.equal(recording.durationMs,1876);
  }finally{
    if(running)await new Promise(resolve=>running.server.close(resolve));
    rmSync(directory,{recursive:true,force:true});
  }
});
