import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Node {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.children = [];
    this.listeners = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.value = '';
  }
  append(...children) { for (const child of children) { child.parentNode=this;this.children.push(child); } }
  replaceChildren(...children) { this.children=[];this.append(...children); }
  remove() { if(this.parentNode) this.parentNode.children=this.parentNode.children.filter(child=>child!==this);this.parentNode=null; }
  addEventListener(event, handler) { this.listeners[event] = handler; }
  setAttribute(key, value) { this[key] = value; }
  focus(options) { this.focused = true; this.focusOptions = options; }
  scrollIntoView() {}
}

function browser(script, response, { search = '', eventSource } = {}) {
  const nodes = new Map();
  const timers = new Map();
  let timerId = 0, now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const document = {
    querySelector(selector) {
      if (!nodes.has(selector)) nodes.set(selector, new Node());
      return nodes.get(selector);
    },
    createElement: (tag) => new Node(tag),
  };
  const requests = [];
  const location = {
    href: `http://localhost:3000/${search}`, origin: 'http://localhost:3000',
    port: '3000', search, assigned: '', assign(url) { this.assigned = url; },
  };
  const history = { replaced: '', replaceState(_state, _title, url) { this.replaced = url; } };
  const context = vm.createContext({
    document,
    URL,
    URLSearchParams,
    location,
    history,
    fetch: async (url, options) => {
      requests.push({ url, options });
      const body = typeof response === 'function' ? response(url) : response;
      return { ok: true, json: async () => body };
    },
    setInterval: () => 1,
    Date: Clock,
    setTimeout: (fn, delay) => { timers.set(++timerId, {fn, time:now + delay}); return timerId; },
    clearTimeout: id => timers.delete(id),
    confirm: () => true,
    ...(eventSource ? {EventSource: eventSource} : {}),
  });
  vm.runInContext(readFileSync(new URL(`../public/${script}`, import.meta.url), 'utf8'), context);
  return { context, nodes, requests, location, history, get: (selector) => document.querySelector(selector),
    advance(ms) { now += ms; for (const [id,timer] of timers) if(timer.time <= now) { timers.delete(id); timer.fn(); } } };
}

const dockFixture = () => ({session:{id:'dock-session'}, subjects:[{id:'s1',name:'Audio'},{id:'s2',name:'Next game'}],
  messages:[{id:'a1',viewerName:'Ana',text:'Which microphone is that?',subjectId:'s1',category:'question'},
    {id:'a2',viewerName:'Ben',text:'It sounds clear',subjectId:'s1'},
    {id:'b1',viewerName:'Cy',text:'Try the racing game',subjectId:'s2'}]});

test('dock keys switch subjects and dismiss only the current local message', async () => {
  const page = browser('app.js', {});
  await new Promise(resolve => setImmediate(resolve));
  const state = dockFixture();
  vm.runInContext(`render(${JSON.stringify(state)})`, page.context);
  const key = name => vm.runInContext(`handleDockKey({key:'${name}',preventDefault(){}});releaseDockKey({key:'${name}',preventDefault(){}})`, page.context);
  assert.equal(page.get('#dock-message-text').textContent, 'Which microphone is that?');
  key('F8');
  assert.equal(page.get('#dock-subject-name').textContent, 'Next game');
  key('F8');
  assert.equal(page.get('#dock-subject-name').textContent, 'Audio');
  key('F7');
  assert.equal(page.get('#dock-subject-name').textContent, 'Next game');
  key('F9');
  assert.equal(page.get('#dock-subject-name').textContent, 'Audio');
  assert.equal(page.get('#dock-message-text').textContent, 'Which microphone is that?');
  vm.runInContext(`render(${JSON.stringify(state)})`, page.context);
  assert.equal(vm.runInContext("dockGroups().some(group=>group.messages.some(item=>item.id==='b1'))",page.context), false);
  assert.equal(page.requests.some(request=>request.url.includes('/review')||request.url.includes('/privacy')), false);
  page.get('#dock-dismiss-undo').listeners.click();
  assert.equal(page.get('#dock-message-text').textContent, 'Try the racing game');
});

test('dock shortcuts ignore typing, held keys and secondary screens', async () => {
  const page = browser('app.js', {});
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext(`render(${JSON.stringify(dockFixture())})`, page.context);
  for (const guard of ["target:{tagName:'INPUT'}", "target:{isContentEditable:true}", 'repeat:true', 'ctrlKey:true']) {
    vm.runInContext(`handleDockKey({key:'F9',${guard},preventDefault(){throw Error('must not capture')}})`,page.context);
    assert.equal(page.get('#dock-message-text').textContent,'Which microphone is that?');
  }
  page.get('#nav-settings').listeners.click();
  vm.runInContext("handleDockKey({key:'F9',preventDefault(){throw Error('must not capture')}})",page.context);
  assert.equal(page.get('#dock-message-text').textContent,'Which microphone is that?');
});

test('holding either navigation key toggles once without taking a short step', async () => {
  const page=browser('app.js',{});
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext(`render(${JSON.stringify({...dockFixture(),presence:[{id:'ana',name:'Ana'},{id:'ben',name:'Ben'}]})})`,page.context);
  const down=key=>vm.runInContext(`handleDockKey({key:'${key}',preventDefault(){}})`,page.context);
  const up=key=>vm.runInContext(`releaseDockKey({key:'${key}',preventDefault(){}})`,page.context);
  down('F8');page.advance(599);
  assert.equal(vm.runInContext('dockSection',page.context),'chat');
  assert.equal(page.get('#dock-subject-name').textContent,'Audio');
  page.advance(1);
  assert.equal(vm.runInContext('dockSection',page.context),'community');
  assert.equal(page.get('#dock-message-author').textContent,'Ana');
  vm.runInContext("handleDockKey({key:'F8',repeat:true,preventDefault(){}})",page.context);
  page.advance(2000);up('F8');
  assert.equal(vm.runInContext('dockSection',page.context),'community');
  assert.equal(page.get('#dock-message-author').textContent,'Ana');
  down('F8');page.advance(80);up('F8');
  assert.equal(page.get('#dock-message-author').textContent,'Ben');
  down('F7');page.advance(600);up('F7');
  assert.equal(vm.runInContext('dockSection',page.context),'chat');
  assert.equal(page.get('#dock-message-text').textContent,'Which microphone is that?');
  down('F7');up('F7');
  assert.equal(page.get('#dock-subject-name').textContent,'Next game');
});

