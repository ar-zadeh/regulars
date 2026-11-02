# Show topic labels instead of category badges, and stop topics absorbing other subjects

## Why

Streamers read chat in the narrow OBS dock. Every message card shows a category badge (Question, Funny, Opinion, Reaction, Other) next to the viewer's name. The streamer doesn't want that badge: every label should say what chat is actually talking about, such as "Monstera plant", "Arcane bleed build" or "Sunday stream time".

The organizer already names real topics. We measured it by replaying four realistic synthetic chats (126 messages, Appendix A) through `Regulars`. The replay used the production models via OpenRouter: JEV for classification and matching, Luna for naming. It ran at real speed with the settings from `src/server.js`: `retries: 0`, the 2 s classify timeout and a 10 s organizer tick. We did two runs:

| Chat | Topics created (run 1) | Right topic, run 1 · run 2 |
|---|---|---|
| Ranked FPS | Valorant Settings · Reyna Throwing · 1v3 Clutch · Valorant Patch Changes | 29/29 · 28/29 |
| Just Chatting | Juno's New Camera · Dune: Part Two · Biscuit the Cat · Sunday Stream Schedule | 30/32 · 30/32 |
| Elden Ring | Malenia Waterfowl Dance · Late-Night Ramen | 22/32 · 24/32 |
| Cozy (slow, 4 chatters) | Lena's New Job · Farm Sprinklers · Rainy Stardew Stream | 9/17 · 8/17 |

In both runs, 82% of topic messages landed under the right topic, 12% (run 1) and 9% (run 2) under a wrong one, and the rest stayed ungrouped. The cozy counts include four lines from 2-message subjects, which Appendix A now marks as `thin`, so the harness will report different totals.

What goes wrong:

1. **The badge is noisy and often wrong.** For example:
   - "sounds like the lofi girl playlist" → Question
   - "freezing pots interrupt her waterfowl btw" → Funny
   - "wait you got the job?? congrats!!" → Reaction
   - "the sandworm riding scene gave me chills" → Reaction
2. **Topics absorb other subjects.**
   - Run 1 put all 9 build messages ("why not arcane bleed instead of strength") under "Malenia Waterfowl Dance".
   - Run 1 also put "is that a monstera on the shelf behind you?" and the tea questions under "Rainy Stardew Stream".
   - Run 2 padded a 2-message "Lofi playlist" topic with a tea line.

   A wrong label is worse than none. The causes are in Part 2.
3. **Small conversations never get a name.** Luna proposed "Lofi Girl Playlist" three times. Two messages never meet the 3-message minimum, so both lines showed "Ungrouped · Question". In the slow chat, some messages waited over 3 minutes for a topic.
4. **Runs vary.** Run 2 formed "Arcane Bleed Build" correctly, but split Malenia into two topics: "Malenia Waterfowl Dance" and "Malenia Fight".

A scratchpad prototype of Part 1 performed well:

- **Accuracy:** all 10 topic messages that ended ungrouped got a correct label. Examples: "Monstera plant" (twice), "Tea choice" (three times), "Biscuit keyboard typing" for "she typed jjjjjjjj in chat", "Monday stream", "Resolution settings", "Community Center bundles" and "Rain on mic".
- **Noise:** greetings and emotes stayed unlabelled, except "hi lena! cozy stream today", which got "Cozy stream".
- **Speed:** labels appeared about 6 s after the message, 14 s at most.
- **Cost:** 33 Luna calls labelled 40 messages for about $0.0025.

## Part 1: Replace the category badge with topic labels

### What the streamer sees

