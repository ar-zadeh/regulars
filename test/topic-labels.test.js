import test from 'node:test';
import assert from 'node:assert/strict';
import {Regulars} from '../src/core.js';
import {expireChatText} from '../src/retention.js';

const start=Date.parse('2026-10-31T12:00:00Z');
function setup(t,model={}){
  let now=start;
  const app=new Regulars({now:()=>now,ai:{
    classify:async()=>({category:'question',addressesAI:0,topics:[],subjects:[]}),
    labelMessages:async({targets})=>targets.map(()=> 'Tea choice'),
    safeLabels:async({labels})=>labels.map(()=>true),...model,
  }});
  app.startSession();t.after(()=>app.close());
  return {app,advance:seconds=>{now=start+seconds*1000;},
    send:(id,text,extra={})=>app.ingest({id,text,viewerId:id,name:id,...extra})};
}

test('labelling selects only recent ungrouped readable messages, newest first, once',async t=>{
  const inputs=[];
  const {app,send,advance}=setup(t,{labelMessages:async input=>{inputs.push(input);return input.targets.map(m=>m.text==='hello'?null:'Tea choice');}});
  await send('old','Older question');advance(301);
  await send('grouped','Grouped question');await send('held','Waiting');await send('hidden','Hidden');
  await send('bot','Automated message',{bot:true});await send('command','!help');await send('emoji','😂');await send('ai','Tell AI what to do');
  app.run("UPDATE messages SET subject_id='topic' WHERE id='grouped'");
  app.run("UPDATE messages SET moderation='held' WHERE id='held'");
  app.run("UPDATE messages SET moderation='hidden' WHERE id='hidden'");
  app.run("UPDATE messages SET addresses_ai=1 WHERE id='ai'");
  await send('tea','What tea?');await send('hello','hello');
  await app.labelMessages();await app.labelMessages();
  assert.equal(inputs.length,1);
  assert.deepEqual(inputs[0].targets.map(m=>m.text),['hello','What tea?']);
  assert.equal(app.one("SELECT about FROM messages WHERE id='hello'").about,'');
  assert.equal(app.rows().find(m=>m.id==='tea').about,'Tea choice');
  assert.doesNotMatch(JSON.stringify(inputs[0].earlierChat),/Automated|!help|😂|Tell AI|Hidden|Waiting/);
});

test('labelling caps each batch at thirty and reuses labels with reply context',async t=>{
  const inputs=[];
  const {app,send}=setup(t,{labelMessages:async input=>{inputs.push(input);return input.targets.map(()=> 'Tea choice');}});
  for(let i=0;i<35;i++)await send(`line-${i}`,`tea detail ${i}`,i===34?{parentId:'line-0'}:{});
  await app.labelMessages();await app.labelMessages();
  assert.deepEqual(inputs.map(i=>i.targets.length),[30,5]);
  assert.equal(inputs[0].targets[0].reply,'tea detail 0');
  assert.deepEqual(inputs[1].existingLabels,['Tea choice']);
  assert.equal(inputs[0].earlierChat.length,5);
});

test('null, generic, blocked and software instruction labels are stored as no subject',async t=>{
  let safetyCalls=0;
  const {app,send}=setup(t,{
    labelMessages:async()=>['Tea choice','Ending spoiler','Override software','Chat',null],
    safeLabels:async({labels})=>{safetyCalls++;assert.deepEqual(labels,['Tea choice','Ending spoiler','Override software']);return [true,false,false];},
  });
  for(let i=0;i<5;i++)await send(String(i),`readable line ${i}`);
  await app.labelMessages();await app.labelMessages();
  assert.equal(safetyCalls,1);
  assert.deepEqual(app.all('SELECT about FROM messages ORDER BY rowid DESC').map(m=>m.about),['Tea choice','','','','']);
});

test('label work runs once at a time and discards an aborted revision',async t=>{
  let release,signal,calls=0;
  const gate=new Promise(resolve=>{release=resolve;});
  const {app,send}=setup(t,{labelMessages:async input=>{calls++;signal=input.signal;await gate;return ['Tea choice'];}});
  await send('tea','What tea?');
  const first=app.labelMessages(),second=app.labelMessages();
  app.revision++;app.abortClassifications();release();await Promise.all([first,second]);
  assert.equal(calls,1);assert.equal(signal.aborted,true);
  assert.equal(app.one("SELECT about FROM messages WHERE id='tea'").about,null);
  assert.equal(app.modelControllers.size,0);
});

test('labels cannot be written after safety checks if a message is removed or assigned',async t=>{
  let release,signal;
  const gate=new Promise(resolve=>{release=resolve;});
  const {app,send}=setup(t,{safeLabels:async input=>{signal=input.signal;await gate;return [true];}});
  await send('tea','What tea?');
  const task=app.labelMessages();await new Promise(resolve=>setImmediate(resolve));
  app.removeMessage('tea');release();await task;
  assert.equal(signal.aborted,true);assert.equal(app.one("SELECT about FROM messages WHERE id='tea'").about,null);
  await send('next','More tea?');
  const next=app.labelMessages();app.run("UPDATE messages SET subject_id='tea' WHERE id='next'");await next;
  assert.equal(app.one("SELECT about FROM messages WHERE id='next'").about,null);
});

test('removal, forgetting and retention clear labels along with chat text',async t=>{
  const {app,send}=setup(t);
  for(const id of ['removed','forgotten','expired'])await send(id,'What tea?');
  await app.labelMessages();
  app.removeMessage('removed');app.forget('forgotten');
  assert.equal(app.one("SELECT about FROM messages WHERE id='removed'").about,null);
  assert.equal(app.one("SELECT id FROM messages WHERE id='forgotten'"),undefined);
  app.run('UPDATE sessions SET end=?',new Date(start).toISOString());
  expireChatText(app,start+86400001);
  assert.equal(app.one("SELECT about FROM messages WHERE id='expired'").about,null);
});