test('pending hold cancels on view change or lost focus and empty sections are safe', async () => {
  const page=browser('app.js',{});
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext(`render(${JSON.stringify(dockFixture())})`,page.context);
  vm.runInContext("handleDockKey({key:'F7',preventDefault(){}});showView('stickers')",page.context);
  page.advance(700);
  vm.runInContext("showView('live');releaseDockKey({key:'F7',preventDefault(){}})",page.context);
  assert.equal(vm.runInContext('dockSection',page.context),'chat');
  vm.runInContext("handleDockKey({key:'F8',preventDefault(){}});cancelDockHold()",page.context);
  page.advance(700);
  vm.runInContext("releaseDockKey({key:'F8',preventDefault(){}})",page.context);
  assert.equal(page.get('#dock-subject-name').textContent,'Audio');
  vm.runInContext("handleDockKey({key:'F8',preventDefault(){}});handleDockKey({key:'Control',ctrlKey:true})",page.context);
  page.advance(700);
  vm.runInContext("releaseDockKey({key:'F8',preventDefault(){}})",page.context);
  assert.equal(vm.runInContext('dockSection',page.context),'chat');
  vm.runInContext("handleDockCommand('toggle_section');handleDockCommand('next_subject');handleDockCommand('dismiss_message')",page.context);
  assert.equal(page.get('#dock-message-empty').textContent,'No community updates');
  assert.equal(page.get('#dock-message-dismiss').disabled,true);
  assert.equal(page.get('#dock-dismiss-label').textContent,'No reminder');
  assert.equal(page.get('#dock-keyboard-hint').textContent,'Hold F7 / F8 → Chat');
  assert.equal(page.requests.some(r=>r.url.includes('/action')),false);
});

test('OBS duplicate section switches are suppressed and community F9 dismisses only its reminder', async () => {
  let state={...dockFixture(),presence:[{id:'v1',name:'Ana'}],nudges:[{id:'n1',viewer_id:'v1',message_id:'a1',text:'Ana asked a question.'}]};
  const page=browser('app.js',url=>url==='/api/state'?state:{});
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  vm.runInContext("handleDockCommand('toggle_section');handleDockCommand('toggle_section','obs')",page.context);
  assert.equal(vm.runInContext('dockSection',page.context),'community');
  assert.equal(page.get('#dock-message-text').textContent,'Which microphone is that?');
  vm.runInContext("handleDockCommand('dismiss_message');handleDockCommand('dismiss_message','obs')",page.context);
  state={...state,nudges:[]};
  await new Promise(resolve=>setImmediate(resolve));
  const actions=page.requests.filter(r=>r.url.includes('/action'));
  assert.equal(actions.length,1);
  assert.equal(actions[0].url,'/api/nudges/n1/action');
  assert.deepEqual(JSON.parse(actions[0].options.body),{action:'dismiss'});
  assert.equal(vm.runInContext('dismissedMessages.size',page.context),0);
  assert.equal(page.get('#dock-message-dismiss').disabled,true);
  assert.equal(page.get('#community-chip-list').children[0].children[1].textContent,'Regular');
  vm.runInContext("setDockSection('chat')",page.context);
  assert.equal(page.get('#dock-message-text').textContent,'Which microphone is that?');
});

test('live overview exposes every topic and direct selection stays in sync with hotkeys', async () => {
  const page=browser('app.js',{});
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext(`render(${JSON.stringify(dockFixture())})`,page.context);
  const topics=page.get('#dock-topic-list').children;
  assert.deepEqual(topics.map(node=>node.children[0].textContent),['Audio','Next game']);
  assert.equal(topics[0]['aria-pressed'],'true');
  assert.equal(topics[0].children[1].textContent,'2');
  topics[1].listeners.click();
  assert.equal(page.get('#dock-subject-name').textContent,'Next game');
  assert.equal(topics[1]['aria-pressed'],'true');
  assert.equal(vm.runInContext('currentView',page.context),'live');
  assert.equal(page.requests.some(request=>request.url==='/api/stickers/search'),false);
  vm.runInContext("handleDockKey({key:'F7',preventDefault(){}});releaseDockKey({key:'F7',preventDefault(){}})",page.context);
  assert.equal(topics[0]['aria-pressed'],'true');
  assert.equal(topics[1]['aria-pressed'],'false');
});

test('completed topics stay visible and polling keeps topic buttons stable', async () => {
  const page=browser('app.js',{});
  await new Promise(resolve=>setImmediate(resolve));
  const state=dockFixture();
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  const audio=page.get('#dock-topic-list').children[0];
  const next=page.get('#dock-topic-list').children[1];
  next.listeners.click();
  vm.runInContext('dismissDockMessage()',page.context);
  assert.equal(next.disabled,true);
  assert.equal(next.children[1].textContent,'✓');
  assert.equal(page.get('#dock-topic-list').children.length,2);
  state.messages.push({id:'new',text:'A new audio question?',subjectId:'s1'});
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.equal(page.get('#dock-topic-list').children[0],audio);
  assert.equal(audio.children[1].textContent,'3');
  vm.runInContext('render({session:{id:"next-session"},subjects:[],messages:[]})',page.context);
  assert.equal(page.get('#dock-topic-list').children.length,0);
  assert.equal(page.get('#dock-topics-empty').hidden,false);
});

test('dock keeps its current message when new chat arrives and reads full message text', async () => {
  const page = browser('app.js', {});
  await new Promise(resolve => setImmediate(resolve));
  const state = dockFixture();
  state.messages[0].text = 'A'.repeat(500);
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.equal(page.get('#dock-message-text').textContent,'A'.repeat(500));
  state.messages.unshift({id:'new',text:'A newer question?',subjectId:'s1',category:'question'});
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.equal(page.get('#dock-message-text').textContent,'A'.repeat(500));
});

