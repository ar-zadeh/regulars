import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync,openSync,closeSync,unlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

export const EVAL_ROOT=resolve(import.meta.dirname,'../data/evals/topic-quality');
export function lockEvaluation(root=EVAL_ROOT){
  mkdirSync(root,{recursive:true,mode:0o700});
  const path=join(root,'evaluation.lock');
  let fd;
  try{fd=openSync(path,'wx',0o600);}catch(error){
    if(error.code==='EEXIST')throw new Error(`An evaluation is already running, or its lock remains: ${path}`);
    throw error;
  }
  writeFileSync(fd,String(process.pid));closeSync(fd);
  let released=false;
  return ()=>{if(!released){unlinkSync(path);released=true;}};
}
export function readApiKey(){
  if(process.env.OPENROUTER_API_KEY)return process.env.OPENROUTER_API_KEY;
  const env=readFileSync(resolve(import.meta.dirname,'../.env'),'utf8');
  const match=env.match(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$/m);
  const key=match?.[1]?.replace(/^(['"])(.*)\1$/,'$2');
  if(!key)throw new Error('OPENROUTER_API_KEY is required');
  return key;
}
export function writeJson(file,data){
  writeFileSync(`${file}.tmp`,JSON.stringify(data,null,2)+'\n',{mode:0o600});
  renameSync(`${file}.tmp`,file);
}
export function highestPricing(endpoints){
  const prices=endpoints.flatMap(endpoint=>[endpoint.pricing,...(endpoint.pricing?.overrides || [])]);
  if(!prices.length || prices.some(p=>!p || ['prompt','completion','request'].some(key=>!Number.isFinite(Number(p[key] ?? (key==='request'?0:NaN))) || Number(p[key] || 0)<0)))throw new Error('Invalid model pricing');
  return Object.fromEntries(['prompt','completion','request'].map(key=>[key,Math.max(...prices.map(p=>Number(p[key] || 0)))]));
}
export async function prepareBudget(apiKey,{fetchImpl=fetch,root=EVAL_ROOT,luna=false}={}){
  mkdirSync(root,{recursive:true,mode:0o700});
  const file=join(root,'budget-metadata.json');
  const [keyResponse,modelsResponse,lunaResponse]=await Promise.all([
    fetchImpl('https://openrouter.ai/api/v1/key',{headers:{Authorization:`Bearer ${apiKey}`}}),
    fetchImpl('https://openrouter.ai/api/v1/models/typesafe/jev-1.14/endpoints'),
    luna?fetchImpl('https://openrouter.ai/api/v1/models/openai/gpt-6-luna/endpoints'):null,
  ]);
  if(!keyResponse.ok || !modelsResponse.ok)throw new Error(`Budget metadata unavailable (${keyResponse.status}/${modelsResponse.status})`);
  const account=(await keyResponse.json()).data;
  const model=(await modelsResponse.json()).data;
  if(!model || !Number.isFinite(account.usage))throw new Error('JEV pricing or account usage unavailable');
  const endpoint=model.endpoints?.[0];
  if(!endpoint)throw new Error('No JEV provider pricing available');
  const data={model:model.id,pricing:highestPricing(model.endpoints),contextLength:Math.max(...model.endpoints.map(e=>e.context_length)),startUsage:account.usage,budgetUsd:2};
  if(luna){
    if(!lunaResponse?.ok)throw new Error('Luna pricing unavailable');
    data.lunaPricing=highestPricing((await lunaResponse.json()).data?.endpoints || []);
  }
  if(!Number.isFinite(Number(data.pricing.prompt)) || !Number.isFinite(Number(data.pricing.completion)))throw new Error('Invalid JEV pricing');
  writeJson(file,data);return data;
}

// This guard applies to every paid request, including retries. Outstanding and
// failed calls retain a conservative reservation across process restarts.
export function budgetedJevFetch(metadata,{root=EVAL_ROOT,fetchImpl=fetch,luna=false}={}){
  const path=join(root,'spend.json');
  const ledger=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{budgetUsd:metadata.budgetUsd,requests:[]};
  ledger.budgetUsd=Math.min(2,metadata.budgetUsd,ledger.budgetUsd);
  if(!Number.isFinite(ledger.budgetUsd) || ledger.budgetUsd<=0)throw new Error('Invalid evaluation budget');
  const spent=()=>ledger.requests.reduce((sum,r)=>sum+(r.cost ?? r.reservation),0);
  const guarded=async(url,options={})=>{
    const body=JSON.parse(options.body || '{}');
    const isJev=url==='https://openrouter.ai/api/alpha/decisions' && body.model==='typesafe/jev-1.14';
    const isLuna=luna && url==='https://openrouter.ai/api/v1/chat/completions' && body.model==='openai/gpt-6-luna';
    if((!isJev && !isLuna) || options.method!=='POST')throw new Error('Evaluation permits only JEV decisions unless Luna is explicitly enabled');
    const count=Object.keys(body.questions || {}).length;
    if(isJev && (count<1 || count>100))throw new Error('Invalid evaluation question count');
    if(isLuna && (!Array.isArray(body.messages) || !Number.isSafeInteger(body.max_tokens) || body.max_tokens<1 || body.max_tokens>128000 || !metadata.lunaPricing))throw new Error('Invalid Luna reservation');
    const pricing=isLuna?metadata.lunaPricing:metadata.pricing;
    const reservation=Number(pricing.prompt)*(isLuna?Buffer.byteLength(JSON.stringify(body),'utf8')+256:metadata.contextLength*count)+
      Number(pricing.completion)*(isLuna?body.max_tokens:65536*count)+Number(pricing.request || 0);
    if(!Number.isFinite(reservation) || reservation<0 || spent()+reservation>ledger.budgetUsd)throw new Error('OpenRouter evaluation budget exhausted');
    const entry={number:ledger.requests.length+1,model:body.model,questions:count,reservation,status:'pending',startedAt:new Date().toISOString()};
    ledger.requests.push(entry);writeJson(path,ledger);
    try{
      const response=await fetchImpl(url,options);
      if(!response.ok){entry.status=`http-${response.status}`;return response;}
      const payload=await response.clone().json(),usage=payload.usage || {};
      const input=usage.input_tokens ?? usage.prompt_tokens,output=usage.output_tokens ?? usage.completion_tokens ?? 0;
      const cost=usage.cost ?? usage.total_cost;
      if(Number.isFinite(cost) && cost>=0){entry.cost=cost;entry.costSource='provider';}
      else if(Number.isFinite(input) && input>=0 && Number.isFinite(output) && output>=0){
        entry.cost=input*Number(pricing.prompt)+output*Number(pricing.completion)+Number(pricing.request || 0);
        entry.costSource='reported tokens and verified pricing';
      }else throw new Error('Provider did not report usage; reservation retained');
      entry.inputTokens=input;entry.outputTokens=output;entry.status='completed';
      if(entry.cost>reservation)throw new Error('Provider cost exceeded reservation; stop evaluation');
      return response;
    }catch(error){entry.status='failed';entry.error=error.name;throw error;}
    finally{entry.finishedAt=new Date().toISOString();writeJson(path,ledger);}
  };
  guarded.summary=()=>({budgetUsd:ledger.budgetUsd,chargedOrReservedUsd:spent(),requests:ledger.requests.length,
    reportedUsd:ledger.requests.reduce((sum,r)=>sum+(r.cost ?? 0),0),
    reservedUsd:ledger.requests.filter(r=>r.cost===undefined).reduce((sum,r)=>sum+r.reservation,0),
    completed:ledger.requests.filter(r=>r.status==='completed').length,pendingOrFailed:ledger.requests.filter(r=>r.status!=='completed').length});
  return guarded;
}

export function codexLunaGenerator({root=EVAL_ROOT,timeoutMs=120000}={}){
  const directory=join(root,'luna');
  for(const child of ['pending','responses'])mkdirSync(join(directory,child),{recursive:true,mode:0o700});
  return async({messages,signal})=>{
    const systemPrompt=messages[0].content,data=JSON.parse(messages[1].content);
    const key=createHash('sha256').update(JSON.stringify({systemPrompt,data})).digest('hex');
    const responseFile=join(directory,'responses',`${key}.json`);
    if(!existsSync(responseFile))writeJson(join(directory,'pending',`${key}.json`),{id:key,systemPrompt,data});
    const deadline=Date.now()+timeoutMs;
    while(!existsSync(responseFile)){
      if(Date.now()>=deadline)throw new Error('Codex Luna naming worker timed out');
      await delay(250,undefined,{signal});
    }
    const output=JSON.parse(readFileSync(responseFile,'utf8'));
    if(!Array.isArray(output))throw new Error('Codex Luna naming response must be an array');
    return JSON.stringify(output);
  };
}

export function groupingMetrics(rows){
  const expected=[...new Set(rows.map(m=>m.expected).filter(Boolean))];
  const actual=[...new Set(rows.map(m=>m.subjectId).filter(Boolean))];
  const weights=actual.map(id=>expected.map(topic=>rows.filter(m=>m.subjectId===id && m.expected===topic).length));
  // Exact one-to-one matching; duplicate generated subjects do not get free
  // credit for splitting a single expected conversation into several groups.
  const memo=new Map();
  const solve=(index,mask)=>{
    if(index===actual.length)return {score:0,pairs:[]};
    const key=`${index}:${mask}`;if(memo.has(key))return memo.get(key);
    let best=solve(index+1,mask);
    for(let i=0;i<expected.length;i++)if(!(mask&(1<<i)) && weights[index][i]){
      const next=solve(index+1,mask|(1<<i)),score=next.score+weights[index][i];
      if(score>best.score)best={score,pairs:[[actual[index],expected[i]],...next.pairs]};
    }
    memo.set(key,best);return best;
  };
  const mapping=new Map(solve(0,0).pairs);
  let pairTrue=0,pairPredicted=0,pairExpected=0;
  for(let i=0;i<rows.length;i++)for(let j=i+1;j<rows.length;j++){
    const predicted=!!rows[i].subjectId && rows[i].subjectId===rows[j].subjectId;
    const target=!!rows[i].expected && rows[i].expected===rows[j].expected;
    if(predicted)pairPredicted++;if(target)pairExpected++;if(predicted && target)pairTrue++;
  }
  const scored=rows.map(m=>({...m,predicted:m.subjectId?(mapping.get(m.subjectId) || '__extra_group__'):null}));
  const topicRows=scored.filter(m=>m.expected),noiseRows=scored.filter(m=>!m.expected);
  return {messages:rows.length,topicMessages:topicRows.length,correct:scored.filter(m=>m.predicted===m.expected).length,
    topicCorrect:topicRows.filter(m=>m.predicted===m.expected).length,noiseCorrect:noiseRows.filter(m=>m.predicted===null).length,
    accuracy:scored.filter(m=>m.predicted===m.expected).length/rows.length,
    coverage:topicRows.length?topicRows.filter(m=>m.predicted===m.expected).length/topicRows.length:1,
    pairPrecision:pairPredicted?pairTrue/pairPredicted:1,pairRecall:pairExpected?pairTrue/pairExpected:1,
    expectedGroups:expected.length,actualGroups:actual.length,
    errors:scored.filter(m=>m.predicted!==m.expected),mapping:Object.fromEntries(mapping)};
}
