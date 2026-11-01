# Repository Guidelines

## Project Structure & Module Organization
Regulars is a local Twitch companion with a streamer dashboard and OBS overlay. Paths below are relative to the `regulars/` repository root.

- `src/`: Node.js backend; `server.js` handles HTTP, `core.js` manages SQLite-backed state, and other modules cover Twitch, OAuth, AI, retention, and replay.
- `public/`: browser JavaScript, HTML, and CSS for the dashboard and overlay.
- `scripts/`: chat recording/replay tools, model smoke checks, and the Python OBS hotkey adapter.
- `test/`: JavaScript tests and Python OBS tests.
- `design/`: UI references; `twitch_x_codex.md`: product requirements.
- `data/`: ignored local databases, generated images, and private recordings.

## Build, Test, and Development Commands
Run commands from `regulars/` with Node.js 24+. No dependency installation or build step is required.

- `npm start`: serve the dashboard at `http://127.0.0.1:3000`.
- `REGULARS_AI=offline npm start`: use deterministic classification heuristics.
- `npm test`: run JavaScript tests with `node --test --test-isolation=none`.
- `python3 -m unittest discover -s test -p 'obs_hotkeys_test.py'`: run OBS adapter tests.
- `npm run chat:save -- --name "Categorizer test"`: snapshot retained chat into `data/recordings/`.
- `npm run chat:replay -- data/recordings/example.json --offline`: replay a saved recording on port 3001.

## Coding Style & Naming Conventions
Use ES modules with explicit `.js` import extensions. Follow existing two-space JavaScript indentation, semicolons, and single-quoted strings; Python uses four spaces. Use camelCase for JavaScript functions and variables, PascalCase for classes, and kebab-case for JavaScript filenames, such as `chat-replay.js`. No formatter or linter is configured; match nearby code and avoid unrelated reformatting.

## Testing Guidelines
JavaScript tests use `node:test` and `node:assert/strict`; Python tests use `unittest`. Name JavaScript tests `test/<feature>.test.js` and describe expected behavior in test names. Cover behavior changes with synthetic data, mocked Twitch/model responses, and isolated databases. No numeric coverage threshold is configured. Run both suites when changing OBS integration.

## Commit & Pull Request Guidelines
History uses capitalized, imperative subjects without prefixes, such as “Size message cards to content instead of filling the dock.” Keep commits focused. PRs should explain the behavior change, list validation commands, link related issues when applicable, and include screenshots for UI changes, including the narrow OBS dock.

## Security & Configuration
Keep `.env`, `data/`, credentials, overlay tokens, and OBS pairing codes private. Configure integrations using the variable names documented in `README.md`. Model/image smoke scripts make paid API requests; offline classification does not disable image-generation charges.