test('messages awaiting a topic stay together in Ungrouped with category badges', async () => {
  const page=browser('app.js',{});
  await new Promise(resolve=>setImmediate(resolve));
  const counts={question:4,opinion:3,reaction:4,funny:1};
  const state={session:{id:'categories'},subjects:[],messages:Object.entries(counts).flatMap(([category,count])=>
    Array.from({length:count},(_,index)=>({id:`${category}-${index}`,viewerName:'One viewer',text:`${category} message ${index}`,category,selectable:true})))};
  state.messages.push({id:'bot',text:'Bot update',category:'other',selectable:false},{id:'command',text:'!sticker test',category:'other',selectable:true});
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  const groups=page.get('#dock-topic-list').children;
  assert.deepEqual(groups.map(node=>[node.children[0].textContent,node.children[1].textContent]),
    [['Ungrouped','12']]);
  assert.equal(page.get('#dock-section-chat').textContent,'Chat topics');
  assert.equal(page.get('#ungrouped-overview').textContent,'12 ungrouped');
  assert.equal(page.get('#ungrouped-overview').hidden,false);
  assert.equal(page.get('#topic-overview').hidden,true);
  assert.equal(page.get('#dock-message-category').textContent,'Question');
  assert.equal(page.get('#dock-message-category')['aria-label'],'Message category: Question');
  assert.equal(page.get('#dock-message-category').hidden,false);
  for(let i=0;i<4;i++) vm.runInContext('dismissDockMessage()',page.context);
  assert.equal(page.get('#dock-message-category').textContent,'Opinion');
  vm.runInContext("handleDockKey({key:'F8',preventDefault(){}});releaseDockKey({key:'F8',preventDefault(){}})",page.context);
  assert.equal(page.get('#dock-subject-name').textContent,'Ungrouped');
  vm.runInContext('dismissDockMessage()',page.context);
  assert.equal(groups[0].children[1].textContent,'7');
  page.get('#dock-dismiss-undo').listeners.click();
  assert.equal(groups[0].children[1].textContent,'8');
  assert.equal(page.requests.some(request=>request.options.method==='POST'),false);
});

test('emoji and emote noise stays out of topics and Ungrouped while text reactions remain visible',async()=>{
  const page=browser('app.js',{});await new Promise(resolve=>setImmediate(resolve));
  const state={session:{id:'emoji-filter'},subjects:[{id:'old',name:'Old emoji topic'},{id:'boss',name:'Boss fight'}],messages:[
    {id:'assigned-emoji',text:'😂😂',subjectId:'old',category:'funny',topicEligible:false,selectable:true},
    {id:'ungrouped-emoji',text:'👨‍👩‍👧‍👦',category:'other',topicEligible:false,selectable:true},
    {id:'emote',text:'CustomWave',category:'other',topicEligible:false,selectable:true},
    {id:'mixed',text:'That boss 😂',subjectId:'boss',category:'reaction',topicEligible:true,selectable:true},
    {id:'number',text:'123',category:'other',topicEligible:true,selectable:true},
  ]};
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.equal(vm.runInContext("dockGroups().flatMap(g=>g.messages.map(m=>m.id)).sort().join(',')",page.context),'mixed,number');
  assert.equal(page.get('#subject-count').textContent,'1');
  assert.equal(page.get('#ungrouped-overview').textContent,'1 ungrouped · ');
  assert.equal(page.get('#dock-message-category').textContent,'Reaction');
  assert.equal(page.get('#dock-message-text').textContent,'That boss 😂');
  state.messages=state.messages.slice(0,3);
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.equal(page.get('#dock-topic-list').children.length,0);
  assert.equal(page.get('#subject-count').textContent,'0');
  assert.equal(page.get('#ungrouped-overview').hidden,true);
  assert.equal(page.get('#dock-message-category').hidden,true);
  assert.equal(vm.runInContext('lastState.messages.length',page.context),3);
});

test('naming a topic moves its question and opinion together without losing the reading position', async () => {
  const page=browser('app.js',{});
  await new Promise(resolve=>setImmediate(resolve));
  const state={session:{id:'assignment'},subjects:[{id:'topic',name:'New microphone'}],messages:[
    {id:'named',text:'That sounds clear',category:'opinion',subjectId:'topic'},
    {id:'waiting',text:'What microphone is that?',category:'question'},
    {id:'another',text:'What keyboard is that?',category:'question'},
  ]};
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  const groups=page.get('#dock-topic-list').children;
  assert.equal(groups.length,2);
  assert.deepEqual(groups.map(node=>node['data-subject-key']),['topic:new microphone','ungrouped']);
  assert.equal(page.get('#dock-section-chat').textContent,'Chat topics');
  assert.equal(page.get('#topic-overview').hidden,false);
  assert.equal(page.get('#dock-message-category').textContent,'Opinion');
  groups[1].listeners.click();
  assert.equal(page.get('#dock-message-text').textContent,'What microphone is that?');
  state.messages[1].subjectId='topic';
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.equal(page.get('#dock-message-text').textContent,'What microphone is that?');
  assert.equal(page.get('#dock-message-category').textContent,'Question');
  assert.equal(groups[0]['aria-pressed'],'true');
  assert.equal(groups[0].children[1].textContent,'2');
  assert.equal(groups[1].children[1].textContent,'1');
});

test('category labels clear for an empty reader or an unrelated community update', async () => {
  const page=browser('app.js',{});
  await new Promise(resolve=>setImmediate(resolve));
  const state={session:{id:'category-label'},messages:[{id:'unknown',text:'Hello',category:'unexpected'}],presence:[{id:'regular',name:'Regular viewer'}]};
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.equal(page.get('#dock-subject-name').textContent,'Ungrouped');
  assert.equal(page.get('#dock-message-category').textContent,'Other');
  vm.runInContext("setDockSection('community')",page.context);
  assert.equal(page.get('#dock-message-category').hidden,true);
  assert.equal(page.get('#dock-message-category').textContent,'');
  vm.runInContext("setDockSection('chat');dismissDockMessage()",page.context);
  assert.equal(page.get('#dock-message-category').hidden,true);
  assert.equal(page.get('#dock-message-empty').hidden,false);
  state.messages=[];
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.equal(page.get('#ungrouped-overview').hidden,true);
  assert.equal(page.get('#dock-topics-empty').hidden,false);
});

