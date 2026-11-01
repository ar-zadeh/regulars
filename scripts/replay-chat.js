import {parseArgs} from 'node:util';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {loadRecording} from '../src/chat-recording.js';

try{
  const {values,positionals}=parseArgs({allowPositionals:true,options:{port:{type:'string',default:'3001'},offline:{type:'boolean'},help:{type:'boolean'}}});
  if(values.help){
    console.log('Replay saved chat in a separate Regulars dashboard:\n  npm run chat:replay -- recording.json [--port 3001] [--offline]\nUse Play in the dashboard. The default uses your configured AI; --offline uses development heuristics.');
  }else{
    if(positionals.length!==1) throw new Error('Provide one saved recording file. Use --help for examples.');
    const port=Number(values.port);
    if(!Number.isInteger(port) || port<1 || port>65535) throw new Error('Choose a port between 1 and 65535.');
    const file=resolve(positionals[0]);
    const recording=loadRecording(file);
    const temporary=mkdtempSync(join(tmpdir(),'regulars-replay-'));
    Object.assign(process.env,{REGULARS_REPLAY_FILE:file,REGULARS_DATA_DIR:temporary,PORT:String(port)});
    if(values.offline)process.env.REGULARS_AI='offline';
    process.on('exit',()=>rmSync(temporary,{recursive:true,force:true}));
    const {server}=await import('../src/server.js');
    console.log(`Loaded ${recording.messages.length} recorded messages. Open http://127.0.0.1:${port} and press Play.`);
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
  }
}catch(error){console.error('Could not start replay:',error.message);process.exitCode=1;}
