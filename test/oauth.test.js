import test from 'node:test';
import assert from 'node:assert/strict';
import {TwitchOAuth} from '../src/oauth.js';
import {TWITCH_SCOPES} from '../src/twitch.js';

const response=(body,status=200)=>({ok:status>=200 && status<300,status,json:async()=>body});
function provider(){
  let refreshCount=0;const requests=[];
  const fetchImpl=async(url,options)=>{
    requests.push({url,options});
    if(url.endsWith('/validate')) return response({client_id:'client',user_id:'owner',login:'owner',scopes:TWITCH_SCOPES});
    const refresh=options.body.get('grant_type')==='refresh_token';
    if(refresh){refreshCount++;return response({access_token:`access-${refreshCount}`,refresh_token:`refresh-${refreshCount}`,expires_in:3600});}
    return response({access_token:'access-0',refresh_token:'refresh-0',expires_in:3600});
  };
  return {fetchImpl,requests};
}
function make(overrides={}){return new TwitchOAuth({clientId:'client',clientSecret:'secret',redirectUri:'http://localhost:3000/twitch/callback',...overrides});}
function callback(manager){const state=new URL(manager.begin()).searchParams.get('state');return `http://localhost:3000/twitch/callback?code=synthetic&state=${state}`;}

test('authorizes with one-use random state and exposes only public metadata',async()=>{
  const {fetchImpl}=provider(),tokens=[],statuses=[],manager=make({fetchImpl,onToken:async token=>tokens.push(token),onStatus:status=>statuses.push(status)});
  try{
    const url=callback(manager),state=new URL(url).searchParams.get('state');assert.match(state,/^[a-f0-9]{64}$/);
    const result=await manager.complete(url);assert.equal(result.userId,'owner');assert.equal(result.accessToken,undefined);assert.equal(tokens[0].accessToken,'access-0');assert.equal(statuses[0].state,'authorized');
    await assert.rejects(manager.complete(url),/expired or already used/);
  }finally{manager.close();}
});
test('rejects expired, mismatched, repeated and wrongly routed callbacks before exchange',async()=>{
  const {fetchImpl,requests}=provider();let now=0;const manager=make({fetchImpl,now:()=>now,stateTtlMs:10});
  try{
    const url=callback(manager),state=new URL(url).searchParams.get('state');
    await assert.rejects(manager.complete('http://localhost:3000/twitch/callback?state=wrong&code=x'),/mismatch/);
    await assert.rejects(manager.complete(`http://localhost:3000/other?state=${state}&code=x`),/Invalid OAuth callback/);
    await assert.rejects(manager.complete(`${url}&state=${state}`),/mismatch/);
    now=10;await assert.rejects(manager.complete(url),/expired/);assert.equal(requests.length,0);
    const denied=callback(manager).replace('code=synthetic','error=access_denied');await assert.rejects(manager.complete(denied),/denied/);await assert.rejects(manager.complete(denied),/already used/);
    const ambiguous=`${callback(manager)}&code=other`;await assert.rejects(manager.complete(ambiguous),/Invalid OAuth callback/);assert.equal(requests.length,0);
  }finally{manager.close();}
});
test('refresh rotates tokens and validates the same account',async()=>{
  const {fetchImpl,requests}=provider(),tokens=[],statuses=[],manager=make({fetchImpl,onToken:async token=>tokens.push(token),onStatus:status=>statuses.push(status)});
  try{
    await manager.complete(callback(manager));await manager.refresh();await manager.refresh();
    const refreshes=requests.filter(r=>r.url.endsWith('/token') && r.options.body.get('grant_type')==='refresh_token');
    assert.equal(refreshes[0].options.body.get('refresh_token'),'refresh-0');assert.equal(refreshes[1].options.body.get('refresh_token'),'refresh-1');
    assert.equal(tokens[2].accessToken,'access-2');assert.deepEqual(statuses.map(s=>s.state),['authorized','refreshed','refreshed']);
  }finally{manager.close();}
});
test('revoked refresh clears authorization without exposing provider data',async()=>{
  const base=provider(),statuses=[],manager=make({fetchImpl:async(url,options)=>options.body?.get('grant_type')==='refresh_token' ? response({},401) : base.fetchImpl(url,options),onStatus:s=>statuses.push(s)});
  try{await manager.complete(callback(manager));await assert.rejects(manager.refresh(),/could not be refreshed/);assert.equal(statuses.at(-1).state,'reauthorize');await assert.rejects(manager.refresh(),/No Twitch authorization/);}finally{manager.close();}
});
test('close prevents a delayed exchange from connecting',async()=>{
  let release;const fetchImpl=async url=>url.endsWith('/token')?new Promise(resolve=>{release=()=>resolve(response({access_token:'a',refresh_token:'r',expires_in:3600}));}):response({client_id:'client',user_id:'owner',scopes:TWITCH_SCOPES});
  let delivered=0;const manager=make({fetchImpl,onToken:async()=>{delivered++;}});const result=manager.complete(callback(manager));await new Promise(resolve=>setImmediate(resolve));manager.close();release();await assert.rejects(result,/superseded/);assert.equal(delivered,0);
});
test('a cancelled refresh timer cannot refresh a newer session',async()=>{
  const {fetchImpl,requests}=provider(),timers=[];
  const manager=make({fetchImpl,setTimer:(fn,ms)=>{const timer={fn,ms,unref(){}};timers.push(timer);return timer;},clearTimer:timer=>{timer.cancelled=true;}});
  try{
    await manager.complete(callback(manager));const first=timers.find(t=>t.ms>10000);assert.ok(first);
    await manager.refresh();const before=requests.length;first.fn();await new Promise(resolve=>setImmediate(resolve));assert.equal(requests.length,before);
  }finally{manager.close();}
});
test('a stale refresh cannot block or replace a newly authorized session',async()=>{
  let releaseOld,refreshCount=0;const tokens=[];
  const fetchImpl=async(url,options)=>{
    if(url.endsWith('/validate')) return response({client_id:'client',user_id:'owner',login:'owner',scopes:TWITCH_SCOPES});
    if(options.body.get('grant_type')==='authorization_code') return response({access_token:'new-login',refresh_token:'new-refresh',expires_in:3600});
    refreshCount++;
    if(refreshCount===1) return new Promise(resolve=>{releaseOld=()=>resolve(response({access_token:'stale',refresh_token:'stale-refresh',expires_in:3600}));});
    return response({access_token:'fresh',refresh_token:'fresh-refresh',expires_in:3600});
  };
  const manager=make({fetchImpl,onToken:async token=>tokens.push(token.accessToken)});
  try{
    await manager.complete(callback(manager));
    const oldRefresh=manager.refresh();while(!releaseOld) await new Promise(resolve=>setImmediate(resolve));
    manager.disconnect();await manager.complete(callback(manager));await manager.refresh();
    assert.equal(refreshCount,2);assert.deepEqual(tokens,['new-login','new-login','fresh']);
    releaseOld();await oldRefresh;assert.deepEqual(tokens,['new-login','new-login','fresh']);
  }finally{manager.close();}
});
test('refuses a token with missing scopes before connecting the account',async()=>{
  let delivered=0;const fetchImpl=async(url,options)=>url.endsWith('/validate')
    ? response({client_id:'client',user_id:'owner',scopes:TWITCH_SCOPES.slice(1)})
    : response({access_token:'access',refresh_token:'refresh',expires_in:3600});
  const manager=make({fetchImpl,onToken:async()=>{delivered++;}});
  try{await assert.rejects(manager.complete(callback(manager)),/Missing Twitch scopes/);assert.equal(delivered,0);await assert.rejects(manager.refresh(),/No Twitch authorization/);}finally{manager.close();}
});
test('close aborts a pending account connection and suppresses status',async()=>{
  const {fetchImpl}=provider();let release,signal;const statuses=[];
  const manager=make({fetchImpl,onToken:async token=>{signal=token.signal;await new Promise(resolve=>{release=resolve;});},onStatus:status=>statuses.push(status)});
  const completion=manager.complete(callback(manager));while(!release) await new Promise(resolve=>setImmediate(resolve));
  manager.close();assert.equal(signal.aborted,true);release();await assert.rejects(completion,/superseded/);assert.deepEqual(statuses,[]);
});
test('rejects nonlocal redirect URIs',()=>{assert.throws(()=>make({redirectUri:'https://attacker.invalid/callback'}),/local Twitch redirect/);});