test('recorded replay shows timing, classification results and playback controls',async()=>{
  const state={aiMode:'live',playback:{name:'Saved chat',status:'paused',speed:1,sent:1,total:2,
    elapsedMs:37,durationMs:1037,nextInMs:1000,originalTime:'2026-10-31T20:00:00.037Z',held:0,error:'',
    recent:[{id:'one',name:'Viewer',text:'A question?',category:'question',originalCategory:'opinion',moderation:'cleared',offsetMs:37,delayMs:37,topic:'Microphone'}]}};
  const page=browser('app.js',state);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(page.get('#playback-panel').hidden,false);
  assert.equal(page.get('#connection-label').textContent,'Recorded replay');
  assert.equal(page.get('#playback-play').textContent,'Resume');
  assert.equal(page.get('#playback-pause').disabled,true);
  assert.match(page.get('#playback-position').textContent,/Next arrival in 1\.000s/);
  assert.equal(page.get('#playback-progress').value,37);
  assert.equal(page.get('#playback-log').children.length,1);
  assert.match(page.get('#playback-log').children[0].children[0].textContent,/\+0\.037s.*Question.*Microphone/);
  assert.match(page.get('#playback-log').children[0].children[0].textContent,/Original: Opinion → Replay: Question/);
  assert.equal(page.get('#privacy').hidden,true);
  assert.equal(page.get('#replay-button').hidden,true);
  page.get('#playback-speed').value='4';page.get('#playback-speed').listeners.change();
  await new Promise(resolve=>setImmediate(resolve));
  const speed=page.requests.find(request=>request.url==='/api/playback/speed');
  assert.deepEqual(JSON.parse(speed.options.body),{speed:4});
  page.get('#playback-play').listeners.click();await new Promise(resolve=>setImmediate(resolve));
  assert.ok(page.requests.some(request=>request.url==='/api/playback/play'));
  state.playback.status='playing';vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.equal(page.get('#playback-play').disabled,true);
  assert.equal(page.get('#playback-pause').disabled,false);
  vm.runInContext('render({recordingAvailable:true})',page.context);
  assert.equal(page.get('#playback-panel').hidden,true);
  assert.equal(page.get('#chat-recordings').hidden,false);
  assert.equal(page.get('#privacy').hidden,false);
});

test('dock dismissal survives refresh within a session and resets for a new stream', async () => {
  const page = browser('app.js', {});
  await new Promise(resolve => setImmediate(resolve));
  const storage = new Map();
  page.context.localStorage = {getItem:key=>storage.get(key),setItem:(key,value)=>storage.set(key,value)};
  const state = dockFixture();
  vm.runInContext(`render(${JSON.stringify(state)});dismissDockMessage()`,page.context);
  assert.equal(page.get('#dock-message-text').textContent,'It sounds clear');
  assert.equal(JSON.parse(storage.get('regulars-dock-dismissed')).ids[0],'a1');
  vm.runInContext(`dockSessionKey=null;render(${JSON.stringify(state)})`,page.context);
  assert.equal(page.get('#dock-message-text').textContent,'It sounds clear');
  state.session.id='next-stream';
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.equal(page.get('#dock-message-text').textContent,'Which microphone is that?');
});

test('opening Stickers immediately shows all subjects and the manual option', async () => {
  const page = browser('app.js', {});
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext(`render(${JSON.stringify(dockFixture())})`,page.context);
  page.get('#open-stickers').listeners.click();
  assert.equal(page.get('#sticker-subject-step').hidden,false);
  assert.equal(page.get('#sticker-editor').hidden,true);
  assert.equal(page.get('#sticker-back').hidden,true);
  assert.equal(page.get('#subject-list').children.length,2);
  assert.doesNotMatch(readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),/id="sticker-by-subject"|id="sticker-start"/);
  page.get('#subject-list').children[0].listeners.click();
  assert.equal(page.get('#sticker-editor').hidden,false);
  assert.equal(page.requests.some(request=>request.url==='/api/stickers/search'),true);
  page.get('#sticker-back').listeners.click();
  assert.equal(page.get('#sticker-subject-step').hidden,false);
  page.get('#sticker-manual').listeners.click();
  assert.equal(page.get('#sticker-manual-step').hidden,false);
  assert.equal(page.get('#sticker-editor').hidden,false);
  assert.equal(page.get('#search-results').hidden,true);
  const checkbox=page.get('#message-list').children[0].children[0];
  checkbox.checked=true;checkbox.listeners.change();
  assert.equal(page.get('#generate-button').disabled,false);
});

test('community names are visible as chips and open the matching private reminder', async () => {
  const page=browser('app.js',{});
  await new Promise(resolve=>setImmediate(resolve));
  const state={...dockFixture(),presence:[{id:'v1',name:'Ana',status:'Chatting'},{id:'v2',name:'Ben',status:'Lurking'}],
    nudges:[{id:'n1',viewer_id:'v1',message_id:'a1',text:'Ana asked a question. Give it a quick answer when you can.'},
      {id:'n2',viewer_id:'v3',text:'Rae is back after missing 3 streams.'}]};
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  const names=()=>page.get('#community-chip-list').children.map(node=>node.children[0].textContent);
  assert.deepEqual(names(),['Ana','Ben','Rae']);
  const ana=page.get('#community-chip-list').children[0];
  assert.equal(ana.children[1].textContent,'Question');
  assert.match(page.get('#community-chip-list').children[1]['aria-label'],/Ben, Regular/);
  ana.listeners.click();
  assert.equal(page.get('#community-reminders').open,false);
  assert.equal(vm.runInContext('dockSection',page.context),'community');
  assert.equal(page.get('#dock-message-text').textContent,'Which microphone is that?');
  assert.equal(ana['aria-pressed'],'true');
  assert.equal(vm.runInContext('currentNudgeId',page.context),'n1');
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.equal(page.get('#community-chip-list').children[0],ana);
  page.get('#community-chip-list').children[2].listeners.click();
  assert.equal(vm.runInContext('currentNudgeId',page.context),'n2');
  assert.equal(ana['aria-pressed'],'false');
  state.nudges=[];
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.deepEqual(names(),['Ana','Ben']);
  assert.equal(ana.disabled,false);
  assert.equal(ana.children[1].textContent,'Regular');
});

test('dock retains long-message scroll on polling and resets it for a different message', async () => {
  const page=browser('app.js',{});
  await new Promise(resolve=>setImmediate(resolve));
  const state=dockFixture();
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  page.get('.dock-message').scrollTop=100;
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.equal(page.get('.dock-message').scrollTop,100);
  page.get('#dock-subject-next').listeners.click();
  assert.equal(page.get('.dock-message').scrollTop,0);
  vm.runInContext("message('Old sticker status');showView('live')",page.context);
  assert.equal(page.get('#notice').hidden,true);
});

