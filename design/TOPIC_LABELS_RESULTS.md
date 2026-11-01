# Topic labels implementation and evaluation

Private topic labels replace category badges. Discovery compares proposals with
stored classify-time scores, revisits weak assignments, and reuses
existing topic IDs when a conversation broadens. Final validation uses the same
application code for both `after-5` and `after-6`.

Both final runs still put build messages under Malenia and music messages under
rain topics. They meet the remaining measured targets, including label accuracy
and the original-chat regression limits. Overall right-topic assignments rise
from 274/296 to 287/296 and 288/296.

## Changes and decisions

The implementation keeps categories internal for reminders and ordering. Labels
remain private and are not added to the overlay or awards.

| Files | Change |
|---|---|
| `src/ai.js` | Luna labels, sanitization, generic-name rejection, batched safety checks, specific-subject matching, and explicit existing-topic references. |
| `src/core.js` | About and subject-score migrations, bounded labelling, cancellation, competing proposals, and correction of weak assignments. |
| `src/server.js`, `src/chat-replay.js` | Labelling after discovery; replay state and downloads retain category compatibility and add about labels. |
| `src/chat-recording.js`, `src/retention.js` | Optional recorded labels and clearing labels with removed or expired text. |
| `public/app.js` | Topic/about text in the dock, reminders, sticker selection, and replay log; grouped cards have no duplicate badge. |
| `scripts/evaluate-topics.js`, `scripts/topic-eval-support.js` | Explicit paid Luna option, highest-price reservations, persistent $2 cap, final labels, and review lists. |
| `test/fixtures/twitch-chats.js` | Four requested chats, for 15 total; thin annotations stay evaluator-only. |
| `test/ai.test.js`, `test/organizer.test.js`, `test/topic-labels.test.js`, `test/frontend.test.js`, `test/topic-eval.test.js`, `test/chat-recording.test.js`, `test/chat-replay.test.js` | Mocked behavior, privacy, cancellation, rendering, budget, and recording compatibility coverage. The recording permission assertion also accounts for Windows file-mode reporting. |
| `README.md`, `twitch_x_codex.md` | Updated behavior, offline limitations, call bounds, and evaluation instructions. |

Topics still require three qualifying messages at registration. An unregistered
proposal competes in discovery and lookback, so another proposal cannot borrow
its evidence. Up to 30 thin proposals retain their scores for five minutes,
including across passes that omit them. This cache contains no message text
and clears on revision changes or restart. Existing subjects compete through
stored scores. Weak assigned messages may enter naming; moving them requires
strong relevance and a direct JEV comparison. A weak assignment that loses to
an unregistered proposal returns to Ungrouped. Luna can identify an existing
topic by index and broaden its name and description while retaining its ID.
About labels provide a subject hint for matching.

## Validation

All checks ran locally without new dependencies or a formatter.

- `npm test`: 288 passed, 0 failed.
- `python -m unittest discover -s test -p obs_hotkeys_test.py`: 6 passed.
- Headless Chromium: 360-pixel viewport, 360-pixel document width, visible
  “Monstera plant” label; screenshot inspected.
- Local commits only; nothing pushed. The pre-existing
  `public/appearance.css` change and task file were left untouched.

## Before and after

All runs use 15 chats, 347 messages, 1× arrivals, zero model retries, a
two-second classification timeout, and a ten-second organizer tick. Ground
truth and thin tags never reach either model. “Right/topic” measures correct
topic assignments; labels do not receive credit in this grouping metric.
Final 1 is `after-5`;
Final 2 is `after-6`. The baseline uses application code from `3b2aafa`;
the final runs use `f86a2c7`. Both final runs have source hash
`d33cdf9a14ce71fe06a12a6d75ba82b6e49abcca7ee52ff5a4c3c14bf2f82292`.

| Chat | Before right/topic | Final 1 right/topic | Final 2 right/topic | Before pair precision | Final 1 | Final 2 |
|---|---:|---:|---:|---:|---:|---:|
| solo | 13/13 | 13/13 | 13/13 | 100.0% | 100.0% | 100.0% |
| boss | 16/16 | 16/16 | 16/16 | 100.0% | 100.0% | 100.0% |
| gear | 15/15 | 15/15 | 15/15 | 100.0% | 100.0% | 100.0% |
| quiet | 10/10 | 10/10 | 10/10 | 100.0% | 100.0% | 100.0% |
| burst | 13/13 | 13/13 | 13/13 | 100.0% | 100.0% | 100.0% |
| replies | 13/14 | 13/14 | 13/14 | 100.0% | 100.0% | 100.0% |
| pets | 14/14 | 14/14 | 14/14 | 100.0% | 100.0% | 100.0% |
| multilingual | 12/13 | 12/13 | 12/13 | 100.0% | 100.0% | 100.0% |
| injection | 11/11 | 11/11 | 11/11 | 100.0% | 100.0% | 100.0% |
| returning | 18/18 | 18/18 | 18/18 | 100.0% | 100.0% | 100.0% |
| multitopic | 52/53 | 53/53 | 53/53 | 100.0% | 100.0% | 100.0% |
| souls | 23/32 | 29/32 | 30/32 | 56.9% | 76.8% | 83.6% |
| justchatting | 31/32 | 31/32 | 31/32 | 100.0% | 100.0% | 100.0% |
| ranked | 26/29 | 27/29 | 27/29 | 90.2% | 100.0% | 100.0% |
| cozy | 7/13 | 12/13 | 12/13 | 20.8% | 63.2% | 80.0% |

