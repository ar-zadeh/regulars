import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DEFAULT_SETTINGS, validateSettings } from '../src/config.js';

const defaults = DEFAULT_SETTINGS;
class Node {
  constructor() { this.children=[]; this.listeners={}; this.value=''; this.textContent=''; this.hidden=false; this.disabled=false; this.classList={toggle(){}}; }
  addEventListener(name, fn) { this.listeners[name]=fn; }
  append(...nodes) { for(const node of nodes){node.parentNode=this;this.children.push(node);} }
  replaceChildren(...nodes) { this.children=[];this.append(...nodes); }
  remove() { if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(node=>node!==this);this.parentNode=null; }
  setAttribute() {}
}
function browser(handler) {
  const nodes = new Map(), calls=[];
  const document = {querySelector(s) { if (!nodes.has(s)) nodes.set(s,new Node()); return nodes.get(s); }, createElement() { return new Node(); }};
  const context = vm.createContext({document,URL,URLSearchParams,location:{href:'http://localhost/',origin:'http://localhost',port:'',search:''},history:{replaceState(){}},setInterval(){},setTimeout(){},clearTimeout(){},confirm(){return true},
    fetch:async (url, options) => { calls.push({url,options}); return handler(url,options); }});
  vm.runInContext(readFileSync(new URL('../public/app.js',import.meta.url),'utf8'),context);
  return {get:s=>document.querySelector(s), context, calls};
}
const ok = body => ({ok:true,json:async()=>body});
const tick = () => new Promise(resolve => setImmediate(resolve));
const submit = page => page.get('#config-form').listeners.submit({preventDefault(){}});

test('live refresh keeps edits and revert restores the saved settings', async () => {
  const page=browser(async url => ok(url === '/api/config' ? {settings:defaults} : {}));
  await tick();
  assert.equal(page.get('#config-regularMinimum').value,'3');
  page.get('#config-regularMinimum').value='4';
  vm.runInContext('render({settings:{regularMinimum:1}})',page.context);
  assert.equal(page.get('#config-regularMinimum').value,'4');
  page.get('#config-revert').listeners.click();
  assert.equal(page.get('#config-regularMinimum').value,'3');
});

test('validates the rolling window and saves the consecutive rule', async () => {
  const page=browser(async (url,options) => ok(url === '/api/config' ? options.method === 'POST' ? JSON.parse(options.body) : {settings:defaults} : {}));
  await tick(); page.get('#config-regularMinimum').value='6'; await submit(page);
  assert.match(page.get('#config-status').textContent,/rolling window/);
  assert.equal(page.calls.filter(c=>c.url==='/api/config' && c.options.method==='POST').length,0);
  page.get('#config-regularMode').value='consecutive'; await submit(page);
  const saved=JSON.parse(page.calls.find(c=>c.url==='/api/config' && c.options.method==='POST').options.body).settings;
  assert.equal(saved.regularMode,'consecutive'); assert.equal(saved.regularMinimum,6);
  assert.equal(page.get('#config-status').textContent,'Settings saved.');
  page.get('#config-maybeThreshold').value='0.7'; await submit(page);
  assert.match(page.get('#config-status').textContent,/lower than/);
});

test('reports server errors without losing edits and allows retry', async () => {
  let fail=true;
  const page=browser(async (url,options) => url==='/api/config' && options.method==='POST' && fail ? {ok:false,json:async()=>({error:'Try again'})} : ok(url==='/api/config' ? options.method==='POST' ? JSON.parse(options.body) : {settings:defaults} : {}));
  await tick(); page.get('#config-regularMinimum').value='4'; await submit(page);
  assert.equal(page.get('#config-status').textContent,'Try again');
  assert.equal(page.get('#config-regularMinimum').value,'4');
  fail=false; await submit(page);
  assert.equal(page.get('#config-status').textContent,'Settings saved.');
});

test('edits made during a pending save are preserved and can be reverted', async () => {
  let release;
  const page=browser(async (url,options) => {
    if(url==='/api/config' && options.method==='POST') return await new Promise(resolve=>{release=()=>resolve(ok(JSON.parse(options.body)));});
    return ok(url==='/api/config' ? {settings:defaults} : {});
  });
  await tick(); page.get('#config-regularMinimum').value='4';
  const saving=submit(page); page.get('#config-regularMinimum').value='5'; release(); await saving;
  assert.equal(page.get('#config-regularMinimum').value,'5');
  assert.match(page.get('#config-status').textContent,/newer edits/);
  page.get('#config-revert').listeners.click();
  assert.equal(page.get('#config-regularMinimum').value,'4');
});