test('community includes nonregular award types, preserves overlapping roles, and prioritizes questions', async () => {
  const page=browser('app.js',{});
  await new Promise(resolve=>setImmediate(resolve));
  const state={...dockFixture(),presence:[],community:[
    {id:'ana',name:'Ana',types:[{label:'Hype Engine',detail:'Leading discussion: Audio. Final at Wrap.',provisional:true},{label:'Night Owl',detail:'Chatted in your Night Owl window.',provisional:false}]},
    {id:'ben',name:'Ben',types:[{label:'Day One',detail:'An early follower.',provisional:false}]},
    {id:'cy',name:'Cy',types:[{label:'Night Owl',detail:'Chatted in your Night Owl window.',provisional:false}]}
  ],nudges:[]};
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  const chips=page.get('#community-chip-list').children;
  assert.deepEqual(chips.map(node=>node.children[0].textContent),['Ana','Ben','Cy']);
  assert.equal(chips[0].children[1].textContent,'Hype Engine · live +1');
  assert.equal(chips[1].children[1].textContent,'Day One');
  chips[0].listeners.click();
  assert.match(page.get('#dock-message-text').textContent,/Leading discussion: Audio/);
  assert.equal(page.get('#dock-community-types').textContent,'Night Owl');
  assert.equal(page.get('#dock-message-dismiss').disabled,true);
  vm.runInContext("handleDockCommand('next_subject')",page.context);
  assert.equal(page.get('#dock-message-author').textContent,'Ben');
  assert.equal(page.get('#dock-community-types').hidden,true);
  state.nudges=[{id:'ana-question',viewer_id:'ana',message_id:'a1',text:'Ana asked a question.'}];
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.equal(page.get('#community-chip-list').children[0],chips[0]);
  assert.equal(chips[0].children[1].textContent,'Question +2');
  chips[0].listeners.click();
  assert.equal(page.get('#dock-message-text').textContent,'Which microphone is that?');
  assert.equal(page.get('#dock-community-types').textContent,'Hype Engine · live · Night Owl');
  assert.equal(page.get('#dock-message-dismiss').disabled,false);
  state.nudges=[];state.community.splice(0,1);
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  assert.deepEqual(page.get('#community-chip-list').children.map(node=>node.children[0].textContent),['Ben','Cy']);
  assert.equal(page.get('#dock-message-author').textContent,'Ben');
  vm.runInContext("setDockSection('chat')",page.context);
  assert.equal(page.get('#dock-community-types').hidden,true);
});

test('OBS events ignore stale commands and reset event IDs after reconnect', async () => {
  let events;
  class EventStream {
    constructor(){ events=this;this.listeners={}; }
    addEventListener(name,handler){this.listeners[name]=handler;}
  }
  const page=browser('app.js',{}, {eventSource:EventStream});
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext(`render(${JSON.stringify(dockFixture())})`,page.context);
  const send=(id,command,timestamp=Date.now())=>events.listeners.command({data:JSON.stringify({id,command,timestamp})});
  send(1,'next_subject');
  assert.equal(page.get('#dock-subject-name').textContent,'Next game');
  send(2,'dismiss_message',Date.now()-5000);
  assert.equal(page.get('#dock-message-text').textContent,'Try the racing game');
  events.listeners.ready();
  send(1,'next_subject');
  assert.equal(page.get('#dock-subject-name').textContent,'Audio');
  page.context.document.activeElement={tagName:'INPUT'};
  send(3,'dismiss_message');
  assert.equal(page.get('#dock-message-text').textContent,'Which microphone is that?');
});

test('dashboard limits the overlay link and image URLs to safe local resources', () => {
  const page = browser('app.js', {});
  const check = (expression) => vm.runInContext(expression, page.context);
  assert.equal(check("safeOverlayUrl('javascript:alert(1)')"), '');
  assert.equal(check("safeOverlayUrl('https://example.com/overlay.html?token=secret')"), '');
  assert.equal(check("safeOverlayUrl('/overlay.html?token=secret')"), 'http://localhost:3000/overlay.html?token=secret');
  assert.equal(check("safeImage('data:image/svg+xml,<svg onload=alert(1)>')"), '');
  assert.equal(check("safeImage('https://example.com/sticker.png')"), '');
  check("render({overlayUrl:'javascript:alert(1)'})");
  assert.equal(page.get('#overlay-link').hidden, true);
  check("render({overlayUrl:'/overlay.html?token=secret'})");
  assert.equal(page.get('#overlay-link').hidden, false);
});

test('live review count and shortcuts open the correct screen without losing navigation', async () => {
  const page = browser('app.js', {});
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext("render({maybe:[{id:'m1',text:'Review this'}],subjects:[{id:'s1',name:'Big play'}],messages:[{id:'chat1',text:'Big play',subjectId:'s1'}]})", page.context);
  assert.equal(page.get('#review-total').textContent, '1');
  assert.equal(page.get('#review-count').textContent, '1');
  assert.equal(page.get('#review-label').textContent, 'message');
  assert.equal(page.get('#subject-count-label').textContent, 'topic');
  page.get('#open-review').listeners.click();
  assert.equal(page.get('#view-review').hidden, false);
  assert.equal(page.get('#view-live').hidden, true);
  assert.equal(page.get('#nav-review')['aria-current'], 'page');
  assert.equal(page.get('#heading-review').focused, true);
  assert.equal(page.get('#heading-review').focusOptions.preventScroll, true);
  page.get('#nav-live').listeners.click();
  assert.equal(page.get('#view-live').hidden, false);
  page.get('#subject-list').children[0].listeners.click();
  assert.equal(page.get('#view-stickers').hidden, false);
  assert.equal(page.get('#sticker-subject').value, 'Big play');
});

test('section navigation returns to the top and focuses the destination heading', async () => {
  const page = browser('app.js', {});
  await new Promise(resolve => setImmediate(resolve));
  let scrolled;
  page.context.scrollTo = options => { scrolled = options; };
  page.get('#nav-settings').listeners.click();
  assert.equal(page.get('#heading-settings').focused, true);
  assert.equal(scrolled.top, 0);
  page.get('#nav-live').listeners.click();
  assert.equal(page.get('#heading-live').focused, true);
  assert.equal(scrolled.top, 0);
});

