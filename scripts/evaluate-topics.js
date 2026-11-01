import {parseArgs} from 'node:util';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAI} from '../src/ai.js';
import {Regulars} from '../src/core.js';
import {twitchChats} from '../test/fixtures/twitch-chats.js';
import {EVAL_ROOT,lockEvaluation,readApiKey,prepareBudget,budgetedJevFetch,codexLunaGenerator,groupingMetrics,writeJson} from './topic-eval-support.js';

const {values}=parseArgs({options:{split:{type:'string',default:'dev'},run:{type:'string',default:'baseline-dev'},concurrency:{type:'string',default:'3'},cases:{type:'string'},luna:{type:'string',default:'codex'}}});
if(!['dev','holdout','all'].includes(values.split) || !/^[a-z0-9-]+$/.test(values.run))throw new Error('Invalid split or run name');
if(!['codex','openrouter'].includes(values.luna))throw new Error('Luna must be codex or openrouter');
const concurrency=Number(values.concurrency);
if(!Number.isInteger(concurrency) || concurrency<1 || concurrency>3)throw new Error('Concurrency must be 1–3');
const selected=twitchChats.filter(s=>(values.split==='all' || s.split===values.split) && (!values.cases || values.cases.split(',').includes(s.id)))
  .sort((a,b)=>b.messages.at(-1).at-a.messages.at(-1).at);
if(!selected.length)throw new Error('No selected scenarios');
const release=lockEvaluation();process.on('exit',release);
const apiKey=readApiKey(),luna=values.luna==='openrouter',metadata=await prepareBudget(apiKey,{luna}),guard=budgetedJevFetch(metadata,{luna});
const startingSpend=guard.summary().chargedOrReservedUsd;
const runDirectory=join(EVAL_ROOT,values.run);mkdirSync(runDirectory,{recursive:true,mode:0o700});
const codeHash=createHash('sha256').update(readFileSync(resolve(import.meta.dirname,'../src/ai.js'))).update(readFileSync(resolve(import.meta.dirname,'../src/core.js'))).digest('hex');
const naming=luna?undefined:codexLunaGenerator();
const results=[];

async function runChat(scenario){
  const wallStart=Date.now(),epoch=Date.parse('2026-10-31T12:00:00Z');
  const now=()=>epoch+Date.now()-wallStart;
  const arrived=new Set(),errors=[],decisions=[],batchDecisions=[],timeline=[],knownAssignments=new Map(),topicStarted=new Map();
  let namingCalls=0,labelCalls=0;
  const ai=createAI({apiKey,offline:false,retries:0,fetchImpl:guard,textGenerator:naming});
  const nameSubjects=ai.nameSubjects;
  ai.nameSubjects=async input=>{
    namingCalls++;
    if(input.messages.some(text=>!arrived.has(text)))throw new Error('Naming input contains a message that has not arrived');
    return nameSubjects(input);
  };
  if(ai.labelMessages){
    const labelMessages=ai.labelMessages;
    ai.labelMessages=async input=>{
      labelCalls++;
      if([...input.earlierChat,...input.targets].some(m=>!arrived.has(typeof m==='string'?m:m.text)))throw new Error('Label input contains a message that has not arrived');
      return labelMessages(input);
    };
  }
  const classify=ai.classify;
  ai.classify=async input=>{
    const result=await classify(input);
    const message=scenario.messages.find(m=>m.text===input.text);
    if(message)decisions.push({id:message.id,at:Date.now()-wallStart,category:result.category,addressesAI:result.addressesAI,
      subjects:result.subjects.map(s=>({name:input.subjects.find(x=>x.id===s.id)?.name,score:s.score}))});
    return result;
  };
  const scoreSubjects=ai.scoreSubjects;
  ai.scoreSubjects=async input=>{
    const scores=await scoreSubjects(input);
    input.messages.forEach((message,index)=>batchDecisions.push({id:scenario.messages.find(m=>m.text===message.text)?.id,at:Date.now()-wallStart,subject:input.subject.name,score:scores[index]}));
    return scores;
  };
  const app=new Regulars({ai,now});app.startSession(new Date(epoch).toISOString());
  const snapshot=()=>{
    const at=Date.now()-wallStart;
    for(const m of app.all('SELECT id,subject_id,organizer FROM messages')){
      if(knownAssignments.get(m.id)===m.subject_id)continue;
      knownAssignments.set(m.id,m.subject_id);
      if(m.subject_id){timeline.push({id:m.id,subjectId:m.subject_id,at});if(!topicStarted.has(m.subject_id))topicStarted.set(m.subject_id,at);}
    }
  };
  let busy=false,lastDiscovery=-10000;
  const backgroundTasks=new Set();
  const discover=()=>{
    if(busy || Date.now()-wallStart-lastDiscovery<10000)return;
    busy=true;lastDiscovery=Date.now()-wallStart;
    const task=(async()=>{
      app.retryHeld();
      try{await app.discover();snapshot();}catch(error){errors.push({operation:'discovery',message:error.message});}
      try{await app.labelMessages?.();}catch(error){errors.push({operation:'labels',message:error.message});}
    })().finally(()=>{busy=false;backgroundTasks.delete(task);});
    backgroundTasks.add(task);
  };
  const timer=setInterval(discover,250);
  console.log(JSON.stringify({event:'started',scenario:scenario.id,messages:scenario.messages.length,durationSeconds:scenario.messages.at(-1).at}));
  try{
    // Absolute arrival times: no awaited model call can stretch the next gap.
    await Promise.all(scenario.messages.map(async message=>{
      await delay(Math.max(0,message.at*1000-(Date.now()-wallStart)));
      arrived.add(message.text);
      const {id,text,viewerId,name,parentId,bot,reaction}=message;
      try{await app.ingest({id,text,viewerId,name,parentId,bot,reaction,timestamp:new Date(epoch+message.at*1000).toISOString()});snapshot();}
      catch(error){errors.push({operation:'ingest',id,message:error.message});}
    }));
    await delay(11000);
    clearInterval(timer);
    await Promise.allSettled([...backgroundTasks,...app.pending]);
    await app.discover();await app.labelMessages?.();snapshot();
    const subjects=app.all('SELECT id,name,description FROM subjects');
    const rows=scenario.messages.map(m=>{
      const row=app.one('SELECT * FROM messages WHERE id=?',m.id);
      return {id:m.id,text:m.text,expected:m.expected,at:m.at,subjectId:row?.subject_id || null,
        subject:subjects.find(s=>s.id===row?.subject_id)?.name || null,about:row?.about ?? null,thin:m.thin || null,
        readerVisible:row?.moderation==='cleared' && !m.bot && !m.text.startsWith('!') && !row?.addresses_ai,
        organizer:row?.organizer,moderation:row?.moderation};
    });
    const metrics=groupingMetrics(rows);
    const delays=Object.entries(metrics.mapping).map(([id,expected])=>{
      const evidence=scenario.messages.filter(m=>m.expected===expected);
      return {topic:expected,thirdMessageAt:evidence[2]?.at,discoveredAt:topicStarted.get(id)/1000,
        delaySeconds:topicStarted.get(id)/1000-(evidence[2]?.at || 0)};
    });
    const result={scenario:scenario.id,name:scenario.name,split:scenario.split,codeHash,metrics,subjects,rows,decisions,batchDecisions,timeline,delays,namingCalls,labelCalls,errors,wallSeconds:(Date.now()-wallStart)/1000};
    writeJson(join(runDirectory,`${scenario.id}.json`),result);results.push(result);
    console.log(JSON.stringify({event:'completed',scenario:scenario.id,accuracy:metrics.accuracy,coverage:metrics.coverage,pairPrecision:metrics.pairPrecision,pairRecall:metrics.pairRecall,errors:metrics.errors.length,namingCalls,spend:guard.summary()}));
  }finally{
    clearInterval(timer);app.abortClassifications();
    await Promise.allSettled([...backgroundTasks,...app.pending]);app.close();
  }
}

