import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {TWITCH_SCOPES} from '../src/twitch.js';

const root=resolve(import.meta.dirname,'..');
let instance=0;
class FakeSocket {static count=0;constructor(){FakeSocket.count++;this.listeners=new Map();}addEventListener(name,fn){this.listeners.set(name,fn);}close(){this.listeners.get('close')?.();}}

async function start(dataDir,broadcasterId,{redirectUri='',accessToken=''}={}){
  const keys=['PORT','REGULARS_DATA_DIR','REGULARS_AI','OPENROUTER_API_KEY','TWITCH_CLIENT_ID','TWITCH_CLIENT_SECRET','TWITCH_ACCESS_TOKEN','TWITCH_BROADCASTER_ID','TWITCH_REDIRECT_URI'];
  const old=new Map(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,{PORT:'0',REGULARS_DATA_DIR:dataDir,REGULARS_AI:'offline',OPENROUTER_API_KEY:'',TWITCH_CLIENT_ID:'test-client',TWITCH_CLIENT_SECRET:'synthetic-client-secret',TWITCH_ACCESS_TOKEN:accessToken,TWITCH_BROADCASTER_ID:broadcasterId,TWITCH_REDIRECT_URI:redirectUri});
  try{
    const {server}=await import(`../src/server.js?oauth-test-${++instance}`);
    if(!server.listening) await once(server,'listening');
    return {base:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(done=>server.close(done))};
  }finally{for(const [key,value] of old) if(value===undefined) delete process.env[key];else process.env[key]=value;}
}

