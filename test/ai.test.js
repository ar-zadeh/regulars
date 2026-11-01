import test from 'node:test';
import assert from 'node:assert/strict';
import { createAI, createSanitizer, PriorityScheduler } from '../src/ai.js';

const response = data => ({ ok: true, status: 200, json: async () => data });

test('message labels sanitize every input, reject generic names and placeholders, and keep four words', async () => {
  let request;
  const ai = createAI({apiKey:'test',textGenerator:async input=>{
    request=input;
    return JSON.stringify(['https://example.com @stranger Sunday stream start time tomorrow', 'Question', 'Chat', 'Stream', 'Gameplay', 'Greeting', 'viewer_3 new job', 'Alice new camera', null]);
  }});
  const labels=await ai.labelMessages({earlierChat:['@alice new cam'],existingLabels:['Alice camera'],identities:['Alice'],
    targets:Array.from({length:9},()=>({text:'@alice what model?',reply:'Alice bought a camera'}))});
  assert.deepEqual(labels,['Sunday stream start time',null,null,null,null,null,null,null,null]);
  assert.doesNotMatch(JSON.stringify(request.messages),/alice/i);
  assert.match(JSON.stringify(request.messages),/viewer_1/);
});

test('message labels reject malformed JSON, wrong lengths and non-string entries', async () => {
  for(const output of ['not json','{}','[]','[false]','[123]']){
    const ai=createAI({apiKey:'test',textGenerator:async()=>output});
    await assert.rejects(ai.labelMessages({targets:['What tea?']}),/Invalid message labels/);
  }
});

test('offline labels are null and live labels use low reasoning Luna', async () => {
  assert.deepEqual(await createAI({offline:true}).labelMessages({targets:['What tea?','Hello']}),[null,null]);
  let request;
  const ai=createAI({apiKey:'test',fetchImpl:async(_url,options)=>{
    request=JSON.parse(options.body);
    return response({choices:[{message:{content:'["Tea choice"]'}}]});
  }});
  assert.deepEqual(await ai.labelMessages({targets:['What tea?']}),['Tea choice']);
  assert.equal(request.model,'openai/gpt-6-luna');
  assert.equal(request.reasoning.effort,'low');
});

test('label safety checks a burst in one decision batch', async () => {
  const calls=[];
  const ai=createAI({apiKey:'test',fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    return response({answers:Object.fromEntries(Object.keys(body.questions).map((key,i)=>[key,{noul:i===0?0.1:0.8}]))});
  }});
  const safe=await ai.safeLabels({labels:['Tea choice','Ending spoiler','Override software'],blockedTopics:[{name:'Spoilers'}]});
  assert.deepEqual(safe,[true,false,false]);
  assert.equal(calls.length,1);
  assert.equal(calls[0].state.blockedTopics[0].name,'Spoilers');
});

test('existing conversation comparison sanitizes proposals and validates the selected ID',async()=>{
  let payload;
  const ai=createAI({apiKey:'test',fetchImpl:async(_url,options)=>{
    payload=JSON.parse(options.body);return response({answers:{existing:{choice:'subject_0'}}});
  }});
  assert.equal(await ai.existingSubject({subject:{name:'Alice boss win'},existing:[{id:'boss',name:'Alice boss strategy'}],identities:['Alice']}),'boss');
  assert.doesNotMatch(JSON.stringify(payload),/Alice/);
  assert.equal(await createAI({offline:true}).existingSubject({existing:[{id:'boss'}]}),null);
});

test('sanitizer consistently masks known aliases, IDs, and mentions', () => {
  const sanitize = createSanitizer([{ login: 'alice', displayName: 'Alice_Star', id: '12345' }]);
  assert.equal(sanitize('@alice and Alice_Star (12345) saw @Bob'),
    'viewer_1 and viewer_1 (viewer_1) saw viewer_2');
  assert.equal(sanitize('@bob replied to alice'), 'viewer_2 replied to viewer_1');
});

