import {DatabaseSync} from 'node:sqlite';
import {readdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {parseArgs} from 'node:util';
import {recordChat,saveRecording} from '../src/chat-recording.js';

try{
  const {values}=parseArgs({options:{database:{type:'string'},session:{type:'string'},output:{type:'string'},name:{type:'string'},help:{type:'boolean'}}});
  if(values.help){
    console.log('Save retained chat with exact arrival gaps:\n  npm run chat:save -- [--database path.sqlite] [--session id] [--name "Test chat"] [--output path.json]');
  }else{
    const root=resolve(import.meta.dirname,'..'),dataDir=process.env.REGULARS_DATA_DIR || join(root,'data');
    let file=values.database;
    if(!file){
      const candidates=readdirSync(dataDir).filter(name=>/^regulars-live-.*\.sqlite$/.test(name));
      if(candidates.length!==1) throw new Error('Choose a channel database with --database; expected exactly one live database.');
      file=join(dataDir,candidates[0]);
    }
    const db=new DatabaseSync(resolve(file),{readOnly:true});
    let recording;
    try{recording=recordChat(db,{sessionId:values.session,name:values.name});}finally{db.close();}
    const output=resolve(values.output || join(dataDir,'recordings',`chat-${new Date().toISOString().replace(/[:.]/g,'-')}.json`));
    saveRecording(output,recording);
    console.log(`Saved ${recording.messages.length} messages over ${(recording.durationMs/1000).toFixed(3)} seconds.\n${output}`);
    console.log('Replay with: npm run chat:replay -- "'+output+'"');
  }
}catch(error){console.error('Could not save chat:',error.message);process.exitCode=1;}
