import { z } from "zod";

/**
 * The intermediate representation.
 *
 * This is the contract. Claude emits it, the plugin executes it. Everything
 * here maps one-to-one onto a Figma concept, which is the whole point — no
 * layout engine, no CSS reverse-engineering, no guessing what a div meant.
 *
 * Keep this file small and boring. Every field you add is a field the plugin
 * has to handle and the model has to learn.
 */

const Hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "expected a 6-digit hex colour like #1F5F45");

const Pad = z.union([
  z.number(),
  z.tuple([z.number(), z.number()]),
  z.tuple([z.number(), z.number(), z.number(), z.number()]),
]);

const Align = z.enum(["start", "center", "end", "space-between"]);
const Sizing = z.enum(["hug", "fill", "fixed"]);

const TextNode = z.object({
  type: z.literal("text"),
  name: z.string().optional(),
  content: z.string(),
  font: z.string().default("Inter"),
  weight: z.string().default("Regular"),
  size: z.number().default(14),
  lineHeight: z.number().optional(),
  letterSpacing: z.number().optional(),
  color: Hex.default("#000000"),
  width: Sizing.default("hug"),
});

const RectNode = z.object({
  type: z.literal("rect"),
  name: z.string().optional(),
  w: z.number().default(0),
  h: z.number().default(0),
  fill: Hex.optional(),
  stroke: Hex.optional(),
  strokeWidth: z.number().default(1),
  radius: z.number().default(0),
  width: Sizing.default("fixed"),
});

/**
 * Recursive, so it needs the lazy getter. A frame is the only container —
 * everything about layout lives here because Figma's auto layout is the
 * only layout primitive worth targeting.
 */
const FrameNode = z.object({
  type: z.literal("frame"),
  name: z.string().optional(),
  layout: z.enum(["row", "col", "none"]).default("col"),
  gap: z.number().default(0),
  pad: Pad.default(0),
  align: Align.default("start"),
  justify: Align.default("start"),
  fill: Hex.optional(),
  stroke: Hex.optional(),
  strokeWidth: z.number().default(1),
  radius: z.number().default(0),
  w: z.number().optional(),
  h: z.number().optional(),
  width: Sizing.default("hug"),
  clip: z.boolean().default(false),
  children: z.lazy(() => z.array(Node)).default([]),
});

export const Node = z.discriminatedUnion("type", [
  FrameNode,
  TextNode,
  RectNode,
]);

export const ScreenSpec = z.object({
  /** Stable key. Re-rendering the same key updates in place instead of duplicating. */
  key: z.string().min(1),
  name: z.string().min(1),
  width: z.number().default(1440),
  background: Hex.default("#FFFFFF"),
  /** Canvas position. Omit and the plugin tiles new screens left to right. */
  x: z.number().optional(),
  y: z.number().optional(),
  root: Node,
});

export const VariableSpec = z.object({
  collection: z.string().min(1),
  mode: z.string().default("Default"),
  colors: z.record(z.string(), Hex),
});

/** Walks a spec and returns every distinct {family, style} pair it needs. */
export function collectFonts(node, found = []) {
  if (node.type === "text") {
    const family = node.font ?? "Inter";
    const style = node.weight ?? "Regular";
    if (!found.some((f) => f.family === family && f.style === style)) {
      found.push({ family, style });
    }
  }
  for (const child of node.children ?? []) collectFonts(child, found);
  return found;
}