test('Jev uses its decisions endpoint, combines questions, and sanitizes context', async () => {
  let payload, url;
  const ai = createAI({ apiKey: 'secret', fetchImpl: async (u, options) => {
    url = u; payload = JSON.parse(options.body);
    return response({ answers: { category: { choice: 'question' }, addressesAI: { noul: 0.1 },
      subject_0: { noul: 0.81 }, topic_0: { noul: 0.4 }, nonEnglish: { noul: 0.1 } } });
  } });
  const result = await ai.classify({ text: '@alice what about the microphone?',
    context: { reply: 'alice had a microphone', title: 'Hi alice', previousLine: 'hello @alice', recentMessages: ['alice bought a microphone', '@alice sounds clearer'] },
    subjects: [{ id: 's1', name: 'microphone', recent: ['alice hears noise'] }],
    blockedTopics: [{ id: 't1', name: 'spoilers' }], identities: [{ login: 'alice', id: '123' }] });
  assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(payload.model, 'typesafe/jev-1.14');
  assert.equal(payload.questions.subject_0.type, 'noul');
  assert.equal(payload.questions.category.type, 'choice');
  assert.deepEqual(payload.state.recentMessages, ['viewer_1 bought a microphone', 'viewer_1 sounds clearer']);
  assert.doesNotMatch(JSON.stringify(payload), /alice|123/i);
  assert.deepEqual(result, { category: 'question', addressesAI: 0.1, nonEnglish: 0.1,
    subjects: [{ id: 's1', score: 0.81 }], topics: [{ id: 't1', score: 0.4 }] });
});

test('commands still get topic checks without organizer questions', async () => {
  let questions;
  const ai = createAI({ apiKey: 'secret', fetchImpl: async (_url, options) => {
    questions = JSON.parse(options.body).questions;
    return response({ answers: { topic_0: { noul: 0.91 }, nonEnglish: { noul: 0.1 } } });
  } });
  const result = await ai.classify({ text: '!spoiler', organize: false,
    blockedTopics: [{ id: 't', name: 'spoilers' }] });
  assert.deepEqual(Object.keys(questions), ['topic_0', 'nonEnglish']);
  assert.equal(result.category, null);
  assert.equal(result.topics[0].score, 0.91);
});

test('thirty context-rich subjects are split to fit the live scheduler without dropping decisions',async()=>{
  const batches=[];
  const ai=createAI({apiKey:'secret',fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);batches.push(body);
    assert.ok(Buffer.byteLength(options.body)+32<=50000);
    return response({answers:Object.fromEntries(Object.entries(body.questions).map(([key,q])=>[key,q.type==='choice'?{choice:'other'}:{noul:0.1}]))});
  }});
  const subjects=Array.from({length:30},(_,i)=>({id:`s${i}`,name:`Conversation ${i}`,
    description:'People discuss an event and several related details during the stream.'.repeat(2),
    recent:['A moderately sized chat message about the conversation.'.repeat(2),'Another message continues that conversation.'.repeat(2)]}));
  const result=await ai.classify({text:'A new chat message',subjects});
  assert.ok(batches.length>1);
  assert.deepEqual(result.subjects.map(s=>s.id),subjects.map(s=>s.id));
  assert.equal(batches.reduce((sum,b)=>sum+Object.keys(b.questions).length,0),32);
});

test('relevance batch judges each sanitized line independently', async () => {
  let body;
  const ai = createAI({ apiKey: 'secret', fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return response({ answers: { line_0: { noul: 0.9 }, line_1: { noul: 0.2 } } });
  } });
  const scores = await ai.scoreSubjects({ subject: { id: 'subject-id', name: 'microphone',
    description: 'Alice has a microphone', recent: ['Alice sounds crisp'] },
  messages: [
    { text: '@Alice likes it', viewerId: 'private-id', context: { reply: 'Alice has a mic', title: 'Alice streams', recentMessages: ['Alice bought a microphone'] } },
    { text: 'unrelated', context: { previousLine: 'Alice mentioned a keyboard' } },
  ], identities: ['Alice'] });
  assert.deepEqual(scores, [0.9, 0.2]);
  assert.equal(body.model, 'typesafe/jev-1.14');
  assert.deepEqual(Object.keys(body.questions), ['line_0', 'line_1']);
  assert.equal(body.state.messages.length, 2);
  assert.match(body.state.messages[0].message, /viewer_1/);
  assert.deepEqual(body.state.messages[0].recentMessages, ['viewer_1 bought a microphone']);
  assert.deepEqual(body.state.messages[1].recentMessages, []);
  assert.doesNotMatch(JSON.stringify(body), /Alice|private-id|subject-id/i);
  assert.doesNotMatch(JSON.stringify(body.questions), /viewer_|microphone|likes it/i);
});