test('all config keys have labeled controls whose number bounds match validation', () => {
  const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
  const controls=[...html.matchAll(/<(?:input|select)\b[^>]*\bid="config-([A-Za-z]+)"[^>]*>/g)];
  assert.equal(controls.length, Object.keys(defaults).length);
  assert.deepEqual(new Set(controls.map(([,key])=>key)),new Set(Object.keys(defaults)));
  for (const [tag,key] of controls) {
    assert.match(html,new RegExp(`<label for="config-${key}">`));
    assert.match(tag,new RegExp(`aria-describedby="help-${key}"`));
    assert.match(html,new RegExp(`<small id="help-${key}">`));
    if (!tag.includes('type="number"')) continue;
    const [,min]=tag.match(/\bmin="([^"]+)"/) || [];
    const [,max]=tag.match(/\bmax="([^"]+)"/) || [];
    assert.ok(min !== undefined && max !== undefined,`${key} has bounds`);
    const atMin={...defaults,[key]:Number(min)};
    const atMax={...defaults,[key]:Number(max)};
    if (key==='regularMinimum' || key==='regularWindow') atMin.regularMode=atMax.regularMode='consecutive';
    if (key==='maybeThreshold') atMin.matchThreshold=atMax.matchThreshold=1;
    if (key==='matchThreshold') atMin.maybeThreshold=atMax.maybeThreshold=0;
    for (const candidate of [atMin,atMax]) {
      if (key==='maybeThreshold' && candidate[key]===1) continue;
      if (key==='matchThreshold' && candidate[key]===0) continue;
      assert.doesNotThrow(()=>validateSettings(candidate),`${key} accepts boundary ${candidate[key]}`);
    }
    for (const value of [Number(min)-1,Number(max)+1]) {
      assert.throws(()=>validateSettings({...defaults,[key]:value}),undefined,`${key} rejects ${value}`);
    }
  }
});

test('a changed raw value during save is not overwritten even if its number is equal', async () => {
  let release;
  const page=browser(async (url,options) => {
    if(url==='/api/config' && options.method==='POST') return await new Promise(resolve=>{release=()=>resolve(ok(JSON.parse(options.body)));});
    return ok(url==='/api/config' ? {settings:defaults} : {});
  });
  await tick(); page.get('#config-regularMinimum').value='4';
  const saving=submit(page); page.get('#config-regularMinimum').value='04'; release(); await saving;
  assert.equal(page.get('#config-regularMinimum').value,'04');
  assert.match(page.get('#config-status').textContent,/newer edits/);
});

test('an unconfirmed successful response leaves the current edits intact', async () => {
  const page=browser(async (url,options) => ok(url==='/api/config' ? options.method==='POST' ? {} : {settings:defaults} : {}));
  await tick(); page.get('#config-regularMinimum').value='4'; await submit(page);
  assert.equal(page.get('#config-regularMinimum').value,'4');
  assert.match(page.get('#config-status').textContent,/did not confirm/);
});

test('every open reminder remains accessible and current controls survive other arrivals', async () => {
  const page=browser(async url => ok(url==='/api/config' ? {settings:{...defaults,maxOpenNudges:5}} : {}));
  await tick();
  const nudges=Array.from({length:5},(_,index)=>({id:`nudge-${index+1}`,text:`Viewer ${index+1} is back`}));
  vm.runInContext(`render(${JSON.stringify({session:{id:'session-1'},nudges})})`,page.context);
  assert.equal(page.get('#nudge-list').children.length,1);
  assert.equal(page.get('#nudge-list').children[0].children[0].textContent,nudges[0].text);
  assert.equal(page.get('#nudge-position').textContent,'1 / 5 reminders');
  page.get('#nudge-next').listeners.click();
  const current=page.get('#nudge-list').children[0];
  assert.equal(current.children[0].textContent,nudges[1].text);
  const newer=[{id:'new',text:'New arrival'},...nudges];
  vm.runInContext(`render(${JSON.stringify({session:{id:'session-1'},nudges:newer})})`,page.context);
  assert.equal(page.get('#nudge-list').children[0],current);
  assert.equal(page.get('#nudge-position').textContent,'3 / 6 reminders');
  for(let i=0;i<3;i++) page.get('#nudge-next').listeners.click();
  assert.equal(page.get('#nudge-list').children[0].children[0].textContent,nudges[4].text);
  assert.equal(page.get('#nudge-next').disabled,true);
});
