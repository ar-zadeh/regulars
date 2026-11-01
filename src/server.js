import http from 'node:http';
import {readFileSync,existsSync,mkdirSync} from 'node:fs';
import {join,extname} from 'node:path';
import {createHash,randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createAI,createSanitizer} from './ai.js';
import {Regulars} from './core.js';
import {generateImage} from './images.js';
import {expireChatText} from './retention.js';
import {computeLoyalty} from './loyalty.js';
import {connectLive} from './live.js';
import {seedDemo} from './demo.js';
import {TwitchOAuth} from './oauth.js';
import {validateAccessToken} from './twitch.js';
import {DEFAULT_SETTINGS,readSettings,validateSettings,writeSettings} from './config.js';
import {DockHotkeys} from './dock-hotkeys.js';
import {loadRecording,recordChat} from './chat-recording.js';
import {ChatReplay} from './chat-replay.js';

const root=fileURLToPath(new URL('..',import.meta.url));
function loadEnv(){
  const file=join(root,'.env'); if(!existsSync(file)) return;
  for(const line of readFileSync(file,'utf8').split(/\r?\n/)){
    const match=line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if(match && !Object.hasOwn(process.env,match[1])) process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
  }
}
loadEnv();
const recording=process.env.REGULARS_REPLAY_FILE ? loadRecording(process.env.REGULARS_REPLAY_FILE) : null;
const publicDir=join(root,'public'),dataDir=process.env.REGULARS_DATA_DIR || join(root,'data'); mkdirSync(dataDir,{recursive:true});
const key=process.env.OPENROUTER_API_KEY,offline=process.env.REGULARS_AI==='offline' || !key;
const twitchClientId=process.env.TWITCH_CLIENT_ID,twitchAccessToken=process.env.TWITCH_ACCESS_TOKEN,twitchClientSecret=process.env.TWITCH_CLIENT_SECRET,twitchBroadcasterId=process.env.TWITCH_BROADCASTER_ID,twitchRedirectUri=process.env.TWITCH_REDIRECT_URI;
const botNames=(process.env.TWITCH_BOT_NAMES || '').split(',').map(name=>name.trim()).filter(Boolean);
const directTwitch=!recording && Boolean(twitchClientId && twitchAccessToken && twitchBroadcasterId);
const oauthConfigured=!recording && Boolean(!directTwitch && twitchClientId && twitchClientSecret && twitchBroadcasterId);
const liveConfigured=directTwitch || oauthConfigured;
const liveDatabase=liveConfigured ? `regulars-live-${createHash('sha256').update(twitchBroadcasterId).digest('hex').slice(0,24)}.sqlite` : 'regulars.sqlite';
// Held live messages have one durable recovery attempt; avoid SDK-level retries
// so the same message does not exceed that total retry budget.
const ai=createAI({apiKey:key,offline,retries:0}),app=new Regulars({dbPath:recording?':memory:':join(dataDir,liveDatabase),ai,
  broadcasterId:recording?.broadcasterId || 'broadcaster'});
