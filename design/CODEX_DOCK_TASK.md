# Build an OBS dock for Regulars

Streamers are mid-game, so they need to glance at Regulars for a second and get back to playing. Build a narrow page, `/dock.html`, that they can add to OBS as a Custom Browser Dock. It should be about 380 px wide and still work at 390 px tall. Wire it to the existing API and leave the main dashboard alone. `design/cue-sheet-dock-prototype.html` is the approved prototype, with fake data and its own template syntax. Copy its look and behaviour, not its code.

## The idea: a cue sheet

The dock reads like a stage cue sheet: read the cue, say it, move on.

- **SAY.** Things to say to chat, taken from the open reminders.
  - **Order.** Questions first, then returning viewers, then first messages. All arriving regulars merge into one line ("Hana and Cy are here"), since one hello covers them all.
  - **Open cue.** One cue is open at a time, in large text with the person's name in yellow and a detail line underneath. The others fold into one-line rows.
  - **Moving between cues.** **F8** opens the next cue and **F7** the previous one, wrapping around; clicking a row works too.
  - **Ticking.** Ticking a cue off is optional.
  - **NEW tag.** A cue that arrived after the dock loaded shows NEW until the streamer opens it.
- **DECIDE.** Things that need a yes or no: held messages (ALLOW / HIDE) and finished stickers (APPROVE / DISCARD).
- **Three big keys** at the bottom:
  - **PAUSE / RESUME** reminders.
  - **STICKER**.
  - **END STREAM**: press and hold for about a second to end the stream, instead of a confirm dialog.
- **Undo, not confirm.** Every action shows a toast with UNDO for 5 seconds.
- **A colour bar along the top** shows the state at a glance:
  - yellow: something to say or decide
  - red: Twitch disconnected or the app not responding, with a plain-language alert band and a fix button
  - grey: paused
  - near-black: nothing waiting

## Sticker picker

When the streamer presses STICKER, ask what the sticker should be made from. Offer two tabs:

- **TOPICS.** What chat has talked about this stream, busiest first, with message counts. One tap makes a sticker from that topic, using the same search the dashboard uses.
- **PICK MESSAGES.** Recent chat, newest first, with checkboxes. The streamer picks up to 10 and then presses "Make sticker from N". Leave out held messages, bots and `!commands`.

The sticker is made in the background while the streamer keeps playing. When it's ready, it waits under DECIDE for approval, along with a line saying where it came from.

## Design language

- **Look.** Black background (#0b0b0b), white text, grey details, one accent (yellow #ffd60a), and red (#ff453a) only for problems.
- **Type.** Barlow Condensed for headings, Barlow for body text.
- **Shapes.** Square edges, thin rules between items, and touch targets of at least 44 px.

## Constraints

- Follow the code style the project already has: zero dependencies, plain DOM code like `public/app.js`, and tests with `node:test`.
- Keep the current CSP. That means no inline scripts or styles; Google Fonts is blocked too, so bundle the fonts locally or fall back to system fonts.
- An OBS dock keeps its own cookies, so `dock.html` must set the session cookie the same way `index.html` does.
- Add any small server routes the dock needs, such as resuming reminders and discarding a sticker.
- F7/F8 only need to work while the dock has focus. Make sure focus isn't lost when a clicked control disappears.

Add tests for the dock logic and any new routes, and make sure `npm test` passes. When you're done, summarize what you built and any decisions you made along the way.