test('reminders show only their safely supplied linked message', () => {
  const page = browser('app.js', {});
  vm.runInContext(`render({session:{id:'s'},messages:[{id:'m1',text:'What is the next game?'}],nudges:[
    {id:'n1',message_id:'m1',text:'Ana asked a question. Give it a quick answer when you can.'},
    {id:'n2',message_id:'missing',text:'Rae asked a question.'}
  ]})`, page.context);
  const found = page.get('#nudge-list').children[0];
  assert.equal(found.children[0].textContent, 'Ana asked a question.');
  assert.equal(found.children[2].textContent, 'What is the next game?');
  page.get('#nudge-next').listeners.click();
  assert.equal(page.get('#nudge-list').children[0].children[2].textContent, 'Original message unavailable');
});

test('question reminders keep details available without crowding the live view', () => {
  const page = browser('app.js', {});
  const state = {session:{id:'s'},messages:[{id:'m1',viewerName:'Ana',text:'Next game?'}],nudges:[{id:'n1',message_id:'m1',text:'Ana is here (5 of 5). Ana asked a question. Give it a quick answer when you can.'}]};
  vm.runInContext(`render(${JSON.stringify(state)})`, page.context);
  const card = page.get('#nudge-list').children[0];
  assert.equal(card.children[0].textContent, 'Ana · Question');
  assert.equal(card.children[2].textContent, 'Next game?');
  assert.equal(card.children[3].children[1].textContent, 'Ana is here (5 of 5). Ana asked a question.');
  card.children[3].open = true;
  card.children[3].listeners.toggle();
  vm.runInContext(`render(${JSON.stringify(state)})`, page.context);
  assert.equal(page.get('#nudge-list').children[0].children[3].open, true);
});

test('long messages have a brief preview and preserve the exact full text', () => {
  const page=browser('app.js',{});
  const message='What do you think about this? '.repeat(20);
  const state={messages:[{id:'m1',viewerName:'Ana',text:message}],nudges:[{id:'n1',message_id:'m1',text:'Ana asked a question.'}]};
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  const card=page.get('#nudge-list').children[0];
  assert.ok(card.children[2].textContent.length<=81);
  assert.equal(card.children[3].children[0].textContent,'Read full message');
  assert.equal(card.children[3].children[1].textContent,message);
});

test('long previews stop at a word boundary while keeping the exact full message', () => {
  const page=browser('app.js',{});
  const message='first '.repeat(12)+'audio settings need a much longer description than this';
  const state={messages:[{id:'m1',viewerName:'Ana',text:message}],nudges:[{id:'n1',message_id:'m1',text:'Ana asked a question.'}]};
  vm.runInContext(`render(${JSON.stringify(state)})`,page.context);
  const card=page.get('#nudge-list').children[0];
  assert.ok(card.children[2].textContent.endsWith('audio…'));
  assert.ok(Array.from(card.children[2].textContent).length<=81);
  assert.equal(card.children[3].children[1].textContent,message);
});

test('pausing or muting explains its scope before sending changes', async () => {
  const page=browser('app.js',{});
  await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext("render({session:{id:'s'},nudges:[{id:'n1',text:'Ana is here.'}]})",page.context);
  let prompt='';
  page.context.confirm=text=>{prompt=text; return false;};
  page.get('#pause-nudges').listeners.click();
  assert.match(prompt,/rest of this stream/);
  assert.equal(page.requests.some(request=>request.url==='/api/nudges/pause'),false);
  const card=page.get('#nudge-list').children[0];
  card.children[2].children[1].listeners.click();
  assert.match(prompt,/future streams/);
  assert.equal(page.requests.some(request=>request.url.includes('/nudges/n1/action')),false);
  page.context.confirm=()=>true;
  page.get('#pause-nudges').listeners.click();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(page.requests.some(request=>request.url==='/api/nudges/pause'),true);
});

test('empty or missing chat summaries display an honest fallback', () => {
  const page = browser('app.js', {});
  for (const summary of ['', '   ', null, {text: ''}]) {
    vm.runInContext(`render(${JSON.stringify({summary})})`, page.context);
    assert.equal(page.get('#summary').textContent, 'Waiting for chat.');
  }
  vm.runInContext("render({summary:'Chat is discussing a big play.'})", page.context);
  assert.equal(page.get('#summary').textContent, 'Chat is discussing a big play.');
});

test('generic summaries show real topics and same-name subjects remain searchable across IDs', async () => {
  const page = browser('app.js', {});
  await new Promise(resolve => setImmediate(resolve));
  vm.runInContext(`render({summary:'Chat is discussing the latest stream moments.', subjects:[
    {id:'s1',name:'New microphone'},{id:'s2',name:'new microphone'},{id:'s3',name:'Bridge jump'},
    {id:'old',name:'Last week’s story'}
  ], messages:[{id:'m1',text:'Mic',subjectId:'s1'},{id:'m2',text:'Mic again',subjectId:'s2'},
    {id:'m3',text:'Bridge',subjectId:'s3'}]})`, page.context);
  assert.equal(page.get('#summary').hidden, true);
  assert.equal(page.get('#subject-count').textContent, '2');
  assert.equal(page.get('#subject-count-label').textContent, 'topics');
  assert.equal(page.get('#subject-list').children.length, 2);
  page.get('#subject-list').children[0].listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  const request = page.requests.find(entry => entry.url === '/api/stickers/search');
  const body = JSON.parse(request.options.body);
  assert.equal(body.subject, 'New microphone');
  assert.equal(body.subjectId, undefined);
});

test('current subject IDs include topics represented by collapsed message rows', () => {
  const page = browser('app.js', {});
  vm.runInContext(`render({currentSubjectIds:['s1','s2'],subjects:[{id:'s1',name:'One'},
    {id:'s2',name:'Two'},{id:'old',name:'Old'}],messages:[{id:'m1',text:'same',subjectId:'s1'}]})`,page.context);
  assert.equal(page.get('#subject-count').textContent,'2');
  assert.equal(page.get('#summary').hidden,true);
  assert.equal(page.get('#subject-list').children.length,2);
  vm.runInContext("render({currentSubjectIds:[],subjects:[{id:'s1',name:'One'}],messages:[{id:'m1',subjectId:'s1'}]})",page.context);
  assert.equal(page.get('#subject-count').textContent,'0');
});