- **Messages in a topic.** The group header already names the topic, so show nothing extra on the card.
- **Ungrouped messages.** Show the message's about label, a 1–4 word name for its subject, where the badge was. Hide that slot when the label is null (greetings, emote-only text, generic reactions) or still pending.
- **Community reader.** A reminder's linked message is shown by `renderCommunityReader` in `public/app.js`. Show the linked message's topic name, or else its about label, or nothing.
- **Sticker "Pick messages" list.** `public/app.js` (around line 648) shows the raw `item.category`. Show the topic name or about label instead.
- **Replay log.** `public/app.js` (around lines 827–829) shows "Original: Question → Replay: Opinion". Show the replay's topic or about label instead of categories. Keep `category` and `recordedCategory` in the downloadable results JSON for compatibility, and add `about`. Recordings may also save `about` in `previousResult`, but older recordings without it must still load.
- **No category words.** Question, Funny, Opinion, Reaction and Other should appear nowhere in the dock.

Keep `category` as an internal field. It still drives the "asked a question" reminder (`src/core.js` around line 274) and question-first ordering within a group (`public/app.js` around line 326).

Keep the 3-message minimum for topics. Thin conversations get consistent about labels instead of topic chips.

### Generating labels

**In `src/ai.js`:**

- Add `labelMessages({earlierChat, targets, existingLabels, identities, signal})`, using `generate()` (Luna, low reasoning).
  - Input: up to about 20 earlier readable messages (oldest first), the labels already in use, and the target messages with their reply text.
  - Output: a JSON array with one string or null per target, in order.
  - Throw on invalid JSON or a length mismatch, as `nameSubjects` does. Offline mode returns nulls.
- Clean every label with the existing helpers: sanitize, strip URLs and @mentions, and keep at most 4 words.
- Reject generic labels. Extend `isGenericSubjectName` with words such as stream, chat, gameplay and greeting. Also reject labels that contain sanitizer placeholders such as `viewer_3`.
- Start from the instruction that worked in the prototype. `generate()` already appends the untrusted-data sentence.

  > Label what each target chat message is about. Return the specific subject in 1 to 4 words: the person, game moment, object, plan, show or running joke being discussed (for example "Malenia waterfowl dodge", "Ramen flavor", "Sunday stream time"). Use the earlier chat (oldest first) and the reply to resolve pronouns and short follow-ups. Reuse an existing label exactly when a message is about the same subject. Never use message-type labels such as Question, Opinion, Reaction, Funny or Other, or vague labels such as Chat, Stream or Gameplay. Use null for greetings, farewells, emote-only messages and generic reactions that name no subject. Return only a JSON array with one string or null per target, in order.

**In `src/core.js`:**

- Add an `about` column to `messages`, following the existing `ALTER TABLE ... ADD COLUMN` migrations. Store `''` for "no subject" so a message isn't relabelled every tick.
- Add a labelling method and call it once per organizer tick, after `discover()`, in both `src/server.js` and `src/chat-replay.js`.
  - Targets are current-session messages that are cleared and readable (`isTopicMessage`, not commands), have no `subject_id` and no label yet, and arrived within the last 5 minutes.
  - Label at most 30 messages per call, newest first.
  - Run one call at a time, and respect `revision` and the model abort controllers as `discover()` does.
- Include `about` in `rows()` so that `/api/state` carries it.
- Labels are derived from message text, so clear `about` wherever the text is cleared: `removeMessage` and `expireChatText` in `src/retention.js`.
- Drop labels that match a blocked topic or read as instructions to the software. Reuse `safeGeneratedText` or a batched equivalent, so a burst of labels can't trigger dozens of extra calls.

**In the docs:** update `README.md` and `twitch_x_codex.md` §5.

- In `README.md`, the OBS dock section says category tags appear beside the viewer's name, and the replay section describes categories in its logs.
- In `twitch_x_codex.md` §5, the spec says categories remain message badges.
- State that offline mode produces no labels, and that labelling makes at most one Luna call per organizer tick.

## Part 2: Stop topics from absorbing other subjects

Fix all three causes; each produced a wrong label in the runs above.

### 1. The matching prompt treats the streamer and the game as a shared subject

