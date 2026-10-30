# Regulars

Regulars is a local Twitch companion prototype. It provides a private dashboard,
a synthetic chat replay, an organizer, topic guardrails, private viewer nudges,
an awards card, and a streamer-controlled sticker workflow.

## Run locally

Use Node.js 24 or later. No package installation is required.

```powershell
npm start
```

Open `http://127.0.0.1:3000`, then open **Settings** and select **Run demo replay**.
Settings also shows a link to the browser-source overlay. The overlay link
contains a secret token; treat it like a password. The server listens on
loopback only. Restarting
the server changes the token, so update the browser source after a restart.

The server reads `.env` at startup and accepts both `NAME=value` and
`export NAME=value`. With `OPENROUTER_API_KEY` configured, Jev and Luna calls use
OpenRouter. The streamer can approve a sticker brief, generate a transparent
image with `openai/gpt-image-2.5-flare`, and then approve the image for
publication. Requests may incur OpenRouter charges.

For deterministic local testing without model requests, set
`REGULARS_AI=offline` before starting the server. Offline classifications are
simple development heuristics and are not suitable for live moderation. Image
generation still requires an OpenRouter key.

## Use the OBS dock

The live interface is a narrow, tall message reader. In OBS, open
**Docks → Custom Browser Docks**, add a dock named **Regulars**, and use
`http://127.0.0.1:3000` as its URL. Resize it to roughly 320–420 pixels wide.

Chat topics and community members stay visible above the large reading card.
Each community name includes a reason: **Question**, **Returned**, **First chat**,
**Say hi**, or **Regular**. **Regular** means a known regular is present without
a pending reminder. Community cues are private to the streamer.

Community also includes **Hype Engine**, **Night Owl**, and **Day One** members,
even when they aren't regulars. Hype Engine shows the first contributors to
the current longest qualifying discussion and carries a **live** label until
Wrap finalizes the awards. Night Owl uses your configured time window and time
zone. Day One requires a verified follow date or an existing active award.
A `+N` beside a reason means the viewer has other community types; select the
person to see them. An active question or welcome reminder stays first.

Tap **F7** or **F8** to move backward or forward within the selected section.
Hold either key for 0.6 seconds to switch between **Chat** and **Community**.
A hold switches once and doesn't also advance an item when you release it.
You can also select either section heading or an individual chip.

Press **F9** when you've answered or want to skip the displayed item. In Chat,
this removes the message from this dock's reading queue; it doesn't delete
Twitch chat or change moderation. **Undo** restores the last dismissed chat
message. Chat dismissals persist in this browser for the current stream when
local storage is available. In Community, F9 dismisses the selected private
reminder. Regulars with no pending reminder have no dismissal action.
The full message remains readable by scrolling within the message area.

Browser shortcuts work while the dock has keyboard focus. To use the shortcuts
while your game is focused, install the included OBS script:

1. Open **Settings → OBS hotkeys** in Regulars and reveal the pairing details.
2. Download [the OBS script](scripts/regulars_obs_hotkeys.py) using the download
   link in that section.
3. In OBS, configure Python under **Tools → Scripts → Python Settings**, then
   add the downloaded script on the **Scripts** tab.
4. Copy the endpoint and pairing code from Regulars into the script settings.
5. Keep the Regulars dock open. Check **OBS Settings → Hotkeys** for the default
   F7, F8, and F9 bindings and ensure OBS permits hotkeys when another app has
   focus. Resolve any conflicting game or OBS bindings there.

Pairing persists across server restarts. The pairing code controls only dock
navigation and dismissal. Each open Regulars live dock receives the command;
keep one live dock open to avoid navigating multiple copies. Hotkeys don't dismiss chat
while you use a secondary Regulars screen or type into a field in the live dock.
Live OBS scripting and game-focus behavior still require verification in OBS;
the script tests use a simulated OBS API.

Open **Stickers** to see all available subjects and the **Pick messages** option.
Select a subject to find its related comments, or pick individual chat lines.
Review the selection and create the sticker brief before approving an image.

## Adjust the rules

Open **Settings** in the streamer dashboard to change attendance definitions,
reminder timing, discussion awards, repeat grouping, matching scores, summary
timing, and sticker cooldowns. The default regular definition remains three of
the last five streams; choose **Consecutive** to require an unbroken streak.
Settings are saved per channel. Existing award cards stay unchanged, and new
score thresholds apply to future checks rather than reclassifying old messages.

The previous version kept at most five session sightings for each viewer. If
you increase the attendance window or required streak, older discarded history
can't be recovered. New sightings accumulate under the selected settings.
Existing reminders keep their assigned expiry; new or updated reminders use the
new expiry settings.

## Connect Twitch

Register a Twitch application with the redirect URI
`http://127.0.0.1:3000/twitch/callback`. Add these values to `.env`:

```text
TWITCH_CLIENT_ID=your-twitch-application-client-id
TWITCH_CLIENT_SECRET=your-twitch-application-client-secret
TWITCH_BROADCASTER_ID=your-broadcaster-user-id
```

Start the app, select **Connect Twitch**, and authorize the configured broadcaster
account. Tokens remain in memory and must be authorized again after restarting.
If the registered redirect differs, set `TWITCH_REDIRECT_URI` to its exact local
URL using the same `/twitch/callback` path and server port.

Alternatively, provide a broadcaster user access token in
`TWITCH_ACCESS_TOKEN`; this skips interactive sign-in and does not refresh that
token automatically. The user access token must belong to the broadcaster and include
`user:read:chat`, `moderator:manage:chat_messages`, `moderator:read:chatters`,
and `moderator:read:followers`. Regulars checks the token before connecting.
You can add bot login names with a comma-separated `TWITCH_BOT_NAMES` value.
The live adapter and synthetic replay use separate databases. Replay is disabled
when a Twitch channel is configured, so test messages can't trigger Twitch
moderation. The interactive flow refreshes its user token while the app runs.

Set the streamer's IANA time zone and Day One date in **Stream awards**. The
Day One award also requires a successful follower lookup. A broadcaster can
wrap from the dashboard or with `!wrap`. A viewer can request deletion with
`!regulars forget` or mark themselves as lurking with `!lurk`. Viewers can
trigger an approved sticker with `!sticker <name>`.

## Test

```powershell
npm test
```

The suite uses synthetic data and mocked Twitch and model responses. To make
synthetic live model requests using the key in `.env`, run
`node scripts/smoke-models.js`. To generate one paid test image, run
`node scripts/smoke-image.js`. It saves the image under `data/` and doesn't
print the key.

## Prototype limits

The replay seeds six past sessions with 300 synthetic messages; it doesn't use
real Twitch history. The organizer implements initial discovery and lookback,
but it doesn't yet cover every relevance-context, ambiguity, or load-testing
rule in the plan. The interface does not yet implement every
nudge and moderation control, and non-English moderation needs additional
handling. Sticker image generation waits for the complete image rather than
streaming partial previews.

Live Twitch authorization, event delivery, moderation, follower lookups, and
reconnect behavior have not been verified against a real channel. The local
dashboard uses a loopback-only session, not broadcaster login, and the public
notice is a demo draft. Identity sanitization and the handling of removed
context need further validation, and model failures can leave messages held.
Complete the remaining privacy, safety, recovery, and Twitch authorization work
in `twitch_x_codex.md` before using this with real viewers or exposing it to
the internet.

Local databases and generated images are stored in `data/`, which is ignored by
Git. While Regulars runs, it checks once a minute for chat text from sessions
closed at least 24 hours ago and deletes it, except approved sticker sources.
It also checks at startup. Removal and opt-out requests override that exception.