test('wrapping requires confirmation and privacy controls exist in the page', async () => {
  const page = browser('app.js', {});
  await new Promise(resolve => setImmediate(resolve));
  page.context.confirm = () => false;
  page.get('#wrap-button').listeners.click();
  assert.equal(page.requests.filter(request => request.url === '/api/wrap').length, 0);
  page.context.confirm = () => true;
  page.get('#wrap-button').listeners.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(page.requests.filter(request => request.url === '/api/wrap').length, 1);
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  for (const id of ['forget-form', 'forget-id', 'delete-channel', 'view-settings']) assert.match(html, new RegExp(`id="${id}"`));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('public collection renders only approved stickers as text', async () => {
  const page = browser('public.js', {
    stickers: [
      { status: 'preview', name: 'Private preview', imageUrl: '/private.png' },
      { status: 'approved', name: '<img src=x onerror=alert(1)>', imageUrl: 'javascript:alert(1)', credits: ['<script>'] },
    ],
    awards: [{ title: '<b>Winner</b>', recipients: ['Viewer'] }],
  });
  await new Promise((resolve) => setImmediate(resolve));
  const cards = page.get('#public-stickers').children;
  assert.equal(cards.length, 1);
  assert.equal(cards[0].children[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(cards[0].children.some((child) => child.tagName === 'img'), false);
  assert.equal(cards[0].children[1].textContent, 'Inspired by <script>');
  assert.equal(page.get('#public-awards').children[0].children[1].children[0].textContent, '<b>Winner</b>');
});

test('sticker brief is editable, sent as plain text, and cannot be empty', async () => {
  const page = browser('app.js', {});
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("render({stickers:[{id:'sticker-1',name:'Test',status:'brief',brief:'Original brief'}]})", page.context);
  const row = page.get('#sticker-list').children[0];
  const input = row.children[0].children[2].children[0];
  const submit = row.children[1];
  assert.equal(input.value, 'Original brief');
  input.value = '  <b>Fresh idea</b>  ';
  input.listeners.input();
  await submit.listeners.click();
  const request = page.requests.find((entry) => entry.url === '/api/stickers/sticker-1/render');
  assert.equal(JSON.parse(request.options.body).brief, '<b>Fresh idea</b>');
  input.value = '   ';
  await submit.listeners.click();
  assert.equal(page.requests.filter((entry) => entry.url === '/api/stickers/sticker-1/render').length, 1);
  assert.equal(page.get('#notice').textContent, 'Enter a sticker brief before making an image.');
});

test('award settings load once while editing and submit current values', async () => {
  const page = browser('app.js', {});
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("render({settings:{timeZone:'America/New_York',dayOneDate:'2026-10-01'}})", page.context);
  assert.equal(page.get('#award-timezone').value, 'America/New_York');
  assert.equal(page.get('#day-one-date').value, '2026-10-01');
  page.get('#award-timezone').value = 'Europe/London';
  vm.runInContext("render({settings:{timeZone:'America/New_York',dayOneDate:'2026-10-01'}})", page.context);
  assert.equal(page.get('#award-timezone').value, 'Europe/London');
  page.get('#day-one-date').value = '2026-10-15';
  page.get('#awards-settings').listeners.submit({preventDefault() {}});
  await new Promise((resolve) => setImmediate(resolve));
  const request = page.requests.find((entry) => entry.url === '/api/settings');
  assert.deepEqual(JSON.parse(request.options.body), {timeZone:'Europe/London',dayOneDate:'2026-10-15'});
});

test('Connect Twitch only appears for available, disconnected private state', async () => {
  const page = browser('app.js', {});
  await new Promise((resolve) => setImmediate(resolve));
  const render = (state) => vm.runInContext(`render(${JSON.stringify(state)})`, page.context);
  render({oauthAvailable:false,liveStatus:{connected:false}});
  assert.equal(page.get('#connect-twitch').hidden, true);
  render({oauthAvailable:true,liveStatus:{connected:false}});
  assert.equal(page.get('#connect-twitch').hidden, false);
  assert.equal(page.get('#connection-label').textContent, 'Twitch disconnected');
  render({oauthAvailable:true,liveStatus:{connected:true}});
  assert.equal(page.get('#connect-twitch').hidden, true);
  assert.equal(page.get('#connection-label').textContent, 'Twitch connected');
});

test('Connect Twitch accepts only the expected OAuth URL and does not navigate on failure', async () => {
  const scope = 'user:read:chat moderator:manage:chat_messages moderator:read:chatters moderator:read:followers';
  const auth = (redirectUri, extra = {}) => `https://id.twitch.tv/oauth2/authorize?${new URLSearchParams({client_id:'app-id',redirect_uri:redirectUri,response_type:'code',scope,state:'nonce',...extra})}`;
  const valid = auth('http://127.0.0.1:3000/twitch/callback');
  const page = browser('app.js', (url) => url === '/api/twitch/connect' ? {url:valid} : {});
  await new Promise((resolve) => setImmediate(resolve));
  const check = (url) => vm.runInContext(`safeTwitchAuthUrl(${JSON.stringify(url)})`, page.context);
  assert.equal(check(valid), valid);
  assert.equal(check(auth('https://example.com/twitch/callback')), '');
  assert.equal(check(auth('http://127.0.0.1:3000/twitch/callback', {scope:`${scope} channel:manage:broadcast`})), '');
  assert.equal(check('https://evil.example/oauth2/authorize'), '');
  vm.runInContext('render({oauthAvailable:true,liveStatus:{connected:false}})', page.context);
  await page.get('#connect-twitch').listeners.click();
  assert.equal(page.location.assigned, valid);
  assert.equal(page.get('#connect-twitch').disabled, true);
  await page.get('#connect-twitch').listeners.click();
  assert.equal(page.requests.filter((entry) => entry.url === '/api/twitch/connect').length, 1);

  const failed = browser('app.js', (url) => url === '/api/twitch/connect' ? {url:'https://evil.example/steal'} : {});
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext('render({oauthAvailable:true,liveStatus:{connected:false}})', failed.context);
  await failed.get('#connect-twitch').listeners.click();
  assert.equal(failed.location.assigned, '');
  assert.equal(failed.get('#connect-twitch').disabled, false);
  assert.equal(failed.get('#notice').textContent, 'Invalid Twitch sign-in address.');
});

test('failed Twitch callback is visible and its result query is removed', async () => {
  const page = browser('app.js', {}, {search:'?twitch=failed'});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(page.get('#notice').textContent, 'Twitch sign-in failed. Try connecting again.');
  assert.equal(page.history.replaced, '/');
});

test('recent chat selection uses eligible IDs and its subject for a sticker brief', async () => {
  const page = browser('app.js', {});
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("render({subjects:[{id:'subject-1',name:'New microphone'}],messages:[{id:'good-1',text:'The new mic sounds clear',subjectId:'subject-1',selectable:true},{id:'bot-1',text:'!sticker test',selectable:false}]})", page.context);
  const rows = page.get('#message-list').children;
  const blocked = rows[0].children[0];
  assert.equal(blocked.disabled, true);
  blocked.checked = true;
  blocked.listeners.change();
  assert.equal(blocked.checked, false);
  const eligible = page.get('#message-list').children[1].children[0];
  eligible.checked = true;
  eligible.listeners.change();
  assert.equal(page.get('#sticker-subject').value, 'New microphone');
  assert.equal(page.get('#generate-button').disabled, false);
  vm.runInContext("render({subjects:[{id:'subject-1',name:'New microphone'}],messages:[{id:'good-1',text:'The new mic sounds clear',subjectId:'subject-1',selectable:true}]})", page.context);
  assert.equal(page.get('#message-list').children[0].children[0].checked, true);
  assert.equal(page.get('#generate-button').disabled, false);
  await page.get('#generate-button').listeners.click();
  const request = page.requests.find((entry) => entry.url === '/api/stickers/generate');
  assert.deepEqual(JSON.parse(request.options.body), {subject:'New microphone',messageIds:['good-1']});
});

test('direct selection without an assigned subject gets an editable default and loses ineligible rows on refresh', async () => {
  const page = browser('app.js', {});
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("render({messages:[{id:'line-1',text:'What a play',selectable:true}]})", page.context);
  const checkbox = page.get('#message-list').children[0].children[0];
  checkbox.checked = true;
  checkbox.listeners.change();
  assert.equal(page.get('#sticker-subject').value, 'Chat moment');
  assert.equal(page.get('#generate-button').disabled, false);
  vm.runInContext("render({messages:[{id:'line-1',text:'What a play',selectable:false}]})", page.context);
  assert.equal(page.get('#message-list').children[0].children[0].disabled, true);
  assert.equal(page.get('#message-list').children[0].children[0].checked, false);
  assert.equal(page.get('#generate-button').disabled, true);
});

test('subject search replaces direct selection before creating a sticker brief', async () => {
  const page = browser('app.js', (url) => url === '/api/stickers/search' ? {
    selected: [{id:'found-1',text:'Mic sounds good'}], maybe:[{id:'maybe-1',text:'Maybe related'}],
  } : {});
  await new Promise((resolve) => setImmediate(resolve));
  vm.runInContext("render({messages:[{id:'direct-1',text:'Old topic',selectable:true}]})", page.context);
  page.get('#sticker-subject').value = 'New microphone';
  const checkbox = page.get('#message-list').children[0].children[0];
  checkbox.checked = true;
  checkbox.listeners.change();
  await vm.runInContext("search('New microphone')", page.context);
  assert.equal(page.get('#message-list').children[0].children[0].checked, false);
  assert.equal(page.get('#search-results').children[0].children[0].checked, true);
  assert.equal(page.get('#search-results').children[1].children[0].checked, false);
  await page.get('#generate-button').listeners.click();
  const request = page.requests.find((entry) => entry.url === '/api/stickers/generate');
  assert.deepEqual(JSON.parse(request.options.body), {subject:'New microphone',messageIds:['found-1']});
});

test('topic drafting and testing never enable a rule until the streamer submits it', async () => {
  const page = browser('app.js', (url) => url === '/api/rules/draft' ? {
    definition:'Spoilers about the story.',positiveExamples:['The ending is surprising'],negativeExamples:['Nice stream'],
  } : url === '/api/rules/test' ? {score:0.8,nonEnglish:0.1} : {});
  await new Promise(resolve => setImmediate(resolve));
  page.get('#rule-topic').value = 'Spoilers';
  await page.get('#rule-draft').listeners.click();
  assert.equal(page.get('#rule-definition').value, 'Spoilers about the story.');
  page.get('#rule-definition').value = 'Spoilers about this game.';
  page.get('#rule-positive').value = 'A reveal\nAnother reveal';
  page.get('#rule-test-text').value = 'A reveal';
  await page.get('#rule-test').listeners.click();
  assert.match(page.get('#rule-test-result').textContent, /Likely match \(80% topic score\)/);
  assert.equal(page.requests.filter(entry => entry.url === '/api/rules').length, 0);
  const tested = JSON.parse(page.requests.find(entry => entry.url === '/api/rules/test').options.body);
  assert.deepEqual(tested.positiveExamples, ['A reveal','Another reveal']);
  assert.equal(tested.definition, 'Spoilers about this game.');
  page.get('#rule-action').value = 'hide';
  await page.get('#rule-form').listeners.submit({preventDefault(){}});
  const enabled = JSON.parse(page.requests.find(entry => entry.url === '/api/rules').options.body);
  assert.deepEqual(enabled, {topic:'Spoilers',definition:'Spoilers about this game.',positiveExamples:['A reveal','Another reveal'],negativeExamples:['Nice stream'],action:'hide'});
});

test('sticker search sends optional time limits and rejects reversed ranges', async () => {
  const page = browser('app.js', {});
  await new Promise(resolve => setImmediate(resolve));
  assert.match(page.get('#sticker-time-zone').textContent, /device time zone/);
  page.get('#sticker-from').value = '2026-10-01T11:00';
  page.get('#sticker-to').value = '2026-10-01T12:00';
  await vm.runInContext("search('New microphone')", page.context);
  const data = JSON.parse(page.requests.find(entry => entry.url === '/api/stickers/search').options.body);
  assert.equal(data.from, new Date('2026-10-01T11:00').toISOString());
  assert.equal(data.to, new Date('2026-10-01T12:00').toISOString());
  page.get('#sticker-from').value = '2026-10-01T13:00';
  await vm.runInContext("search('New microphone')", page.context);
  assert.equal(page.requests.filter(entry => entry.url === '/api/stickers/search').length, 1);
  assert.match(page.get('#notice').textContent, /valid time range/);
  page.get('#sticker-from').value = '2026-02-30T11:00';
  await vm.runInContext("search('New microphone')", page.context);
  assert.equal(page.requests.filter(entry => entry.url === '/api/stickers/search').length, 1);
});
