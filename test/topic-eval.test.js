import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAI} from '../src/ai.js';
import {lockEvaluation,budgetedJevFetch,groupingMetrics,highestPricing} from '../scripts/topic-eval-support.js';
import {twitchChats} from './fixtures/twitch-chats.js';

test('external Luna naming preserves sanitization and never calls OpenRouter',async()=>{
  let input;
  const ai=createAI({apiKey:'test',fetchImpl:()=>{throw new Error('Unexpected OpenRouter request');},textGenerator:async request=>{
    input=request;return JSON.stringify([{name:'Balcony tomatoes',description:'Tomato leaves and watering.'}]);
  }});
  const result=await ai.nameSubjects({messages:['@alice is growing tomatoes'],identities:['alice']});
  assert.equal(result[0].name,'Balcony tomatoes');
  assert.doesNotMatch(JSON.stringify(input.messages),/alice/i);
  assert.match(JSON.stringify(input.messages),/viewer_1/);
});

test('budget guard rejects non-JEV models, reserves concurrent spend and persists reported cost',async t=>{
  const root=mkdtempSync(join(tmpdir(),'regulars-budget-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  let calls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const metadata={budgetUsd:0.03,contextLength:1000,pricing:{prompt:'0.00001',completion:'0'}};
  const guarded=budgetedJevFetch(metadata,{root,fetchImpl:async()=>{calls++;await gate;return new Response(JSON.stringify({usage:{input_tokens:100,output_tokens:0,cost:0.001}}));}});
  const options=model=>({method:'POST',body:JSON.stringify({model,questions:{a:{type:'noul'},b:{type:'noul'}}})});
  await assert.rejects(guarded('https://openrouter.ai/api/v1/chat/completions',options('openai/gpt-6-luna')),/only JEV/);
  const first=guarded('https://openrouter.ai/api/alpha/decisions',options('typesafe/jev-1.14'));
  await assert.rejects(guarded('https://openrouter.ai/api/alpha/decisions',options('typesafe/jev-1.14')),/budget exhausted/);
  release();await first;
  assert.equal(calls,1);
  assert.equal(guarded.summary().chargedOrReservedUsd,0.001);
  assert.equal(JSON.parse(readFileSync(join(root,'spend.json'),'utf8')).requests[0].costSource,'provider');
});

test('evaluation lock prevents two processes from independently spending the same budget',t=>{
  const root=mkdtempSync(join(tmpdir(),'regulars-budget-lock-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const release=lockEvaluation(root);
  assert.throws(()=>lockEvaluation(root),/already running/);
  release();release();
  const next=lockEvaluation(root);next();
});

test('opt-in Luna uses the highest price tiers, reserves max_tokens, and records actual usage',async t=>{
  const root=mkdtempSync(join(tmpdir(),'regulars-luna-budget-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const lunaPricing=highestPricing([{pricing:{prompt:'0.000001',completion:'0.000002',overrides:[{prompt:'0.000003',completion:'0.000004'}]}},
    {pricing:{prompt:'0.000002',completion:'0.000003'}}]);
  assert.deepEqual(lunaPricing,{prompt:0.000003,completion:0.000004,request:0});
  let release,calls=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const metadata={budgetUsd:0.009,contextLength:1000,pricing:{prompt:0,completion:0},lunaPricing};
  const guarded=budgetedJevFetch(metadata,{root,luna:true,fetchImpl:async()=>{calls++;await gate;return new Response(JSON.stringify({usage:{prompt_tokens:100,completion_tokens:20,cost:0.0002}}));}});
  const body={model:'openai/gpt-6-luna',messages:[{role:'user',content:'Label tea'}],max_tokens:1000};
  const request={method:'POST',body:JSON.stringify(body)},url='https://openrouter.ai/api/v1/chat/completions';
  const first=guarded(url,request);
  const reservation=(Buffer.byteLength(request.body)+256)*lunaPricing.prompt+1000*lunaPricing.completion;
  assert.equal(guarded.summary().chargedOrReservedUsd,reservation);
  await assert.rejects(guarded(url,request),/budget exhausted/);
  release();await first;
  assert.equal(calls,1);assert.equal(guarded.summary().reportedUsd,0.0002);
  const restarted=budgetedJevFetch(metadata,{root,luna:true});
  assert.equal(restarted.summary().reportedUsd,0.0002);
  await assert.rejects(guarded(url,{method:'POST',body:JSON.stringify({...body,max_tokens:undefined})}),/Invalid Luna/);
  await assert.rejects(guarded(url,{method:'POST',body:JSON.stringify({...body,model:'another-model'})}),/only JEV/);
});

test('evaluation cap never exceeds two dollars even with older metadata',t=>{
  const root=mkdtempSync(join(tmpdir(),'regulars-budget-cap-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const guarded=budgetedJevFetch({budgetUsd:5},{root});
  assert.equal(guarded.summary().budgetUsd,2);
  assert.throws(()=>highestPricing([{pricing:{prompt:'-1',completion:'0'}}]),/Invalid/);
  assert.throws(()=>highestPricing([]),/Invalid/);
});

test('grouping metrics penalize both merged topics and duplicate splits',()=>{
  const merged=groupingMetrics([{expected:'a',subjectId:'one'},{expected:'a',subjectId:'one'},{expected:'b',subjectId:'one'},{expected:'b',subjectId:'one'}]);
  assert.equal(merged.accuracy,0.5);assert.equal(merged.pairPrecision,1/3);
  const split=groupingMetrics([{expected:'a',subjectId:'one'},{expected:'a',subjectId:'one'},{expected:'a',subjectId:'two'},{expected:'a',subjectId:'two'}]);
  assert.equal(split.accuracy,0.5);assert.equal(split.pairRecall,1/3);
});

test('chat fixtures have chronological arrivals and enough evidence per topic',()=>{
  assert.equal(twitchChats.length,15);assert.equal(twitchChats.filter(s=>s.split==='holdout').length,5);
  for(const s of twitchChats){
    assert.ok(s.messages.every((m,i)=>i===0 || m.at>=s.messages[i-1].at));
    for(const topic of new Set(s.messages.map(m=>m.expected).filter(Boolean)))assert.ok(s.messages.filter(m=>m.expected===topic).length>=3);
    for(const m of s.messages)if(m.parentId)assert.ok(s.messages.slice(0,s.messages.indexOf(m)).some(p=>p.id===m.parentId));
  }
});
