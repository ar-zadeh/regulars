import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';

export const DOCK_COMMANDS = new Set(['prev_subject','next_subject','toggle_section','dismiss_message']);

// This credential grants only dock navigation actions, never dashboard access.
export class DockHotkeys {
  constructor({dataDir,now=Date.now,maxClients=4,maxPerSecond=20}={}) {
    this.tokenFile=join(dataDir,'obs-hotkey-token');
    this.token=existsSync(this.tokenFile)?readFileSync(this.tokenFile,'utf8').trim():'';
    if(!/^[a-f0-9]{64}$/.test(this.token)) this.token='';
    this.now=now;this.maxClients=maxClients;this.maxPerSecond=maxPerSecond;
    this.clients=new Set();this.sequence=0;this.recent=[];
  }
  pairing(endpoint) {
    if(!this.token){this.token=randomBytes(32).toString('hex');writeFileSync(this.tokenFile,this.token,{mode:0o600});}
    return {endpoint,token:this.token,scriptUrl:'/api/dock/script'};
  }
  authorized(header) {
    const value=typeof header==='string' && header.startsWith('Bearer ')?header.slice(7):'';
    return !!this.token && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value),Buffer.from(this.token));
  }
  attach(req,res) {
    if(this.clients.size>=this.maxClients) return false;
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Accel-Buffering':'no'});
    res.write('event: ready\ndata: {}\n\n');
    const client={res,heartbeat:null};this.clients.add(client);
    const remove=()=>{clearInterval(client.heartbeat);this.clients.delete(client);};
    client.heartbeat=setInterval(()=>{if(!res.write(': keepalive\n\n')){remove();res.end();}},15000);
    client.heartbeat.unref?.();req.once('close',remove);
    return true;
  }
  send(command) {
    if(!DOCK_COMMANDS.has(command)) return {status:400,error:'Unknown dock command.'};
    const timestamp=this.now();this.recent=this.recent.filter(time=>time>timestamp-1000);
    if(this.recent.length>=this.maxPerSecond) return {status:429,error:'Too many hotkey presses.'};
    if(!this.clients.size) return {status:409,error:'Open the Regulars dock first.'};
    this.recent.push(timestamp);
    const event={id:++this.sequence,command,timestamp};
    const packet=`event: command\ndata: ${JSON.stringify(event)}\n\n`;
    for(const client of this.clients){
      // Do not build a delayed queue of potentially destructive F9 actions.
      if(!client.res.write(packet)){clearInterval(client.heartbeat);this.clients.delete(client);client.res.end();}
    }
    return {status:200,event};
  }
  close(){for(const client of this.clients){clearInterval(client.heartbeat);client.res.end();}this.clients.clear();}
}