let cursor=0;
await Promise.all(Array.from({length:Math.min(concurrency,selected.length)},async()=>{
  while(cursor<selected.length){const scenario=selected[cursor++];await runChat(scenario);}
}));
const accountResponse=await fetch('https://openrouter.ai/api/v1/key',{headers:{Authorization:`Bearer ${apiKey}`}});
const account=accountResponse.ok?(await accountResponse.json()).data:null;
const total=field=>results.reduce((sum,r)=>sum+r.metrics[field],0);
const report={run:values.run,codeHash,scenarios:results.length,messages:total('messages'),correct:total('correct'),accuracy:total('correct')/total('messages'),
  topicMessages:total('topicMessages'),topicCorrect:total('topicCorrect'),topicAccuracy:total('topicCorrect')/total('topicMessages'),
  luna:values.luna,spend:guard.summary(),runSpendUsd:guard.summary().chargedOrReservedUsd-startingSpend,accountUsageDeltaUsd:account?account.usage-metadata.startUsage:null,
  results:results.map(r=>({scenario:r.scenario,...r.metrics,delays:r.delays,namingCalls:r.namingCalls,labelCalls:r.labelCalls,serviceErrors:r.errors}))};
writeJson(join(runDirectory,'report.json'),report);
const table=['| Chat | Correct messages | Topic coverage | Pair precision | Pair recall |','|---|---:|---:|---:|---:|',
  ...results.map(r=>`| ${r.name} | ${r.metrics.correct}/${r.metrics.messages} | ${(r.metrics.coverage*100).toFixed(1)}% | ${(r.metrics.pairPrecision*100).toFixed(1)}% | ${(r.metrics.pairRecall*100).toFixed(1)}% |`)];
const cell=text=>String(text ?? '').replace(/\|/g,'\\|').replace(/[\r\n]+/g,' ');
const labelReview=['| Chat | Message | Expected subject | About label |','|---|---|---|---|',
  ...results.flatMap(r=>r.rows.filter(m=>m.readerVisible && !m.subjectId).map(m=>`| ${r.scenario} | ${cell(m.text)} | ${cell(m.expected || m.thin || '—')} | ${cell(m.about || '—')} |`))];
writeFileSync(join(runDirectory,'report.md'),`# Topic grouping evaluation: ${values.run}\n\nTimed arrivals at 1× with asynchronous JEV requests. Naming and labels use ${luna?'OpenRouter Luna':'the Codex Luna worker'}. Ground truth is not sent to either model.\n\n${table.join('\n')}\n\nTotal: ${report.correct}/${report.messages} correct (${(report.accuracy*100).toFixed(1)}%).\n\nCumulative charged/reserved: $${report.spend.chargedOrReservedUsd.toFixed(6)} of $${report.spend.budgetUsd}. This run: $${report.runSpendUsd.toFixed(6)}. Account usage delta: ${report.accountUsageDeltaUsd}.\n\n## Ungrouped label review\n\nEvery reader-visible message left ungrouped is listed below, including thin conversations and reactions.\n\n${labelReview.join('\n')}\n`,{mode:0o600});
console.log(JSON.stringify({event:'report',...report,results:undefined}));