`conversationMatch` and `conversationCriteria` (`src/ai.js` around lines 10–14) group messages about the "same person, show, object, activity or situation" even when they discuss different aspects. Everything in a stream shares the streamer and the game.

- **Effect:** JEV scored build questions 0.71–0.91 against "Malenia Waterfowl Dance". Those lines were assigned at classify time and never reached the discovery pool, so a Build topic could never form.
- **Fix:** tell JEV that sharing only the streamer, the stream or the game is not enough. A different specific point about them is a different conversation: a character build versus a boss strategy, or a plant on the shelf versus the rain.
- **Keep:** different aspects of one specific subject must still group together. The `multitopic` fixture's blue-hair lines (colour, eyebrows, profile picture) must stay in one topic.

The spec's original false criterion was "a different point, or only the same game or stream in general" (`twitch_x_codex.md` §5, step 2).

### 2. Discovery only compares the proposals from the current pass

`assignments()` in `discover()` (`src/core.js` around lines 412–416, and again in the lookback around line 435) chooses only among this pass's candidates.

- **Effect:** "ramen break before the next try?" scored Ramen 0.81 and Malenia 0.75 at classify time. A later pass re-proposed only Malenia, so the line went there.
- **Fix:** store each message's classify-time subject scores at or above `maybeThreshold`. The spec already calls for this in §5 step 2 and in the message-assignment record. Include existing subjects as competitors, using those stored scores, whenever discovery or lookback assigns a message.
- **Keep:** close ties stay ungrouped, as they do in live matching.

### 3. A new topic can borrow evidence from other subjects

Proposals that fail the 3-message check are dropped before assignment (`src/core.js` around line 408). That leaves their messages free for another proposal to claim.

- **Effect:** "Monstera" and "Chamomile Tea" had 2 lines each. "Rainy Stardew Stream" then registered with 2 rain lines plus 4 plant and tea lines.
- **Fix:** keep every scored proposal as a competitor during assignment, including in the lookback. Register only proposals that still have 3 qualifying messages afterwards.
- **Result:** a message whose best match is an unregistered proposal stays ungrouped and gets an about label.

### If build lines are still absorbed

If, after these three fixes, build lines in the Elden Ring chat still land under a Malenia topic, make the smallest structural change that solves it, and explain it. For example, let a naming pass consider recently assigned messages with weak margins. Then move them through the existing JEV comparison in the re-home step (around lines 437–462).

### Don't trade absorption for duplicates

A stricter prompt can split one subject into two topics, as run 2 did with "Malenia Waterfowl Dance" and "Malenia Fight". Report any duplicate topics for one subject. If they appear, reuse or broaden the existing topic rather than registering a near-duplicate.

## Part 3: Validate

### Unit tests

Use `node:test` with synthetic data and mocked models.

- **`labelMessages`:** sanitization, generic and placeholder rejection, the word limit, length mismatch, and offline nulls.
- **Labelling in core:**
  - only ungrouped readable messages are targeted;
  - nothing is relabelled;
  - null labels are handled;
  - labels are cleared on removal, forget and retention;
  - work is aborted on revision changes.
- **Discovery:**
  - an unregistered proposal's messages are not absorbed (the cozy case);
  - an existing topic with a higher stored score blocks a weaker re-proposed one (the ramen case);
  - close ties stay ungrouped.
- **Frontend:**
  - Ungrouped shows the about label;
  - messages in a topic show none;
  - no category words render.

  Update the existing badge tests in `test/frontend.test.js` (around lines 230–320) rather than deleting their coverage.
- `npm test` must pass.

### Real-model evaluation

**Fixtures:**

- Append the four chats in Appendix A to `test/fixtures/twitch-chats.js`.
- Update `test/topic-eval.test.js` (it expects 11 chats) and the count in `README.md`.
- Cozy lines tagged `thin` belong to 2-message subjects. They are expected to stay ungrouped (`expected: null`) but should get an about label. The evaluator reads the tag; the models never see it.

**Tooling:**

