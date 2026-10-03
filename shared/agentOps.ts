import { z } from 'zod';

/**
 * Edit operations the in-app Claude can send in one `edit` call. The main process validates tool
 * input with this schema and the renderer applies the ops to a draft project, committing once
 * (one undo step) or not at all if any op fails.
 */
const id = z.string().describe('clip id from get_state');
const sec = z.number().min(0);
const color = z
  .object({
    brightness: z.number().min(-1).max(1),
    contrast: z.number().min(-1).max(1),
    saturation: z.number().min(-1).max(1),
    temperature: z.number().min(-1).max(1),
    look: z.number().min(0).max(1),
  })
  .partial();

export const EditOp = z.discriminatedUnion('op', [
  z.object({ op: z.literal('seek'), t: sec }),
  z.object({ op: z.literal('select'), clip: id.nullable() }),
  z.object({ op: z.literal('move'), clip: id, start: sec, track: z.string().optional().describe('target track id, same kind') }),
  z.object({ op: z.literal('trim'), clip: id, start: sec.optional(), end: sec.optional() }).describe('new timeline start and/or end'),
  z.object({ op: z.literal('split'), clip: id, t: sec }),
  z.object({ op: z.literal('delete'), clip: id }),
  z.object({
    op: z.literal('add_media'),
    asset: z.string().describe('asset alias like A1, or asset id'),
    start: sec.optional().describe('omit to append at the end of the main track'),
    track: z.string().optional().describe('track id; omit for main track, "new" for a new track'),
  }),
  z.object({
    op: z.literal('add_text'),
    preset: z.enum(['hook-num', 'hook', 'sub', 'aside', 'badge-dday', 'badge-salary']),
    text: z.string().optional(),
    start: sec,
    dur: z.number().positive().optional(),
  }),
  z.object({
    op: z.literal('set_text'),
    clip: id,
    text: z.string().optional(),
    x: z.number().min(0).max(1).optional(),
    y: z.number().min(0).max(1).optional(),
    size: z.number().min(12).max(300).optional(),
    color: z.string().optional(),
    font: z
      .enum(['black', 'bold', 'semibold', 'medium', 'serif', 'pres-bold', 'pres-black', 'hand'])
      .optional()
      .describe('serif = Korean myeongjo for titles; pres-* = Freesentation gothic; hand = handwriting'),
    tracking: z.number().min(-0.1).max(0.3).optional().describe('letter spacing in em, e.g. -0.04'),
    shadow: z.number().min(0).max(1).optional().describe('soft shadow opacity; 0 = none'),
    highlight: z.string().optional().describe('word drawn in highlight color'),
    anim: z.enum(['none', 'fade', 'pop', 'rise']).optional(),
  }),
  z.object({
    op: z.literal('set_clip'),
    clip: id,
    volume: z.number().min(0).max(2).optional(),
    fadeIn: sec.optional(),
    fadeOut: sec.optional(),
    speed: z.number().min(0.5).max(2).optional().describe('later clips on the track shift with it'),
    dissolve: z.number().min(0).max(2).optional().describe('cross dissolve from the clip just before on the same video track, centered on the cut; 0 = hard cut'),
    scale: z.number().min(0.1).max(4).optional(),
    x: z.number().min(-1).max(1).optional(),
    y: z.number().min(-1).max(1).optional(),
    crop: z
      .object({ l: z.number(), t: z.number(), r: z.number(), b: z.number() })
      .partial()
      .optional()
      .describe('fractions of the picture cut from left/top/right/bottom (0-0.95); position stays put, the cut area shows what is below'),
  }),
  z.object({
    op: z.literal('color'),
    clip: z.string().describe('clip id, or "all" for every video-track clip'),
    preset: z.string().optional().describe('color preset name; applied before values'),
    values: color.optional(),
  }),
  z.object({ op: z.literal('save_color_preset'), name: z.string().min(1), clip: id }),
  z.object({ op: z.literal('track'), track: z.string(), muted: z.boolean().optional(), hidden: z.boolean().optional() }),
  z.object({
    op: z.literal('vars'),
    uploadDate: z.string().optional().describe('YYYY-MM-DD'),
    ddayTarget: z.string().optional(),
    salary: z.number().optional(),
    goal: z.number().optional(),
  }),
  z.object({ op: z.literal('import_conti'), post: z.string().describe('board post id, e.g. p001') }),
]);

export type EditOp = z.infer<typeof EditOp>;

export const AGENT_TOOLS = ['get_state', 'edit', 'screenshot', 'screenshot_app'] as const;
export type AgentToolName = (typeof AGENT_TOOLS)[number];

/**
 * Extra tools for the local bridge only (Claude Code editing the open window from outside).
 * Never offered to the in-app Claude, which cannot replace projects, probe files or export.
 */
export const BRIDGE_TOOLS = ['load_project', 'probe_media', 'export'] as const;
export type BridgeToolName = (typeof BRIDGE_TOOLS)[number];
export type ToolName = AgentToolName | BridgeToolName;

/** What a renderer-side tool returns to the main process. */
export interface AgentToolResult {
  text: string;
  /** JPEG, base64 without data: prefix */
  jpegBase64?: string;
  isError?: boolean;
}

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; detail: string }
  | {
      type: 'done';
      sessionId: string;
      seconds: number;
      inputTokens: number;
      cachedTokens: number;
      outputTokens: number;
    }
  | { type: 'error'; message: string };

export type AgentModel = 'sonnet' | 'haiku' | 'opus';
