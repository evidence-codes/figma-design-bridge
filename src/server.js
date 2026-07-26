#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { WebSocketServer } from "ws";
import { z } from "zod";
import { ScreenSpec, VariableSpec, collectFonts } from "./schema.js";

const PORT = Number(process.env.FIGMA_BRIDGE_PORT ?? 3055);

/* ------------------------------------------------------------------ *
 * Transport to the plugin
 *
 * One socket at a time — a second Figma window connecting replaces the
 * first. Multiplexing across files is a real feature but it is not a
 * day-one feature, and pretending otherwise gets you silent misdelivery.
 * ------------------------------------------------------------------ */

let socket = null;
let seq = 0;
const pending = new Map();

let wsError = null;
const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });

wss.on("error", (err) => {
  // Never let a listen failure crash the process — that would kill the
  // stdio MCP transport too, and Claude would only see "failed to connect"
  // with no explanation. Record it so figma_status can report it instead.
  wsError = err;
  if (err.code === "EADDRINUSE") {
    log(
      `port ${PORT} is already in use — another figma-bridge instance is ` +
        `probably running. The plugin socket is unavailable. Set ` +
        `FIGMA_BRIDGE_PORT to use a different port.`
    );
  } else {
    log(`websocket server error: ${err.message}`);
  }
});

wss.on("connection", (ws) => {
  if (socket && socket.readyState === 1) socket.close();
  socket = ws;
  log(`plugin connected`);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return log("dropped a malformed frame from the plugin");
    }
    const entry = pending.get(msg.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(msg.id);
    msg.ok ? entry.resolve(msg.result) : entry.reject(new Error(msg.error));
  });

  ws.on("close", () => {
    log("plugin disconnected");
    if (socket === ws) socket = null;
  });
});

function log(line) {
  // stdout belongs to the MCP protocol. Anything human goes to stderr.
  process.stderr.write(`[figma-bridge] ${line}\n`);
}

function callPlugin(cmd, payload, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    if (!socket || socket.readyState !== 1) {
      return reject(
        new Error(
          "No Figma plugin connected. Open your file in the Figma desktop app " +
            "and run the Design Bridge plugin, then try again."
        )
      );
    }
    const id = String(++seq);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Plugin did not answer '${cmd}' within ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, cmd, payload }));
  });
}

/* ------------------------------------------------------------------ *
 * MCP surface
 *
 * Deliberately coarse. One call renders a whole screen. Fine-grained
 * tools (create_rect, set_fill) read nicely in a README and are agony in
 * practice — every node becomes a round trip through model latency.
 * ------------------------------------------------------------------ */

const server = new McpServer({ name: "figma-bridge", version: "0.1.0" });

server.tool(
  "figma_status",
  "Check whether the Figma plugin is connected and which file it has open. " +
    "Call this first if anything seems wrong.",
  {},
  async () => {
    if (wsError) {
      return text(
        `The plugin socket failed to start: ${wsError.message}. ` +
          (wsError.code === "EADDRINUSE"
            ? `Port ${PORT} is in use by another instance. Stop it, or set ` +
              `FIGMA_BRIDGE_PORT to a free port and restart.`
            : "Restart the figma-bridge server.")
      );
    }
    if (!socket || socket.readyState !== 1) {
      return text(
        "Not connected. Open the file in Figma desktop and run the Design Bridge plugin."
      );
    }
    const info = await callPlugin("status", {}, 10_000);
    return text(
      `Connected to "${info.fileName}", page "${info.pageName}". ` +
        `${info.existingScreens} screen(s) previously rendered by this bridge.`
    );
  }
);

server.tool(
  "render_screen",
  "Render a screen onto the Figma canvas from a typed spec. Frames become " +
    "auto-layout frames, text becomes real text nodes. Re-rendering the same " +
    "'key' replaces the previous version in place rather than duplicating it.",
  { spec: ScreenSpec },
  async ({ spec }) => {
    const fonts = collectFonts(spec.root);
    const result = await callPlugin("render", { spec, fonts });
    return text(
      `Rendered "${spec.name}" — ${result.nodeCount} nodes at ` +
        `(${Math.round(result.x)}, ${Math.round(result.y)}). ` +
        `Node id ${result.id}.` +
        (result.replaced ? " Replaced the previous version." : "")
    );
  }
);

server.tool(
  "create_variables",
  "Create or update a Figma variable collection of colours. Run this before " +
    "rendering screens so the design tokens exist as real variables.",
  { spec: VariableSpec },
  async ({ spec }) => {
    const result = await callPlugin("variables", { spec });
    return text(
      `Collection "${spec.collection}": ${result.created} created, ${result.updated} updated.`
    );
  }
);

server.tool(
  "list_screens",
  "List the screens this bridge has rendered into the current file, with their keys.",
  {},
  async () => {
    const result = await callPlugin("list", {}, 15_000);
    if (!result.screens.length) return text("No screens rendered yet.");
    return text(
      result.screens.map((s) => `${s.key} — ${s.name} (${s.id})`).join("\n")
    );
  }
);

server.tool(
  "delete_screen",
  "Remove a screen previously rendered by this bridge, by its key.",
  { key: z.string() },
  async ({ key }) => {
    const result = await callPlugin("delete", { key });
    return text(result.deleted ? `Deleted "${key}".` : `No screen with key "${key}".`);
  }
);

function text(body) {
  return { content: [{ type: "text", text: body }] };
}

/* ------------------------------------------------------------------ */

const transport = new StdioServerTransport();
await server.connect(transport);
log(`listening for the Figma plugin on ws://127.0.0.1:${PORT}`);

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    wss.close();
    process.exit(0);
  });
}