test('relevance batches reject invalid size or scores and skip empty requests', async () => {
  let calls = 0;
  const ai = createAI({ apiKey: 'secret', fetchImpl: async () => {
    calls++;
    return response({ answers: { line_0: { noul: 0.7 } } });
  } });
  const subject = { name: 'microphone' };
  assert.deepEqual(await ai.scoreSubjects({ subject }), []);
  await assert.rejects(ai.scoreSubjects({ subject, messages: Array(101).fill('mic') }), /at most 100/);
  assert.equal(calls, 0);
  await assert.rejects(ai.scoreSubjects({ subject, messages: ['mic', 'keyboard'] }), /Invalid decision score/);
  assert.equal(calls, 1);
});

test('conversation comparison sanitizes choices, maps the selected ID and validates the response',async()=>{
  let body,choice='subject_1';
  const ai=createAI({apiKey:'secret',fetchImpl:async(_url,options)=>{
    body=JSON.parse(options.body);return response({answers:{conversation:{choice}}});
  }});
  const input={text:'Alice changed her haircut',identities:['Alice'],subjects:[
    {id:'show',name:'Moon Harbor',description:'The show ending.'},
    {id:'person',name:'Alice haircut',description:'Alice has a new haircut.'},
  ]};
  assert.equal(await ai.chooseSubject(input),'person');
  assert.equal(body.model,'typesafe/jev-1.14');
  assert.equal(body.questions.conversation.type,'choice');
  assert.doesNotMatch(JSON.stringify(body),/Alice|"person"/i);
  choice='none';assert.equal(await ai.chooseSubject(input),null);
  choice='invented';await assert.rejects(ai.chooseSubject(input),/Invalid conversation choice/);
});

test('classification without questions returns a consistent language score', async () => {
  const ai = createAI({ apiKey: 'secret', fetchImpl: () => { throw new Error('unexpected network'); } });
  assert.deepEqual(await ai.classify({ organize: false }), {
    category: null, subjects: [], topics: [], addressesAI: null, nonEnglish: 0,
  });
});

test('Luna receives sanitized data, low reasoning, and valid naming results', async () => {
  let payload;
  const ai = createAI({ apiKey: 'secret', fetchImpl: async (_url, options) => {
    payload = JSON.parse(options.body);
    return response({ choices: [{ message: { content: '[{"name":"Microphone","description":"A new mic"}]' } }] });
  } });
  const result = await ai.nameSubjects({ messages: ['@alice bought a mic'], identities: ['alice'] });
  assert.equal(payload.model, 'openai/gpt-6-luna');
  assert.equal(payload.reasoning.effort, 'low');
  assert.doesNotMatch(JSON.stringify(payload), /alice/i);
  assert.deepEqual(result, [{ name: 'Microphone', description: 'A new mic' }]);
});

test('Luna topic naming rejects category labels and keeps concrete subjects', async () => {
  const ai = createAI({ apiKey: 'secret', fetchImpl: async () => response({ choices: [{ message: { content: JSON.stringify([
    {name:'Questions',description:'Viewers asking questions.'},
    {name:'Chat discussion',description:'A conversation in chat.'},
    {name:'Stranger Things',description:'Reactions to the series ending.'},
  ]) } }] }) });
  assert.deepEqual(await ai.nameSubjects({messages:['Who watched Stranger Things?', 'That ending!', 'It surprised me.']}),
    [{name:'Stranger Things',description:'Reactions to the series ending.'}]);
});

