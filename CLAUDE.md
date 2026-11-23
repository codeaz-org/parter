# Parter: notes for Claude Code

Floor plan → furnished rooms → 3D views → AI renders. Static web app in `public/`, no build
step, no backend. Optional local server and MCP server in Node. MIT.

## Commands

- `npm start` runs the local server at http://localhost:4173 (plans as files in `./projects`)
- `npm test` runs all tests (`node --test tests/*.test.mjs`); keep them green
- `npm run docs` regenerates `docs/IMPORT.md` from the prompts in code
- `npm run mcp` runs the MCP server on stdio (normally started by the client via `.mcp.json`)

## Architecture in one paragraph

A plan is one JSON document, the *scene* (`docs/SCENE.md`, `public/js/core/scene.js`). Rooms are
never stored: `core/rooms.js` derives them from the walls on a 5 cm grid. Every change an
assistant can make is a tool in `core/ops.js` with a JSON schema and a `run(scene, args)` that
mutates the scene and returns text, including warnings the model can act on. The in-app chat
(`ai/assistant.js`), the plan reader (same file) and the MCP server (`mcp/server.mjs`) all use
that one tool list. The editor (`ui/app.js`, `ui/panels.js`) mutates the scene directly and
calls `A.commit(struct)`.

## Rules that matter

- `public/js/core/**` and `public/js/ai/**`: no DOM, no `window`. They are imported by Node.
- Coordinates are metres; x east, y north; plan `(x, y)` maps to three.js `(x, height, -y)`.
- Furniture rotation `r` is degrees counter-clockwise; at 0 the back of a piece faces north.
- Walls are axis-aligned rectangles. An opening's `a`..`b` are world coordinates along the
  wall's long axis. Keep wall coordinates on the 0.05 grid or rooms may leak.
- After changing walls, openings, room labels or the ceiling, call `A.commit(true)` so rooms
  are re-derived and the 3D house is rebuilt. Furniture-only changes use `A.commit()`.
- User-facing text is plain and specific. No jargon in the interface.
- No bundler, no framework, no new runtime dependencies in `public/`.

## Where things are

- Add furniture: one entry in `core/catalog.js` (parts format documented at the top).
- Add an assistant ability: a tool in `core/ops.js`, plus a test in `tests/core.test.mjs`.
- Add a model provider: `ai/providers.js` (`PRESETS`, `modelStep`, `generateImage`).
- Plan-reading instructions: `IMPORT_GUIDE` in `ai/assistant.js`, then `npm run docs`.
- Storage (browser vs. local files): `ui/store.js`. Local API: `server/local.mjs`.
- The sample house: `public/projects/frumusita.json`. A test pins its room areas to the
  drawing; if you change the room detector, that test tells you whether you broke it.

## Known gaps (good first tasks)

- AI paths are tested with fake fetches only. Nobody has yet run chat, plan reading or renders
  against the live Anthropic, OpenAI or Gemini APIs. Do that first and fix what breaks.
- The Claude Code hand-off (`askAgent` in `server/local.mjs`) was tested with a stand-in CLI.
  Check the real `claude -p` flags and the JSON output shape.
- No real-browser or phone testing yet. The header wraps to two rows under 820 px
  (`css/app.css`); check it on a phone.
- OpenAI's Responses API is not supported (needed for tools on their newest models).
- Walls cannot be angled; snapping to other walls while drawing is not implemented.
- `ui/app.js` is large. Splitting plan interaction from the selection bars would help.

## Testing the UI without a browser

The UI has no automated tests in the repo. During development it was exercised by bundling
`public/js/ui/app.js` with esbuild into an IIFE and loading `index.html` in jsdom with
`canvas` and headless `gl`. `window.parter` exposes the app state (`scene`, `an`, `toScreen`,
`panels`) for that purpose.
