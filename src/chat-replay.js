import {validateRecording} from './chat-recording.js';

const SPEEDS=[0.25,0.5,1,2,4,8,16];
const RUNNING=new Set(['playing','processing']);

export class ChatReplay {
  constructor({app,recording,now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout}){
    this.app=app;this.recording=validateRecording(recording);
    Object.assign(this,{now,setTimer,clearTimer});
    this.startTime=Date.parse(recording.startedAt);
    this.status='ready';this.speed=1;this.offset=0;this.anchor=now();this.next=0;
    this.timer=null;this.tasks=new Set();this.generation=0;this.backgroundBusy=false;
    this.lastOrganizer=-10000;this.lastSummary=-Infinity;this.lastLabels=-Infinity;this.error='';this.resetting=null;this.closed=false;
    app.now=()=>this.startTime+this.elapsed();
  }
  elapsed(){return this.offset+(RUNNING.has(this.status)?Math.max(0,this.now()-this.anchor)*this.speed:0);}
  freeze(){this.offset=this.elapsed();this.anchor=this.now();}
  cancelTimer(){if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;}
  async play(){
    if(this.closed) throw new Error('Replay is closed.');
    if(this.resetting) await this.resetting;
    if(this.status==='completed') await this.reset();
    if(RUNNING.has(this.status)) return;
    if(!this.app.currentSession()) this.app.startSession(this.recording.sourceSession?.start || this.recording.startedAt);
    this.anchor=this.now();this.status=this.next<this.recording.messages.length?'playing':'processing';
    this.tick();
  }
  pause(){
    if(!RUNNING.has(this.status)) return;
    this.freeze();this.status='paused';this.cancelTimer();
  }
  setSpeed(speed){
    if(!SPEEDS.includes(speed)) throw new Error('Choose a replay speed from 0.25× to 16×.');
    this.freeze();this.speed=speed;
    if(RUNNING.has(this.status)) this.tick();
  }
  track(work,message){
    const generation=this.generation;
    const task=Promise.resolve(work).catch(()=>{if(generation===this.generation)this.error=message;})
      .finally(()=>this.tasks.delete(task));
    this.tasks.add(task);return task;
  }
  tick(){
    this.cancelTimer();
    if(this.closed || !RUNNING.has(this.status)) return;
    const elapsed=this.elapsed(),messages=this.recording.messages;
    // Schedule from absolute offsets, never from completion of the previous AI
    // request. Slow classifications must not stretch the recorded message gaps.
    while(this.next<messages.length && messages[this.next].offsetMs<=elapsed){
      const message=messages[this.next++];
      const {id,viewerId,name,login,text,timestamp,parentId,bot,moderator,vip,reaction}=message;
      this.track(this.app.ingest({id,eventId:`replay:${id}`,viewerId,name,login,text,timestamp,parentId,bot,moderator,vip,reaction}),
        'A recorded message could not be processed.');
    }
    this.background(elapsed);
    if(this.next===messages.length){
      this.status='processing';
      // Drain eligible label batches and allow the normal discovery pass and
      // durable classification retry after the last arrival on the same clock.
      const retry=this.app.one("SELECT 1 FROM messages WHERE moderation='held' AND job_status='failed' AND retry_count=1 AND retry_at IS NOT NULL LIMIT 1");
      if(elapsed>=this.recording.durationMs+10000 && !this.tasks.size && !this.app.pending.size && !retry && !this.app.labelTargets(1).length){
        this.freeze();this.status='completed';return;
      }
    }
    const nextOffset=messages[this.next]?.offsetMs ?? Infinity;
    this.timer=this.setTimer(()=>{this.timer=null;this.tick();},Math.max(1,Math.min(250,(nextOffset-this.elapsed())/this.speed)));
    this.timer?.unref?.();
  }
  background(elapsed){
    if(!this.app.labelling && elapsed-this.lastLabels>=10000){
      this.lastLabels=elapsed;
      this.track(this.app.labelMessages(),'Message labelling failed. Check the AI configuration.');
    }
    if(this.backgroundBusy) return;
    const organizerDue=elapsed-this.lastOrganizer>=10000;
    const summaryDue=elapsed-this.lastSummary>=this.app.config.summaryIntervalSeconds*1000;
    if(!organizerDue && !summaryDue) return;
    if(organizerDue)this.lastOrganizer=elapsed;
    if(summaryDue)this.lastSummary=elapsed;
    const generation=this.generation;
    this.backgroundBusy=true;
    this.track((async()=>{
      if(organizerDue){
        this.app.retryHeld();
        try{await this.app.discover();}catch{if(generation===this.generation)this.error='Topic discovery failed. Check the AI configuration.';}
      }
      if(generation!==this.generation || this.closed) return;
      if(summaryDue){try{await this.app.refreshSummary();}catch{if(generation===this.generation)this.error='The chat summary could not be updated.';}}
    })().finally(()=>{this.backgroundBusy=false;}),'Replay background processing failed.');
  }
  async reset(){
    if(this.resetting)return this.resetting;
    this.resetting=this.clearRun();
    try{await this.resetting;}finally{this.resetting=null;}
  }
  async clearRun(){
    this.pause();this.status='resetting';this.generation++;
    this.app.run('UPDATE sessions SET end=? WHERE end IS NULL',new Date(this.app.now()).toISOString());
    this.app.revision++;this.app.abortClassifications();
    await Promise.allSettled([...this.tasks,...this.app.pending]);
    this.app.db.exec(`DELETE FROM awards;DELETE FROM stickers;DELETE FROM nudges;DELETE FROM first_messages;
      DELETE FROM moderation_actions;DELETE FROM messages;DELETE FROM subjects;DELETE FROM viewers;
      DELETE FROM events;DELETE FROM sessions;`);
    this.app.summary='';this.app.overlayEvent=null;this.app.presentIds=null;
    this.next=0;this.offset=0;this.anchor=this.now();this.lastOrganizer=-10000;this.lastSummary=-Infinity;this.lastLabels=-Infinity;
    this.error='';this.status='ready';
  }
  results(){
    const rows=new Map(this.app.all('SELECT m.id,m.category,m.about,m.label_attempts AS labelAttempts,m.moderation,m.organizer,s.name AS topic FROM messages m LEFT JOIN subjects s ON s.id=m.subject_id').map(m=>[m.id,m]));
    return {recording:this.recording.name,status:this.status,speed:this.speed,settings:this.app.config,
      messages:this.recording.messages.map(m=>({id:m.id,name:m.name,text:m.text,timestamp:m.timestamp,
        receivedAt:m.receivedAt,offsetMs:m.offsetMs,delayMs:m.delayMs,recordedCategory:m.category ?? m.previousResult?.category ?? null,previousResult:m.previousResult || null,
        result:rows.get(m.id) || null}))};
  }
  state(){
    const elapsed=this.elapsed();
    const recent=this.recording.messages.slice(Math.max(0,this.next-12),this.next).reverse().map(m=>{
      const row=this.app.one('SELECT m.category,m.about,m.moderation,s.name AS topic FROM messages m LEFT JOIN subjects s ON s.id=m.subject_id WHERE m.id=?',m.id);
      return {id:m.id,name:m.name,text:m.text,offsetMs:m.offsetMs,delayMs:m.delayMs,originalTopic:m.previousResult?.topic || null,originalAbout:m.previousResult?.about ?? null,originalCategory:m.category ?? m.previousResult?.category ?? null,...row};
    });
    return {name:this.recording.name,status:this.status,speed:this.speed,elapsedMs:Math.min(elapsed,this.recording.durationMs),
      durationMs:this.recording.durationMs,sent:this.next,total:this.recording.messages.length,
      nextInMs:this.next<this.recording.messages.length?Math.max(0,this.recording.messages[this.next].offsetMs-elapsed):null,
      originalTime:new Date(this.startTime+Math.min(elapsed,this.recording.durationMs)).toISOString(),
      held:this.app.one("SELECT COUNT(*) AS n FROM messages WHERE moderation='held'").n,error:this.error,recent};
  }
  async close(){
    this.pause();this.closed=true;this.generation++;
    this.app.run('UPDATE sessions SET end=? WHERE end IS NULL',new Date(this.app.now()).toISOString());
    this.app.revision++;this.app.abortClassifications();
    await Promise.allSettled([...this.tasks,...this.app.pending]);
  }
}
