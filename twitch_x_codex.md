# Regulars: Turn Your Chat Into a Crew

Oct 25, 2026 · @Borna · Updated Oct 27, 2026

## Overview

Regulars remembers your chat, helps the streamer welcome viewers, organizes the
conversation, turns your community's moments into inside jokes, crowns the
night's MVPs, and keeps chat clean. It is an entry for the OpenAI Codex x
TwitchCon Hackathon.

All five features run on one shared community memory, which is what makes
Regulars one product rather than a bundle of bots.

## The five features

### 1. Lurker Bridge (the memory)

- Remembers who shows up, not just who talks. A regular is someone seen in 3
  of the last 5 streams, either chatting or in Twitch's list of viewers with
  chat open.
- Privately nudges the streamer when a regular arrives, even one who never
  chats ("Sam is here, 4 of the last 5 streams"), when someone returns after
  missing several streams, and when Regulars sees a viewer's first message. For
  example: "Sam asked about your build. Give their question a quick answer when
  you can."
- Shows a private "Who's here" panel: the regulars in chat right now, split
  into chatting and lurking.
- Uses remembered subjects to suggest natural conversation starters, without
  calling attention to how often someone chats.
- Every other feature builds on this memory.

### 2. Chat Stickers (inside jokes, made live)

Stickers turn subjects and messages selected by the streamer into inside jokes
the channel can reuse.

- The streamer selects a subject from Chat organizer, which gathers its related
  comments, or types a subject. Either way, Jev then scores every message in
  the stream for relevance to it.
- The streamer reviews the collected comments and can adjust the selection or
  select individual messages. The assistant then generates a sticker from that
  context with an image model.
- The streamer previews and approves each sticker before it appears on the
  overlay or in the channel sticker book. Only the streamer can request sticker
  creation; viewers can use approved stickers.
- Inside-joke stickers keep their source comments privately and credit their
  contributors publicly. Generic stickers are channel-themed reactions anyone
  can use.
- Stickers pop up on the overlay when triggered (`!sticker sam`) and collect
  into a public channel sticker book that shows each sticker and its credits,
  never chat quotes.
- Constraint: Twitch doesn't let apps create real chat emotes through the API,
  since emotes go through Twitch's own upload and approval. Stickers live on
  the overlay and in the sticker book. The streamer can manually upload
  favorites as real emotes, a "graduation" moment worth pitching.

### 3. End-of-Stream Awards (the Warzone moment)

When the streamer presses **Wrap** in the dashboard or types `!wrap` before
ending the stream, the overlay plays an awards card. If the stream ends without
a wrap, Regulars saves the awards quietly.

| Title | Awarded for |
| --- | --- |
| Hype Engine | The first 10 distinct contributors to the longest discussion detected by Chat organizer |
| Night Owl | Chatting between midnight and 5 AM in the streamer's time zone |
| Day One | Following the channel on or before a date the streamer picks |

Hype Engine uses the chat organizer's discussion records to find the longest
discussion by duration. Its first 10 distinct contributors receive the title;
if fewer than 10 participated, all qualifying contributors receive it. Night
Owl and Day One use rules and stored history. Only viewers who chatted during
the stream appear on the card.

Comeback Kid is now a private Lurker Bridge nudge. Returns, arrivals, and first
messages stay private cues for the streamer to say something friendly. They do
not appear in the public awards.

Titles persist on the sticker book's Crew page, so viewers have a reason to
come back.

### 4. Guardrails (simple moderation)

- The streamer lists topics they don't want in chat, in plain words: "my ex,"
  "politics," "backseat gaming." For each topic they choose **Hide from me**
  (it disappears from the Regulars dashboard) or **Keep out of chat** (Regulars
  also deletes it from Twitch chat).
- Jev decides whether a message brings up a listed topic. Unsure cases go to a
  **Maybe** tray for the streamer or a mod.
- Code collects repeated messages from each 10-second frame into one dashboard
  row, such as `LOL (X20)`.
- Twitch's AutoMod and Blocked Terms handle everything else, such as slurs and
  harassment. Regulars deletes messages but never warns, times out, or bans;
  those stay with human mods.
- Uses Twitch's moderation endpoints, so it works alongside existing mods and
  AutoMod.

### 5. Chat organizer (follow the conversation)

The chat organizer helps the streamer keep up with the conversation as new
messages arrive.

- Uses Jev to tag each message (question, funny, opinion, reaction, or other)
  and to match it to the conversation subjects already found. The tags are a
  fixed list.
- Routes messages that fit no subject to **New**. An LLM names coherent new
  subjects, which Jev then uses for future messages.
- Uses an LLM to write a one-sentence summary of the current conversation.
- Tracks discussion duration and each viewer's first contribution. Passes these
  records to End-of-Stream Awards to choose the Hype Engine recipients.
- Lets the streamer select a subject or search for one to collect related
  comments for Chat Stickers.

## How it fits in one stream

1. **Start:** Lurker Bridge privately lists the regulars already in chat, each
   with a conversation starter from remembered subjects.
2. **During:** Chat organizer groups incoming messages and summarizes the
   conversation, tracking discussions for Hype Engine. Lurker Bridge privately
   nudges the streamer when regulars arrive, when someone returns, and when a
   first message needs an answer. The streamer selects or searches for subjects
   for Chat Stickers, while Guardrails keeps unwanted topics out.
3. **End:** The streamer presses Wrap before ending the stream. The awards card
   recognizes the first 10 contributors to the longest discussion and the
   viewers who meet the loyalty rules. The memory updates for next time.

## Implementation plan