- Add an opt-in `--luna openrouter` flag to `scripts/evaluate-topics.js`. With it, `generate()` calls (naming and labels) use the real Luna model instead of the Codex worker.
- Extend `budgetedJevFetch` in `scripts/topic-eval-support.js` to accept `openai/gpt-6-luna` chat completions, but only when that option is set.
  - Reserve each call by its `max_tokens` at the highest listed Luna price.
  - Record the actual cost from `usage`.
  - The default stays JEV-only, and the existing guard test must keep passing.
- Record each message's final topic and about label in the per-chat results. Add a section to `report.md` that lists every reader-visible message that ended ungrouped, with its label, for review.

**Runs:**

- Run all 15 chats once on the unchanged code (`--split all --luna openrouter --run before-1`), then twice after the changes (`after-1`, `after-2`).
- Each full run takes roughly 10–15 minutes at 1× speed.
- Keep total spend under $2. The ledger already enforces a cumulative cap. Never print the API key.

### Acceptance criteria (both after-runs)

- No build line in `souls` sits under a Malenia topic.
- "ramen break before the next try?" is not under Malenia.
- No cozy plant, tea or music line sits under another subject's topic.
- Wrong-topic messages are at most 5% of topic messages across the four new chats.
- `ranked` keeps at least 27/29 right, and `justchatting` at least 29/32.
- On the 11 existing chats, right-topic coverage and pair precision drop by no more than 3 points compared with `before-1`.
- At least 90% of topic messages that end ungrouped, including `thin` lines, show a correct, specific label.
- Greetings and emote-only messages mostly show no label.

If a target can't be met, say which one and why. Don't tune to the fixtures.

## Constraints

- Follow `AGENTS.md`: ES modules, the surrounding code style (including the dense style of `src/core.js`), no new dependencies and no formatter.
- Labels are private to the streamer. Don't add them to the public overlay or the awards.
- Keep `.env` and `data/` private.

## When you're done

- Make focused commits (labels, absorption fixes, evaluation tooling) with imperative subjects. Don't push.
- Report:
  - the files you changed and the decisions you made;
  - the `npm test` result;
  - a before/after table per chat from the evaluation;
  - the label review list;
  - total spend;
  - known limitations.
- If you can capture one, include a screenshot of the dock at about 360 px wide showing an Ungrouped message with its label.

## Appendix A: four simulated chats

Append these entries to `twitchChats` in `test/fixtures/twitch-chats.js`. They use that file's `chat()` helper.

