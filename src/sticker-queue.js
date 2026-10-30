import {randomUUID} from 'node:crypto';

export class StickerQueue {
  constructor({app,now=()=>Date.now(),setTimer=setTimeout,clearTimer=clearTimeout,durationMs=6000,viewerCooldownMs=60000,channelCooldownMs=10000,maxQueue=3}={}) {
    Object.assign(this,{app,now,setTimer,clearTimer,durationMs,viewerCooldownMs,channelCooldownMs,maxQueue});
    this.lastChannel=-Infinity;
    this.lastViewer=new Map();
    this.queue=[];
    this.timer=null;
    this.activeEventId=null;
    this.stopped=false;
  }

  updateCooldowns({viewerCooldownMs = this.viewerCooldownMs, channelCooldownMs = this.channelCooldownMs} = {}) {
    this.viewerCooldownMs = viewerCooldownMs;
    this.channelCooldownMs = channelCooldownMs;
  }

  trigger(name,viewerId){
    if(this.stopped || typeof name!=='string' || !name.trim() || !viewerId) return false;
    const now=this.now();
    for(const [id,last] of this.lastViewer) if(now-last>=this.viewerCooldownMs) this.lastViewer.delete(id);
    if(this.app.one('SELECT opted_out FROM viewers WHERE id=?',viewerId)?.opted_out){
      this.lastViewer.delete(viewerId);
      return false;
    }
    if(now-this.lastChannel<this.channelCooldownMs || now-(this.lastViewer.get(viewerId) ?? -Infinity)<this.viewerCooldownMs || this.queue.length>=this.maxQueue) return false;
    // Other overlay events take precedence; don't retain a sticker to play after one.
    if(this.app.overlayEvent && this.app.overlayEvent.id!==this.activeEventId) return false;
    const sticker=this.app.one('SELECT * FROM stickers WHERE lower(name)=lower(?) AND approved=1',name.trim());
    if(!sticker || !sticker.image || !this.eligible(sticker)) return false;
    this.lastChannel=now;
    this.lastViewer.set(viewerId,now);
    this.queue.push(sticker.id);
    this.showNext();
    return true;
  }

  eligible(sticker){
    let ids,contributors;
    try {
      ids=JSON.parse(sticker.source_ids);
      contributors=JSON.parse(sticker.contributor_ids);
    } catch {return false;}
    return Array.isArray(ids) && ids.length>0 && ids.every(id=>typeof id==='string' && this.app.one("SELECT id FROM messages WHERE id=? AND moderation='cleared' AND text IS NOT NULL",id)) &&
      Array.isArray(contributors) && contributors.length>0 && contributors.every(id=>typeof id==='string' && this.app.one('SELECT id FROM viewers WHERE id=? AND opted_out=0',id));
  }

  showNext(){
    if(this.stopped || this.timer || !this.queue.length) return;
    if(this.app.overlayEvent){
      this.queue=[];
      return;
    }
    while(this.queue.length){
      const sticker=this.app.one('SELECT * FROM stickers WHERE id=? AND approved=1',this.queue.shift());
      if(!sticker || !sticker.image || !this.eligible(sticker)) continue;
      const event={id:randomUUID(),type:'sticker',name:sticker.name,imageUrl:sticker.image,durationMs:this.durationMs};
      this.activeEventId=event.id;
      this.app.overlayEvent=event;
      this.timer=this.setTimer(()=>{
        if(this.stopped || this.activeEventId!==event.id) return;
        this.timer=null;
        this.activeEventId=null;
        if(this.app.overlayEvent?.id===event.id) this.app.overlayEvent=null;
        this.showNext();
      },this.durationMs);
      this.timer.unref?.();
      return;
    }
  }

  stop(){
    this.stopped=true;
    if(this.timer) this.clearTimer(this.timer);
    if(this.app.overlayEvent?.id===this.activeEventId) this.app.overlayEvent=null;
    this.timer=null;
    this.activeEventId=null;
    this.queue=[];
    this.lastViewer.clear();
  }
}