test('OAuth callback binds the configured broadcaster and partitions channel storage',async()=>{
  const dataDir=mkdtempSync(join(root,'oauth-server-test-'));
  const nativeFetch=globalThis.fetch,nativeSocket=globalThis.WebSocket;
  let validationUser='other',providerCalls=0,first,second,third,delayToken=false,releaseToken;
  globalThis.WebSocket=FakeSocket;
  globalThis.fetch=(url,options={})=>{
    const target=String(url);
    if(target==='https://id.twitch.tv/oauth2/token'){
      providerCalls++;
      const tokenResponse=()=>new Response(JSON.stringify({access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600}),{status:200});
      if(delayToken) return new Promise(resolveToken=>{releaseToken=()=>resolveToken(tokenResponse());});
      return Promise.resolve(tokenResponse());
    }
    if(target==='https://id.twitch.tv/oauth2/validate'){
      providerCalls++;
      return Promise.resolve(new Response(JSON.stringify({client_id:'test-client',user_id:validationUser,login:'synthetic',scopes:TWITCH_SCOPES}),{status:200}));
    }
    if(target.startsWith('https://api.twitch.tv/helix/')) return Promise.resolve(new Response(JSON.stringify({data:[],pagination:{}}),{status:200}));
    throw new Error(`Unexpected external request: ${target}`);
  };
  try{
    first=await start(dataDir,'owner-one');
    const req=(base,path,options={})=>nativeFetch(base+path,options);
    const page=await req(first.base,'/');
    const cookie=page.headers.get('set-cookie').split(';')[0];
    const post=(base,path,data={},origin=base)=>req(base,path,{method:'POST',headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
    assert.equal((await req(first.base,'/api/twitch/connect',{method:'POST'})).status,401);
    assert.equal((await post(first.base,'/api/twitch/connect',{},'https://example.invalid')).status,403);
    const connect=await (await post(first.base,'/api/twitch/connect')).json();
    const auth=new URL(connect.url),state=auth.searchParams.get('state');
    assert.equal(auth.hostname,'id.twitch.tv');assert.match(state,/^[a-f0-9]{64}$/);
    assert.equal((await req(first.base,`/twitch/callback?code=synthetic&state=wrong`,{redirect:'manual'})).headers.get('location'),'/?twitch=failed');
    assert.equal(providerCalls,0);
    const callback=`/twitch/callback?code=synthetic&state=${state}`;
    assert.equal((await req(first.base,callback,{redirect:'manual'})).headers.get('location'),'/?twitch=failed');
    assert.equal((await req(first.base,callback,{redirect:'manual'})).headers.get('location'),'/?twitch=failed');
    validationUser='owner-one';
    const next=await (await post(first.base,'/api/twitch/connect')).json();
    const accepted=`/twitch/callback?code=synthetic&state=${new URL(next.url).searchParams.get('state')}`;
    assert.equal((await req(first.base,accepted,{redirect:'manual'})).headers.get('location'),'/?twitch=connected');
    const stateBody=await (await req(first.base,'/api/state',{headers:{Cookie:cookie}})).text();
    assert.doesNotMatch(stateBody,/synthetic-access|synthetic-refresh|synthetic-client-secret/);
    assert.equal((await post(first.base,'/api/rules',{topic:'test topic',action:'hide'})).status,201);
    assert.equal((await post(first.base,'/api/twitch/disconnect')).status,200);
    delayToken=true;
    const interrupted=await (await post(first.base,'/api/twitch/connect')).json();
    const interruptedCallback=req(first.base,`/twitch/callback?code=synthetic&state=${new URL(interrupted.url).searchParams.get('state')}`,{redirect:'manual'});
    for(let i=0;i<100 && !releaseToken;i++) await new Promise(resolveWait=>setTimeout(resolveWait,5));
    assert.equal(typeof releaseToken,'function');
    assert.equal((await post(first.base,'/api/twitch/disconnect')).status,200);
    releaseToken();releaseToken=null;delayToken=false;
    assert.equal((await interruptedCallback).headers.get('location'),'/?twitch=failed');
    await first.close();first=null;

    second=await start(dataDir,'owner-two');
    const secondCookie=(await req(second.base,'/')).headers.get('set-cookie').split(';')[0];
    const other=await (await req(second.base,'/api/state',{headers:{Cookie:secondCookie}})).json();
    assert.deepEqual(other.rules,[]);
    const files=readdirSync(dataDir).filter(name=>name.endsWith('.sqlite'));
    assert.equal(files.length,2);
    assert.ok(files.every(name=>/^regulars-live-[a-f0-9]{24}\.sqlite$/.test(name)));
    third=await start(dataDir,'owner-three',{redirectUri:'https://example.invalid/twitch/callback'});
    const invalidCookie=(await req(third.base,'/')).headers.get('set-cookie').split(';')[0];
    const invalidState=await (await req(third.base,'/api/state',{headers:{Cookie:invalidCookie}})).json();
    assert.equal(invalidState.oauthAvailable,false);
    assert.equal(invalidState.liveStatus.reason,'Invalid local Twitch redirect configuration');
  }finally{
    if(first) await first.close();if(second) await second.close();if(third) await third.close();
    globalThis.fetch=nativeFetch;globalThis.WebSocket=nativeSocket;
    rmSync(dataDir,{recursive:true,force:true});
  }
});

test('disconnect cancels direct-token startup before a delayed validation creates a bridge',async()=>{
  const dataDir=mkdtempSync(join(root,'direct-server-test-'));
  const nativeFetch=globalThis.fetch,nativeSocket=globalThis.WebSocket;
  let releaseValidation,validationSignal,server;
  FakeSocket.count=0;
  globalThis.WebSocket=FakeSocket;
  globalThis.fetch=(url,options)=>{
    if(String(url)==='https://id.twitch.tv/oauth2/validate') return new Promise(resolveValidation=>{
      validationSignal=options.signal;
      releaseValidation=()=>resolveValidation(new Response(JSON.stringify({client_id:'test-client',user_id:'owner-direct',scopes:TWITCH_SCOPES}),{status:200}));
    });
    throw new Error('Unexpected external request');
  };
  try{
    server=await start(dataDir,'owner-direct',{accessToken:'synthetic-direct-token'});
    for(let i=0;i<100 && !releaseValidation;i++) await new Promise(resolveWait=>setTimeout(resolveWait,5));
    assert.equal(typeof releaseValidation,'function');
    const cookie=(await nativeFetch(server.base+'/')).headers.get('set-cookie').split(';')[0];
    const disconnect=await nativeFetch(server.base+'/api/twitch/disconnect',{method:'POST',headers:{Cookie:cookie,Origin:server.base,'Content-Type':'application/json'},body:'{}'});
    assert.equal(disconnect.status,200);
    assert.equal(validationSignal.aborted,true);
    const state=await (await nativeFetch(server.base+'/api/state',{headers:{Cookie:cookie}})).json();
    assert.equal(state.liveStatus.reason,'Disconnected');
    await server.close();server=null;
    assert.equal(FakeSocket.count,0);
  }finally{
    releaseValidation?.();if(server) await server.close();
    await new Promise(resolveWait=>setImmediate(resolveWait));
    globalThis.fetch=nativeFetch;globalThis.WebSocket=nativeSocket;
    rmSync(dataDir,{recursive:true,force:true});
  }
});
