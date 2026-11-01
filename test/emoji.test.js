import test from 'node:test';
import assert from 'node:assert/strict';
import {isEmojiOnly} from '../src/emoji.js';

test('emoji-only detection covers flags, skin tones, joined families and keycaps',()=>{
  const messages=['😂😂','❤ ❤️','👍🏽','👨‍👩‍👧‍👦','🫱🏻‍🫲🏿','🏳️‍🌈','🇨🇦 🇯🇵',
    '1️⃣ 2\u20E3 #️⃣ *️⃣','😂\n🔥 \t👍🏽','\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}'];
  for(const text of messages)assert.equal(isEmojiOnly(text),true,JSON.stringify(text));
});

test('emoji-only detection preserves ordinary numbers, text and mixed messages',()=>{
  for(const text of ['',null,' \t\n','\u200D\uFE0F','123','1','# *','😂!!!','That boss 😂','مرحبا ❤️','Kappa']){
    assert.equal(isEmojiOnly(text),false,JSON.stringify(text));
  }
});
