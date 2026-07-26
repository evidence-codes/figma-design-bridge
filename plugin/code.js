/**
 * Design Bridge — plugin main thread.
 *
 * Receives specs from the bridge server (via ui.html) and turns them into
 * Figma nodes. This is the only place in the system that can mutate a canvas.
 *
 * Three things in here are load-bearing and easy to get wrong:
 *   1. Fonts are loaded up front, all of them, before any text is created.
 *   2. Children are appended before their sizing is set. FILL silently does
 *      nothing if the node isn't already inside an auto-layout parent.
 *   3. Every screen carries a key in pluginData so a re-render replaces
 *      rather than duplicates.
 */

const KEY = "bridgeKey";
const GAP = 80; // canvas gutter between tiled screens

figma.showUI(__html__, { width: 300, height: 188 });

figma.ui.onmessage = async (msg) => {
  if (!msg || !msg.id) return;
  try {
    const result = await handle(msg.cmd, msg.payload || {});
    figma.ui.postMessage({ id: msg.id, ok: true, result });
  } catch (err) {
    figma.ui.postMessage({
      id: msg.id,
      ok: false,
      error: (err && err.message) || String(err),
    });
  }
};

async function handle(cmd, payload) {
  switch (cmd) {
    case "status":
      return {
        fileName: figma.root.name,
        pageName: figma.currentPage.name,
        existingScreens: findScreens().length,
      };
    case "render":
      return await render(payload.spec, payload.fonts || []);
    case "variables":
      return await variables(payload.spec);
    case "list":
      return {
        screens: findScreens().map((n) => ({
          key: n.getPluginData(KEY),
          name: n.name,
          id: n.id,
        })),
      };
    case "delete": {
      const found = findScreens().find((n) => n.getPluginData(KEY) === payload.key);
      if (!found) return { deleted: false };
      found.remove();
      return { deleted: true };
    }
    default:
      throw new Error(`Unknown command '${cmd}'`);
  }
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */

let budget = 0;

async function render(spec, fonts) {
  // 1. Fonts first. Every one of them. This is the step people skip and
  //    then spend an afternoon debugging "Cannot write to node with
  //    unloaded font".
  await Promise.all(
    fonts.map((f) =>
      figma.loadFontAsync({ family: f.family, style: f.style }).catch(() => {
        throw new Error(
          `Font not available in Figma: ${f.family} ${f.style}. ` +
            `Install it or pick another.`
        );
      })
    )
  );

  // 2. Work out where it goes, and whether we're replacing something.
  const existing = findScreens().find((n) => n.getPluginData(KEY) === spec.key);
  let x = spec.x;
  let y = spec.y;
  if (existing) {
    if (x === undefined) x = existing.x;
    if (y === undefined) y = existing.y;
  } else if (x === undefined || y === undefined) {
    const spot = nextFreeSpot(spec.width);
    x = x === undefined ? spot.x : x;
    y = y === undefined ? spot.y : y;
  }

  // 3. Build into a detached frame, then swap. Building in place makes the
  //    canvas flicker through half-drawn states on every re-render.
  budget = 0;
  const screen = figma.createFrame();
  screen.name = spec.name;
  screen.setPluginData(KEY, spec.key);
  screen.fills = [solid(spec.background || "#FFFFFF")];
  screen.layoutMode = "VERTICAL";
  screen.primaryAxisSizingMode = "AUTO";
  screen.counterAxisSizingMode = "FIXED";
  screen.resize(spec.width, 1);
  screen.clipsContent = true;

  figma.currentPage.appendChild(screen);
  const child = await build(spec.root, screen);
  applySizing(child, spec.root, screen);

  // The wrapper is AUTO on its vertical axis, but a single auto-layout child
  // whose own vertical sizing resolves to FILL leaves the wrapper pinned at its
  // seed height of 1 — and with clipsContent on, that guillotines the whole
  // design to a 1px sliver. Pin the wrapper to the built child's real height so
  // it fits its content instead of clipping.
  screen.primaryAxisSizingMode = "FIXED";
  screen.resize(spec.width, Math.max(child.height, 1));

  screen.x = x;
  screen.y = y;

  if (existing) existing.remove();

  figma.currentPage.selection = [screen];
  return {
    id: screen.id,
    x: screen.x,
    y: screen.y,
    nodeCount: budget,
    replaced: Boolean(existing),
  };
}

async function build(spec, parent) {
  budget++;
  // Yield occasionally. Figma runs this on its UI thread and a few thousand
  // synchronous node creations will visibly freeze the app.
  if (budget % 200 === 0) await new Promise((r) => setTimeout(r, 0));

  let node;

  if (spec.type === "frame") {
    node = figma.createFrame();
    node.name = spec.name || "Frame";
    node.fills = spec.fill ? [solid(spec.fill)] : [];
    node.clipsContent = Boolean(spec.clip);
    if (spec.radius) node.cornerRadius = spec.radius;
    if (spec.stroke) {
      node.strokes = [solid(spec.stroke)];
      node.strokeWeight = spec.strokeWidth || 1;
    }

    if (spec.layout === "none") {
      node.layoutMode = "NONE";
    } else {
      node.layoutMode = spec.layout === "row" ? "HORIZONTAL" : "VERTICAL";
      node.itemSpacing = spec.gap || 0;
      const p = pad(spec.pad);
      node.paddingTop = p[0];
      node.paddingRight = p[1];
      node.paddingBottom = p[2];
      node.paddingLeft = p[3];
      node.primaryAxisSizingMode = "AUTO";
      node.counterAxisSizingMode = "AUTO";
      node.primaryAxisAlignItems = primaryAlign(spec.justify);
      node.counterAxisAlignItems = counterAlign(spec.align);
    }

    // Append the container before its children so their FILL sizing has a
    // parent to fill against.
    parent.appendChild(node);

    for (const childSpec of spec.children || []) {
      const child = await build(childSpec, node);
      applySizing(child, childSpec, node);
    }

    if (spec.w !== undefined || spec.h !== undefined) {
      node.resize(spec.w || node.width, spec.h || node.height);
    }
    return node;
  }

  if (spec.type === "text") {
    node = figma.createText();
    node.fontName = { family: spec.font, style: spec.weight };
    node.characters = spec.content;
    node.fontSize = spec.size;
    node.fills = [solid(spec.color)];
    if (spec.lineHeight) {
      node.lineHeight = { value: spec.lineHeight, unit: "PIXELS" };
    }
    if (spec.letterSpacing !== undefined) {
      node.letterSpacing = { value: spec.letterSpacing, unit: "PIXELS" };
    }
    node.name = spec.name || truncate(spec.content);
    parent.appendChild(node);
    return node;
  }

  if (spec.type === "rect") {
    node = figma.createRectangle();
    node.name = spec.name || "Rectangle";
    node.resize(Math.max(spec.w, 0.01), Math.max(spec.h, 0.01));
    node.fills = spec.fill ? [solid(spec.fill)] : [];
    if (spec.stroke) {
      node.strokes = [solid(spec.stroke)];
      node.strokeWeight = spec.strokeWidth || 1;
    }
    if (spec.radius) node.cornerRadius = spec.radius;
    parent.appendChild(node);
    return node;
  }

  throw new Error(`Unknown node type '${spec.type}'`);
}

/**
 * Sizing has to happen after the node is in the tree, and it throws on
 * combinations Figma considers nonsense (HUG on a rectangle, FILL with no
 * auto-layout parent). Failing soft here beats aborting a whole screen.
 */
function applySizing(node, spec, parent) {
  if (!parent || parent.layoutMode === "NONE" || parent.layoutMode === undefined) return;
  const mode = spec.width;
  if (!mode || mode === "fixed") return;
  try {
    node.layoutSizingHorizontal = mode === "fill" ? "FILL" : "HUG";
  } catch (e) {
    // A rectangle can't hug; a text node in a vertical stack can't always
    // fill. Leave it at its natural size rather than blowing up the render.
  }
}

/* ------------------------------------------------------------------ *
 * Variables
 * ------------------------------------------------------------------ */

async function variables(spec) {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  let collection = collections.find((c) => c.name === spec.collection);
  if (!collection) {
    collection = figma.variables.createVariableCollection(spec.collection);
  }

  let modeId = collection.modes[0].modeId;
  const named = collection.modes.find((m) => m.name === spec.mode);
  if (named) modeId = named.modeId;
  else if (spec.mode !== "Default") {
    collection.renameMode(modeId, spec.mode);
  }

  const existing = await figma.variables.getLocalVariablesAsync("COLOR");
  let created = 0;
  let updated = 0;

  for (const [name, hex] of Object.entries(spec.colors)) {
    let v = existing.find(
      (item) => item.name === name && item.variableCollectionId === collection.id
    );
    if (!v) {
      v = figma.variables.createVariable(name, collection, "COLOR");
      created++;
    } else {
      updated++;
    }
    v.setValueForMode(modeId, rgb(hex));
  }

  return { created, updated };
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function findScreens() {
  return figma.currentPage.children.filter(
    (n) => n.getPluginData && n.getPluginData(KEY)
  );
}

function nextFreeSpot(width) {
  const screens = findScreens();
  if (!screens.length) return { x: 0, y: 0 };
  const right = Math.max(...screens.map((n) => n.x + n.width));
  const top = Math.min(...screens.map((n) => n.y));
  return { x: right + GAP, y: top };
}

function rgb(hex) {
  const h = hex.replace("#", "");
  return {
    r: parseInt(h.slice(0, 2), 16) / 255,
    g: parseInt(h.slice(2, 4), 16) / 255,
    b: parseInt(h.slice(4, 6), 16) / 255,
  };
}

function solid(hex) {
  return { type: "SOLID", color: rgb(hex) };
}

function pad(value) {
  if (typeof value === "number") return [value, value, value, value];
  if (!Array.isArray(value)) return [0, 0, 0, 0];
  if (value.length === 2) return [value[0], value[1], value[0], value[1]];
  if (value.length === 4) return value;
  return [0, 0, 0, 0];
}

function primaryAlign(v) {
  return v === "center"
    ? "CENTER"
    : v === "end"
    ? "MAX"
    : v === "space-between"
    ? "SPACE_BETWEEN"
    : "MIN";
}

function counterAlign(v) {
  return v === "center" ? "CENTER" : v === "end" ? "MAX" : "MIN";
}

function truncate(s) {
  return s.length > 28 ? s.slice(0, 28) + "…" : s;
}
