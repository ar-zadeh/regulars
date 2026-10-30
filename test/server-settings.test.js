import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DEFAULT_SETTINGS} from '../src/config.js';

const root=resolve(import.meta.dirname,'..');
async function start(dataDir){
  const keys=['PORT','REGULARS_DATA_DIR','REGULARS_AI','OPENROUTER_API_KEY','TWITCH_CLIENT_ID','TWITCH_CLIENT_SECRET','TWITCH_ACCESS_TOKEN','TWITCH_BROADCASTER_ID'];
  const original=new Map(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{PORT:'0',REGULARS_DATA_DIR:dataDir,REGULARS_AI:'offline',OPENROUTER_API_KEY:'',TWITCH_CLIENT_ID:'',TWITCH_CLIENT_SECRET:'',TWITCH_ACCESS_TOKEN:'',TWITCH_BROADCASTER_ID:''});
  try{
    const {server,app}=await import(`../src/server.js?settings-test=${randomUUID()}`);
    if(!server.listening) await once(server,'listening');
    return {server,app,base:`http://127.0.0.1:${server.address().port}`};
  }finally{for(const [key,value] of original) if(value===undefined) delete process.env[key];else process.env[key]=value;}
}
test('settings API authenticates, persists, rejects invalid changes, and does not block demo',async()=>{
  const dir=mkdtempSync(join(root,'settings-test-'));let running;
  try{
    running=await start(dir);
    let {server,app,base}=running;
    assert.equal((await fetch(base+'/api/config')).status,401);
    let cookie=(await fetch(base+'/')).headers.get('set-cookie').split(';')[0];
    let get=()=>fetch(base+'/api/config',{headers:{Cookie:cookie}});
    let post=(input,origin=base)=>fetch(base+'/api/config',{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input)});
    assert.deepEqual((await (await get()).json()).settings,DEFAULT_SETTINGS);
    assert.equal((await post({settings:{regularMinimum:4}},'https://example.com')).status,403);
    let response=await post({settings:{regularMode:'consecutive',regularMinimum:8,summaryIntervalSeconds:2}});
    assert.equal(response.status,200);let saved=(await response.json()).settings;
    assert.equal(saved.regularMinimum,8);assert.equal(app.config.regularMinimum,8);
    response=await post({settings:{regularMode:'rolling',matchThreshold:0.1}});
    assert.equal(response.status,400);assert.deepEqual((await (await get()).json()).settings,saved);
    // Exercise the real scheduler: summary cadence changes without restarting the server.
    const originals={currentSession:app.currentSession,refreshSummary:app.refreshSummary,discover:app.discover,retryHeld:app.retryHeld,retryDeletes:app.retryDeletes};
    let summaries=0,discoveries=0;
    try{
      app.currentSession=()=>({id:'scheduler-test'});
      app.refreshSummary=async()=>{summaries++;};app.discover=async()=>{discoveries++;};
      app.retryHeld=()=>{};app.retryDeletes=()=>{};
      assert.equal((await post({settings:{summaryIntervalSeconds:1}})).status,200);
      await new Promise(done=>setTimeout(done,2400));
      assert.ok(summaries>=2,`Expected at least two summaries, got ${summaries}`);
      assert.equal(discoveries,1);
      assert.equal((await post({settings:{summaryIntervalSeconds:2}})).status,200);
    }finally{Object.assign(app,originals);}
    await new Promise(done=>server.close(done));running=null;
    running=await start(dir);({server,app,base}=running);
    cookie=(await fetch(base+'/')).headers.get('set-cookie').split(';')[0];
    get=()=>fetch(base+'/api/config',{headers:{Cookie:cookie}});
    assert.deepEqual((await (await get()).json()).settings,saved);
    assert.equal(app.config.regularMinimum,8);
    const replay=await fetch(base+'/api/replay',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:'{}'});
    assert.equal(replay.status,202);
    for(let i=0;i<100;i++){
      const state=await (await fetch(base+'/api/state',{headers:{Cookie:cookie}})).json();
      if(!state.replaying) break;
      await new Promise(done=>setTimeout(done,10));
    }
    assert.deepEqual((await (await get()).json()).settings,saved);
    assert.ok(app.all('SELECT id FROM messages').length>0);
    const scoreSubjects=app.ai.scoreSubjects;
    let beginScoring,finishScoring;
    const scoringStarted=new Promise(resolve=>{beginScoring=resolve;});
    const scoringFinished=new Promise(resolve=>{finishScoring=resolve;});
    try{
      app.ai.scoreSubjects=async ({messages})=>{
        beginScoring();await scoringFinished;return messages.map(()=>0.75);
      };
      const search=fetch(base+'/api/stickers/search',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:JSON.stringify({subject:'microphone'})});
      await scoringStarted;
      assert.equal((await post({settings:{matchThreshold:0.8}})).status,200);
      finishScoring();
      const result=await search;
      assert.equal(result.status,400);
      assert.match((await result.json()).error,/Chat changed during this search/);
    }finally{finishScoring?.();app.ai.scoreSubjects=scoreSubjects;}
    const deleted=await fetch(base+'/api/privacy/delete-channel',{method:'POST',headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json'},body:'{}'});
    assert.equal(deleted.status,200);
    assert.deepEqual((await (await get()).json()).settings,DEFAULT_SETTINGS);
  }finally{
    if(running) await new Promise(done=>running.server.close(done));
    if(resolve(dir).startsWith(root+sep)) rmSync(dir,{recursive:true,force:true});
  }
});
