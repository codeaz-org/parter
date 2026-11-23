# Parter

Turn a floor plan into rooms you can furnish, walk through in 3D, and hand to an image
generator. Talk to an assistant to make changes. Open source, MIT.

Parter is a static web app with no backend. You can host it for free, and it never sees
anyone's plans or API keys: plans stay in the browser, and AI requests go straight from the
browser to the provider you choose.

> **Status: 0.1, early.** The editor, storage, local server and MCP server are covered by
> automated tests. The AI features (chat, plan reading, renders) have been tested against
> stand-in providers only, not yet against the live APIs, and the interface has not been
> through real-browser or phone testing. Expect rough edges and please report them.

## What it does

- **Furnish.** Drag furniture on a to-scale plan. Rotate, resize, mirror, set heights. About
  fifty pieces: living, dining, kitchen, bedroom, bathroom, laundry and utility.
- **Build.** Draw walls, add windows and doors, name rooms. Rooms and floor areas are worked
  out from the walls. Doors can be open, closed, glazed or walled up.
- **Start from a drawing.** Upload a photo or scan. Trace over it with a two-point scale tool,
  or let a vision model read it into walls, openings and rooms.
- **Assistant.** "Put the sofa on the opposite wall." The assistant edits the plan through the
  same operations the editor uses, and every turn is one undo step.
- **3D.** Eye-level walk-through and a roof-off dollhouse view.
- **Export and render.** Colour view, depth map, clay view, plan, and a prompt written for the
  camera's room. Send them to OpenAI or Gemini image models from the app, or save them and
  use any tool you like.
- **Claude Code.** Run it locally and Claude Code can edit your plans through an MCP server
  while you watch the changes land in the browser.

A sample house is included (`public/projects/frumusita.json`).

## Run it

### On your computer

```bash
npm install
npm start          # http://localhost:4173
```

Plans are saved as JSON files in `./projects`. Needs Node 18 or newer.

### Free hosting on Cloudflare Pages

The site is the `public` folder, exactly as it is. There is no build step.

**Upload by hand.** In the Cloudflare dashboard open *Workers & Pages*, choose
*Create application*, then *Drag and drop your files*, name the project, and drop the
`public` folder (or a zip of it). Select *Deploy site*.

**From git.** Connect the repository in *Workers & Pages* and set the build output directory
to `public` with no build command. `wrangler.toml` already says the same thing.

**From the command line.**

```bash
npx wrangler pages deploy public --project-name parter
```

Any other static host works too (GitHub Pages, Netlify, an S3 bucket): serve `public`.

When hosted, plans live in each visitor's own browser storage. Nothing is uploaded to you.

## Setting up the AI features

Open **Assistant → Settings**. Keys are stored in that browser only.

| Feature | Runs on | Notes |
|---|---|---|
| Assistant and plan reading | Claude (Anthropic) | Default. Needs an API key. |
| | OpenRouter, Gemini's OpenAI-compatible endpoint, Ollama, LM Studio | Chat Completions format. The model must support tool calling; plan reading also needs vision. |
| | OpenAI | Same format. Some of OpenAI's newest models only allow tools through their Responses API, which Parter does not speak yet. |
| | Claude Code on this computer | Local mode only. No API key: it uses your Claude Code sign-in. |
| Renders | OpenAI images, Gemini images | Model names are editable in Settings, because they change often. |

Use keys with a spending limit. Anyone who can use the browser profile can read a stored key.

## Claude Code and MCP

The repository ships an MCP server (`mcp/server.mjs`) and a `.mcp.json` that registers it, so
opening this folder in Claude Code is enough. Approve the `parter` server when asked, then:

```
> list the parter projects and describe frumusita
> in frumusita, move the dining table next to the kitchen opening
```

If `npm start` is running, the browser updates as each tool call lands.

When the `claude` CLI is on your PATH, `npm start` also offers **Claude Code on this
computer** as the engine for the in-app assistant. Each message is passed to
`claude -p … --mcp-config .mcp.json --allowedTools mcp__parter`. Set `PARTER_AGENT_CMD` to use
a different command.

The tools are listed in [docs/IMPORT.md](docs/IMPORT.md). Any MCP client can use the server:
`command: node`, `args: ["<path>/mcp/server.mjs"]`.

## How it is put together

```
public/                 the whole app; this folder is what gets hosted
  index.html, css/
  js/core/              no DOM in here: runs in the browser, in Node and in tests
    scene.js            the scene document: validate, repair, helpers
    rooms.js            finds rooms, areas and the footprint from the walls
    catalog.js          furniture: one parts list drives both the plan symbol and the 3D model
    ops.js              every edit an assistant can make, as tools with JSON schemas
    plan2d.js           draws the plan on a 2D canvas
    scene3d.js          builds the three.js model
    prompt.js           writes prompts for image generators
  js/ai/
    providers.js        Anthropic and OpenAI-compatible chat; OpenAI and Gemini images
    assistant.js        the chat tool loop and the plan reader
  js/ui/                the editor itself
  projects/             the bundled sample
  vendor/three.min.js   three.js r128 (MIT)
server/local.mjs        optional local server: files on disk, live updates, Claude Code hand-off
mcp/server.mjs          MCP server exposing ops.js to Claude Code and other clients
tests/                  node --test
docs/SCENE.md           the scene file format
```

One idea holds it together: **a plan is one small JSON document**, and the editor, the
assistant, the plan reader, the MCP server and the exports all read and write that document
through the same functions. See [docs/SCENE.md](docs/SCENE.md).

```bash
npm test           # core, AI adapters (with a fake fetch), local server, MCP round trip
npm run docs       # regenerate docs/IMPORT.md from the prompts in the code
```

## Limits today

- Walls are straight and run along x or y. No angled or curved walls.
- One floor per plan. No stairs, roofs or terrain.
- Furniture is built from boxes, cylinders and spheres. It is a layout model for image
  generators to dress, not a finished render.
- Plan reading depends entirely on the model and the drawing. Always check room sizes.
- No accounts, sharing or sync. Moving a plan between devices means exporting the project file.

## Roadmap

- Angled walls, wall snapping, dimension lines on the plan.
- More furniture and a way to add your own pieces without code.
- OpenAI Responses API support.
- Multiple cameras per plan and batch renders.
- A hosted edition for people who do not want to manage API keys: accounts, cloud projects
  and sharing, with AI usage included. The editor stays open source; the hosted edition would
  add a small backend in front of the same scene format.

## Licence

MIT. See [LICENSE](LICENSE). three.js is bundled under its own MIT licence
(`public/vendor/THREE-LICENSE.txt`).
