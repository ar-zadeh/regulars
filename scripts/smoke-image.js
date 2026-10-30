import {existsSync,readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {generateImage} from '../src/images.js';
try {
  const line=existsSync('.env') ? readFileSync('.env','utf8').split(/\r?\n/).find(value=>/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=/.test(value)) : undefined;
  const key=process.env.OPENROUTER_API_KEY || line?.replace(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*/,'').trim().replace(/^(['"])(.*)\1$/,'$2');
  const image=await generateImage({apiKey:key,prompt:'A cheerful original cartoon microphone sticker, bold simple outlines, no words or logos, transparent background.'});
  const [,format,encoded]=image.url.match(/^data:image\/(png|webp|jpeg);base64,(.+)$/) || [];
  if(!format) throw new Error('Unexpected image format.');
  const path=`data/test-sticker.${format==='jpeg'?'jpg':format}`;
  mkdirSync('data',{recursive:true});writeFileSync(path,Buffer.from(encoded,'base64'));
  console.log(`Synthetic image smoke test passed; saved ${path}.`);
} catch(error) {
  const status=/^Image generation failed \(\d+\)\.$/.test(error.message) ? ` ${error.message}` : '';
  console.error(`Synthetic image smoke test failed.${status}`);
  process.exitCode=1;
}