Use code for rules, tracking, timestamps, and counts; Jev for classification and
relevance judgments; an LLM for new names, summaries, and sticker briefs; and an
image model for the sticker itself. This division follows the documented
[Jev 1.13 limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13).
The defaults below are starting choices to validate with recorded chat.

### Models and Twitch access

Pin every model. SDK defaults and older tutorials point at moving or retired
ones.

| Job | Model | Notes |
| --- | --- | --- |
| Tags, subjects, relevance, topic checks | Jev, pinned (for example `jev-1.14.0`) | Both TypeSafe SDKs default to `jev-latest`, which now points to 1.14, while the limitations page covers 1.13. Run the replay set on the pinned version and include the model ID in every cache key. |
| Subject names, summaries, sticker briefs, topic definitions | `gpt-6-luna` | OpenAI's fast tier. Not `gpt-4.1-nano`, which shut down Oct 23. |
| Sticker images | `gpt-image-2.5-flare` | Images API (`/v1/images/generations`) with `background: "transparent"`, PNG output, and an explicit `low` or `medium` quality. It returns base64 only, so store the file. Complex prompts can take up to 2 minutes. Not `gpt-image-1`, which shut down Oct 23. Complete OpenAI organization verification early. |

Connect to EventSub over WebSocket with the broadcaster's user token, so no
public server is needed. Request these scopes, and check at startup that all of
them were granted:

| Scope | Used for |
| --- | --- |
| `user:read:chat` | Chat messages and the three removal events |
| `moderator:manage:chat_messages` | Deleting **Keep out of chat** messages |
| `moderator:read:chatters` | Presence, through Get Chatters |
| `moderator:read:followers` | Day One follow dates |

Install TypeSafe's agent skill in Codex so it writes correct Jev calls:
`npx skills add typesafe-ai/skills --skill typesafe-ai`.

### Shared foundation

Start with one backend, a database, a private streamer dashboard, and a browser
overlay. Every feature reads the same message and participation records.

