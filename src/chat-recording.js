import {readFileSync,writeFileSync,mkdirSync,statSync} from 'node:fs';
import {dirname} from 'node:path';
import {DEFAULT_SETTINGS,readSettings,validateSettings} from './config.js';

const FORMAT='regulars-chat';
const MAX_MESSAGES=100000;

// Arrival time drives playback. Keep Twitch's timestamp separately, including
// its original precision, so latency and event order remain inspectable.
export function recordChat(db,{sessionId,name='Chat recording',broadcasterId=''}={}){
  const session=sessionId ? db.prepare('SELECT id,start,end FROM sessions WHERE id=?').get(sessionId)
    : db.prepare('SELECT id,start,end FROM sessions ORDER BY idx DESC LIMIT 1').get();
  if(!session) throw new Error('There is no chat session to save.');
  const rows=db.prepare(`SELECT m.*,s.name AS topic_name FROM messages m
    LEFT JOIN viewers v ON v.id=m.viewer_id LEFT JOIN subjects s ON s.id=m.subject_id
    WHERE m.session_id=? AND m.text IS NOT NULL AND m.moderation<>'removed' AND COALESCE(v.opted_out,0)=0
    ORDER BY COALESCE(m.received_at,m.timestamp),m.rowid`).all(session.id);
  if(!rows.length) throw new Error('This session has no retained chat messages to save.');
  const startedAt=rows[0].received_at || rows[0].timestamp;
  const start=Date.parse(startedAt);
  let previous=0;
  const messages=rows.map(m=>{
    const receivedAt=m.received_at || m.timestamp;
    const offsetMs=Math.max(previous,Date.parse(receivedAt)-start);
    const entry={id:m.id,viewerId:m.viewer_id,name:m.name,login:m.login || '',text:m.text,category:m.category,
      timestamp:m.timestamp,receivedAt,offsetMs,delayMs:offsetMs-previous,parentId:m.parent_id || null,
      bot:!!m.bot,moderator:!!m.moderator,vip:!!m.vip,
      reaction:m.organizer==='reaction' && !m.bot && !m.text.startsWith('!'),
      previousResult:{category:m.category,moderation:m.moderation,topic:m.topic_name || null}};
    previous=offsetMs;return entry;
  });
  const hasSettings=!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='settings'").get();
  const rules=db.prepare('SELECT * FROM rules').all().map(rule=>({name:rule.name,definition:rule.definition,action:rule.action,
    positiveExamples:JSON.parse(rule.positive_examples || '[]'),negativeExamples:JSON.parse(rule.negative_examples || '[]')}));
  return validateRecording({format:FORMAT,version:1,name:String(name).trim().slice(0,120) || 'Chat recording',
    savedAt:new Date().toISOString(),startedAt,sourceSession:{...session},broadcasterId,
    settings:hasSettings?readSettings(db):{...DEFAULT_SETTINGS},rules,messages,durationMs:previous});
}

export function validateRecording(recording){
  if(!recording || recording.format!==FORMAT || recording.version!==1) throw new Error('Unsupported chat recording.');
  if(typeof recording.name!=='string' || !recording.name.trim() || !Number.isFinite(Date.parse(recording.startedAt))) throw new Error('Invalid recording metadata.');
  if(!Array.isArray(recording.messages) || !recording.messages.length || recording.messages.length>MAX_MESSAGES) throw new Error('A recording must contain 1–100,000 messages.');
  const ids=new Set();let previous=0;
  for(const [index,m] of recording.messages.entries()){
    if(!m || typeof m.id!=='string' || !m.id || ids.has(m.id) || typeof m.viewerId!=='string' || !m.viewerId ||
      typeof m.name!=='string' || typeof m.text!=='string' || !m.text || m.text.length>5000 ||
      !Number.isFinite(Date.parse(m.timestamp)) || !Number.isFinite(Date.parse(m.receivedAt)) ||
      !Number.isSafeInteger(m.offsetMs) || m.offsetMs<previous || (index===0 && m.offsetMs!==0) || m.delayMs!==m.offsetMs-previous)
      throw new Error(`Invalid recorded message at position ${index+1}.`);
    ids.add(m.id);previous=m.offsetMs;
  }
  if(recording.durationMs!==previous) throw new Error('Recording duration does not match its message timing.');
  validateSettings(recording.settings || DEFAULT_SETTINGS);
  if(!Array.isArray(recording.rules) || recording.rules.some(rule=>!rule || typeof rule.name!=='string' || typeof rule.definition!=='string' || !['hide','delete'].includes(rule.action))) throw new Error('Invalid recorded topic rules.');
  return recording;
}

export function saveRecording(file,recording){
  validateRecording(recording);
  mkdirSync(dirname(file),{recursive:true,mode:0o700});
  writeFileSync(file,JSON.stringify(recording,null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
  return file;
}

export function loadRecording(file){
  if(statSync(file).size>50*1024*1024) throw new Error('Chat recording exceeds 50 MB.');
  return validateRecording(JSON.parse(readFileSync(file,'utf8')));
}