```js
  // Topics: malenia = Malenia fight: dodging waterfowl, attempts, the kill; build = Character build: bleed / arcane vs strength, level; ramen = Streamer eating ramen at 2am
  chat('souls','Elden Ring boss night (game stream, medium chat)','dev',[
    [0,1,'malenia attempt #47 lets gooo','malenia'],
    [3,2,'hi chat',null],
    [5,3,'dodge waterfowl by running away, then roll INTO the third flurry','malenia'],
    [8,1,'KEKW',null],
    [10,4,'just bloodhound step through the waterfowl ez','malenia'],
    [13,5,'what build is this? str/faith?','build'],
    [16,3,'rivers of blood + bleed ash of war i think','build',{parent:5}],
    [19,6,'rivers of blood got nerfed into the ground tho','build'],
    [22,2,'is that ramen at 2am lol','ramen'],
    [24,4,'the mic picked up that slurp KEKW','ramen'],
    [27,1,'she healed off your block again','malenia'],
    [30,5,'stop blocking, her lifesteal works through your guard','malenia'],
    [33,6,'what flavor is the ramen','ramen'],
    [35,3,'PHASE 2 LETS GO','malenia'],
    [37,7,'PogChamp',null,{reaction:true}],
    [39,1,'scarlet aeonia incoming, run far','malenia'],
    [42,2,'shin ramyun is elite stream food','ramen'],
    [45,5,'why not arcane bleed instead of strength','build'],
    [49,4,'arcane scales way better with bleed procs yeah','build'],
    [52,7,'NOOOOO one hit away','malenia'],
    [54,1,'attempt 48 here we go','malenia'],
    [57,6,'!deaths',null],
    [59,8,'Deaths: 312',null,{bot:true}],
    [63,3,'use mimic tear for phase 1, no shame','malenia'],
    [67,5,'using mimic tear on malenia is basically cheating lmao','malenia'],
    [70,2,'dont let the ramen get cold','ramen'],
    [74,4,'freezing pots interrupt her waterfowl btw','malenia'],
    [78,6,'im switching my char to arcane after watching this','build'],
    [83,7,'what level are you','build'],
    [88,3,'rl 150 probably','build',{parent:28}],
    [92,2,'monkaS',null],
    [96,5,'ramen break before the next try?','ramen'],
    [100,2,'the noodle break is earned','ramen'],
    [105,7,'SHE IS DOWN?? NO WAY','malenia'],
    [106,3,'MALENIA DOWN LETS GOOOO','malenia'],
    [107,4,'GG GG GG',null],
    [110,6,'clip that waterfowl dodge','malenia'],
    [115,1,'47 attempts was worth it','malenia'],
    [120,5,'now respec to arcane like we said','build'],
  ]),
  // Topics: camera = Streamer's new camera, lens and lighting; dune = Dune: Part Two movie discussion; cat = Biscuit the cat on the desk; schedule = Sunday stream time / collab, Monday cancellation
  chat('justchatting','Just Chatting with Juno (new camera, Dune, cat cameo, schedule)','dev',[
    [0,1,'hiii juno',null],
    [2,2,'the new camera is SO crisp today','camera'],
    [5,3,'wait new cam? what model','camera'],
    [8,1,'looks like a sony a6400 maybe','camera'],
    [11,4,'did anyone see dune part two yet','dune'],
    [14,2,'lighting is kinda orange on the left side tho','camera'],
    [17,5,'dune 2 was peak cinema','dune'],
    [20,3,'the sandworm riding scene gave me chills','dune'],
    [23,4,'austin butler as feyd was terrifying','dune'],
    [26,6,'BISCUIT ON THE DESK','cat'],
    [27,1,'CAT TAX PAID','cat'],
    [29,2,'biscuit is sitting on the keyboard lmao','cat'],
    [31,6,'she typed jjjjjjjj in chat','cat'],
    [34,5,'are you streaming sunday?','schedule'],
    [37,3,'book fans hated the chani changes','dune'],
    [40,4,'nah chani was way better in the movie','dune',{parent:14}],
    [43,1,'what time is the sunday stream','schedule'],
    [46,2,'turn the key light down a bit and it would be perfect','camera'],
    [49,6,'is biscuit even allowed on the desk?','cat'],
    [52,7,'first time here, love the vibes',null],
    [55,5,'panels say sunday 3pm est','schedule'],
    [58,3,'hans zimmer cooked with that soundtrack','dune'],
    [62,4,'LUL',null,{reaction:true}],
    [65,2,'autofocus keeps hunting when you lean back','camera'],
    [69,1,'biscuit just knocked the mic over OMEGALUL','cat'],
    [73,7,'is the sunday stream a collab?','schedule'],
    [77,6,'protect the mic from biscuit','cat'],
    [82,5,'anyone know if dune messiah is getting made','dune'],
    [86,3,'villeneuve confirmed messiah is next','dune',{parent:27}],
    [91,1,'what lens is on the new cam','camera'],
    [96,2,'probably the sigma 18-50, super common for streamers','camera',{parent:29}],
    [101,4,'is monday still canceled?','schedule'],
    [106,6,'biscuit fell asleep on the stream deck','cat'],
    [112,7,'ok i need to go watch dune now','dune'],
    [118,5,'sunday collab with who??','schedule'],
    [122,4,'OMEGALUL',null],
  ]),
  // Topics: settings = Streamer's sens / dpi / crosshair / resolution; patch = Patch balance: new agent, operator nerf; teammate = Throwing Reyna teammate; clutch = The 1v3 clutch play
  chat('ranked','Ranked FPS (settings questions, patch opinions, teammate, clutch)','dev',[
    [0,1,'whats your sens','settings'],
    [2,2,'crosshair code pls','settings'],
    [4,3,'this new agent is so broken lol','patch'],
    [6,4,'dpi?','settings'],
    [8,1,'the reyna on your team is throwing hard','teammate'],
    [10,5,'they need to nerf the new agent wall asap','patch'],
    [12,2,'sens is in the !settings command i think','settings'],
    [15,3,'reyna is 2 and 14 bro','teammate'],
    [17,4,'this patch ruined the operator','patch'],
    [19,5,'just mute the reyna, not worth it','teammate'],
    [22,6,'!rank',null],
    [24,7,'Rank: Immortal 2',null,{bot:true}],
    [27,1,'1v3 lets see it','clutch'],
    [29,2,'HE GOT ONE','clutch'],
    [30,3,'TWO','clutch'],
    [31,4,'NO WAY 1V3 CLUTCH','clutch'],
    [32,5,'W',null],
    [33,6,'that flick on the last guy was insane','clutch'],
    [35,1,'clip it clip it','clutch'],
    [38,2,'what res do you play on, stretched?','settings'],
    [41,3,'the reyna is typing in all chat again lmao','teammate'],
    [44,4,'op was fine before the patch, now its useless','patch'],
    [47,5,'reyna said skill issue after going 2-15 KEKW','teammate'],
    [51,6,'the new agent ult is so overtuned','patch'],
    [55,1,'that 1v3 is going in the highlight reel','clutch'],
    [59,2,'crosshair is green 0 4 2 2 right?','settings'],
    [63,4,'riot never playtests their patches','patch'],
    [67,3,'reyna instalocked and is baiting every round','teammate'],
    [71,5,'0.35 sens at 800 dpi','settings',{parent:0}],
    [75,6,'GG',null],
    [78,1,'dont queue with that reyna again','teammate'],
    [82,2,'the op nerf was deserved tbh','patch'],
    [86,4,'still thinking about that clutch','clutch'],
  ]),
  // Topics: stardew = Stardew farm: sprinklers, community center; plant = Monstera plant on the shelf (2 lines, thin); job = Congrats on Lena's new job; tea = Streamer's chamomile tea; rain = Rain sounds where the streamer is; music = Background lofi playlist (2 lines, thin)
  chat('cozy','Small cozy Stardew stream (slow chat, 4 chatters)','dev',[
    [0,1,'hi lena! cozy stream today',null],
    [18,2,'the farm is looking so good','stardew'],
    [41,1,'is that a monstera on the shelf behind you?',null,{thin:'plant'}],
    [58,2,'wait you got the job?? congrats!!','job'],
    [62,1,'CONGRATS LENA','job'],
    [67,3,'so happy for you, you worked so hard for that','job'],
    [90,3,'what tea are you drinking','tea'],
    [118,2,'you should put the sprinklers in a grid so you dont have to water every day','stardew'],
    [140,1,'mine has three new leaves this month',null,{thin:'plant'}],
    [165,3,'chamomile is the best for night streams','tea'],
    [190,4,'is it raining where you are? i can hear it on your mic','rain'],
    [214,2,'iridium sprinklers cover a 5x5 area btw','stardew'],
    [236,4,'rain sounds + stardew is peak comfy','rain'],
    [258,3,'what playlist is this?',null,{thin:'music'}],
    [280,1,'sounds like the lofi girl playlist',null,{parent:13,thin:'music'}],
    [302,2,'dont forget to finish the community center bundles before winter','stardew'],
    [325,3,'honey in chamomile is elite','tea'],
    [340,4,'Sadge rain stopped','rain'],
  ]),
```