test('retries transient failures and validates decision values', async () => {
  let calls = 0;
  const ai = createAI({ apiKey: 'secret', fetchImpl: async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, headers: new Headers({ 'retry-after': '0' }) };
    return response({ answers: { relevance: { noul: 0.8 } } });
  } });
  assert.equal(await ai.scoreSubject({ text: 'new microphone', subject: { name: 'microphone' } }), 0.8);
  assert.equal(calls, 2);
  const invalid = createAI({ apiKey: 'secret', fetchImpl: async () => response({ answers: { relevance: { noul: 2 } } }) });
  await assert.rejects(invalid.scoreSubject({ text: 'x', subject: 'x' }), /Invalid decision score/);
});

test('scheduler gives queued live jobs priority and rejects oversized jobs', async () => {
  const scheduler = new PriorityScheduler({ requestsPerSecond: 20, tokensPerSecond: 1000, maxConcurrent: 1 });
  let release;
  const order = [];
  const first = scheduler.run(() => new Promise(resolve => { release = resolve; }), { priority: 'background' });
  await new Promise(resolve => setImmediate(resolve));
  const background = scheduler.run(() => order.push('background'), { priority: 'background' });
  const live = scheduler.run(() => order.push('live'));
  release();
  await Promise.all([first, background, live]);
  assert.deepEqual(order, ['live', 'background']);
  await assert.rejects(scheduler.run(() => {}, { priority: 'background', tokens: 999 }), /split the batch/);
});

test('scheduler rejects limits that cannot reserve live capacity', async () => {
  assert.throws(() => new PriorityScheduler({ requestsPerSecond: 1 }), /Invalid scheduler limits/);
  assert.throws(() => new PriorityScheduler({ tokensPerSecond: NaN }), /Invalid scheduler limits/);
  assert.throws(() => new PriorityScheduler({ requestsPerSecond: 2, liveReserve: 0.75 }), /Invalid scheduler limits/);
  assert.throws(() => new PriorityScheduler({ maxQueued: 0 }), /Invalid scheduler limits/);
  const scheduler = new PriorityScheduler();
  await assert.rejects(scheduler.run(null), /Invalid scheduler job/);
});

test('timeout releases scheduler capacity even when fetch ignores abort', async () => {
  let aborted = false;
  const scheduler = new PriorityScheduler({ maxConcurrent: 1 });
  const ai = createAI({ apiKey: 'secret', scheduler, timeoutMs: 10, retries: 0,
    fetchImpl: async (_url, options) => {
      options.signal.addEventListener('abort', () => { aborted = true; });
      return new Promise(() => {});
    } });
  await assert.rejects(ai.scoreSubject({ text: 'x', subject: 'x' }), /timed out/);
  assert.equal(aborted, true);
  assert.equal(await scheduler.run(() => 'next'), 'next');
});