The original 11-chat baseline has 98.4% right-topic
coverage and 100.0% pooled pair precision. Aggregate
pair precision counts message pairs across chats, without mixing separate chats.

## Acceptance

Wrong-topic percentages use the 106 non-thin topic messages in the four new
chats. Thin plant/music assignments are checked separately. Original-chat
regression targets use pooled metrics; per-chat values remain visible above.

| Criterion | Final 1 | Final 2 | Target |
|---|---|---|---|
| Build lines under Malenia | 3 — miss | 2 — miss | 0 |
| Ramen break under Malenia | No — pass | No — pass | No |
| Cozy plant, tea or music under another topic | 2 — miss | 1 — miss | 0 |
| Wrong topic across four new chats | 3/106 (2.8%) — pass | 2/106 (1.9%) — pass | ≤5% |
| Ranked right topic | 27/29 — pass | 27/29 — pass | ≥27/29 |
| Just Chatting right topic | 31/32 — pass | 31/32 — pass | ≥29/32 |
| Original 11 coverage | 98.9% (0.5 pp) — pass | 98.9% (0.5 pp) — pass | Drop ≤3 pp |
| Original 11 pair precision | 100.0% (0.0 pp) — pass | 100.0% (0.0 pp) — pass | Drop ≤3 pp |
| Correct labels on ungrouped subject messages | 8/8 (100.0%) — pass | 9/9 (100.0%) — pass | ≥90% |

Other reader-visible lines show no about label in 29/29
cases in Final 1 and 29/29 in Final 2.
No non-topic line received an about label in either final run.

## Label review

The full reports linked below also list greetings, reactions, and every other
reader-visible message left ungrouped. These tables focus on messages that need
a subject label.

### after-5

This table lists every ungrouped message with an expected subject, including
thin conversations. Correctness was reviewed against the message and context.

| Chat/message | Text | About label | Review |
|---|---|---|---|
| replies/replies-9 | how much did it cost? | Camera lens | Correct: the explicit reply asks about the camera lens price. |
| multilingual/multilingual-9 | un cafecito y seguimos | Cafecito | Correct: Cafecito means a little coffee and names the message's subject. |
| justchatting/justchatting-12 | she typed jjjjjjjj in chat | Biscuit keyboard typing | Correct: Biscuit is the cat on the keyboard in the preceding messages. |
| ranked/ranked-19 | what res do you play on, stretched? | Resolution settings | Correct: asks about display resolution. |
| ranked/ranked-20 | the reyna is typing in all chat again lmao | Reyna throwing | Correct: continues the conversation about the throwing Reyna teammate. |
| cozy/cozy-2 | is that a monstera on the shelf behind you? | Monstera plant | Correct: explicitly asks about the Monstera plant. |
| cozy/cozy-8 | mine has three new leaves this month | Monstera plant | Correct: the earlier shelf-plant question resolves the new-leaves follow-up. |
| cozy/cozy-15 | dont forget to finish the community center bundles before winter | Community Center bundles | Correct: explicitly names the Community Center bundles. |

### after-6

This table lists every ungrouped message with an expected subject, including
thin conversations. Correctness was reviewed against the message and context.

| Chat/message | Text | About label | Review |
|---|---|---|---|
| replies/replies-9 | how much did it cost? | Camera lens | Correct: the explicit reply asks about the camera lens price. |
| multilingual/multilingual-9 | un cafecito y seguimos | Café | Correct: Café names the coffee mentioned in Spanish. |
| justchatting/justchatting-31 | is monday still canceled? | Monday stream cancellation | Correct: asks about the canceled Monday stream. |
| ranked/ranked-2 | this new agent is so broken lol | New agent | Correct: discusses the newly added game agent's balance; no character name is supplied. |
| ranked/ranked-23 | the new agent ult is so overtuned | New agent | Correct: reuses New agent for the same character's overtuned ultimate. |
| cozy/cozy-2 | is that a monstera on the shelf behind you? | Monstera plant | Correct: explicitly asks about the Monstera plant. |
| cozy/cozy-8 | mine has three new leaves this month | Monstera plant | Correct: the earlier shelf-plant question resolves the new-leaves follow-up. |
| cozy/cozy-13 | what playlist is this? | Playlist | Correct: names the playlist being asked about; its identity is not yet given. |
| cozy/cozy-15 | dont forget to finish the community center bundles before winter | Community Center bundles | Correct: explicitly names the Community Center bundles. |

## Duplicate topics and remaining limitations

No duplicate groups for a single expected subject were observed in the two
final runs.

Unmet acceptance targets:

