# Contributing to Design Bridge

Thanks for being here. Design Bridge is small on purpose, and contributions that
keep it that way are the most welcome.

## How it fits together

Three pieces, one data flow:

```
agent → MCP server (src/) → ws://127.0.0.1:3055 → plugin UI (plugin/ui.html) → plugin sandbox (plugin/code.js) → canvas
```

- **`src/server.js`** — the MCP server. Exposes the tools, relays specs to the
  plugin over a WebSocket.
- **`src/schema.js`** — the IR (the contract). `frame` / `text` / `rect`, each
  mapping one-to-one onto a Figma concept.
- **`plugin/code.js`** — the only code that can mutate the canvas. Turns a spec
  into real nodes.
- **`plugin/ui.html`** — a dumb relay iframe (the sandbox can't open a socket;
  this can). No Figma API calls, no logic.

## Local setup

```bash
git clone https://github.com/evidence-codes/figma-design-bridge
cd figma-design-bridge
npm install
node src/server.js            # starts the bridge on 127.0.0.1:3055
node src/server.js --doctor   # preflight if something won't connect
```

Then load the plugin in the Figma **desktop** app: right-click the canvas →
`Plugins → Development → Import plugin from manifest…` → `plugin/manifest.json`.
Leave its panel open. See the [README](README.md) for the full walkthrough and
smoke test.

Editing `plugin/*` requires re-running (or re-importing) the plugin in Figma to
reload it. Editing `src/*` requires restarting the server.

## Before you open a PR

- `node --check src/*.js plugin/code.js` — everything parses.
- `node src/server.js --version` and `--help` still work.
- `npm publish --dry-run` — the package still builds cleanly.
- Run the README smoke test against a real Figma file.

CI runs these on every push and PR (Node 18 and 22), so you'll see failures
there too.

## The bar for new IR fields

Every field added to `src/schema.js` is a field the plugin (`code.js`) must
handle **and** the model has to learn. Keep the IR boring: add a field only when
it maps cleanly onto a single Figma concept and earns its complexity. When in
doubt, open an issue to discuss before building.

## Gotchas worth knowing

- **Fonts must already exist in Figma.** `weight` is Figma's style name
  (`"Semi Bold"`), not a CSS number.
- **The plugin UI runs at a null origin** where `localStorage` can throw — guard
  any storage access in `try/catch` or the whole script aborts and the popup
  hangs on "Connecting…".
- **One socket at a time.** A second Figma window connecting drops the first.
- **Port 3055** is shared: the server binds it once. A stale instance squatting
  the port makes a second one fail with `EADDRINUSE`.

## Reporting bugs / requesting features

Use the issue templates — for bugs, the connection checklist in the form saves a
lot of round-trips.

By contributing, you agree your work is licensed under the [MIT License](LICENSE).
