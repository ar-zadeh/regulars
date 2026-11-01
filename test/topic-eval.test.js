import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAI} from '../src/ai.js';
import {lockEvaluation,budgetedJevFetch,groupingMetrics} from '../scripts/topic-eval-support.js';
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

test('grouping metrics penalize both merged topics and duplicate splits',()=>{
  const merged=groupingMetrics([{expected:'a',subjectId:'one'},{expected:'a',subjectId:'one'},{expected:'b',subjectId:'one'},{expected:'b',subjectId:'one'}]);
  assert.equal(merged.accuracy,0.5);assert.equal(merged.pairPrecision,1/3);
  const split=groupingMetrics([{expected:'a',subjectId:'one'},{expected:'a',subjectId:'one'},{expected:'a',subjectId:'two'},{expected:'a',subjectId:'two'}]);
  assert.equal(split.accuracy,0.5);assert.equal(split.pairRecall,1/3);
});

test('chat fixtures have chronological arrivals and enough evidence per topic',()=>{
  assert.equal(twitchChats.length,11);assert.equal(twitchChats.filter(s=>s.split==='holdout').length,5);
  for(const s of twitchChats){
    assert.ok(s.messages.every((m,i)=>i===0 || m.at>=s.messages[i-1].at));
    for(const topic of new Set(s.messages.map(m=>m.expected).filter(Boolean)))assert.ok(s.messages.filter(m=>m.expected===topic).length>=3);
    for(const m of s.messages)if(m.parentId)assert.ok(s.messages.slice(0,s.messages.indexOf(m)).some(p=>p.id===m.parentId));
  }
});
