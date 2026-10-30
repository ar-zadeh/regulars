import { existsSync, readFileSync } from 'node:fs';
import { createAI } from '../src/ai.js';

try {
  const line = existsSync('.env') ? readFileSync('.env', 'utf8').split(/\r?\n/)
    .find(value => /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=/.test(value)) : undefined;
  const key = process.env.OPENROUTER_API_KEY || line?.replace(/^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*/, '')
    .trim().replace(/^(['"])(.*)\1$/, '$2');
  if (!key) throw new Error('OPENROUTER_API_KEY is required');
  const ai = createAI({ apiKey: key, offline: false });
  const decision = await ai.classify({ text: 'Is the microphone new?',
    blockedTopics: [{ id: 'topic', name: 'spoilers', description: 'Spoiling stories' }] });
  const scores = await ai.scoreSubjects({ subject: { name: 'new microphone', description: 'The new microphone' },
    messages: [{ text: 'The microphone sounds crisp' }, { text: 'I like pancakes' }] });
  const summary = await ai.summarize({ messages: ['Is the microphone new?', 'It sounds crisp.'] });
  const draft = await ai.draftTopic({ topic: 'fictional story spoilers' });
  if (!Number.isFinite(decision.nonEnglish) || scores.length !== 2 || !summary || !draft.definition || !draft.positiveExamples.length || !draft.negativeExamples.length) throw new Error('Incomplete response');
  console.log('Synthetic Jev classification, batched relevance, Luna summary, and topic draft passed.');
} catch (error) {
  console.error('Synthetic model smoke test failed:', error.message);
  process.exitCode = 1;
}