const dockHotkeys=new DockHotkeys({dataDir});
let liveBridge=null,liveConnectionTask=null,directController=null,oauth=null,serverClosed=false,liveEpoch=0,liveStatus={connected:false,reason:directTwitch?'Connecting':oauthConfigured?'Sign in required':'Not configured'};
async function validateCurrentToken(options,epoch,signal){
  const result=await validateAccessToken({...options,signal});
  if(serverClosed || epoch!==liveEpoch || signal?.aborted) throw new Error('Twitch connection was canceled.');
  return result;
}
function updateLiveStatus(status){
  if(serverClosed) return;
  liveStatus=status;
  if(status.revoked || status.reason==='Twitch token validation failed'){
    liveEpoch++;directController?.abort();
    oauth?.disconnect();liveBridge?.stop();liveBridge=null;app.getFollower=null;
  }
}
app.db.exec('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY,value TEXT NOT NULL)');
function applySettings(settings){
  if(typeof app.setConfig==='function') app.setConfig(settings);else app.config=settings;
  liveBridge?.updateSettings?.(settings);
}
applySettings(recording?.settings || readSettings(app.db));
const ruleColumns=app.all('PRAGMA table_info(rules)').map(column=>column.name);
if(!ruleColumns.includes('positive_examples')) app.db.exec("ALTER TABLE rules ADD COLUMN positive_examples TEXT NOT NULL DEFAULT '[]'");
if(!ruleColumns.includes('negative_examples')) app.db.exec("ALTER TABLE rules ADD COLUMN negative_examples TEXT NOT NULL DEFAULT '[]'");
if(recording)for(const rule of recording.rules){
  const id=app.addRule(rule);
  app.run('UPDATE rules SET positive_examples=?,negative_examples=? WHERE id=?',JSON.stringify(rule.positiveExamples || []),JSON.stringify(rule.negativeExamples || []),id);
}
app.timeZone=app.one("SELECT value FROM settings WHERE key='timeZone'")?.value || 'UTC';
app.dayOneDate=app.one("SELECT value FROM settings WHERE key='dayOneDate'")?.value || undefined;
expireChatText(app);
// Sweep every minute so closed-session chat text expires within about a minute of the 24-hour deadline.
const retentionTimer=setInterval(()=>expireChatText(app),60*1000);retentionTimer.unref?.();
let organizerBusy=false,lastOrganizerTick=0,lastSummaryTick=0;
const organizerTimer=setInterval(async()=>{
  if(recording) return;
  if(organizerBusy) return;
  const now=Date.now(),organizerDue=now-lastOrganizerTick>=10000;
  if(organizerDue){lastOrganizerTick=now;try{app.retryDeletes();}catch{}}
  if(!app.currentSession() || replaying){lastSummaryTick=0;return;}
  const summaryDue=now-lastSummaryTick>=app.config.summaryIntervalSeconds*1000;
  if(!organizerDue && !summaryDue) return;
  organizerBusy=true;
  try{
    if(organizerDue){try{app.retryHeld();}catch{}try{await app.discover();}catch{}try{await app.labelMessages();}catch{}}
    if(summaryDue){lastSummaryTick=now;try{await app.refreshSummary();}catch{}}
  }finally{organizerBusy=false;}
},1000);organizerTimer.unref?.();
const dashboardToken=randomBytes(32).toString('hex'),overlayToken=randomBytes(32).toString('hex'); let replaying=false,stickerJobs=0;
const renderingStickers=new Set();
const privacyControllers=new Set();
app.onPrivacyChange=()=>{for(const controller of privacyControllers) controller.abort();};
const playback=recording ? new ChatReplay({app,recording}) : null;
const json=(res,status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(value));};
const valid=(a,b)=>typeof a==='string' && a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
function authorized(req){const cookie=(req.headers.cookie || '').split(';').map(x=>x.trim()).find(x=>x.startsWith('regulars_session=')); return valid(cookie?.slice('regulars_session='.length),dashboardToken);}
function sameOrigin(req){if(!req.headers.origin) return false;try{const u=new URL(req.headers.origin);return ['127.0.0.1','localhost','[::1]'].includes(u.hostname) && u.host===req.headers.host && u.protocol==='http:';}catch{return false;}}
async function body(req){let text='';for await(const chunk of req){text+=chunk;if(text.length>100000) throw new Error('Request too large');}return text ? JSON.parse(text) : {};}
function eligibleSource(id){return app.one("SELECT id,session_id,viewer_id FROM messages WHERE id=? AND moderation='cleared' AND bot=0 AND addresses_ai=0 AND text IS NOT NULL AND text NOT LIKE '!%'",id);}
function sourcesAvailable(ids){
  if(!ids.length) return false;
  const rows=ids.map(eligibleSource);
  return rows.every(Boolean) && new Set(rows.map(row=>row.session_id)).size===1 && rows.every(row=>app.one('SELECT id FROM viewers WHERE id=? AND opted_out=0',row.viewer_id));
}
function stickerEligible(s){
  const ids=JSON.parse(s.source_ids),contributors=JSON.parse(s.contributor_ids);
  return !!s.image && sourcesAvailable(ids) && contributors.length>0 && contributors.every(id=>app.one('SELECT id FROM viewers WHERE id=? AND opted_out=0',id));
}
function stickerRows(){return app.all('SELECT * FROM stickers').map(s=>({id:s.id,name:s.name,brief:s.brief,status:s.approved && stickerEligible(s)?'approved':s.image?'preview':'brief',imageUrl:s.image || '',credits:JSON.parse(s.contributor_ids).map(id=>app.one('SELECT name FROM viewers WHERE id=? AND opted_out=0',id)?.name).filter(Boolean)}));}
function topicDraft(input){
  const topic=String(input.topic || '').trim().slice(0,100),definition=String(input.definition || '').trim().slice(0,500);
  if(!topic || !definition) throw new Error('Provide a topic and definition.');
  const examples=value=>Array.isArray(value)?value.filter(item=>typeof item==='string').map(item=>item.trim().slice(0,300)).filter(Boolean).slice(0,5):[];
  return {id:'draft',name:topic,definition,positiveExamples:examples(input.positiveExamples),negativeExamples:examples(input.negativeExamples)};
}
function sessionDate(timestamp){
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:app.timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(timestamp));
  const values=Object.fromEntries(parts.map(part=>[part.type,part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function publicState(){
  const rows=app.all('SELECT a.session_id,a.title,a.subject,a.duration_ms,v.name,s.start FROM awards a JOIN viewers v ON v.id=a.viewer_id JOIN sessions s ON s.id=a.session_id WHERE a.active=1 AND v.opted_out=0 ORDER BY s.idx DESC,a.title,COALESCE(a.recipient_order,2147483647),v.name');
  const grouped=new Map();for(const row of rows){const key=`${row.session_id}\0${row.title}`;if(!grouped.has(key)){const award={title:row.title,date:sessionDate(row.start),recipients:[]};if(row.title==='Hype Engine' && row.subject!=null && row.duration_ms!=null){award.subject=row.subject;award.durationMs=row.duration_ms;}grouped.set(key,award);}grouped.get(key).recipients.push(row.name);}
  return {stickers:stickerRows().filter(s=>s.status==='approved').map(({brief,...s})=>s),awards:[...grouped.values()]};
}
function hasChannelData(){
  return ['sessions','viewers','messages','subjects','rules','stickers','awards','nudges','events','first_messages','moderation_actions'].some(table=>app.one(`SELECT 1 AS found FROM ${table} LIMIT 1`)) ||
    !!app.one("SELECT 1 AS found FROM settings WHERE key NOT IN ('timeZone','dayOneDate','dashboardConfig') LIMIT 1");
}
function prepareDemo(){
  if(app.one("SELECT value FROM settings WHERE key='demoSeeded'")) return;
  if(hasChannelData()) throw new Error('Existing channel data cannot be mixed with demo history.');
  app.db.exec('BEGIN IMMEDIATE');
  try{
    if(!seedDemo(app)) throw new Error('Existing channel data cannot be mixed with demo history.');
    app.run("INSERT INTO settings(key,value) VALUES ('demoSeeded','1')");
    app.db.exec('COMMIT');
  }catch(error){app.db.exec('ROLLBACK');throw error;}
}
async function replay(){
  if(replaying) return; replaying=true;
  try{
    if(liveConfigured) throw new Error('Replay is disabled while a Twitch channel is configured.');
    app.startSession();const subjectId=randomUUID(),now=Date.now(),subject='New microphone';
    app.run('INSERT INTO subjects (id,name,description,last_active) VALUES (?,?,?,?)',subjectId,subject,'Viewers discuss the new microphone and its sound.',new Date(now).toISOString());
    const lines=[['Ana','Is that a new microphone?'],['Ben','The microphone sounds so crisp'],['Cy','I love the microphone sound'],['Sam','The microphone sounds great tonight'],['Rae','I missed the new microphone reveal'],['Dee','That microphone is wonderful'],['Ben','LOL'],['Cy','lol LOL'],['Dee','LOL']];
    for(let i=0;i<lines.length;i++) await app.ingest({id:randomUUID(),eventId:randomUUID(),viewerId:`demo-${lines[i][0]}`,name:lines[i][0],text:lines[i][1],timestamp:new Date(now-10000+i*1000).toISOString()});
    try{await app.discover();await app.refreshSummary();}catch{}
  }finally{replaying=false;}
}
async function searchStickers(input){
  const controller=new AbortController();privacyControllers.add(controller);
  try{
  const name=String(input.subject || '').trim().slice(0,100);if(!name) throw new Error('Enter a subject.');
  const subject=app.one('SELECT * FROM subjects WHERE id=?',input.subjectId || '') || {name,description:name}; const session=app.currentSession();if(!session) return {selected:[],maybe:[]};
  const from=input.from ? Date.parse(input.from) : -Infinity,to=input.to ? Date.parse(input.to) : Infinity;
  if(Number.isNaN(from) || Number.isNaN(to) || from>to) throw new Error('Enter a valid search time range.');
  const rows=app.all("SELECT * FROM messages WHERE session_id=? AND moderation='cleared' AND bot=0 AND addresses_ai=0 AND text IS NOT NULL ORDER BY timestamp DESC",session.id).filter(m=>!m.text.startsWith('!') && Date.parse(m.timestamp)>=from && Date.parse(m.timestamp)<=to);
  const selected=[],maybe=[],scores=new Map(),identities=app.identities(),revision=app.revision,{matchThreshold,maybeThreshold}=app.config;
  const candidates=rows;
  const contextFor=m=>({
    reply:m.parent_id ? app.one("SELECT text FROM messages WHERE id=? AND moderation='cleared' AND text IS NOT NULL",m.parent_id)?.text : undefined,
    previousLine:app.one("SELECT text FROM messages WHERE viewer_id=? AND (timestamp<? OR (timestamp=? AND id<?)) AND moderation='cleared' AND text IS NOT NULL ORDER BY timestamp DESC,id DESC LIMIT 1",m.viewer_id,m.timestamp,m.timestamp,m.id)?.text,
  });
  async function scoreBatch(batch){
    try{
      const values=await ai.scoreSubjects({messages:batch.map(m=>({text:m.text,context:contextFor(m)})),subject,identities,signal:controller.signal});
      if(revision!==app.revision) throw new Error('Chat changed during this search. Try again.');
      if(values.length!==batch.length) throw new Error('Incomplete relevance results.');
      batch.forEach((m,i)=>scores.set(m.id,values[i]));
    }catch(error){
      if(batch.length<2 || !/scheduler token capacity|split relevance batches/i.test(error?.message || '')) throw error;
      const middle=Math.floor(batch.length/2);
      await scoreBatch(batch.slice(0,middle));await scoreBatch(batch.slice(middle));
    }
  }
  for(let i=0;i<candidates.length;i+=20) await scoreBatch(candidates.slice(i,i+20));
  if(revision!==app.revision) throw new Error('Chat changed during this search. Try again.');
  for(const m of rows){
    const score=scores.get(m.id);
    if(eligibleSource(m.id)?.session_id!==session.id) continue;
    const item={id:m.id,text:m.text,viewerName:m.name,timestamp:m.timestamp,score};
    if((m.subject_id && m.subject_id===subject.id) || score>=matchThreshold) selected.push(item);else if(score>=maybeThreshold) maybe.push(item);
  }
  return {selected,maybe};
  }finally{privacyControllers.delete(controller);}
}
async function generateSticker(input){
  const controller=new AbortController();privacyControllers.add(controller);stickerJobs++;
  try{
  const ids=[...new Set(Array.isArray(input.messageIds)?input.messageIds:[])].slice(0,100); if(!ids.length) throw new Error('Select at least one comment.');
  const session=app.currentSession();if(!session) throw new Error('Start a session before creating a sticker.');
  const sources=ids.map(id=>app.one("SELECT * FROM messages WHERE id=? AND session_id=? AND moderation='cleared' AND bot=0 AND addresses_ai=0 AND text IS NOT NULL AND text NOT LIKE '!%'",id,session.id));if(sources.some(s=>!s) || !sourcesAvailable(ids)) throw new Error('Some selected comments are no longer available.');
  const subject=String(input.subject || 'chat moment').slice(0,100),brief=await ai.stickerBrief({messages:sources.map(s=>s.text),subject,identities:app.identities(),signal:controller.signal});
  if(!await app.safeGeneratedText(brief,app.identities(),controller.signal) || controller.signal.aborted) throw new Error('The proposed brief did not pass the topic checks.');
  if(app.currentSession()?.id!==session.id || !sourcesAvailable(ids) || sources.some(s=>eligibleSource(s.id)?.session_id!==session.id)) throw new Error('A source comment was removed during generation.');
  const id=randomUUID();app.run('INSERT INTO stickers (id,name,subject,brief,image,source_ids,contributor_ids) VALUES (?,?,?,?,?,?,?)',id,subject,subject,brief,null,JSON.stringify(ids),JSON.stringify([...new Set(sources.map(s=>s.viewer_id))]));return {id};
  }finally{stickerJobs--;privacyControllers.delete(controller);}
}
async function renderSticker(id,input){
  if(renderingStickers.has(id)) throw new Error('This sticker is already rendering.');
  renderingStickers.add(id);
  const controller=new AbortController();privacyControllers.add(controller);stickerJobs++;
  try{
    const s=app.one('SELECT * FROM stickers WHERE id=?',id);if(!s || s.image) throw new Error('Sticker brief is unavailable.');
    const sourceIds=JSON.parse(s.source_ids),contributors=JSON.parse(s.contributor_ids),revision=app.revision;
    const eligible=()=>sourcesAvailable(sourceIds) && contributors.every(viewer=>app.one('SELECT id FROM viewers WHERE id=? AND opted_out=0',viewer));
    if(!eligible()) throw new Error('Sticker sources are no longer available.');
    const brief=createSanitizer(app.identities())(String(input.brief || s.brief).trim().slice(0,1000));
    if(!await app.safeGeneratedText(brief,app.identities(),controller.signal) || revision!==app.revision || controller.signal.aborted) throw new Error('The brief did not pass the topic checks.');
    const image=await generateImage({apiKey:key,prompt:brief,signal:controller.signal});
    if(revision!==app.revision || !eligible() || !app.one('SELECT id FROM stickers WHERE id=?',id)) throw new Error('A source comment was removed during generation.');
    app.run('UPDATE stickers SET image=?,brief=? WHERE id=?',image.url,brief,id);return {id};
  }finally{stickerJobs--;renderingStickers.delete(id);privacyControllers.delete(controller);}
}

const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8'};
const staticFiles=new Set(['index.html','app.js','style.css','appearance.css','overlay.html','overlay.js','crew.html','public.js','notice.html']);
const server=http.createServer(async(req,res)=>{
  try{
    const host=req.headers.host || '';if(!/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return json(res,403,{error:'Invalid host.'});
    const url=new URL(req.url,`http://${host}`),path=url.pathname;
    if(req.method==='GET' && path==='/twitch/callback'){
      if(!oauth){res.writeHead(303,{Location:'/?twitch=unavailable','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();}
      try{await oauth.complete(url.href);res.writeHead(303,{Location:'/?twitch=connected','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});}
      catch{res.writeHead(303,{Location:'/?twitch=failed','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});}
      return res.end();
    }
    if(req.method==='GET' && path==='/api/public') return json(res,200,publicState());
    if(req.method==='GET' && path==='/api/overlay') return valid(url.searchParams.get('token'),overlayToken) ? json(res,200,{event:app.overlayEvent}) : json(res,403,{error:'Invalid overlay token.'});
    if(path==='/api/dock/hotkey'){
      if(req.method!=='POST') return json(res,405,{error:'Use POST.'});
      if(!dockHotkeys.authorized(req.headers.authorization)) return json(res,401,{error:'Invalid OBS pairing token.'});
      if(req.headers.origin && !sameOrigin(req)) return json(res,403,{error:'Invalid origin.'});
      if(!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(res,415,{error:'Use JSON.'});
      const input=await body(req);
      if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length!==1 || typeof input.command!=='string') return json(res,400,{error:'Provide one dock command.'});
      const result=dockHotkeys.send(input.command);
      return json(res,result.status,result.error?{error:result.error}:{ok:true,id:result.event.id});
    }
    if(path.startsWith('/api/')){
      if(!authorized(req)) return json(res,401,{error:'Open the local dashboard first.'});
      if(req.method==='GET' && path==='/api/dock/pairing') return json(res,200,dockHotkeys.pairing(`http://127.0.0.1:${server.address().port}/api/dock/hotkey`));
      if(req.method==='GET' && path==='/api/dock/events'){
        if(!dockHotkeys.attach(req,res)) return json(res,429,{error:'Too many open docks.'});
        return;
      }
      if(req.method==='GET' && path==='/api/dock/script'){
        res.writeHead(200,{'Content-Type':'text/x-python; charset=utf-8','Content-Disposition':'attachment; filename="regulars_obs_hotkeys.py"','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        return res.end(readFileSync(join(root,'scripts','regulars_obs_hotkeys.py')));
      }
      if(req.method==='GET' && path==='/api/config') return json(res,200,{settings:app.config});
      if(req.method==='GET' && path==='/api/chat/recording'){
        if(playback) throw new Error('Save recordings from the live dashboard.');
        const saved=recordChat(app.db,{broadcasterId:twitchBroadcasterId || '',name:'Twitch chat recording'});
        res.setHeader('Content-Disposition','attachment; filename="regulars-chat.json"');
        return json(res,200,saved);
      }
      if(req.method==='GET' && path==='/api/playback/results'){
        if(!playback) throw new Error('Open a saved chat replay first.');
        res.setHeader('Content-Disposition','attachment; filename="regulars-replay-results.json"');
        return json(res,200,{...playback.results(),aiMode:offline?'offline':'live'});
      }
      if(req.method==='GET' && path==='/api/state'){
        const state=app.state();if(state.session && liveConfigured) state.session={...state.session,mode:'live',status:liveStatus.connected?'connected':'disconnected'};
        if(state.session && playback) state.session={...state.session,mode:'recorded-replay',status:playback.status};
        state.rules=app.all('SELECT id,name AS topic,definition,action,positive_examples,negative_examples FROM rules').map(rule=>({...rule,positiveExamples:JSON.parse(rule.positive_examples),negativeExamples:JSON.parse(rule.negative_examples)}));
        return json(res,200,{...state,stickers:stickerRows(),overlayUrl:`http://${host}/overlay.html?token=${overlayToken}`,aiMode:offline?'offline':'live',replaying,liveStatus,oauthAvailable:!!oauth,recordingAvailable:!playback,playback:playback?.state() || null,settings:{timeZone:app.timeZone,dayOneDate:app.dayOneDate || ''}});
      }
      if(req.method!=='POST') return json(res,404,{error:'Not found.'});
      if(!sameOrigin(req)) return json(res,403,{error:'Invalid origin.'});
      const input=await body(req);let match;
      if(path.startsWith('/api/playback/')){
        if(!playback) throw new Error('Open a saved chat replay first.');
        if(path==='/api/playback/play') await playback.play();
        else if(path==='/api/playback/pause') playback.pause();
        else if(path==='/api/playback/restart'){await playback.reset();await playback.play();}
        else if(path==='/api/playback/reset') await playback.reset();
        else if(path==='/api/playback/speed') playback.setSpeed(input.speed);
        else return json(res,404,{error:'Unknown playback action.'});
        return json(res,200,{playback:playback.state()});
      }
      if(path==='/api/config'){
        if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length!==1 || !Object.hasOwn(input,'settings')) throw new Error('Provide a settings object.');
        const settings=validateSettings(input.settings,app.config);
        app.db.exec('BEGIN IMMEDIATE');
        try{writeSettings(app.db,settings);app.db.exec('COMMIT');}catch(error){app.db.exec('ROLLBACK');throw error;}
        applySettings(settings);return json(res,200,{settings:app.config});
      }
      if(path==='/api/twitch/connect'){if(!oauth) throw new Error('Twitch app credentials or redirect are not configured.');return json(res,200,{url:oauth.begin()});}
      if(path==='/api/twitch/disconnect'){liveEpoch++;directController?.abort();oauth?.disconnect();liveBridge?.stop();liveBridge=null;app.getFollower=null;liveStatus={connected:false,reason:'Disconnected'};return json(res,200,{ok:true});}
      if(path==='/api/replay'){
        if(playback) throw new Error('Use the saved recording playback controls.');
        if(liveConfigured) throw new Error('Replay is disabled while a Twitch channel is configured.');
        if(replaying) throw new Error('Replay is already running.');
        prepareDemo();
        replay().catch(()=>{});return json(res,202,{started:true});
      }
      if(path==='/api/wrap') return json(res,200,{awards:await app.wrap()});
      if(path==='/api/settings'){
        const timeZone=String(input.timeZone || 'UTC'),dayOneDate=String(input.dayOneDate || '');
        try{new Intl.DateTimeFormat('en-US',{timeZone}).format();computeLoyalty({messages:[],timeZone,dayOneDate:dayOneDate || undefined});}catch{throw new Error('Enter a valid IANA time zone and calendar date.');}
        app.timeZone=timeZone;app.dayOneDate=dayOneDate || undefined;
        app.run("INSERT INTO settings (key,value) VALUES ('timeZone',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",timeZone);
        app.run("INSERT INTO settings (key,value) VALUES ('dayOneDate',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",dayOneDate);
        app.backfillFollowers();
        return json(res,200,{ok:true});
      }
      if(path==='/api/rules/draft'){
        const topic=String(input.topic || '').trim().slice(0,100);if(!topic) throw new Error('Provide a topic.');
        const controller=new AbortController(),revision=app.revision;privacyControllers.add(controller);
        try{const draft=await ai.draftTopic({topic,identities:app.identities(),signal:controller.signal});if(controller.signal.aborted || revision!==app.revision) throw new Error('Chat or rules changed during topic drafting. Try again.');return json(res,200,draft);}
        finally{privacyControllers.delete(controller);}
      }
      if(path==='/api/rules/test'){
        const topic=topicDraft(input),sample=String(input.text || '').trim().slice(0,500);if(!sample) throw new Error('Enter a sample message.');
        const controller=new AbortController(),revision=app.revision;privacyControllers.add(controller);
        try{const result=await ai.classify({text:sample,blockedTopics:[topic],subjects:[],identities:app.identities(),organize:false,signal:controller.signal});if(controller.signal.aborted || revision!==app.revision) throw new Error('Chat or rules changed during topic testing. Try again.');return json(res,200,{score:result.topics[0].score,nonEnglish:result.nonEnglish});}
        finally{privacyControllers.delete(controller);}
      }
      if(path==='/api/rules'){
        const topic=topicDraft({...input,definition:input.definition || input.topic});
        const id=app.addRule({name:topic.name,definition:topic.definition,action:input.action});
        app.run('UPDATE rules SET positive_examples=?,negative_examples=? WHERE id=?',JSON.stringify(topic.positiveExamples),JSON.stringify(topic.negativeExamples),id);
        app.revision++;app.abortClassifications();
        return json(res,201,{id});
      }
      if((match=path.match(/^\/api\/rules\/([^/]+)\/delete$/))){app.run('DELETE FROM rules WHERE id=?',decodeURIComponent(match[1]));app.revision++;app.abortClassifications();return json(res,200,{ok:true});}
      if(path==='/api/stickers/search') return json(res,200,await searchStickers(input));
      if(path==='/api/stickers/generate') return json(res,201,await generateSticker(input));
      if((match=path.match(/^\/api\/stickers\/([^/]+)\/render$/))) return json(res,200,await renderSticker(decodeURIComponent(match[1]),input));
      if((match=path.match(/^\/api\/stickers\/([^/]+)\/approve$/))){const id=decodeURIComponent(match[1]);const s=app.one('SELECT * FROM stickers WHERE id=?',id);if(!s || !stickerEligible(s)) throw new Error('Sticker sources or preview are no longer available.');app.run('UPDATE stickers SET approved=1 WHERE id=?',id);return json(res,200,{ok:true});}
      if(path==='/api/privacy/forget'){
        const viewerId=String(input.viewerId || '');
        const affected=viewerId ? app.all('SELECT id,contributor_ids FROM stickers').filter(s=>JSON.parse(s.contributor_ids).includes(viewerId)).map(s=>s.id) : [];
        if(liveBridge) liveBridge.forget(viewerId);else app.forget(viewerId);
        for(const id of affected) app.run('DELETE FROM stickers WHERE id=?',id);
        return json(res,200,{ok:true});
      }
      if(path==='/api/privacy/delete-channel'){
        if(playback) throw new Error('Use Reset replay to clear this simulation.');
        if(replaying || stickerJobs || app.pending.size || app.naming || app.wrapTask) throw new Error('Wait for active work to finish before deleting channel data.');
        app.revision++;app.abortClassifications();
        app.db.exec('DELETE FROM awards; DELETE FROM stickers; DELETE FROM nudges; DELETE FROM first_messages; DELETE FROM moderation_actions; DELETE FROM messages; DELETE FROM subjects; DELETE FROM rules; DELETE FROM viewers; DELETE FROM events; DELETE FROM sessions; DELETE FROM settings;');app.summary='';app.overlayEvent=null;app.timeZone='UTC';app.dayOneDate=undefined;applySettings({...DEFAULT_SETTINGS});liveBridge?.reset();return json(res,200,{ok:true});
      }
      if((match=path.match(/^\/api\/maybe\/([^/]+)\/review$/))){
        const id=decodeURIComponent(match[1]),m=app.one("SELECT * FROM messages WHERE id=? AND moderation='maybe'",id);if(!m) throw new Error('Message is no longer available.');
        if(input.action==='allow') app.run("UPDATE messages SET moderation='cleared',organizer='unassigned' WHERE id=?",id);
        else if(input.action==='hide' || input.action==='delete') app.run("UPDATE messages SET moderation='hidden',organizer='unassigned' WHERE id=?",id);
        else throw new Error('Invalid review action.');
        if(input.action==='delete'){
          if(!liveBridge) throw new Error('Twitch deletion is unavailable in replay mode; the message was hidden locally.');
          await app.guardedDelete(m.id,m.viewer_id,!!m.moderator);
        }return json(res,200,{ok:true});
      }
      if(path==='/api/nudges/pause'){app.pauseNudges(true);return json(res,200,{ok:true});}
      if((match=path.match(/^\/api\/nudges\/([^/]+)\/action$/))){const n=app.one('SELECT * FROM nudges WHERE id=?',decodeURIComponent(match[1]));if(!n) throw new Error('Nudge not found.');if(!['done','dismiss','mute'].includes(input.action)) throw new Error('Invalid action.');app.run('UPDATE nudges SET status=? WHERE id=?',input.action,n.id);if(input.action==='mute') app.run('UPDATE viewers SET muted=1 WHERE id=?',n.viewer_id);return json(res,200,{ok:true});}
      return json(res,404,{error:'Not found.'});
    }
    if(req.method!=='GET') return json(res,404,{error:'Not found.'});
    const name=path==='/' ? 'index.html' : path.slice(1); if(!staticFiles.has(name)) return json(res,404,{error:'Not found.'});
    const headers={'Content-Type':types[extname(name)] || 'application/octet-stream','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",'Referrer-Policy':'no-referrer','Cache-Control':'no-store'};
    if(name==='index.html') headers['Set-Cookie']=`regulars_session=${dashboardToken}; HttpOnly; SameSite=Strict; Path=/`;
    res.writeHead(200,headers);res.end(readFileSync(join(publicDir,name)));
  }catch(error){json(res,400,{error:error instanceof Error ? error.message : 'Request failed.'});}
});
const port=Number(process.env.PORT ?? 3000);
server.on('close',()=>{
  dockHotkeys.close();
  serverClosed=true;liveEpoch++;directController?.abort();oauth?.close();app.abortClassifications();clearInterval(retentionTimer);clearInterval(organizerTimer);
  if(playback) void playback.close().finally(()=>app.close());
  else if(liveConnectionTask) void liveConnectionTask.catch(()=>{}).finally(()=>{liveBridge?.stop();app.close();});
  else app.close();
});
server.listen(port,'127.0.0.1',()=>{
  console.log(`Regulars is available at http://127.0.0.1:${server.address().port} (AI: ${offline?'offline':'OpenRouter'}; Twitch: ${directTwitch?'connecting':oauthConfigured?'sign-in available':'disconnected'}).`);
  if(directTwitch){
    const epoch=liveEpoch;directController=new AbortController();
    liveConnectionTask=connectLive({app,clientId:twitchClientId,accessToken:twitchAccessToken,broadcasterId:twitchBroadcasterId,botNames,validate:options=>validateCurrentToken(options,epoch,directController.signal),onStatus:status=>{if(epoch===liveEpoch) updateLiveStatus(status);}})
      .then(bridge=>{if(serverClosed || epoch!==liveEpoch){bridge.stop();return;}liveBridge=bridge;app.getFollower=id=>bridge.client.getFollower(id);app.backfillFollowers();})
      .catch(()=>{if(!serverClosed && epoch===liveEpoch) liveStatus={connected:false,reason:'Twitch authorization or connection failed'};});
  }
  if(oauthConfigured){
    try{
      const redirect=twitchRedirectUri || `http://127.0.0.1:${server.address().port}/twitch/callback`;
      const parsed=new URL(redirect);if(parsed.pathname!=='/twitch/callback' || Number(parsed.port || 80)!==server.address().port) throw new Error('Invalid local redirect');
      oauth=new TwitchOAuth({clientId:twitchClientId,clientSecret:twitchClientSecret,redirectUri:redirect,
        onToken:async({accessToken,userId,signal})=>{
          if(userId!==twitchBroadcasterId) throw new Error('The authorized account does not match the configured broadcaster.');
          if(liveBridge){liveBridge.client.setAccessToken(accessToken);return;}
          const epoch=liveEpoch,pending=connectLive({app,clientId:twitchClientId,accessToken,broadcasterId:userId,botNames,validate:options=>validateCurrentToken(options,epoch,signal),onStatus:status=>{if(epoch===liveEpoch) updateLiveStatus(status);}});liveConnectionTask=pending;
          let bridge;try{bridge=await pending;}finally{if(liveConnectionTask===pending) liveConnectionTask=null;}
          if(signal.aborted || serverClosed || epoch!==liveEpoch){bridge.stop();throw new Error('Twitch authorization was canceled.');}
          liveBridge=bridge;app.getFollower=id=>bridge.client.getFollower(id);app.backfillFollowers();
        },
        onStatus:status=>{if(status.state==='reauthorize'){liveBridge?.stop();liveBridge=null;app.getFollower=null;liveStatus={connected:false,reason:'Twitch sign-in expired; reconnect.'};}}
      });
    }catch{liveStatus={connected:false,reason:'Invalid local Twitch redirect configuration'};}
  }
});
export {server,app};
