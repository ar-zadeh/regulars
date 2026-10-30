import test from 'node:test';
import assert from 'node:assert/strict';
import {StickerQueue} from '../src/sticker-queue.js';
test('approved stickers trigger once with channel and viewer cooldowns',()=>{
  let now=0,callback;const sticker={id:'s',name:'mic',approved:1,image:'data:image/png;base64,aA==',source_ids:'["m"]',contributor_ids:'["v"]'};
  const app={one:query=>query.includes('stickers')?sticker:{id:'eligible'}};const queue=new StickerQueue({app,now:()=>now,setTimer:fn=>(callback=fn,1),clearTimer:()=>{}});
  assert.equal(queue.trigger('mic','viewer'),true);assert.equal(app.overlayEvent.type,'sticker');assert.equal(queue.trigger('mic','other'),false);
  now=11000;callback();assert.equal(queue.trigger('mic','other'),true);assert.equal(queue.trigger('mic','viewer'),false);queue.stop();
});
test('unapproved or removed-source stickers do not trigger',()=>{
  const app={one:query=>query.includes('stickers')?{id:'s',image:'x',source_ids:'["gone"]',contributor_ids:'["v"]'}:undefined};assert.equal(new StickerQueue({app}).trigger('mic','viewer'),false);
});

test('an opted-out viewer cannot trigger and does not consume cooldown',()=>{
  let optedOut=true;
  const sticker={id:'s',name:'mic',approved:1,image:'x',source_ids:'["m"]',contributor_ids:'["v"]'};
  const app={one:query=>query.includes('SELECT opted_out')?{opted_out:Number(optedOut)}:query.includes('stickers')?sticker:{id:'eligible'}};
  const queue=new StickerQueue({app,setTimer:()=>1});
  assert.equal(queue.trigger('mic','viewer'),false);
  optedOut=false;
  assert.equal(queue.trigger('mic','viewer'),true);
  optedOut=true;
  assert.equal(queue.trigger('mic','viewer'),false);
  assert.equal(queue.lastViewer.has('viewer'),false);
  queue.stop();
});

test('a queued sticker is rechecked after source removal, image deletion, or contributor opt-out',()=>{
  for(const invalidate of ['source','image','optout']){
    let now=0,callback,sourceRemoved=false,optedOut=false;
    const stickers=new Map([
      ['first',{id:'first',name:'first',approved:1,image:'first.png',source_ids:'["m1"]',contributor_ids:'["v"]'}],
      ['second',{id:'second',name:'second',approved:1,image:'second.png',source_ids:'["m2"]',contributor_ids:'["v"]'}],
    ]);
    const app={one:(query,value)=>{
      if(query.includes('stickers')) return query.includes('lower(name)')?[...stickers.values()].find(s=>s.name===value && s.approved):stickers.get(value);
      if(query.includes('messages') && value==='m2' && sourceRemoved) return undefined;
      if(query.includes('viewers') && value==='v' && optedOut) return undefined;
      return {id:value};
    }};
    const queue=new StickerQueue({app,now:()=>now,setTimer:fn=>(callback=fn,1)});
    assert.equal(queue.trigger('first','a'),true);
    now=10000;
    assert.equal(queue.trigger('second','b'),true);
    if(invalidate==='source') sourceRemoved=true;
    else if(invalidate==='image') stickers.get('second').image=null;
    else optedOut=true;
    queue.updateCooldowns({viewerCooldownMs:2000,channelCooldownMs:2000});
    callback();
    assert.equal(app.overlayEvent,null,invalidate);
    assert.equal(queue.queue.length,0,invalidate);
    queue.stop();
  }
});

test('external overlay takes precedence and stop removes only its own sticker',()=>{
  let now=0,callback;
  const sticker={id:'s',name:'mic',approved:1,image:'x',source_ids:'["m"]',contributor_ids:'["v"]'};
  const app={one:query=>query.includes('stickers')?sticker:{id:'eligible'}};
  const queue=new StickerQueue({app,now:()=>now,setTimer:fn=>(callback=fn,1),clearTimer:()=>{}});
  assert.equal(queue.trigger('mic','a'),true);
  now=10000;
  assert.equal(queue.trigger('mic','b'),true);
  app.overlayEvent={id:'awards',type:'awards'};
  callback();
  assert.deepEqual(app.overlayEvent,{id:'awards',type:'awards'});
  assert.equal(queue.queue.length,0);
  queue.stop();
  assert.equal(app.overlayEvent.type,'awards');
  assert.equal(queue.trigger('mic','c'),false);
});

test('stop clears its active sticker and ignores a late timer callback',()=>{
  let callback;
  const sticker={id:'s',name:'mic',approved:1,image:'x',source_ids:'["m"]',contributor_ids:'["v"]'};
  const app={one:query=>query.includes('stickers')?sticker:{id:'eligible'}};
  const queue=new StickerQueue({app,setTimer:fn=>(callback=fn,1),clearTimer:()=>{}});
  assert.equal(queue.trigger('mic','a'),true);
  queue.stop();
  assert.equal(app.overlayEvent,null);
  callback();
  assert.equal(app.overlayEvent,null);
});

test('changing cooldowns keeps the active display and applies to the next triggers',()=>{
  let now=0,callback;
  const sticker={id:'s',name:'mic',approved:1,image:'x',source_ids:'["m"]',contributor_ids:'["v"]'};
  const app={one:query=>query.includes('stickers')?sticker:{id:'eligible'}};
  const queue=new StickerQueue({app,now:()=>now,setTimer:fn=>(callback=fn,1),clearTimer:()=>{}});
  assert.equal(queue.trigger('mic','a'),true);
  const first=app.overlayEvent;
  now=1000;
  queue.updateCooldowns({viewerCooldownMs:2000,channelCooldownMs:2000});
  assert.equal(app.overlayEvent,first);
  assert.equal(queue.trigger('mic','a'),false);
  now=2000;
  assert.equal(queue.trigger('mic','a'),true);
  assert.equal(queue.queue.length,1);
  callback();
  assert.equal(app.overlayEvent.type,'sticker');
  assert.notEqual(app.overlayEvent.id,first.id);
  queue.stop();
});
