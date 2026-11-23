# Contributing

Thanks for helping. A few things keep the project easy to work on:

- **No build step.** The app is plain ES modules served from `public/`. Please keep it that way.
- **`public/js/core` and `public/js/ai` must not touch the DOM.** They run in Node for tests and
  for the MCP server.
- **Every edit goes through the scene document.** If you add something an assistant should be
  able to do, add it as a tool in `core/ops.js`; the chat and the MCP server pick it up.
- **Add a test** in `tests/` for anything in `core`, `ai`, `server` or `mcp`. Run `npm test`.
- Adding furniture is one entry in `core/catalog.js`; the header of that file explains the
  parts format. The catalogue test checks every piece.

Bug reports with a project file attached (Export → Project file) are the most useful kind.
