const IMAGE_ENDPOINT = 'https://openrouter.ai/api/v1/images';

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

function awaitAbortable(work,signal){
  if(signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{
    const onAbort=()=>reject(signal.reason);
    signal.addEventListener('abort',onAbort,{once:true});
    Promise.resolve(work).then(value=>{signal.removeEventListener('abort',onAbort);resolve(value);},error=>{signal.removeEventListener('abort',onAbort);reject(error);});
  });
}

export async function generateImage({ apiKey, prompt, fetchImpl = fetch, timeoutMs = 120000, signal } = {}) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is required for sticker images.');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('A sticker brief is required.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Image timeout must be a positive integer.');
  if(signal?.aborted) throw new DOMException('Image request canceled','AbortError');

  const requestSignal=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
  const response = await awaitAbortable(fetchImpl(IMAGE_ENDPOINT, {
    method: 'POST',
    signal: requestSignal,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'openai/gpt-image-2.5-flare', prompt: prompt.slice(0, 1000),
      background: 'transparent', quality: 'low', aspect_ratio: '1:1', n: 1,
    }),
  }),requestSignal);
  if (!response.ok) throw new Error(`Image generation failed (${response.status}).`);

  const result = await awaitAbortable(response.json(),requestSignal);
  const image = result?.data?.[0];
  const encoded = image?.b64_json;
  if (typeof encoded !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) || !encoded) {
    throw new Error('Image provider returned no valid image.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  const actualType = imageType(bytes);
  if (!actualType || bytes.toString('base64') !== encoded) throw new Error('Image provider returned no valid image.');
  if (image.media_type && image.media_type !== actualType) throw new Error('Image provider returned a mismatched image format.');
  return { url: `data:${actualType};base64,${encoded}`, cost: result.usage?.cost };
}