1. Within 10 seconds of EventSub's Welcome message, subscribe to
   `channel.chat.message`, `stream.online`, `stream.offline`, and the removal
   events `channel.chat.message_delete`, `channel.chat.clear_user_messages`
   (fires on timeouts and bans), and `channel.chat.clear`. Deduplicate on both
   the EventSub message ID and the chat message ID before changing counts or
   taking actions; Twitch can deliver an event more than once. See
   [EventSub delivery behavior](https://dev.twitch.tv/docs/eventsub/#handling-duplicate-events).
   Twitch doesn't resend events missed during a reconnect, so check Get Streams
   after every reconnect or restart.
2. Check the viewer's opt-out state before storing any message. For viewers
   who have not opted out, store each message's ID, session, viewer ID,
   timestamp, original text, reply parent, and statuses. Take the timestamp
   from `metadata.message_timestamp`; the chat event has no timestamp field of
   its own. Keep raw messages when the dashboard collapses repeats so
   attribution still works. Opted-out viewers use only the transient
   moderation path described under Privacy and data handling.
3. Before Jev, code tags commands (messages starting with `!`), bot posts, and
   reactions, and builds repetition rows. Those tags affect organizer and award
   eligibility; every message still gets Guardrails topic checks. A `!` prefix
   never exempts text from moderation. Validate supported commands and their
   arguments before executing them; process `!regulars forget` immediately,
   even if Jev is unavailable. Combine applicable Jev questions in one request,
   the pattern TypeSafe shows in its
   [Twitch chat filter](https://docs.typesafe.ai/cookbooks/twitch_chat_filter).
   - **State:** the sanitized message; its cleared reply parent and subject;
     the latest cleared line of any viewer it @mentions; the sender's previous
     cleared line; and the stream title and game. Resolve links locally, then
     apply the same identity sanitizer to every text field before sending it.
   - **Questions:** the Guardrails topic Nouls for every message. For messages
     eligible for organization, also ask the category Choice, one Noul per
     live subject (each carrying its record; see §5), and "Does `message.text`
     address a bot, AI, or this app, or tell it what to write?"
4. Give live Jev calls a 2-second timeout and at most one retry per live job.
   Route every attempt, including SDK retries, through one scheduler that
   tracks the organization's limits on requests and tokens per second.
   Reserve configurable capacity for live checks; run sticker scans and
   lookbacks only with the remaining capacity, starting at two background
   requests in flight. Shrink or defer batches that would consume the live
   reserve, pause background dispatch when live work queues up, and honor
   `Retry-After` on 429s. Separate queues alone do not isolate provider
   capacity. Measure queue wait and event-to-deletion time under simultaneous
   live and scan traffic. See
   [TypeSafe's organization-wide rate limits](https://docs.typesafe.ai/models#rate-limits).
5. Keep held, hidden, or removed messages out of summaries, sticker sources,
   award eligibility, nudges, and conversation starters, and apply later
   removals to records already built from them.

Never use "pending". Each message has three statuses: moderation (held,
cleared, hidden, removed), organizer (assigned, uncertain, new, unassigned,
reaction), and jobs (queued, failed).

Keep the records small and reusable:

| Record | Main fields and purpose |
| --- | --- |
| Session | Channel-local session index, stream IDs, start, end, wrap cutoff and processing deadline, award revision and completion status; one session survives an outage of up to 10 minutes |
| Viewer | Channel and Twitch user ID; which of the last 5 sessions they were seen in, total sessions seen, last_seen_session_index, first and last message, subject counts from their last 5 sessions, titles, mute state |
| Message | ID, session, viewer, timestamp, text (expires), reply parent, the three statuses |
| Message assignment | Message ID, category, subject probabilities of 0.3 or more (primary flagged), model ID |
| Semantic cache | Channel, model and question versions, rule and subject versions, sanitized-input digest, source and context message IDs for invalidation |
| Subject | Stable ID, name, description, last active, exclude-from-awards flag |
| Blocked topic | Name, definition and examples, action, version |
| Moderation action | Message ID, topic, action, idempotency key, result |
| Nudge | Type, viewer, status, expiry |
| Sticker | Subject, source message IDs, brief, image, approval, contributor IDs |
| Award | Session, title, recipient, source message IDs, active or retracted; unique on session, title, and recipient |

Discussions are computed from assignments when needed, not stored.

Keep API keys and authorization checks on the backend. Only the broadcaster can
request or publish a sticker; chat messages cannot change rules or permissions.
The overlay URL carries a secret token. The overlay receives only approved
stickers and the awards card, and renders chat-derived text with `textContent`,
never `innerHTML`.

### 1. Lurker Bridge: rules and tracking

Implement this as database updates and a small rules engine that reads
organizer labels but makes no Jev calls. Values are starting defaults.

- **Identity:** key memory by channel and Twitch user ID, since logins change.
  Lurker Bridge and Awards share one exclusion list: the broadcaster, the app's
  account, a configurable bot list seeded with known lurker bots, and Shared
  Chat messages from other channels (`source_broadcaster_user_id` set).
- **Presence:** while live, poll
  [Get Chatters](https://dev.twitch.tv/docs/api/reference/#get-chatters) every
  30 s. The first poll that includes a viewer marks their arrival for this
  session. The list holds logged-in viewers with this channel's chat open,
  whether or not they type. Logged-out viewers never appear, and Twitch says
  the list updates after an unstated delay, so measure it on day 1. An open
  chat isn't proof of watching, and lurker bots sit in thousands of channels,
  which is why the bot list and the Mute action matter.
- **Definitions:** a session runs from stream online to offline (see §3 for
  outages). A viewer is *seen* in a session if they chat or appear in the
  chatter list. A **regular** was seen in at least 3 of the channel's last 5
  sessions. A **return** is a viewer seen in at least 2 earlier sessions who
  missed the last 3 or more in a row and is seen now.
- **Return history:** give each new channel session a consecutive index; an
  outage that resumes the same session keeps that index. Persist each viewer's
  `last_seen_session_index`, including sightings without a message. On their
  first sighting in a session, calculate missed sessions as the current index
  minus the previous last-seen index minus one, before updating the stored
  value. This keeps return counts accurate after more than 5 missed sessions.
- **Nudges:**
  1. A regular arrives: "Sam is here (4 of the last 5 streams). Last time: the
     bridge jump." The first poll after going live produces one "already here"
     greeting list instead of separate nudges.
  2. A return: "Sam is back after missing 4 streams." This replaces the public
     Comeback Kid title.
  3. A first message Regulars has seen, never worded as a new viewer:
     questions only until the channel has 3 recorded sessions, and never for
     moderators, VIPs, commands, or repeated messages.
- **Starters:** use subject labels, never quotes from earlier sessions.
  Interests are the subjects of a viewer's cleared messages in their last 5
  sessions, limited to subjects that came up in 2 or more sessions; the
  streamer can hide any subject. The nudge shows counts privately, but the
  suggested opener is topic-first and never mentions silence or frequency.
- **Queue:** show a message nudge only after its message is cleared and
  classified, and withdraw it if a removal event deletes the message. Allow one
  new nudge per 60 s, three open, and one per viewer per session; later events
  update that viewer's nudge, for example when a lurker starts chatting.
  Priority: first-message questions, returns, other first messages, regular
  arrivals. Message nudges expire after 3 minutes and arrival nudges after 10.
  `!lurk` marks a viewer as lurking on purpose: their nudge says so, and they
  get no more nudges this session. Actions: Done, Dismiss, Mute viewer (never
  nudge about this account), Pause for this stream.
- **Who's here:** the same poll feeds a private dashboard panel listing the
  regulars in chat now, split into chatting and lurking, with their recent
  subjects.
- **Presence stays private:** it never reaches the overlay or public pages and
  never counts toward awards. Store which of the last 5 sessions a viewer was
  seen in, a total count, and `last_seen_session_index`.
- **Demo seed:** replay about 6 earlier sessions (~300 messages, ~12 personas)
  through ingestion with historical timestamps and presence entries. The seed
  takes no Twitch actions and creates no nudges or awards. Include a regular
  who mostly lurks, a viewer who returns after 3 missed sessions, and a bot
  that is present every stream. Personas who appear live use the team
  accounts' real user IDs. Say in the video that the history is seeded.

Later: auto-clear a nudge when the broadcaster replies, and a raid card.

### 2. Chat Stickers: select or search a subject

Use Chat organizer's subjects for selection, and Jev to judge whether each
message is about the subject the streamer selects or types.

1. Selecting an organizer subject pre-selects its cleared messages at once,
   then scans the range with the subject's name and description, so lines the
   organizer filed elsewhere or marked uncertain still appear. A typed subject
   runs the same scan on submit. The default range is this stream; the
   streamer can narrow it and remove lines.
2. The scan asks one Jev **Noul** per message: "Is `chat_message` about
   `subject`?" True: it mentions, jokes about, asks about, or reacts to the
   subject, including by nickname, emote, or a reply to a message about it.
   False: it is about something else, is a greeting or hype that nothing ties
   to the subject, or only shares a word with it.
3. Batch them like the
   [Noul structured-instructions example](https://docs.typesafe.ai/primitives/noul#structured-instructions):
   state holds the subject, stream title, and game; each question's
   instructions hold one message and its reply parent beside the fixed question
   text. Aim for 40k estimated tokens per request only when the scheduler's
   background allowance permits it; otherwise split the batch or wait. Stay
   within the 64k request and 32k per-question context limits, and split any
   request rejected with `max_tokens_exceeded`. Scan cleared, non-command,
   non-bot messages newest first, streaming results in with a progress count.
   A 2,000-line stream takes about 10 requests and costs a cent or two, so
   there is no full-text search, embedding index, or shortlist: Jev judges
   every line.
4. The noul is the relevance score. Sort by it, pre-select at 0.7 or above,
   list 0.3–0.7 unselected under **Maybe**, and hide the rest. It is the
   probability that a line is about the subject, not a measure of closeness,
   and a Noul returns no separate confidence. Tune both cut-offs on labeled
   replay.
5. After review, generate a short sticker brief and image for preview and
   approval, keeping every selected source ID. Chat reaches the LLM only as
   quoted data, and the brief asks for no real people's likenesses and no
   trademarked characters. Start the image as soon as the brief is approved
   and stream partial images; keep a pre-generated fallback for the video.
6. Viewers trigger approved stickers with `!sticker <name>`, limited by a
   per-viewer and a channel-wide cooldown. The overlay shows one sticker at a
   time and queues a few more.

Ask about each message separately so any number can qualify; a Choice over
message IDs sums to 1 and always ranks some line first
([line-by-line search](https://docs.typesafe.ai/cookbooks/semantic_find)).
Each question is judged independently against its supplied context. Keep
unrelated chat out of that context. Cache answers by channel, model and question
versions, subject definition version, and a digest of the exact sanitized
message, reply context, stream title, and game sent to Jev. Keep local source
and context IDs for invalidation after edits, removals, or opt-outs. A subject
name or message ID alone is not enough to reuse an answer. Cancel superseded
scans and discard results whose inputs are no longer eligible.

### 3. Awards: longest discussion and loyalty rules

Chat organizer determines which messages belong together. Code computes
duration, orders contributors, and assigns awards from those records.

- **Sessions:** open or resume a session on `stream.online` (type `live`), or
  when Get Streams shows the channel live after a restart or reconnect.
  Messages outside a session earn nothing. After `stream.offline`, a wrapped
  session closes; an unwrapped one waits 10 minutes (a stored deadline) for the
  stream to return, then closes once Get Streams confirms it is offline.
- **Wrap:** the dashboard Wrap button and the broadcaster's `!wrap` share one
  endpoint. The first wrap records a message cutoff and a processing deadline
  5 seconds later. Only messages already received at the cutoff can earn
  awards. Use that interval to finish their moderation, assignments, naming,
  lookbacks, and award checks, then calculate and save the card. New arrivals
  cannot extend the cutoff, and repeated wrap requests cannot start another
  finalization job.
- **Incomplete processing:** at the deadline, save the completed evidence and
  show only verified awards. If organizer jobs needed to choose the longest
  discussion remain unfinished, omit Hype Engine and show a private status
  explaining that the discussion results were incomplete. Keep the card's
  six-second display target. Late results may update chat history but cannot
  silently add recipients to the saved card.
- **Replay and corrections:** later wraps replay the current saved card.
  Removals and opt-outs override the saved result: retract affected awards and
  invalidate the card, Crew page, and overlay copies before another display.
  A replay must use the corrected revision. Offline never plays the card;
  when an unwrapped session closes, use the same bounded finalization process
  with its last received message as the cutoff and save quietly. A dashboard
  button can replay it during the next stream. Remind the streamer to wrap
  before raiding out or ending.
- **Hype Engine:** a discussion runs from its first to last qualifying message,
  and a gap over 60 seconds starts a new one. Candidates need 3 or more
  eligible contributors and a subject the streamer hasn't excluded from awards;
  the dashboard shows the current leader. Pick the longest (ties: more
  contributors, then earlier start) and award its first 10 contributors in
  message-timestamp order. Messages that joined from the New pool or a lookback
  keep their original timestamps, so whoever started a conversation before it
  had a name still counts first.
- **Eligibility:** exclude the broadcaster, bots, and Shared Chat guests, and
  ignore commands, repetition-only messages, and hidden or removed messages,
  including every message of a viewer cleared by a timeout or ban.
- **Night Owl** (per session): a qualifying message between 00:00 and 05:00 in
  the streamer's IANA time zone. Code does the conversion and comparison;
  unit-test a session that crosses midnight and one that spans a DST change.
- **Day One** (once): earned when a viewer chats and Get Channel Followers
  (with `user_id`) shows `followed_at` on or before the Day One date the
  streamer set. Check once per viewer per session until earned, and cache the
  result.
  Without `moderator:read:followers`, Twitch returns no follow date, which
  looks like "not following".
- **Card:** Hype Engine shows the subject, its duration, and up to 10 names;
  Night Owl and Day One show up to 5 names plus "+N more", and Day One appears
  only in the session it is first earned. Only viewers who chatted this stream
  appear. The card never shows chat text, counts, or presence, and any title
  can be turned off. The sticker book's Crew page lists titles and dates.

### 4. Guardrails: blocked topics, repeat rows, and AutoMod

Keep repetition grouping in code. Use Jev only for the topics the streamer
lists, and leave everything else to Twitch's AutoMod.

- **Topic setup:** the streamer names each topic in plain words. An LLM drafts
  a one-line definition plus a few messages that do and don't count; the
  streamer edits them and tests them on sample messages before turning the
  topic on. Each topic becomes one Jev **Noul**, "Does `message.text` bring up
  `topic`?", where yes means the message should go. See
  [Jev Noul](https://docs.typesafe.ai/primitives/noul).
- **Coverage:** check blocked topics even when a message is a command, bot
  post, or reaction. These messages skip subject discovery and awards only.
  For example, adding `!` before a blocked sentence must not change its
  moderation result. Command authorization and argument validation are
  separate from deciding whether its text violates a topic rule.
- **Actions:** each topic is set to **Hide from me** (the message disappears
  from the Regulars dashboard; Twitch chat is untouched) or **Keep out of
  chat** (Regulars also deletes it from Twitch chat). At 0.7 or above, apply
  the action. From 0.3 to 0.7, the message goes to a collapsed **Maybe** tray,
  where keep-out items have a one-click delete. Messages not in English only
  ever go to the Maybe tray, because Jev is less accurate outside English.
- **Hidden means hidden everywhere:** a hidden or deleted message never feeds a
  subject, sticker, summary, or award, so a blocked topic can't win "longest
  discussion".
- **No automatic penalties:** Regulars deletes but never warns, times out, or
  bans. A viewer who keeps raising a blocked topic appears on the dashboard
  with a count, and human mods handle them in Twitch.
- **Guarded delete:** every deletion goes through one function that rejects an
  empty message ID (without one, Twitch clears the entire chat), skips the
  broadcaster's and moderators' messages, and records an idempotency key.
- **Timing:** turn on Twitch's 2-second non-moderator chat delay. Treat deletion
  before display as best effort: a 2-second Jev timeout plus a retry, queue
  wait, and the Twitch deletion request can exceed that delay. Measure median
  and 95th-percentile time from event arrival to successful deletion, including
  during sticker scans and 429 responses, before claiming how often deletion
  beats display. Keep the message held in Regulars until its check completes.
- **AutoMod:** slurs, harassment, and sexual content go to Twitch's AutoMod and
  Blocked Terms, configured in the Creator Dashboard. Regulars doesn't change
  AutoMod settings.

Repetition rows:

- Key each message by channel, reply parent (if any), and text: casefold, trim
  and collapse whitespace, and remove the invisible characters clients append
  to get past Twitch's 30-second duplicate check (U+034F, U+E0000–U+E007F,
  U+00AD, U+200B–U+200D, U+2060, U+FEFF). A message made of one repeated token
  (`LOL LOL LOL`) keys as that token.
- A key's first message opens a row covering the next 10 seconds. Matches in
  that frame join it, and the first match after the frame opens a new row.
  From the second match the row reads `LOL (X2)`, `LOL (X3)`, and so on. Counts
  never fall with time, and a finished row keeps its final count. Group by
  stored message timestamps, not timers, so replays produce the same rows.
  Show the first cleared member's original text and emotes, and keep eligible
  members' IDs and authors. Twitch's native chat is unchanged.
- Grouping is a display operation. Each member gets its own moderation result
  and, when eligible, its own organizer assignment. Cache a Jev answer only
  when the channel, model and question versions, topic and subject versions,
  and exact sanitized inputs match. The input digest includes the message,
  reply context, sender's previous line, mentioned viewer's line, subject
  descriptions and recent examples, and stream title and game when supplied.
  Identical display text with different context requires a fresh decision.
- Members with identical semantic inputs may share an in-flight request;
  matching a display row is insufficient. Show and count only cleared members,
  and apply hide or delete decisions to the individual messages that matched.
  Recalculate the visible row when a member is removed or opts out; a row may
  lose members for those reasons, but never because its 10-second frame ended.
  A removal also invalidates cached answers that used that message as context.
- Rows stay in the streamer's dashboard, off the public overlay. Collecting is
  the whole response to repetition; rows keep per-author counts.

### 5. Chat organizer: tags, subjects, New, and discussions

Separate a message's category from its subject. A question about the
streamer's new mic is tagged **question** and belongs to the **New microphone**
subject. Categories stay internal for reminders and question-first ordering;
subjects are the visible groups. A subject is one
specific point people are discussing (a moment, question, claim, or running
joke), never the game, the stream, or a broad theme: "New microphone", not
"Streaming gear".

1. Code tags commands, bot posts, and reactions: messages made only of emotes,
   or only of reaction words such as lol, GG, and W plus the channel's
   third-party emote names. These skip organizer questions, never enter the
   New pool, and never count toward a discussion. Guardrails topic checks
   still run for each message.
2. In the per-message request, ask a **category** Choice (question, funny,
   opinion, reaction, other, each defined in one line). For each live subject
   (the 30 most recently active), also ask a **Noul**: "Is `message.text` part
   of the specific conversation in `subject`?" Following the
   [structured-instructions pattern](https://docs.typesafe.ai/primitives/noul#structured-instructions),
   each subject Noul carries that subject's record: name, description, and its
   latest 2 lines, so Jev compares the message directly with that conversation.
   Each message also carries its reply and up to 8 preceding eligible chat
   lines from the last 2 minutes, in chronological order, to resolve short
   follow-ups. Use this context in discovery and lookback checks too, including
   an existing about label as a subject hint when it agrees with the message.
   The `false` criterion is "a different point, or only the same game or stream
   in general". Store probabilities at or above the configured maybe threshold
   (0.3 by default), and retain those existing subjects as competitors in
   discovery and lookback. Different aspects of one specific subject, such as
   new hair colour and its matching profile picture, still belong together.
3. The best subject at 0.7 or above is primary. If two subjects both reach 0.7,
   the message is **uncertain** unless it is a reply, in which case it takes
   the reply parent's subject. A best of 0.3–0.7 is also uncertain (a sticker
   "maybe"). If all are below 0.3, or there are no subjects yet, the message
   joins the **New pool**. Uncertain messages also participate in discovery:
   a weak match to an existing subject must not prevent a new topic forming.
4. A message leaves the pool once it is at least 15 seconds old and 20 newer
   messages have arrived, or once it is 5 minutes old. In busy chat that is 15
   seconds; in quiet chat it waits for replies. Leaving the pool doesn't delete
   a message: it stays in the chat feed, unassigned, with its about label.
5. When the pool holds 3 messages and has grown since the last successful
   pass, run a naming pass: one at a time, at most every 10 s. The LLM sees the
   newest 60 pool messages in chronological order (text only, no usernames) and the current subject
   names, and proposes up to 3 subjects, each either new (a name and a
   one-sentence description) or an existing one identified by its supplied
   index. Another aspect of the same event reuses that index and broadens the
   existing name and description. Jev checks each pool message
   against each proposal with the step-2 Noul, in bounded batches. A new
   proposal is registered only if 3 messages confidently belong to it. One
   viewer can start a subject with 3 distinct lines; repeating one line does
   not qualify. Compare every scored proposal before assigning ambiguous lines,
   including proposals with fewer than three matches. Only register a new
   proposal if three qualifying messages remain after competition; messages
   won by unregistered proposals stay ungrouped.
   Reuse existing subject IDs. Keep the messages' original timestamps.
   Reject generic category names; unassigned messages appear in **Ungrouped**
   with a private 1–4 word about label beside the viewer name. Grouped cards
   show no extra label. Community reminders and sticker selection use the
   linked message's topic name, then about label, then nothing. Offline mode
   produces neither topic names nor labels. After discovery, each organizer
   tick makes at most one Luna labelling call for the newest 30 cleared,
   readable, ungrouped messages from the last 5 minutes with no label yet.
   Include up to 20 earlier readable lines, replies, and labels already in use.
   Store an empty string for no subject so greetings and generic reactions
   are not retried. Batch safety checks, discard blocked or instructional
   labels, abort on revision changes, and clear labels when text is removed
   or expires. Labels never appear in the public overlay or awards.
6. When a subject is registered, run a **lookback**: Jev checks it against the
   messages from the last 5 minutes that have no primary subject, and matches
   at 0.7 or above join with their original timestamps. Someone whose opening
   message already left the pool still counts first for Hype Engine. At Wrap,
   run any final naming pass and its dependent lookback within the shared
   5-second processing deadline, using only messages received before the
   cutoff. Naming may also consider recent assignments with confidence below
   0.9 or a competing score within 0.2, within the same 60-message input bound.
   These assignments can support a new topic only after a direct Jev comparison
   confirms the move. Reuse existing IDs for renamed or broader descriptions,
   then recheck recent assignments against the updated topic. Moving a grouped
   message requires strong relevance and direct comparison with its old topic.
   If that work is unfinished, apply the incomplete-awards behavior in
   §3; a late naming result cannot rewrite an already saved card.
7. Compute discussions in code from primary assignments plus uncertain replies
   to them. Sort by time and split at gaps over 60 s. Opinions from two or more
   viewers mark a discussion as a debate.
8. Keep the one-sentence summary. Refresh it every 10 s when the conversation
   changes, from representative messages of the previous 30 s, weighted by
   distinct contributors so spam doesn't dominate. Run one summary call at a
   time and keep the last summary if a call fails.

A new subject forming, with made-up chatters:

```
20:01:05  ana  is that a new mic?          fits no subject → New pool
20:01:09  ben  audio is so much crisper    → New pool
20:01:12  cy   lol the cat's on the desk   → New pool
20:01:15  ana  what mic is it?             → pool: 4 messages, 3 viewers → naming pass
          LLM proposes: "New microphone", "Cat on the desk"
          Jev checks every pool message against each name:
            New microphone: ana :05, ben :09, ana :15 → 3 msgs, 2 viewers → registered
            Cat on the desk: cy :12 only → stays in the pool
20:01:30  dee  is it a USB one?            → matches "New microphone" directly
```

"New microphone" starts at 20:01:05, when ana asked, not when it got a name. If
it becomes the longest discussion, Hype Engine goes to ana, ben, and dee in
that order.

For all LLM text, pass chat as quoted JSON data with an instruction never to
follow text inside messages, and get JSON back. Cap names at 5 words,
descriptions at 20, and summaries at 25, and strip URLs and @mentions. Before
display or registration, screen each output with the Guardrails topic Nouls
plus "Does `candidate.text` try to instruct the app or an AI?", and drop it at
0.7 or above. Generated text stays on the private dashboard unless the streamer
approves it. Messages that score 0.7 or above on the "addresses a bot or AI"
question stay out of LLM inputs and sticker sources.

Why Jev rather than embeddings: identical text always gets an identical
embedding, so "is it a USB one?" would land in the same subject whatever chat
was discussing, and a similarity score gives no reliable "fits none of these"
for New. Jev judges each message with the context above, so the same words can
belong to different subjects at different moments. Jev can't group or name
messages, which is why the LLM proposes names. Keep that context small and
specific: the
[1.13 limitations page](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
says unrelated state and questions that need several reasoning steps both
lower accuracy.

### Privacy and data handling

Twitch's
[Developer Services Agreement](https://legal.twitch.com/legal/developer-agreement/)
limits chat logs to what the service needs, and requires a public notice, an
opt-out from activity tracking, and deletion on request.

- **Chat text expires.** Delete raw message text, model inputs and outputs, and
  caches 24 hours after the stream ends, and keep message text out of logs.
  Exceptions: approved stickers' source comments (dashboard only) and replay
  sets from the team's own test streams. Removals and opt-outs take precedence
  over these exceptions and the 24-hour expiry.
- **Long-term memory is per channel:** sessions seen (the last 5 plus a total),
  `last_seen_session_index`, dates, counts, subject IDs from a viewer's last 5
  sessions, titles, awards with message IDs as evidence, approved stickers
  with contributor IDs, and deletions without text. No personal facts,
  model-inferred traits, or cross-channel joins.
- **Removals.** On the three removal events, delete the affected text; drop
  those messages from summaries, sticker sources, awards, and nudges; and flag
  approved stickers that used them. Invalidate caches and queued or in-flight
  results that refer to the message, including copies used as reply context.
  Retract affected awards even after Wrap and refresh public card and Crew
  page copies. A room-wide clear deletes stored text and its cached copies
  but keeps non-text award eligibility; individual deletions, user clears,
  and opt-outs still override that eligibility.
- **Opt-out.** `!regulars forget`, matched to the sender's user ID, deletes
  that viewer's text, presence, activity, interests, titles, credits, sticker
  source quotes, and cached context, and adds the ID to an opt-out list.
  Cancel queued work and discard in-flight results that could restore those
  records. Update saved cards, the Crew page, sticker credits, and overlay
  copies immediately, including after Wrap. Process later messages only in a
  bounded in-memory moderation task, then discard their text on completion or
  timeout. Never write that text to the database, caches, persistent job
  queues, logs, organizer, or sticker sources. Keep only the opt-out entry and
  minimal text-free moderation identifiers needed to avoid duplicate actions.
  These viewers are never tracked, credited, awarded, or nudged. The dashboard
  can also forget a viewer or delete all channel data.
- **Notice.** A short public page, linked from a channel panel, says what is
  stored (including who had chat open), for how long, what is public, which AI
  providers process chat, and how to opt out or ask for deletion.
- **AI inputs.** Resolve reply and mention relationships on the backend, then
  sanitize every outbound model payload. Omit Twitch user ID, login, and
  display-name fields. Replace `@mentions` and known logins or display names
  embedded in message text, reply quotes, nearby lines, subject records,
  definitions, stream metadata, and sticker briefs with anonymous labels.
  Keep labels consistent within a request and keep the identity mapping on
  the backend. Jev gets sanitized messages and context; the LLM gets sanitized
  messages and subject names; the image model gets only the sanitized,
  approved brief. Check outbound payloads for identifiers inside text as well
  as in metadata, including names copied into quoted context.
- **Public pages and the overlay** show approved stickers with contributor
  names and award cards, never chat quotes, presence, interests, activity,
  per-viewer pages, or viewer search, and they leave out opted-out viewers.

Record the demo on the team's channel with participants who know Regulars is
running. Before running on other channels, get Twitch's written answer on
sending chat to AI providers (Section VI.C), handle revoked authorizations
automatically, and replace the short notice with a full privacy policy.

### Build order and acceptance checks

Submissions close Mon Nov 2. Build a working end-to-end skeleton first, then
replace the stubs one feature at a time, so every feature has a working demo
path before any one goes deeper.

| Order | Deliverable | Acceptance check |
| --- | --- | --- |
| 1 (day 1) | EventSub ingestion, sessions, storage, replay injector, demo seed, and dashboard and overlay shells, with Jev, LLM, and image calls stubbed. Generate one test sticker image and measure the Get Chatters delay. | One replayed stream runs end to end and wraps; replayed deliveries count once. |
| 2 | Repetition rows and Guardrails | 20 cleared matches within 10 s show one `LOL (X20)` that keeps X20; a match after 10 s opens a new row; `lol`, `LOL LOL`, and suffixed variants join it; a faster replay gives the same rows. Commands still get topic checks. Identical text with different context gets separate Jev decisions. A keep-out message disappears from Twitch chat; a hide-from-me message disappears only from the dashboard; an empty message ID never reaches Twitch. |
| 3 | Chat organizer | Known subjects get their messages; the scripted new topic is named within seconds and its earliest message keeps its timestamp; commands and emote-only lines never form a subject; the three "USB" cases below pass. |
| 4 | Lurker Bridge and Awards | An empty database never labels anyone new. After the seed, a regular's arrival gives one nudge and a return gives one return nudge; return counts remain correct after more than 5 missed sessions. Bots, the broadcaster, and LOL bursts get no nudges. One finalization per wrap; offline plays nothing; a short outage stays one session. With Jev down the card appears within 6 s and omits Hype Engine if its required processing is incomplete. Later removals and opt-outs correct saved public cards. With all checks complete, a fresh database plus the seed shows all three titles. |
| 5 | Stickers, privacy checks, then a full video rehearsal | Selecting a subject pre-selects its members, and the scan adds related reactions and uncertain replies; unrelated keyword matches stay out of Selected. Only the streamer can generate and approve; `!sticker` respects cooldowns. Scans preserve reserved live capacity. Opted-out messages leave no retained text, and all model payloads pass the identity-sanitization checks. |

Use the seed and demo script for development and rehearsal. Keep a separate
labeled evaluation set of conversations that were not used to write prompts,
choose examples, or tune thresholds. Freeze those settings before evaluating
on the pinned Jev version; if a failure leads to a change, validate it with
fresh unseen cases too. Record category and subject accuracy, retrieval
precision and recall, moderation false positives, latency, and request usage
separately from demo results.

Include unseen paraphrases, unrelated keyword matches, mixed conversations,
busy-chat bursts, injected instructions, and repeated text with different
context. Retain these three context cases in the development checks and use
different wording and subjects in the independent evaluation:

1. Only a mic conversation is active: "is it a USB one?" goes to the mic
   subject at 0.7 or above.
2. Mic and controller conversations are both active: the line is uncertain.
3. The line replies to a controller message: it goes to the controller
   subject.

Use Twitch's reply button in the demo when the intended subject is ambiguous.
Keep unresolved classification failures in the evaluation results; changing
the demo wording does not count as fixing them.

Add these regression and load checks before the video rehearsal:

- A blocked sentence receives the same topic action with and without a `!`
  prefix. Commands, reactions, and bot posts skip organizer work but still
  receive Guardrails checks.
- Identical text with different sender history, reply context, or subject
  records does not share a stale answer. A changed topic definition invalidates
  earlier decisions. Only cleared members contribute to a repetition row.
- A final naming pass and lookback finishing before the Wrap deadline include
  the original starters. Work finishing after it cannot alter the saved award
  set. Removal or opt-out after Wrap retracts affected public entries.
- A large sticker scan and a burst of live messages share the scheduler without
  spending reserved live capacity on scans. Inject 429s and slow responses;
  measure queue wait and event-to-deletion latency, including retries.
- A silent regular returning after 8 missed sessions gets the correct return
  count, and a reconnect within the same session does not add a missed session.
- After `!regulars forget`, later messages are moderated transiently and leave
  no text in storage, logs, caches, or persistent queues. An in-flight result
  cannot restore deleted data. Model payloads contain anonymous labels instead
  of test usernames in mentions, reply quotes, subject records, and briefs.

On a Jev or LLM timeout, keep ingesting and running deterministic rules, and
queue eligible unfinished work through the shared scheduler without duplicating
counts, deletions, sticker jobs, or awards. Opted-out message text is discarded
at timeout, and late jobs cannot change saved awards except for the removal
and opt-out corrections described above.

## Hackathon submission and demo video

Submissions close **Monday, November 2, 2026, at 2:00 PM Pacific / 5:00 PM
Eastern (22:00 UTC)**, as stated in Section 1 of the
[official Devpost rules](https://twitchcon-codex.devpost.com/rules).
A saved draft isn't entered: press **Submit** and confirm the entry shows as
submitted. Finish any submission edits before that deadline. The requirements
below follow the official rules, which take precedence over conflicting FAQ
or promotional wording.

- **Video:** up to 3 minutes on YouTube, showing Regulars working on Twitch and
  how Codex was used. Judges score from the video and the description, aren't
  required to run the project, and needn't watch past 3 minutes.
- **Codex session ID:** from `/status` in the thread where most of the build
  happened, so do the core build in one thread.
- **Description:** the features and how Codex was used.
- **Repo:** all source, assets, and run instructions, and no keys. A private
  repo must be on GitHub or GitLab and shared with the judging address. Ship
  the replay file so anyone can run Regulars without a live channel.
- **Judging:** Innovation, Impact, Technical implementation (including Codex
  use), and Design ("easy to use and fun to watch"), weighted equally. The top
  5 are shown on the Codex booth stage at TwitchCon San Diego on Nov 15.
- **Content:** no game footage, music, other streamers, or third-party
  trademarks without permission. Use made-up subjects in the seed and script.
  Confirm that Jev's early-access terms allow a public demo.

Build all five features: Lurker Bridge, Chat Stickers, End-of-Stream Awards,
Guardrails, and Chat organizer. All five use the shared community memory, one
backend, and one overlay.

Video script (3 minutes or less), recorded on the team's channel with about 5
team accounts:

1. A seeded regular's account opens the stream without chatting. The dashboard
   shows "Sam is here (4 of the last 5 streams). Last time: …", and the
   streamer greets them by topic.
2. Two or three accounts start a new topic. Chat organizer files it under New,
   names it within seconds, and the summary updates. The streamer selects the
   subject, reviews the collected lines, and approves a sticker, which a viewer
   then triggers with `!sticker`.
3. The accounts alternate `LOL` and `LOL LOL` about every 2 seconds, and the
   dashboard shows one `LOL (X20)` row beside native chat. A message about a
   keep-out topic is removed from native chat.
4. The streamer presses Wrap. The card shows Hype Engine for the new topic's
   first contributors, plus Night Owl and Day One.
5. 15–20 seconds of building it in Codex.

Before recording:

- Start from a fresh database plus the demo seed, so Day One is first earned on
  camera.
- Use non-moderator team accounts that followed before the Day One date, with
  their seeded history under their real user IDs. Connect all but the arriving
  regular a few minutes early; open that one on camera and cut the wait for
  the chatter list in editing.
- Turn off slow mode, unique-chat mode, and followers-only mode, and turn on
  the 2-second non-moderator chat delay.
- Set the Night Owl window to cover the recording time and show that setting on
  screen. Say on screen that the history is seeded.
- Keep the scripted topic going longest so it wins Hype Engine, and cut the
  wait in editing.
- Start sticker generation early and keep a pre-generated fallback.
- Record native Twitch chat beside the dashboard.

The demo connects a private nudge and a friendly greeting with a chat subject
that becomes a sticker and recognition for the people who started the longest
discussion.