- after-5: Build lines under Malenia
- after-5: Cozy plant, tea or music under another topic
- after-6: Build lines under Malenia
- after-6: Cozy plant, tea or music under another topic

The remaining wrong assignments are listed below.

| Run/message | Text | Assigned topic | Expected subject |
|---|---|---|---|
| after-5/souls-18 | arcane scales way better with bleed procs yeah | Malenia Boss Fight | build |
| after-5/souls-28 | what level are you | Malenia Boss Fight | build |
| after-5/souls-29 | rl 150 probably | Malenia Boss Fight | build |
| after-5/cozy-13 | what playlist is this? | Cozy Rainy Stardew Stream | music |
| after-5/cozy-14 | sounds like the lofi girl playlist | Cozy Rainy Stardew Stream | music |
| after-6/souls-28 | what level are you | Malenia boss fight | build |
| after-6/souls-29 | rl 150 probably | Malenia boss fight | build |
| after-6/cozy-14 | sounds like the lofi girl playlist | Rainy Stardew Stream | music |

In after-5, the two character-level lines still landed under Malenia. During
discovery, JEV scored the level question 0.79–0.84 for the boss and 0.59–0.71
for the build. No separate level proposal was scored in that run, so retaining
thin proposals could not protect this exchange.

The arcane-scaling line also remained under Malenia in after-5 despite
stronger later build scores. Its stored boss score was 0.88; the first build
rescore was 0.96, below the required 0.10 lead. Reconsideration remains
conservative: ambiguous rescoring can preserve an earlier assignment, and a
move still requires direct JEV comparison. Labels are generated only for
ungrouped messages and used as contextual hints, so they do not guarantee
correction of wrong assignments.

In after-5, Luna proposed a broad cozy-rain conversation without a separate
music proposal. JEV then scored the playlist question and reply 0.81 and 0.88
against that topic. The two music lines were absorbed despite the stricter
instructions. The three-message registration rule and retained competitors
cannot separate subjects when the models supply no competing proposal.

After-6 repeated the two character-level errors. Its playlist question stayed
ungrouped with a correct label, but the Lofi Girl reply still joined the rain
topic despite an earlier Playlist label; JEV scored it 0.78 against rain.
These failures are reported rather than treated as successful label coverage.

Model outputs can vary. These provided regression scenarios do not establish
accuracy on unseen streams. Sparse messages can remain ungrouped; empty labels
are stored rather than retried, and offline mode generates no labels. Labelling
is limited to recent messages and may wait behind discovery work. Pending
competitors are memory-only and expire after five minutes. A high but incorrect
model score can remain a competitor during that window.

Final-run service errors, retained in the reports:

- after-6/ranked: discovery — Invalid subject naming response

## Evaluation iterations and spend

The unchanged baseline was `before-1`. The initial `after-1` still grouped
five build lines under Malenia. Weak-assignment reconsideration corrected the
arcane discussion in `after-2`, but two level messages remained under Malenia,
the boss fight split into two topics, and a music line joined the farm. This
motivated explicit existing-topic references and about-label context in
`after-3` and `after-4`. Their traces showed that thin proposals could be
forgotten on later passes and weak assignments could survive losing to an
unregistered proposal. The final version retains those competitors and releases
those assignments, with mocked regression tests. These are general conversation
rules; production code contains no fixture IDs or fixture-specific branches.
The earlier reports are retained for review.

| Run | Right/topic messages | Total correct | Run charged/reserved |
|---|---:|---:|---:|
| before-1 | 274/296 | 322/347 | $0.031232 |
| after-1 | 283/296 | 333/347 | $0.048138 |
| after-2 | 283/296 | 333/347 | $0.087797 |
| after-3 | 286/296 | 336/347 | $0.086840 |
| after-4 | 286/296 | 334/347 | $0.091751 |
| after-5 | 287/296 | 336/347 | $0.084949 |
| after-6 | 288/296 | 338/347 | $0.088349 |

Across all seven full runs, provider-reported spend is $0.517554;
outstanding/failed-call reservations are $0.001502. The
cumulative charged-or-reserved total is **$0.519056 of $2**.
The ledger includes every paid request, including all four development passes.

- [before-1 full report and visible ungrouped list](../data/evals/topic-quality/before-1/report.md)
- [after-1 full report and visible ungrouped list](../data/evals/topic-quality/after-1/report.md)
- [after-2 full report and visible ungrouped list](../data/evals/topic-quality/after-2/report.md)
- [after-3 full report and visible ungrouped list](../data/evals/topic-quality/after-3/report.md)
- [after-4 full report and visible ungrouped list](../data/evals/topic-quality/after-4/report.md)
- [after-5 full report and visible ungrouped list](../data/evals/topic-quality/after-5/report.md)
- [after-6 full report and visible ungrouped list](../data/evals/topic-quality/after-6/report.md)

Raw results and the screenshot stay in ignored `data/`; these links resolve
in this local workspace and the artifacts are not committed.

## Narrow dock screenshot

The screenshot uses synthetic messages and the actual dashboard assets at
360 pixels wide.

![Ungrouped message with the Monstera plant label](../data/evals/topic-quality/topic-label-dock-360.png)
