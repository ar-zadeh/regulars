import test from 'node:test';
import assert from 'node:assert/strict';
import { generateImage } from '../src/images.js';

const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex').toString('base64');
const webp = Buffer.from('524946460400000057454250', 'hex').toString('base64');
const reply = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });

test('image request uses supported model controls, a deadline, and a private brief', async () => {
  let request;
  const result = await generateImage({
    apiKey: 'test-key', prompt: 'Original microphone sticker', timeoutMs: 250,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return reply({ data: [{ b64_json: png, media_type: 'image/png' }], usage: { cost: 0.01 } });
    },
  });
  assert.equal(request.url, 'https://openrouter.ai/api/v1/images');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer test-key');
  assert.equal(request.options.signal.aborted, false);
  const payload = JSON.parse(request.options.body);
  assert.deepEqual(payload, {
    model: 'openai/gpt-image-2.5-flare', prompt: 'Original microphone sticker',
    background: 'transparent', quality: 'low', aspect_ratio: '1:1', n: 1,
  });
  assert.equal(result.url, `data:image/png;base64,${png}`);
  assert.equal(result.cost, 0.01);
});

test('image response detects the actual type when media_type is omitted', async () => {
  const result = await generateImage({ apiKey: 'key', prompt: 'test', fetchImpl: async () => reply({ data: [{ b64_json: webp }] }) });
  assert.equal(result.url, `data:image/webp;base64,${webp}`);
});

test('image response rejects missing, malformed, and mismatched output', async () => {
  for (const image of [undefined, { b64_json: 'aGVsbG8=' }, { b64_json: 'bad!' }, { b64_json: png.slice(0, -1) }, { b64_json: png, media_type: 'image/svg+xml' }]) {
    await assert.rejects(
      generateImage({ apiKey: 'key', prompt: 'test', fetchImpl: async () => reply({ data: [image] }) }),
      /valid image|mismatched image format/,
    );
  }
});

test('image errors expose only status and invalid timeouts fail before fetch', async () => {
  await assert.rejects(
    generateImage({ apiKey: 'private-key', prompt: 'private brief', fetchImpl: async () => reply({ error: { message: 'private brief private-key' } }, 400) }),
    error => error.message === 'Image generation failed (400).',
  );
  await assert.rejects(generateImage({ apiKey: 'key', prompt: 'test', timeoutMs: 0, fetchImpl: async () => { throw new Error('called'); } }), /timeout/);
});

test('image request aborts a stalled fetch at its deadline', async () => {
  await assert.rejects(generateImage({
    apiKey: 'key', prompt: 'test', timeoutMs: 5,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  }), error => error.name === 'TimeoutError');
});

test('image request aborts when its source is forgotten', async () => {
  const controller=new AbortController();
  const work=generateImage({apiKey:'key',prompt:'test',signal:controller.signal,
    fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),
  });
  controller.abort();
  await assert.rejects(work,error=>error.name==='AbortError');
});

test('image request releases stalled fetch and JSON parsing even if the provider ignores abort', async () => {
  await assert.rejects(generateImage({apiKey:'key',prompt:'test',timeoutMs:5,fetchImpl:()=>new Promise(()=>{})}),error=>error.name==='TimeoutError');
  await assert.rejects(generateImage({apiKey:'key',prompt:'test',timeoutMs:5,fetchImpl:async()=>({ok:true,json:()=>new Promise(()=>{})})}),error=>error.name==='TimeoutError');
  const controller=new AbortController();
  const work=generateImage({apiKey:'key',prompt:'test',signal:controller.signal,fetchImpl:()=>new Promise(()=>{})});
  controller.abort();
  await assert.rejects(work,error=>error.name==='AbortError');
});
