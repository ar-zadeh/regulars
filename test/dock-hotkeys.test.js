import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DockHotkeys} from '../src/dock-hotkeys.js';

function fixture(options={}){
  const dataDir=mkdtempSync(join(tmpdir(),'regulars-hotkeys-'));
  const dock=new DockHotkeys({dataDir,...options});
  return {dock,dataDir,close(){dock.close();rmSync(dataDir,{recursive:true,force:true});}};
}
function client(dock,{blocked=false}={}){
  const req=new EventEmitter(),packets=[];
  const res={writeHead(){},write(value){packets.push(value);return !blocked;},end(){this.ended=true;}};
  return {req,res,packets,attached:dock.attach(req,res)};
}

test('OBS pairing is persistent, narrow-scope, and never authorizes an empty token',()=>{
  const f=fixture();
  try{
    assert.equal(f.dock.authorized('Bearer '),false);
    const pairing=f.dock.pairing('http://127.0.0.1:3000/api/dock/hotkey');
    assert.match(pairing.token,/^[a-f0-9]{64}$/);
    assert.equal(pairing.scriptUrl,'/api/dock/script');
    assert.equal(f.dock.authorized('Bearer '+pairing.token),true);
    assert.equal(f.dock.authorized('Bearer '+'0'.repeat(64)),false);
    assert.equal(f.dock.authorized('Bearer '+'é'.repeat(64)),false);
    const reload=new DockHotkeys({dataDir:f.dataDir});
    assert.equal(reload.pairing('local').token,pairing.token);reload.close();
  }finally{f.close();}
});

test('hotkeys reject unknown commands, have bounded delivery, and do not queue stale actions',()=>{
  let now=1000;const f=fixture({now:()=>now,maxClients:1,maxPerSecond:2});
  try{
    assert.equal(f.dock.send('delete_channel').status,400);
    assert.equal(f.dock.send('dismiss_message').status,409);
    const c=client(f.dock);
    assert.equal(c.attached,true);assert.equal(client(f.dock).attached,false);
    assert.equal(c.packets.length,1); // No replay of the disconnected F9.
    const event=f.dock.send('next_subject').event;
    assert.deepEqual(event,{id:1,command:'next_subject',timestamp:1000});
    assert.match(c.packets[1],/event: command/);
    assert.equal(f.dock.send('prev_subject').status,200);
    assert.equal(f.dock.send('dismiss_message').status,429);
    now+=1001;assert.equal(f.dock.send('dismiss_message').status,200);
    c.req.emit('close');assert.equal(f.dock.clients.size,0);
    const replacement=client(f.dock);assert.equal(replacement.packets.length,1);
  }finally{f.close();}
});

test('slow dock clients are disconnected rather than accumulating delayed F9 actions',()=>{
  const f=fixture();
  try{
    const c=client(f.dock,{blocked:true});
    f.dock.send('dismiss_message');
    assert.equal(c.res.ended,true);assert.equal(f.dock.clients.size,0);
    assert.equal(f.dock.send('dismiss_message').status,409);
  }finally{f.close();}
});

test('section toggles use the same bounded dock delivery as subject navigation',()=>{
  const f=fixture();
  try{
    assert.equal(f.dock.send('toggle_section').status,409);
    const c=client(f.dock);
    const result=f.dock.send('toggle_section');
    assert.equal(result.status,200);
    assert.equal(result.event.command,'toggle_section');
    assert.equal(JSON.parse(c.packets[1].split('data: ')[1]).command,'toggle_section');
  }finally{f.close();}
});