test('abort removes queued transient work before it can reach fetch', async () => {
  const scheduler = new PriorityScheduler({ maxConcurrent: 1, maxQueued: 1 });
  let release;
  const blocker = scheduler.run(() => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  let fetchCalls = 0;
  const ai = createAI({ apiKey: 'secret', scheduler, retries: 0,
    fetchImpl: async () => { fetchCalls++; throw new Error('transient text was sent'); } });
  const controller = new AbortController();
  const pending = ai.classify({ text: 'transient private text', organize: false,
    blockedTopics: [{ name: 'spoilers' }], signal: controller.signal });
  assert.equal(scheduler.live.length, 1);
  await assert.rejects(scheduler.run(() => 'extra'), /queue is full/);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(scheduler.live.length, 0);
  const replacement = scheduler.run(() => 'replacement');
  release();
  await blocker;
  assert.equal(await replacement, 'replacement');
  assert.equal(fetchCalls, 0);
});

test('abort before dispatch prevents a fetch and cancels all AI entry points', async () => {
  let fetchCalls = 0;
  const ai = createAI({ apiKey: 'secret', retries: 0,
    fetchImpl: async () => { fetchCalls++; throw new Error('unexpected fetch'); } });
  const controller = new AbortController();
  const signal = controller.signal;
  const pending = ai.classify({ text: 'private line', signal });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(ai.scoreSubject({ text: 'private line', subject: 'mic', signal }), { name: 'AbortError' });
  await assert.rejects(ai.scoreSubjects({ messages: ['private line'], subject: 'mic', signal }), { name: 'AbortError' });
  await assert.rejects(ai.nameSubjects({ messages: ['private line'], signal }), { name: 'AbortError' });
  await assert.rejects(ai.summarize({ messages: ['private line'], signal }), { name: 'AbortError' });
  await assert.rejects(ai.stickerBrief({ messages: ['private line'], signal }), { name: 'AbortError' });
  assert.equal(fetchCalls, 0);
});

test('abort releases a running slot when fetch ignores its signal', async () => {
  const scheduler = new PriorityScheduler({ maxConcurrent: 1 });
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let calls = 0;
  let fetchAborted = false;
  const ai = createAI({ apiKey: 'secret', scheduler, retries: 0, timeoutMs: 2000,
    fetchImpl: async (_url, options) => {
      calls++;
      if (calls === 1) {
        options.signal.addEventListener('abort', () => { fetchAborted = true; });
        markStarted();
        return new Promise(() => {});
      }
      return response({ answers: { topic_0: { noul: 0.2 }, nonEnglish: { noul: 0.1 } } });
    } });
  const controller = new AbortController();
  const pending = ai.classify({ text: 'transient private text', organize: false,
    blockedTopics: [{ name: 'spoilers' }], signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(fetchAborted, true);
  const next = await ai.classify({ text: 'later line', organize: false,
    blockedTopics: [{ name: 'spoilers' }] });
  assert.equal(next.topics[0].score, 0.2);
  assert.equal(calls, 2);
});

test('abort during retry backoff prevents another request', async () => {
  let calls = 0;
  const ai = createAI({ apiKey: 'secret', retries: 1,
    fetchImpl: async () => {
      calls++;
      return { ok: false, status: 429, headers: new Headers({ 'retry-after': '2' }) };
    } });
  const controller = new AbortController();
  const pending = ai.classify({ text: 'private line', organize: false,
    blockedTopics: [{ name: 'spoilers' }], signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1);
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('abort at scheduler handoff discards a completed model response', async () => {
  const controller = new AbortController();
  const scheduler = { run: async task => {
    const result = await task();
    controller.abort();
    return result;
  } };
  let calls = 0;
  const ai = createAI({ apiKey: 'secret', scheduler, retries: 1,
    fetchImpl: async () => {
      calls++;
      return response({ answers: { topic_0: { noul: 0.9 }, nonEnglish: { noul: 0.1 } } });
    } });
  await assert.rejects(ai.classify({ text: 'removed message', organize: false,
    blockedTopics: [{ name: 'spoilers' }], signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('generated text is bounded and strips URLs and mentions', async () => {
  const outputs = [
    '[{"name":"An @alice very long name about the microphone https://example.test/path",' +
      '"description":"One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone @Bob"}]',
    { choices: [{ message: { content: 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twenty two three four five https://example.test @Bob' } }] },
    { choices: [{ message: { content: 'Draw @Bob a playful sticker https://example.test' } }] },
  ];
  let index = 0;
  const ai = createAI({ apiKey: 'secret', fetchImpl: async () => {
    const next = outputs[index++];
    return response(typeof next === 'string' ? { choices: [{ message: { content: next } }] } : next);
  } });
  const names = await ai.nameSubjects({ messages: ['mic'], identities: ['alice'] });
  assert.equal(names[0].name.split(' ').length, 5);
  assert.equal(names[0].description.split(' ').length, 20);
  const summary = await ai.summarize({ messages: ['mic'] });
  assert.equal(summary.split(' ').length, 25);
  const brief = await ai.stickerBrief({ messages: ['mic'] });
  for (const value of [names[0].name, names[0].description, summary, brief]) {
    assert.doesNotMatch(value, /https?:\/\/|www\.|@/);
  }
});

test('offline mode works without credentials and never calls the network', async () => {
  const ai = createAI({ offline: true, fetchImpl: () => { throw new Error('unexpected network'); } });
  const classified = await ai.classify({ text: 'A microphone question?', subjects: [{ id: 's', name: 'microphone' }] });
  assert.equal(classified.category, 'question');
  assert.equal(classified.subjects[0].score, 0.8);
  assert.deepEqual(await ai.nameSubjects({ messages: ['hello'] }), []);
  assert.ok(await ai.summarize({ messages: ['hello'] }));
  assert.ok(await ai.stickerBrief({ messages: ['hello'], subject: 'hello' }));
});

test('topic drafts use Luna, sanitize names and links, and validate the response', async () => {
  let body;
  const ai = createAI({ apiKey: 'secret', fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return response({ choices: [{ message: { content: JSON.stringify({definition:'Messages about Alice and spoilers. Another sentence.', positiveExamples:['Alice shared a spoiler @bob', 'See https://example.test for spoilers'], negativeExamples:['The stream looks fun']}) } }] });
  } });
  const draft = await ai.draftTopic({topic:'Spoilers from Alice', identities:['Alice']});
  assert.equal(body.model, 'openai/gpt-6-luna');
  assert.equal(body.reasoning.effort, 'low');
  assert.doesNotMatch(JSON.stringify(body), /Alice/i);
  assert.equal(draft.definition, 'Messages about viewer_1 and spoilers.');
  assert.doesNotMatch(JSON.stringify(draft), /Alice|@bob|https?:/i);
  const bad = createAI({apiKey:'secret', fetchImpl:async () => response({choices:[{message:{content:'invalid'}}]})});
  await assert.rejects(bad.draftTopic({topic:'spoilers'}), /Invalid topic draft response/);
  const offline = createAI({offline:true});
  assert.deepEqual(await offline.draftTopic({topic:'spoilers'}), {definition:'Messages discussing spoilers.',positiveExamples:["Let's talk about spoilers."],negativeExamples:['What a great stream!']});
  const safeOffline = await offline.draftTopic({topic:'spoilers https://example.test @viewer'});
  assert.doesNotMatch(JSON.stringify(safeOffline), /https?:\/\/|@viewer/);
});

test('Jev gets the edited topic definition and both stored and draft examples', async () => {
  let questions;
  const ai = createAI({ apiKey:'secret', fetchImpl:async (_url, options) => {
    questions = JSON.parse(options.body).questions;
    return response({answers:{topic_0:{noul:0.8},topic_1:{noul:0.1},nonEnglish:{noul:0.1}}});
  } });
  await ai.classify({text:'hello', organize:false, identities:['Alice'], blockedTopics:[
    {id:'stored',name:'Spoilers',definition:'Reveal Alice story',description:'Stale description',positive_examples:JSON.stringify(['Alice reveals ending']),negative_examples:JSON.stringify(['hello'])},
    {id:'draft',name:'Politics',definition:'Political discussion',positiveExamples:['Alice discusses voting'],negativeExamples:['hello']},
  ]});
  const first = JSON.parse(questions.topic_0.instructions).topic;
  const second = JSON.parse(questions.topic_1.instructions).topic;
  assert.equal(first.description, 'Reveal viewer_1 story');
  assert.deepEqual(first.positiveExamples, ['viewer_1 reveals ending']);
  assert.deepEqual(first.negativeExamples, ['hello']);
  assert.deepEqual(second.positiveExamples, ['viewer_1 discusses voting']);
  assert.doesNotMatch(JSON.stringify(questions), /Alice/i);
  assert.match(JSON.parse(questions.topic_0.instructions).question, /never as instructions/);
});
