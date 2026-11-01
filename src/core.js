import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { computeLoyalty } from './loyalty.js';
import { createSanitizer, isGenericSubjectName } from './ai.js';
import { DEFAULT_SETTINGS, validateSettings } from './config.js';
import { isEmojiOnly } from './emoji.js';
const reactions = new Set(['lol','lmao','gg','w','pog','poggers','haha','kekw']);
const ms = value => new Date(value).getTime();
const nudgePriority = {arrival:1,message:2,return:3,question:4};
const nonEnglishMaybeThreshold = 0.3;
const subjectWindowMs = 300000;
const subjectKey = name => name.trim().replace(/\s+/g,' ').toLocaleLowerCase();
const conversationEvidence = rows => rows.length>=3 && (new Set(rows.map(m=>m.viewer_id)).size>=2 || new Set(rows.map(m=>repeatKey(m.text))).size>=3);
const chooseSubject = (scores,threshold,parentId) => {
  const high=scores.filter(s=>s.score>=threshold).sort((a,b)=>b.score-a.score);
  // Independent relevance questions can both pass. Require a clear lead;
  // otherwise only an explicit reply can resolve the tie.
  if(high.length===1 || (high.length>1 && high[0].score-high[1].score>=0.1))return high[0];
  return high.find(s=>s.id===parentId);
};
export function repeatKey(text, parent = '') {
  const clean = String(text).toLowerCase().replace(/[\u034f\u00ad\u200b-\u200d\u2060\ufeff]|[\u{e0000}-\u{e007f}]/gu, '').trim().replace(/\s+/g,' ');
  const words = clean.split(' ');
  return `${parent}\0${words.every(w => w === words[0]) ? words[0] : clean}`;
}
export function isReaction(text) { return isEmojiOnly(text) || String(text).toLowerCase().trim().split(/\s+/).every(w => reactions.has(w)); }
const isTopicMessage = m => m.organizer!=='reaction' && !m.bot && !m.addresses_ai && !m.text.startsWith('!') && !isEmojiOnly(m.text);
const isRepetitionOnly = text => {const words=String(text).toLowerCase().trim().split(/\s+/);return words.length>1 && words.every(word=>word===words[0]);};
export function discussions(messages, excluded = new Set(), {gapSeconds=60,minContributors=3}={}) {
  const groups = new Map();
  for (const m of messages.filter(m => m.subject_id && !excluded.has(m.subject_id)).sort((a,b) => ms(a.timestamp)-ms(b.timestamp))) {
    const group = groups.get(m.subject_id) || []; let d = group.at(-1);
    if (!d || ms(m.timestamp)-d.end > gapSeconds*1000) { d={subjectId:m.subject_id,start:ms(m.timestamp),end:ms(m.timestamp),contributors:[],evidence:[]}; group.push(d); groups.set(m.subject_id,group); }
    d.end=ms(m.timestamp); d.evidence.push(m.id); if (!d.contributors.includes(m.viewer_id)) d.contributors.push(m.viewer_id);
  }
  return [...groups.values()].flat().filter(d => d.contributors.length >= minContributors).sort((a,b) => (b.end-b.start)-(a.end-a.start) || b.contributors.length-a.contributors.length || a.start-b.start);
}
export function regularCount(seen,sessionIndex,settings=DEFAULT_SETTINGS){
  const unique=new Set(seen.filter(index=>Number.isInteger(index) && index<=sessionIndex));
  if(settings.regularMode==='consecutive'){
    let count=0;while(unique.has(sessionIndex-count)) count++;return count;
  }
  return [...unique].filter(index=>index>=sessionIndex-settings.regularWindow+1).length;
}
export class Regulars {
  constructor({ dbPath=':memory:', ai, deleteMessage=null, broadcasterId='broadcaster', now=()=>Date.now(),timeZone='UTC',dayOneDate=undefined,getFollower=null,transientModerationTimeout=2000,config=DEFAULT_SETTINGS }={}) {
    this.db=new DatabaseSync(dbPath); this.ai=ai; this.deleteMessage=deleteMessage || (async()=>{});this.deleteMessageAvailable=!!deleteMessage;this.onPrivacyChange=()=>{}; this.broadcasterId=broadcasterId; this.now=now; this.pending=new Set(); this.naming=null; this.summary=''; this.overlayEvent=null; this.revision=0; this.wrapTask=null; this.transientDeletes=new Set();this.classificationControllers=new Map();this.modelControllers=new Set();this.summaryGeneration=0;this.summaryInFlightKey='';
    this.config=Object.freeze(validateSettings(config));
    this.timeZone=timeZone;this.dayOneDate=dayOneDate || undefined;this.getFollower=getFollower;this.transientModerationTimeout=transientModerationTimeout;this.followDates={};this.followerChecks=new Map();this.presentIds=null;this.intentionalLurkers=new Set();this.knownIdentities=new Map();this.lastNamingAt=-Infinity;this.lastNamedMessageIds=new Set();this.lastSummaryKey='';
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY,idx INTEGER NOT NULL,start TEXT NOT NULL,end TEXT,cutoff TEXT,wrapped INTEGER DEFAULT 0,incomplete INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS viewers (id TEXT PRIMARY KEY,name TEXT NOT NULL,login TEXT,seen TEXT NOT NULL DEFAULT '[]',total INTEGER NOT NULL DEFAULT 0,last_seen INTEGER,muted INTEGER DEFAULT 0,opted_out INTEGER DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY,session_id TEXT NOT NULL,viewer_id TEXT NOT NULL,name TEXT NOT NULL,login TEXT,timestamp TEXT NOT NULL,received_at TEXT,text TEXT,parent_id TEXT,moderation TEXT NOT NULL,organizer TEXT NOT NULL,category TEXT,subject_id TEXT,bot INTEGER DEFAULT 0,moderator INTEGER DEFAULT 0,vip INTEGER DEFAULT 0,addresses_ai INTEGER DEFAULT 0,FOREIGN KEY(session_id) REFERENCES sessions(id));
      CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY,name TEXT NOT NULL,definition TEXT NOT NULL,action TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS subjects (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,excluded INTEGER DEFAULT 0,last_active TEXT);
      CREATE TABLE IF NOT EXISTS nudges (id TEXT PRIMARY KEY,viewer_id TEXT NOT NULL,message_id TEXT,text TEXT NOT NULL,created TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open');
      CREATE TABLE IF NOT EXISTS first_messages (session_id TEXT NOT NULL,viewer_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(session_id,viewer_id));
      CREATE TABLE IF NOT EXISTS stickers (id TEXT PRIMARY KEY,name TEXT NOT NULL,subject TEXT NOT NULL,brief TEXT NOT NULL,image TEXT,approved INTEGER NOT NULL DEFAULT 0,source_ids TEXT NOT NULL,contributor_ids TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS awards (session_id TEXT NOT NULL,title TEXT NOT NULL,viewer_id TEXT NOT NULL,evidence TEXT NOT NULL,active INTEGER DEFAULT 1,PRIMARY KEY(session_id,title,viewer_id));`);
    this.db.exec("CREATE TABLE IF NOT EXISTS moderation_actions (message_id TEXT PRIMARY KEY,sender_id TEXT NOT NULL,status TEXT NOT NULL,retry_count INTEGER NOT NULL DEFAULT 0,retry_at TEXT)");
    this.run("UPDATE moderation_actions SET status='failed',retry_count=CASE WHEN retry_count=0 THEN 1 ELSE retry_count END,retry_at=CASE WHEN retry_count<2 THEN ? ELSE NULL END WHERE status='queued'",new Date(this.now()+30000).toISOString());
    const sessionColumns=this.all('PRAGMA table_info(sessions)').map(c=>c.name);
    if(!sessionColumns.includes('cutoff_rowid')) this.db.exec('ALTER TABLE sessions ADD COLUMN cutoff_rowid INTEGER');
    if(!sessionColumns.includes('nudges_paused')) this.db.exec('ALTER TABLE sessions ADD COLUMN nudges_paused INTEGER DEFAULT 0');
    if(!sessionColumns.includes('last_nudge_at')) this.db.exec('ALTER TABLE sessions ADD COLUMN last_nudge_at TEXT');
    if(!this.all('PRAGMA table_info(messages)').some(c=>c.name==='received_at')) this.db.exec('ALTER TABLE messages ADD COLUMN received_at TEXT');
    const messageColumns=this.all('PRAGMA table_info(messages)').map(c=>c.name);
    if(!messageColumns.includes('about')) this.db.exec('ALTER TABLE messages ADD COLUMN about TEXT');
    if(!messageColumns.includes('job_status')) this.db.exec('ALTER TABLE messages ADD COLUMN job_status TEXT');
    if(!messageColumns.includes('retry_at')) this.db.exec('ALTER TABLE messages ADD COLUMN retry_at TEXT');
    if(!messageColumns.includes('retry_count')) this.db.exec('ALTER TABLE messages ADD COLUMN retry_count INTEGER DEFAULT 0');
    this.run("UPDATE messages SET job_status='failed',retry_count=CASE WHEN COALESCE(retry_count,0)=0 THEN 1 ELSE retry_count END,retry_at=CASE WHEN COALESCE(retry_count,0)<2 THEN ? ELSE NULL END WHERE moderation='held' AND text IS NOT NULL AND (job_status IS NULL OR job_status='queued')",new Date(this.now()+30000).toISOString());
    if(!this.all('PRAGMA table_info(messages)').some(c=>c.name==='login')) this.db.exec('ALTER TABLE messages ADD COLUMN login TEXT');
    if(!this.all('PRAGMA table_info(viewers)').some(c=>c.name==='login')) this.db.exec('ALTER TABLE viewers ADD COLUMN login TEXT');
    const awardColumns=this.all('PRAGMA table_info(awards)').map(c=>c.name);
    if(!awardColumns.includes('subject')) this.db.exec('ALTER TABLE awards ADD COLUMN subject TEXT');
    if(!awardColumns.includes('duration_ms')) this.db.exec('ALTER TABLE awards ADD COLUMN duration_ms INTEGER');
    if(!awardColumns.includes('recipient_order')) this.db.exec('ALTER TABLE awards ADD COLUMN recipient_order INTEGER');
    if(!this.all('PRAGMA table_info(messages)').some(c=>c.name==='vip')) this.db.exec('ALTER TABLE messages ADD COLUMN vip INTEGER DEFAULT 0');
    const nudgeColumns=this.all('PRAGMA table_info(nudges)').map(c=>c.name);
    if(!nudgeColumns.includes('session_id')) this.db.exec('ALTER TABLE nudges ADD COLUMN session_id TEXT');
    if(!nudgeColumns.includes('priority')) this.db.exec('ALTER TABLE nudges ADD COLUMN priority INTEGER DEFAULT 1');
    if(!nudgeColumns.includes('expires_at')) this.db.exec('ALTER TABLE nudges ADD COLUMN expires_at TEXT');
    this.run("UPDATE nudges SET expires_at=strftime('%Y-%m-%dT%H:%M:%fZ',created,CASE WHEN message_id IS NULL THEN '+10 minutes' ELSE '+3 minutes' END) WHERE expires_at IS NULL");
  }
  close(){this.db.close();} one(sql,...args){return this.db.prepare(sql).get(...args);} all(sql,...args){return this.db.prepare(sql).all(...args);} run(sql,...args){return this.db.prepare(sql).run(...args);}
  setConfig(settings){
    const next=Object.freeze(validateSettings(settings));const previous=this.config;
    this.config=next;
    if(previous && (previous.matchThreshold!==next.matchThreshold || previous.maybeThreshold!==next.maybeThreshold)){
      this.revision++;this.abortClassifications();this.lastSummaryKey='';this.lastNamedMessageIds.clear();this.lastNamingAt=-Infinity;
    }
    if(previous && next.maxOpenNudges<previous.maxOpenNudges){
      const session=this.currentSession();
      if(session){
        const overflow=this.all("SELECT id FROM nudges WHERE session_id=? AND status='open' ORDER BY priority DESC,created,id LIMIT -1 OFFSET ?",session.id,next.maxOpenNudges);
        for(const {id} of overflow) this.run("UPDATE nudges SET status='waiting' WHERE id=? AND status='open'",id);
      }
    }
    return next;
  }
  currentSession(){return this.one('SELECT * FROM sessions WHERE end IS NULL ORDER BY idx DESC LIMIT 1');}
  startSession(timestamp=new Date(this.now()).toISOString()){
    if(this.currentSession()) return this.currentSession();
    this.revision++;this.abortClassifications();this.naming=null;this.lastNamingAt=-Infinity;this.lastNamedMessageIds.clear();
    this.followDates={};this.followerChecks.clear();this.presentIds=null;this.intentionalLurkers.clear();this.knownIdentities.clear();this.summary='';this.lastSummaryKey='';this.overlayEvent=null;
    const idx=(this.one('SELECT MAX(idx) AS n FROM sessions').n || 0)+1;
    this.run('INSERT INTO sessions (id,idx,start) VALUES (?,?,?)',randomUUID(),idx,timestamp); return this.currentSession();
  }
  sight(viewer,session=this.currentSession(),{nudge=true}={}){
    if(!session || !viewer.id || viewer.id===this.broadcasterId || viewer.bot) return;
    const old=this.one('SELECT * FROM viewers WHERE id=?',viewer.id); if(old?.opted_out) return;
    if(!old) this.run('INSERT INTO viewers (id,name,login) VALUES (?,?,?)',viewer.id,viewer.name || viewer.id,viewer.login || null);
    else this.run('UPDATE viewers SET name=?,login=COALESCE(?,login) WHERE id=?',viewer.name || old.name,viewer.login || null,viewer.id);
    const record=old || this.one('SELECT * FROM viewers WHERE id=?',viewer.id), seen=JSON.parse(record.seen); if(seen.includes(session.idx)) return;
    const missed=record.last_seen==null ? 0 : session.idx-record.last_seen-1;
    const historyLimit=Math.max(5,this.config.regularWindow,this.config.regularMinimum),recent=seen.filter(n=>n>=session.idx-historyLimit+1);recent.push(session.idx);
    const count=regularCount(recent,session.idx,this.config);
    this.run('UPDATE viewers SET name=?,seen=?,total=total+1,last_seen=? WHERE id=?',viewer.name || viewer.id,JSON.stringify(recent),session.idx,viewer.id);
    if(nudge && !record.muted && record.total>=this.config.returnMinPrevious && missed>=this.config.returnMissedSessions) this.addNudge(viewer.id,null,`${viewer.name || viewer.id} is back after missing ${missed} streams.`,{kind:'return'});
    else if(nudge && !record.muted && count>=this.config.regularMinimum){
      const starter=this.starterFor(viewer.id,session.idx);
      const attendance=this.config.regularMode==='consecutive' ? `${count} consecutive streams` : `${count} of the last ${this.config.regularWindow} streams`;
      this.addNudge(viewer.id,null,`${viewer.name || viewer.id} is here (${attendance}).${starter?` Topic to bring up: ${starter}.`:''}`);
    }
  }
  starterFor(viewerId,sessionIndex){
    return this.one("SELECT s.name FROM messages m JOIN sessions se ON se.id=m.session_id JOIN subjects s ON s.id=m.subject_id WHERE m.viewer_id=? AND se.idx>=? AND se.idx<? AND m.moderation='cleared' AND s.excluded=0 GROUP BY s.id HAVING COUNT(DISTINCT se.id)>=2 ORDER BY COUNT(DISTINCT se.id) DESC,s.name LIMIT 1",viewerId,sessionIndex-5,sessionIndex)?.name || '';
  }
  updatePresence(viewers){
    const session=this.currentSession();if(!session) return;
    const firstPoll=this.presentIds===null,present=new Set();
    for(const viewer of viewers){
      const id=typeof viewer==='string'?viewer:viewer?.id;
      if(!id || this.one('SELECT opted_out FROM viewers WHERE id=?',id)?.opted_out) continue;
      if(typeof viewer!=='string') this.knownIdentities.set(id,{id,name:viewer.name,login:viewer.login});
      if(id===this.broadcasterId || viewer?.bot) continue;
      present.add(id);
      this.sight(typeof viewer==='string'?{id,name:id}:viewer,session,{nudge:!firstPoll});
    }
    this.presentIds=present;
  }
  addNudge(viewerId,messageId,text,{kind=messageId?'message':'arrival'}={}){
    const session=this.currentSession();if(!session || session.nudges_paused) return;
    const viewer=this.one('SELECT muted,opted_out FROM viewers WHERE id=?',viewerId);
    if(!viewerId || this.intentionalLurkers.has(viewerId) || viewer?.muted || viewer?.opted_out) return;
    const lurked=this.all("SELECT text FROM messages WHERE session_id=? AND viewer_id=? AND moderation='cleared' AND text LIKE '!lurk%'",session.id,viewerId).some(message=>/^!lurk\s*$/i.test(message.text));
    if(lurked){this.intentionalLurkers.add(viewerId);return;}
    const priority=nudgePriority[kind] || nudgePriority.arrival,now=this.now(),created=new Date(now).toISOString(),expires=new Date(now+1000*(messageId?this.config.messageNudgeExpirySeconds:this.config.arrivalNudgeExpirySeconds)).toISOString();
    const existing=this.one('SELECT * FROM nudges WHERE viewer_id=? AND session_id=?',viewerId,session.id);
    if(existing){
      if(!['open','waiting'].includes(existing.status) || (existing.expires_at && ms(existing.expires_at)<=now)) return;
      const updatedText=messageId && !existing.message_id ? `${existing.text} ${text}` : text;
      this.run('UPDATE nudges SET message_id=?,text=?,priority=?,expires_at=? WHERE id=?',messageId,updatedText,Math.max(existing.priority || 0,priority),expires,existing.id);
    } else {
      this.run("INSERT INTO nudges (id,viewer_id,message_id,text,created,session_id,status,priority,expires_at) VALUES (?,?,?,?,?,?,'waiting',?,?)",randomUUID(),viewerId,messageId,text,created,session.id,priority,expires);
    }
    this.pumpNudges();
  }
  pumpNudges(){
    const session=this.currentSession();if(!session) return;
    const now=this.now(),timestamp=new Date(now).toISOString();
    this.run("UPDATE nudges SET status='expired' WHERE session_id=? AND status IN ('open','waiting') AND expires_at IS NOT NULL AND expires_at<=?",session.id,timestamp);
    if(session.nudges_paused || this.one("SELECT COUNT(*) AS n FROM nudges WHERE session_id=? AND status='open'",session.id).n>=this.config.maxOpenNudges) return;
    if(session.last_nudge_at && now-ms(session.last_nudge_at)<this.config.nudgeCooldownSeconds*1000) return;
    const next=this.one("SELECT id FROM nudges WHERE session_id=? AND status='waiting' ORDER BY priority DESC,created,id LIMIT 1",session.id);if(!next) return;
    this.run("UPDATE nudges SET status='open' WHERE id=? AND status='waiting'",next.id);
    this.run('UPDATE sessions SET last_nudge_at=? WHERE id=?',timestamp,session.id);
  }
  pauseNudges(paused=true){
    const session=this.currentSession();if(!session) return;
    this.run('UPDATE sessions SET nudges_paused=? WHERE id=?',paused?1:0,session.id);
    if(paused) this.run("UPDATE nudges SET status='dismissed' WHERE session_id=? AND status IN ('open','waiting')",session.id);
  }
  addRule({name,definition=name,action}){
    if(!name?.trim() || !['hide','delete'].includes(action)) throw new Error('Provide a topic and a valid action.');
    const id=randomUUID(); this.run('INSERT INTO rules (id,name,definition,action) VALUES (?,?,?,?)',id,name.trim().slice(0,100),definition.trim().slice(0,500),action); return id;
  }
  forget(viewerId){
    if(!viewerId) throw new Error('A viewer ID is required.');
    this.revision++;this.abortClassifications(); this.summary='';this.lastSummaryKey='';
    delete this.followDates[viewerId]; this.followerChecks.delete(viewerId); this.presentIds?.delete(viewerId);this.intentionalLurkers.delete(viewerId);this.knownIdentities.delete(viewerId);
    if(!this.one('SELECT id FROM viewers WHERE id=?',viewerId)) this.run('INSERT INTO viewers (id,name,opted_out) VALUES (?,?,1)',viewerId,'');
    else this.run("UPDATE viewers SET name='',login=NULL,seen='[]',total=0,last_seen=NULL,muted=0,opted_out=1 WHERE id=?",viewerId);
    const ids=this.all('SELECT id FROM messages WHERE viewer_id=?',viewerId).map(m=>m.id); for(const id of ids) this.removeMessage(id);
    this.run('DELETE FROM messages WHERE viewer_id=?',viewerId); this.run('DELETE FROM nudges WHERE viewer_id=?',viewerId); this.run('DELETE FROM first_messages WHERE viewer_id=?',viewerId); this.run('UPDATE awards SET active=0 WHERE viewer_id=?',viewerId);
    for(const s of this.all('SELECT * FROM stickers')) if(JSON.parse(s.source_ids).some(id=>ids.includes(id)) || JSON.parse(s.contributor_ids).includes(viewerId)) this.run('DELETE FROM stickers WHERE id=?',s.id);
    this.overlayEvent=null;
  }
  removeMessage(id){
    if(!id) return;
    this.revision++;this.abortClassifications(); this.summary='';this.lastSummaryKey='';
    this.run("UPDATE messages SET text=NULL,about=NULL,moderation='removed',subject_id=NULL WHERE id=?",id); this.run('DELETE FROM nudges WHERE message_id=?',id);
    this.run("UPDATE moderation_actions SET status='done',retry_at=NULL WHERE message_id=?",id);
    for(const a of this.all('SELECT * FROM awards WHERE active=1')) if(JSON.parse(a.evidence).includes(id)) this.run('UPDATE awards SET active=0 WHERE session_id=? AND title=? AND viewer_id=?',a.session_id,a.title,a.viewer_id);
    for(const s of this.all('SELECT * FROM stickers')) if(JSON.parse(s.source_ids).includes(id)) this.run('UPDATE stickers SET approved=0 WHERE id=?',s.id);
    this.overlayEvent=null;
  }
  async ingest(event){
    const session=this.currentSession(); if(!session || !event.id || !event.viewerId || typeof event.text!=='string') return;
    if(event.eventId){if(this.one('SELECT id FROM events WHERE id=?',event.eventId)) return; this.run('INSERT INTO events (id) VALUES (?)',event.eventId);}
    if(this.one('SELECT id FROM messages WHERE id=?',event.id)) return;
    const text=event.text.slice(0,5000);
    if(/^!regulars\s+forget\s*$/i.test(text)){this.forget(event.viewerId); return;}
    const rules=this.all('SELECT * FROM rules');
    if(this.one('SELECT opted_out FROM viewers WHERE id=?',event.viewerId)?.opted_out){
      const controller=new AbortController();this.modelControllers.add(controller);let timer;
      try {
        const result=await Promise.race([this.ai.classify({text,blockedTopics:rules,subjects:[],identities:[...this.identities(),{id:event.viewerId,name:event.name,login:event.login}],organize:false,signal:controller.signal}),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Moderation timeout'));},this.transientModerationTimeout);})]);
        if(!controller.signal.aborted && !(result.nonEnglish>=nonEnglishMaybeThreshold) && (result.topics || []).some(s=>s.score>=this.config.matchThreshold && rules.some(r=>r.id===s.id && r.action==='delete'))){
          const messageId=event.id,senderId=event.viewerId,isModerator=!!event.moderator;
          const task=this.guardedDelete(messageId,senderId,isModerator);this.pending.add(task);task.finally(()=>this.pending.delete(task)).catch(()=>{});
        }
      } catch {} finally {clearTimeout(timer);controller.abort();this.modelControllers.delete(controller);}
      return;
    }
    const command=text.startsWith('!'), reaction=isReaction(text) || !!event.reaction;
    const bot=!!event.bot || event.viewerId===this.broadcasterId || !!event.shared;
    this.knownIdentities.set(event.viewerId,{id:event.viewerId,name:event.name,login:event.login});
    this.sight({id:event.viewerId,name:event.name,login:event.login,bot},session);
    const timestamp=event.timestamp || new Date(this.now()).toISOString(); if(!Number.isFinite(ms(timestamp))) throw new Error('Invalid message timestamp.');
    this.run('INSERT INTO messages (id,session_id,viewer_id,name,login,timestamp,received_at,text,parent_id,moderation,organizer,bot,moderator,vip) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',event.id,session.id,event.viewerId,event.name || event.viewerId,event.login || null,timestamp,new Date(this.now()).toISOString(),text,event.parentId || null,'held',command || reaction || bot ? 'reaction' : 'new',bot?1:0,event.moderator?1:0,event.vip?1:0);
    const task=this.processMessage(event.id,rules); this.pending.add(task); try{await task;}finally{this.pending.delete(task);}
  }
  async processMessage(id,rules,attempt=0){
    const m=this.one('SELECT rowid,* FROM messages WHERE id=?',id); if(!m || !m.text) return;
    const revision=this.revision;
    const subjects=m.organizer==='reaction' ? [] : this.all('SELECT * FROM subjects ORDER BY last_active DESC LIMIT 30').map(subject=>({...subject,recent:this.all("SELECT text FROM messages WHERE subject_id=? AND moderation='cleared' AND text IS NOT NULL AND timestamp<=? ORDER BY timestamp DESC LIMIT 2",subject.id,m.timestamp).filter(row=>!isEmojiOnly(row.text)).reverse().map(row=>row.text)}));
    const context=this.messageContext(m);
    const parent=m.parent_id ? this.one("SELECT subject_id FROM messages WHERE id=? AND session_id=? AND moderation='cleared'",m.parent_id,m.session_id) : null;
    let result;const controller=new AbortController();this.classificationControllers.set(id,controller);
    try{result=await this.ai.classify({text:m.text,context,blockedTopics:rules,subjects,organize:m.organizer!=='reaction',identities:this.identities(),signal:controller.signal});}
    catch{
      const current=this.one('SELECT text,moderation FROM messages WHERE id=?',id);
      if(controller.signal.aborted && revision!==this.revision && current?.text && current.moderation==='held' && this.currentSession()?.id===m.session_id && attempt<2) return this.processMessage(id,this.all('SELECT * FROM rules'),attempt+1);
      this.deferHeld(id);return;
    } finally {if(this.classificationControllers.get(id)===controller)this.classificationControllers.delete(id);}
    const current=this.one('SELECT * FROM messages WHERE id=?',id);
    if(!current || !current.text || current.moderation!=='held' || this.one('SELECT opted_out FROM viewers WHERE id=?',m.viewer_id)?.opted_out) return;
    if(revision!==this.revision){if(attempt<2)return this.processMessage(id,this.all('SELECT * FROM rules'),attempt+1);this.deferHeld(id);return;}
    // Discovery can publish a topic while this message is still being scored.
    // Recheck against the new choices so a lone in-flight line is not stranded
    // waiting for enough unrelated ungrouped messages to trigger discovery.
    if(m.organizer!=='reaction' && result.addressesAI<0.7 && attempt<2 &&
      this.all('SELECT id FROM subjects ORDER BY last_active DESC LIMIT 30').some(s=>!subjects.some(known=>known.id===s.id))){
      return this.processMessage(id,rules,attempt+1);
    }
    this.run('UPDATE messages SET job_status=NULL,retry_at=NULL WHERE id=?',id);
    const {matchThreshold,maybeThreshold}=this.config;
    const matched=(result.topics || []).filter(s=>s.score>=matchThreshold).map(s=>rules.find(r=>r.id===s.id)).filter(Boolean);
    const maybe=(result.topics || []).some(s=>s.score>=maybeThreshold && s.score<matchThreshold);
    if(rules.length && result.nonEnglish>=nonEnglishMaybeThreshold){this.run("UPDATE messages SET moderation='maybe',organizer='unassigned' WHERE id=?",id);return;}
    if(matched.length){this.run("UPDATE messages SET moderation='hidden',organizer='unassigned' WHERE id=?",id);if(matched.some(r=>r.action==='delete')) await this.guardedDelete(id,m.viewer_id,!!m.moderator); return;}
    if(maybe){this.run("UPDATE messages SET moderation='maybe' WHERE id=?",id);return;}
    const addressesAI=result.addressesAI>=0.7;
    let organizer=m.organizer,subjectId=null;
    if(organizer!=='reaction' && addressesAI) organizer='unassigned';
    else if(organizer!=='reaction'){
      const scores=(result.subjects || []).filter(s=>s.score>=maybeThreshold);
      const selected=chooseSubject(scores,matchThreshold,parent?.subject_id);
      if(selected){organizer='assigned';subjectId=selected.id;}
      else if(scores.length) organizer='uncertain';
    }
    this.run('UPDATE messages SET moderation=?,organizer=?,category=?,subject_id=?,addresses_ai=? WHERE id=?','cleared',organizer,result.category || 'other',subjectId,addressesAI?1:0,id);
    if(/^!lurk\s*$/i.test(m.text) && !m.bot && this.currentSession()?.id===m.session_id){
      this.intentionalLurkers.add(m.viewer_id);
      this.run("UPDATE nudges SET text=? WHERE viewer_id=? AND session_id=? AND status IN ('open','waiting')",`${m.name} has chosen to lurk.`,m.viewer_id,m.session_id);
    }
    if(subjectId) this.run('UPDATE subjects SET last_active=? WHERE id=? AND (last_active IS NULL OR last_active<?)',m.timestamp,subjectId,m.timestamp);
    if(!m.bot && !m.moderator && !m.vip && organizer!=='reaction' && !isRepetitionOnly(m.text) && this.currentSession()?.id===m.session_id){
      this.run('INSERT OR IGNORE INTO first_messages (session_id,viewer_id,message_id) VALUES (?,?,?)',m.session_id,m.viewer_id,id);
      if(this.one('SELECT message_id FROM first_messages WHERE session_id=? AND viewer_id=?',m.session_id,m.viewer_id)?.message_id===id){
        const early=this.one('SELECT COUNT(*) AS n FROM sessions').n<3;
        if(!early || result.category==='question') this.addNudge(m.viewer_id,id,result.category==='question'?`${m.name} asked a question. Give it a quick answer when you can.`:`${m.name} sent a first message. Give it a quick welcome when you can.`,{kind:result.category==='question'?'question':'message'});
      }
    }
    if(!m.bot && organizer!=='reaction' && this.dayOneDate && this.getFollower) await this.checkFollower(m.viewer_id,m.session_id);
  }
  deferHeld(id){
    const row=this.one("SELECT retry_count FROM messages WHERE id=? AND moderation='held' AND text IS NOT NULL",id);if(!row) return;
    const count=(row.retry_count || 0)+1;
    this.run("UPDATE messages SET job_status='failed',retry_count=?,retry_at=? WHERE id=? AND moderation='held' AND text IS NOT NULL",count,count===1?new Date(this.now()+30000).toISOString():null,id);
  }
  abortClassifications(){for(const controller of this.classificationControllers.values()) controller.abort();for(const controller of this.modelControllers)controller.abort();try{this.onPrivacyChange();}catch{}}
  retryHeld(){
    const session=this.currentSession();if(!session) return;
    const rows=this.all("SELECT id FROM messages WHERE session_id=? AND moderation='held' AND job_status='failed' AND retry_count=1 AND retry_at<=? AND text IS NOT NULL ORDER BY retry_at LIMIT 5",session.id,new Date(this.now()).toISOString());
    for(const {id} of rows){
      const claim=this.run("UPDATE messages SET job_status='queued',retry_count=2,retry_at=NULL WHERE id=? AND moderation='held' AND job_status='failed' AND retry_count=1 AND retry_at<=?",id,new Date(this.now()).toISOString());if(!claim.changes) continue;
      const task=this.processMessage(id,this.all('SELECT * FROM rules'));this.pending.add(task);task.finally(()=>this.pending.delete(task)).catch(()=>{});
    }
    this.retryDeletes();
  }
  checkFollower(viewerId,sessionId){
    if(this.followerChecks.has(viewerId)) return this.followerChecks.get(viewerId);
    const check=Promise.resolve().then(()=>{
      if(this.currentSession()?.id!==sessionId || this.one('SELECT opted_out FROM viewers WHERE id=?',viewerId)?.opted_out) return null;
      return this.getFollower(viewerId);
    }).then(follower=>{if(follower?.followed_at && this.currentSession()?.id===sessionId && !this.one('SELECT opted_out FROM viewers WHERE id=?',viewerId)?.opted_out) this.followDates[viewerId]=follower.followed_at;}).catch(()=>{});
    this.followerChecks.set(viewerId,check);return check;
  }
  backfillFollowers(){
    const session=this.currentSession();if(!session || session.wrapped || !this.dayOneDate || !this.getFollower) return;
    const viewers=this.all("SELECT DISTINCT viewer_id FROM messages WHERE session_id=? AND moderation='cleared' AND organizer<>'reaction' AND bot=0 AND text IS NOT NULL",session.id);
    for(const {viewer_id:id} of viewers){
      if(this.followerChecks.has(id)) continue;
      const task=this.checkFollower(id,session.id);this.pending.add(task);task.finally(()=>this.pending.delete(task));
    }
  }
  async guardedDelete(messageId,senderId,isModerator){
    if(!messageId || !senderId || isModerator || senderId===this.broadcasterId) return;
    this.run("INSERT OR IGNORE INTO moderation_actions (message_id,sender_id,status) VALUES (?,?,'queued')",messageId,senderId);
    if(this.one('SELECT status FROM moderation_actions WHERE message_id=?',messageId)?.status!=='queued') return;
    await this.performDeleteAction(messageId);
  }
  async performDeleteAction(messageId){
    if(this.transientDeletes.has(messageId)) return;
    const action=this.one('SELECT * FROM moderation_actions WHERE message_id=?',messageId);
    if(!action || action.status!=='queued') return;
    this.transientDeletes.add(messageId);
    try {
      if(!this.deleteMessageAvailable){
        this.run("UPDATE moderation_actions SET status='failed',retry_count=1,retry_at=? WHERE message_id=? AND status='queued'",new Date(this.now()+30000).toISOString(),messageId);
        return;
      }
      const result=await this.deleteMessage({messageId,senderId:action.sender_id,isModerator:false});
      if(result===false) throw new Error('Twitch deletion failed');
      this.run("UPDATE moderation_actions SET status='done',retry_at=NULL WHERE message_id=?",messageId);
    } catch {
      const count=action.retry_count || 1;
      this.run("UPDATE moderation_actions SET status='failed',retry_count=?,retry_at=? WHERE message_id=? AND status='queued'",count,count===1?new Date(this.now()+30000).toISOString():null,messageId);
    } finally {this.transientDeletes.delete(messageId);}
  }
  retryDeletes(){
    if(!this.deleteMessageAvailable) return;
    const due=this.all("SELECT message_id FROM moderation_actions WHERE status='failed' AND retry_count=1 AND retry_at<=? ORDER BY retry_at LIMIT 5",new Date(this.now()).toISOString());
    for(const {message_id:id} of due){
      const claim=this.run("UPDATE moderation_actions SET status='queued',retry_count=2,retry_at=NULL WHERE message_id=? AND status='failed' AND retry_count=1 AND retry_at<=?",id,new Date(this.now()).toISOString());if(!claim.changes)continue;
      const task=this.performDeleteAction(id);this.pending.add(task);task.finally(()=>this.pending.delete(task)).catch(()=>{});
    }
  }
  rows(){
    const messages=this.all("SELECT * FROM messages WHERE session_id=? AND moderation='cleared' AND text IS NOT NULL ORDER BY timestamp,id",this.currentSession()?.id || ''),active=new Map(),rows=[];
    for(const m of messages){const key=repeatKey(m.text,m.parent_id);let row=active.get(key);if(!row || ms(m.timestamp)-row.start>=this.config.repetitionWindowSeconds*1000){row={id:m.id,text:m.text,start:ms(m.timestamp),count:0,authors:{},category:m.category,about:m.about,subjectId:m.subject_id,viewerName:m.name,timestamp:m.timestamp,topicEligible:isTopicMessage(m),selectable:!m.bot && !m.text.startsWith('!') && !m.addresses_ai};rows.push(row);active.set(key,row);}row.count++;row.authors[m.name]=(row.authors[m.name] || 0)+1;}
    return rows;
  }
  async safeGeneratedText(text,identities,signal){
    if(typeof text!=='string' || !text.trim()) return false;
    try {
      const result=await this.ai.classify({text,blockedTopics:this.all('SELECT * FROM rules'),subjects:[],identities,organize:true,signal});
      return result.addressesAI<0.7 && !(result.topics || []).some(topic=>topic.score>=this.config.maybeThreshold);
    } catch {return false;}
  }
  async labelMessages(){
    if(this.labelling)return this.labelling;
    const session=this.currentSession();if(!session || !this.ai.labelMessages)return;
    const since=new Date(this.now()-subjectWindowMs).toISOString();
    const targets=this.all("SELECT rowid,* FROM messages WHERE session_id=? AND moderation='cleared' AND text IS NOT NULL AND subject_id IS NULL AND about IS NULL AND COALESCE(received_at,timestamp)>=? ORDER BY COALESCE(received_at,timestamp) DESC,rowid DESC",session.id,since).filter(isTopicMessage).slice(0,30);
    if(!targets.length)return;
    const first=Math.min(...targets.map(m=>m.rowid));
    const earlierChat=this.all("SELECT rowid,* FROM messages WHERE session_id=? AND rowid<? AND moderation='cleared' AND text IS NOT NULL ORDER BY rowid DESC",session.id,first).filter(isTopicMessage).slice(0,20).reverse();
    const existingLabels=this.all("SELECT DISTINCT about FROM messages WHERE session_id=? AND moderation='cleared' AND text IS NOT NULL AND about<>'' AND COALESCE(received_at,timestamp)>=? ORDER BY rowid DESC LIMIT 60",session.id,since).map(m=>m.about);
    const revision=this.revision,controller=new AbortController();this.modelControllers.add(controller);
    const valid=()=>revision===this.revision && !controller.signal.aborted && this.currentSession()?.id===session.id;
    const work=(async()=>{
      const identities=this.identities();
      const labels=await this.ai.labelMessages({earlierChat:earlierChat.map(m=>m.text),targets:targets.map(m=>({text:m.text,reply:this.messageContext(m).reply})),existingLabels,identities,signal:controller.signal});
      if(!valid())return;
      if(!Array.isArray(labels) || labels.length!==targets.length || labels.some(label=>label!==null && typeof label!=='string'))throw new Error('Invalid message labels response');
      const unique=[...new Set(labels.filter(label=>label && !isGenericSubjectName(label)))];
      const allowed=unique.length ? await this.ai.safeLabels({labels:unique,blockedTopics:this.all('SELECT * FROM rules'),identities,threshold:this.config.maybeThreshold,signal:controller.signal}) : [];
      if(!valid())return;
      const safe=new Set(unique.filter((_,index)=>allowed[index]===true));
      for(let i=0;i<targets.length;i++)this.run("UPDATE messages SET about=? WHERE id=? AND session_id=? AND moderation='cleared' AND text IS NOT NULL AND subject_id IS NULL AND about IS NULL",safe.has(labels[i])?labels[i]:'',targets[i].id,session.id);
    })();
    this.labelling=work;
    try{return await work;}finally{this.modelControllers.delete(controller);if(this.labelling===work)this.labelling=null;}
  }
  messageContext(message,maxRowid=Number.MAX_SAFE_INTEGER){
    const before=Math.min(maxRowid,message.rowid-1);
    const parent=message.parent_id ? this.one("SELECT text,subject_id FROM messages WHERE id=? AND session_id=? AND rowid<=? AND moderation='cleared' AND text IS NOT NULL",message.parent_id,message.session_id,before) : null;
    const since=new Date(ms(message.timestamp)-120000).toISOString();
    const recent=this.all("SELECT text,viewer_id FROM messages WHERE session_id=? AND rowid<=? AND timestamp>=? AND timestamp<=? AND moderation='cleared' AND bot=0 AND addresses_ai=0 AND organizer<>'reaction' AND text IS NOT NULL ORDER BY timestamp DESC,rowid DESC LIMIT 8",message.session_id,before,since,message.timestamp).filter(m=>!isEmojiOnly(m.text));
    return {reply:parent?.text?.slice(0,500),replySubject:parent?.subject_id ? this.one('SELECT name FROM subjects WHERE id=?',parent.subject_id)?.name : '',
      previousLine:recent.find(m=>m.viewer_id===message.viewer_id)?.text.slice(0,500),recentMessages:recent.reverse().map(m=>m.text.slice(0,300))};
  }
  async scoreConversation(messages,subject,identities,signal,maxRowid){
    const scores=[];
    // Keep context-rich batches small enough for the background token budget.
    for(let start=0;start<messages.length;){
      const batch=[];let bytes=0;
      while(start+batch.length<messages.length && batch.length<8){
        const m=messages[start+batch.length],item={text:m.text,context:this.messageContext(m,maxRowid)};
        const size=Buffer.byteLength(JSON.stringify(item),'utf8');
        if(batch.length && bytes+size>10000) break;
        batch.push(item);bytes+=size;
      }
      const values=this.ai.scoreSubjects ? await this.ai.scoreSubjects({messages:batch,subject,identities,signal}) :
        await Promise.all(batch.map(item=>this.ai.scoreSubject({...item,subject,identities,signal})));
      for(let i=0;i<batch.length;i++) scores.push({m:messages[start+i],score:values[i]});
      start+=batch.length;
    }
    return scores;
  }
  async discover(maxRowid=Number.MAX_SAFE_INTEGER,{force=false}={}){
    if(this.naming){await this.naming;if(!force)return;}
    const session=this.currentSession(); if(!session) return;
    const pendingRows=this.all("SELECT rowid,* FROM messages WHERE session_id=? AND rowid<=? AND moderation='cleared' AND organizer IN ('new','uncertain') AND addresses_ai=0 ORDER BY timestamp DESC",session.id,maxRowid);
    for(const message of pendingRows){
      const age=this.now()-ms(message.received_at || message.timestamp);
      const newer=this.one("SELECT COUNT(*) AS n FROM messages WHERE session_id=? AND rowid>? AND rowid<=?",session.id,message.rowid,maxRowid).n;
      if(age>=subjectWindowMs || (age>=15000 && newer>=20)) this.run("UPDATE messages SET organizer='unassigned' WHERE id=? AND organizer IN ('new','uncertain')",message.id);
    }
    const pool=this.all("SELECT rowid,* FROM messages WHERE session_id=? AND rowid<=? AND moderation='cleared' AND organizer IN ('new','uncertain') AND addresses_ai=0 AND text IS NOT NULL ORDER BY timestamp DESC,rowid DESC LIMIT 60",session.id,maxRowid).filter(isTopicMessage).reverse();
    if(!conversationEvidence(pool)) return;
    if(!force && (pool.every(m=>this.lastNamedMessageIds.has(m.id)) || this.now()-this.lastNamingAt<10000)) return;
    this.lastNamingAt=this.now();
    const revision=this.revision;
    const controller=new AbortController();this.modelControllers.add(controller);
    this.naming=(async()=>{
      const identities=this.identities(),existing=this.all('SELECT * FROM subjects');
      const proposals=await this.ai.nameSubjects({messages:pool.map(m=>m.text),existing,identities,signal:controller.signal});
      if(revision!==this.revision) return;
      const candidates=[],seen=new Set();
      for(const proposal of (proposals || []).slice(0,3)){
        if(typeof proposal?.name!=='string' || typeof proposal.description!=='string' || !proposal.name.trim() || !proposal.description.trim() || isGenericSubjectName(proposal.name)) continue;
        const key=subjectKey(proposal.name);if(seen.has(key))continue;seen.add(key);
        if(!await this.safeGeneratedText(`${proposal.name}. ${proposal.description}`,identities,controller.signal) || revision!==this.revision) continue;
        const known=existing.find(s=>subjectKey(s.name)===key);
        const subject=known || {id:randomUUID(),name:proposal.name.trim().slice(0,100),description:proposal.description.trim().slice(0,300)};
        const scores=await this.scoreConversation(pool,subject,identities,controller.signal,maxRowid);
        if(revision!==this.revision) return;
        if(known || conversationEvidence(scores.filter(x=>x.score>=this.config.matchThreshold).map(x=>x.m))) candidates.push({subject,known,scores});
      }
      // Compare all proposals before assigning, so proposal order cannot claim
      // an ambiguous message for whichever subject Luna happened to name first.
      const assignments=(messages,options)=>messages.map((m,index)=>{
        const parent=m.parent_id ? this.one("SELECT subject_id FROM messages WHERE id=? AND session_id=? AND rowid<=? AND moderation='cleared'",m.parent_id,session.id,maxRowid) : null;
        const selected=chooseSubject(options.map(candidate=>({id:candidate.subject.id,score:candidate.scores[index].score,candidate})),this.config.matchThreshold,parent?.subject_id);
        return {m,candidate:selected?.candidate};
      });
      const selected=assignments(pool,candidates),registered=[];
      for(const candidate of candidates){
        const matches=selected.filter(item=>item.candidate===candidate).map(item=>item.m);
        if(!matches.length || (!candidate.known && !conversationEvidence(matches))) continue;
        const {subject}=candidate;
        if(!candidate.known) this.run('INSERT INTO subjects (id,name,description) VALUES (?,?,?)',subject.id,subject.name,subject.description);
        registered.push(candidate);
        for(const m of matches) this.run("UPDATE messages SET organizer='assigned',subject_id=? WHERE id=? AND moderation='cleared' AND organizer IN ('new','uncertain')",subject.id,m.id);
        this.run("UPDATE subjects SET last_active=(SELECT MAX(timestamp) FROM messages WHERE subject_id=? AND moderation='cleared') WHERE id=?",subject.id,subject.id);
      }
      if(registered.length){
        const earliest=new Date(this.now()-subjectWindowMs).toISOString();
        const lookback=this.all("SELECT rowid,* FROM messages WHERE session_id=? AND rowid<=? AND COALESCE(received_at,timestamp)>=? AND moderation='cleared' AND organizer IN ('new','unassigned','uncertain') AND addresses_ai=0 AND text IS NOT NULL ORDER BY timestamp,rowid",session.id,maxRowid,earliest).filter(isTopicMessage);
        const checked=[];
        for(const candidate of registered){
          checked.push({...candidate,scores:await this.scoreConversation(lookback,candidate.subject,identities,controller.signal,maxRowid)});
          if(revision!==this.revision) return;
        }
        for(const {m,candidate} of assignments(lookback,checked)) if(candidate) this.run("UPDATE messages SET organizer='assigned',subject_id=? WHERE id=? AND moderation='cleared' AND text IS NOT NULL AND organizer IN ('new','unassigned','uncertain')",candidate.subject.id,m.id);
        for(const {subject} of registered) this.run("UPDATE subjects SET last_active=(SELECT MAX(timestamp) FROM messages WHERE subject_id=? AND moderation='cleared') WHERE id=?",subject.id,subject.id);
        // Before a conversation had a name, some of its messages may have been
        // assigned to an older topic. Revisit at most 60 recent assignments,
        // requiring both strong relevance and a direct JEV comparison to move.
        const newTopics=registered.filter(candidate=>!candidate.known);
        if(newTopics.length && this.ai.chooseSubject){
          const assigned=this.all("SELECT rowid,* FROM messages WHERE session_id=? AND rowid<=? AND COALESCE(received_at,timestamp)>=? AND moderation='cleared' AND organizer='assigned' AND addresses_ai=0 AND text IS NOT NULL ORDER BY timestamp DESC,rowid DESC LIMIT 60",session.id,maxRowid,earliest).filter(isTopicMessage).reverse();
          const competitors=assigned.filter(m=>!newTopics.some(c=>c.subject.id===m.subject_id));
          const rescored=[];
          for(const candidate of newTopics){
            rescored.push({...candidate,scores:await this.scoreConversation(competitors,candidate.subject,identities,controller.signal,maxRowid)});
            if(revision!==this.revision)return;
          }
          const touched=new Set();
          for(let i=0;i<competitors.length;i++){
            const m=competitors[i],matches=rescored.filter(c=>c.scores[i].score>=this.config.matchThreshold);
            if(!matches.length)continue;
            const original=this.one('SELECT * FROM subjects WHERE id=?',m.subject_id);
            if(!original)continue;
            const selected=await this.ai.chooseSubject({text:m.text,context:this.messageContext(m,maxRowid),subjects:[original,...matches.map(c=>c.subject)],identities,signal:controller.signal});
            if(revision!==this.revision)return;
            if(!matches.some(c=>c.subject.id===selected))continue;
            this.run("UPDATE messages SET subject_id=? WHERE id=? AND subject_id=? AND moderation='cleared' AND organizer='assigned' AND addresses_ai=0 AND text IS NOT NULL",selected,m.id,m.subject_id);
            touched.add(m.subject_id);touched.add(selected);
          }
          for(const id of touched)this.run("UPDATE subjects SET last_active=(SELECT MAX(timestamp) FROM messages WHERE subject_id=? AND moderation='cleared') WHERE id=?",id,id);
        }
      }
      this.lastNamedMessageIds=new Set(pool.map(m=>m.id));
    })();
    const naming=this.naming;
    try{return await naming;}finally{this.modelControllers.delete(controller);if(this.naming===naming)this.naming=null;}
  }
  identities(){
    const stored=this.all('SELECT id,name,login FROM viewers WHERE opted_out=0');
    const senders=this.all("SELECT DISTINCT m.viewer_id AS id,m.name,m.login FROM messages m LEFT JOIN viewers v ON v.id=m.viewer_id WHERE m.text IS NOT NULL AND COALESCE(v.opted_out,0)=0");
    return [...stored,...senders,...this.knownIdentities.values()].filter(v=>v.id && !this.one('SELECT opted_out FROM viewers WHERE id=?',v.id)?.opted_out);
  }
  async refreshSummary(){
    const session=this.currentSession(); if(!session) return;
    const revision=this.revision;
    const since=new Date(this.now()-this.config.summaryWindowSeconds*1000).toISOString();
    const rows=this.all("SELECT id,viewer_id,text FROM messages WHERE session_id=? AND COALESCE(received_at,timestamp)>=? AND moderation='cleared' AND addresses_ai=0 AND text IS NOT NULL ORDER BY COALESCE(received_at,timestamp) DESC,rowid DESC",session.id,since);
    const groups=new Map();for(const row of rows){const group=groups.get(row.viewer_id) || [];group.push(row);groups.set(row.viewer_id,group);}
    const selected=[];while(selected.length<30 && [...groups.values()].some(group=>group.length)){for(const group of groups.values()){if(group.length && selected.length<30) selected.push(group.shift());}}
    const key=selected.map(m=>m.id).join(',');if(!selected.length || key===this.lastSummaryKey || key===this.summaryInFlightKey) return;
    const generation=++this.summaryGeneration;this.summaryInFlightKey=key;
    const controller=new AbortController();this.modelControllers.add(controller);
    try {
      const identities=this.identities(),summary=await this.ai.summarize({messages:selected.map(m=>m.text),identities,signal:controller.signal});
      if(revision===this.revision && this.currentSession()?.id===session.id && generation===this.summaryGeneration && await this.safeGeneratedText(summary,identities,controller.signal) && revision===this.revision && generation===this.summaryGeneration){this.summary=summary;this.lastSummaryKey=key;}
    } finally {this.modelControllers.delete(controller);if(this.summaryInFlightKey===key)this.summaryInFlightKey='';}
  }
  async wrap({play=true,timeout=5000}={}){
    const session=this.currentSession(); if(!session) throw new Error('Start a session first.');
    if(this.wrapTask?.sessionId===session.id) {await this.wrapTask.promise; const awards=this.awards(session.id);if(play && this.currentSession()?.id===session.id) this.overlayEvent={id:randomUUID(),type:'awards',awards}; return awards;}
    if(session.wrapped){const awards=this.awards(session.id);if(play) this.overlayEvent={id:randomUUID(),type:'awards',awards};return awards;}
    const cutoff=new Date(this.now()).toISOString(), cutoffRowid=this.one('SELECT MAX(rowid) AS n FROM messages WHERE session_id=?',session.id).n || 0;
    this.run('UPDATE sessions SET cutoff=?,cutoff_rowid=?,wrapped=1 WHERE id=? AND wrapped=0',cutoff,cutoffRowid,session.id);
    const awardSettings={config:this.config,timeZone:this.timeZone,dayOneDate:this.dayOneDate};
    const promise=this.finalizeWrap(session,cutoff,cutoffRowid,play,timeout,awardSettings);
    this.wrapTask={sessionId:session.id,promise};
    try{return await promise;}finally{if(this.wrapTask?.promise===promise)this.wrapTask=null;}
  }
  async finalizeWrap(session,cutoff,cutoffRowid,play,timeout,awardSettings={config:this.config,timeZone:this.timeZone,dayOneDate:this.dayOneDate}){
    let complete=false; const work=(async()=>{await Promise.allSettled([...this.pending]);await this.discover(cutoffRowid,{force:true});complete=true;})().catch(()=>{});
    let timer;
    try {await Promise.race([work,new Promise(resolve=>{timer=setTimeout(resolve,timeout);})]);} finally {clearTimeout(timer);}
    if(this.one("SELECT COUNT(*) AS n FROM messages WHERE session_id=? AND rowid<=? AND moderation='held'",session.id,cutoffRowid).n) complete=false;
    this.run('UPDATE sessions SET incomplete=? WHERE id=?',complete?0:1,session.id);
    const eligible=this.all("SELECT * FROM messages WHERE session_id=? AND rowid<=? AND timestamp<=? AND moderation='cleared' AND organizer<>'reaction' AND bot=0 AND text IS NOT NULL ORDER BY timestamp,id",session.id,cutoffRowid,cutoff);
    const config=awardSettings.config;
    if(complete){const leader=discussions(eligible,new Set(this.all('SELECT id FROM subjects WHERE excluded=1').map(s=>s.id)),{gapSeconds:config.discussionGapSeconds,minContributors:config.hypeMinContributors})[0];
      if(leader){
        const rawSubject=this.one('SELECT name FROM subjects WHERE id=?',leader.subjectId)?.name || '';
        const subject=createSanitizer(this.identities())(rawSubject).replace(/https?:\/\/\S+|www\.\S+/giu,'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,100) || 'Chat discussion';
        for(const [order,id] of leader.contributors.slice(0,config.hypeMaxContributors).entries()) this.run('INSERT OR IGNORE INTO awards (session_id,title,viewer_id,evidence,subject,duration_ms,recipient_order) VALUES (?,?,?,?,?,?,?)',session.id,'Hype Engine',id,JSON.stringify(leader.evidence),subject,leader.end-leader.start,order);
      }}
    const previousDayOne=this.all("SELECT viewer_id FROM awards WHERE title='Day One' AND session_id<>?",session.id).map(a=>a.viewer_id);
    const loyalty=computeLoyalty({messages:eligible,timeZone:awardSettings.timeZone,dayOneDate:awardSettings.dayOneDate,followDates:this.followDates,previousDayOne,nightOwlStart:config.nightOwlStart,nightOwlEnd:config.nightOwlEnd});
    for(const award of loyalty) this.run('INSERT OR IGNORE INTO awards (session_id,title,viewer_id,evidence) VALUES (?,?,?,?)',session.id,award.title,award.viewerId,JSON.stringify(award.evidence));
    const awards=this.awards(session.id);
    if(play && this.currentSession()?.id===session.id) this.overlayEvent={id:randomUUID(),type:'awards',awards}; return awards;
  }
  awards(sessionId=this.currentSession()?.id){
    if(!sessionId) return [];
    const rows=this.all('SELECT a.title,a.viewer_id,a.subject,a.duration_ms,v.name FROM awards a JOIN viewers v ON v.id=a.viewer_id WHERE a.session_id=? AND a.active=1 AND v.opted_out=0 ORDER BY a.title,COALESCE(a.recipient_order,2147483647),v.name',sessionId);
    return [...new Set(rows.map(r=>r.title))].map(title=>{const matches=rows.filter(r=>r.title===title),award={title,recipients:matches.map(r=>r.name)};if(title==='Hype Engine' && matches[0].subject!=null && matches[0].duration_ms!=null){award.subject=matches[0].subject;award.durationMs=matches[0].duration_ms;}return award;});
  }
  community(session,presence){
    if(!session) return [];
    const members=new Map();
    const add=(id,label,detail,provisional=false)=>{
      if(id===this.broadcasterId) return;
      const viewer=this.one('SELECT name,opted_out FROM viewers WHERE id=?',id);
      if(!viewer || viewer.opted_out) return;
      const member=members.get(id) || {id,name:viewer.name,types:[]};
      if(!member.types.some(type=>type.label===label)) member.types.push({label,detail,provisional});
      members.set(id,member);
    };
    for(const viewer of presence) add(viewer.id,'Regular','A regular is here.');
    const eligible=this.all("SELECT m.* FROM messages m JOIN viewers v ON v.id=m.viewer_id WHERE m.session_id=? AND v.opted_out=0 AND m.moderation='cleared' AND m.organizer<>'reaction' AND m.bot=0 AND m.text IS NOT NULL ORDER BY m.timestamp,m.id",session.id)
      .filter(m=>m.viewer_id!==this.broadcasterId && !m.text.startsWith('!') && !isReaction(m.text) && !isRepetitionOnly(m.text));
    const eligibleIds=new Set(eligible.map(m=>m.viewer_id));
    const presentRegularIds=new Set(presence.map(viewer=>viewer.id));
    const previousDayOne=this.all("SELECT DISTINCT viewer_id FROM awards WHERE title='Day One' AND active=1 AND session_id<>?",session.id).map(a=>a.viewer_id);
    for(const id of previousDayOne) if(eligibleIds.has(id) || this.presentIds?.has(id) || presentRegularIds.has(id)) add(id,'Day One','An early follower.');
    if(session.wrapped){
      // Final awards remain a snapshot, including an incomplete wrap's absence of Hype.
      for(const award of this.all('SELECT title,viewer_id,subject FROM awards WHERE session_id=? AND active=1 ORDER BY title,recipient_order',session.id)){
        if(['Night Owl','Day One','Hype Engine'].includes(award.title)) add(award.viewer_id,award.title,award.title==='Hype Engine' ? (award.subject || 'Chat discussion') : award.title==='Day One' ? 'An early follower.' : 'Qualified for Night Owl this stream.');
      }
    } else {
      for(const award of computeLoyalty({messages:eligible,timeZone:this.timeZone,dayOneDate:this.dayOneDate,followDates:this.followDates,previousDayOne,nightOwlStart:this.config.nightOwlStart,nightOwlEnd:this.config.nightOwlEnd})) add(award.viewerId,award.title,award.title==='Day One' ? 'An early follower.' : 'Chatted in your Night Owl window.');
      const leader=discussions(eligible,new Set(this.all('SELECT id FROM subjects WHERE excluded=1').map(s=>s.id)),{gapSeconds:this.config.discussionGapSeconds,minContributors:this.config.hypeMinContributors})[0];
      if(leader){
        const subject=this.one('SELECT name FROM subjects WHERE id=?',leader.subjectId)?.name || 'Chat discussion';
        for(const id of leader.contributors.slice(0,this.config.hypeMaxContributors)) add(id,'Hype Engine',`Current longest: ${subject}`,true);
      }
    }
    return [...members.values()].sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  }
  state(){
    this.pumpNudges();
    const session=this.currentSession(), viewers=this.all('SELECT id,name,seen,total,last_seen,muted FROM viewers WHERE opted_out=0');
    const chatting=new Set(session?this.all("SELECT DISTINCT viewer_id FROM messages WHERE session_id=? AND moderation='cleared' AND text IS NOT NULL",session.id).map(m=>m.viewer_id):[]);
    const presence=viewers.filter(v=>session && (this.presentIds ? this.presentIds.has(v.id) : JSON.parse(v.seen).includes(session.idx)) && regularCount(JSON.parse(v.seen),session.idx,this.config)>=this.config.regularMinimum).map(v=>({...v,status:chatting.has(v.id)?'Chatting':'Lurking'})).sort((a,b)=>a.status.localeCompare(b.status)||a.name.localeCompare(b.name));
    const currentSubjectIds=[...new Set(this.all("SELECT subject_id,text,organizer,bot,addresses_ai FROM messages WHERE session_id=? AND moderation='cleared' AND text IS NOT NULL AND subject_id IS NOT NULL",session?.id || '').filter(isTopicMessage).map(row=>row.subject_id))];
    return {session:session ? {...session,status:'live',mode:'demo'} : null,summary:this.summary,subjects:this.all('SELECT * FROM subjects ORDER BY last_active DESC'),currentSubjectIds,messages:this.rows(),presence,community:this.community(session,presence),nudgesPaused:!!session?.nudges_paused,nudges:this.all("SELECT * FROM nudges WHERE session_id=? AND status='open' ORDER BY created DESC LIMIT 20",session?.id || ''),rules:this.all('SELECT id,name AS topic,definition,action FROM rules'),maybe:this.all("SELECT id,name AS viewerName,text FROM messages WHERE moderation='maybe' AND text IS NOT NULL"),stickers:this.all('SELECT * FROM stickers'),awards:this.awards()};
  }
}
