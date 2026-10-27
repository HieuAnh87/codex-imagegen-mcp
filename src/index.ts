#!/usr/bin/env node
// MCP stdio server exposing Codex's built-in image generation.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import { DesignTasks } from "./designTasks.js";
import { registerDesignTools } from "./designTools.js";
import { z } from "zod";
import { AppServerClient } from "./appServer.js";
import { buildAppServerArgs, buildCodexEnv, readConfiguredMcpServerNames } from "./codexLaunch.js";
import { copyWithoutOverwrite, imageSize, makePreview, resolveOutDir, slugify } from "./files.js";
import { ImagegenError, ImagegenService, type Effort } from "./imagegen.js";
import { mapWithConcurrency, planEdit, planGenerate, type PlannedImage } from "./prompts.js";

const VERSION = "0.1.0";
const log = (msg: string) => process.stderr.write(`[codex-imagegen-mcp] ${msg}\n`);

function intEnv(name: string, fallback: number): number {
  const v = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

const config = {
  codexBin: process.env.CODEX_BIN || "codex",
  concurrency: intEnv("CODEX_IMAGEGEN_CONCURRENCY", 3),
  timeoutMs: intEnv("CODEX_IMAGEGEN_TIMEOUT_SECONDS", 300) * 1000,
  defaultEffort: (process.env.CODEX_IMAGEGEN_EFFORT as Effort | undefined) ?? "low",
  model: process.env.CODEX_IMAGEGEN_MODEL || undefined,
};

const client = new AppServerClient({
  command: config.codexBin,
  args: buildAppServerArgs(readConfiguredMcpServerNames()),
  env: buildCodexEnv(),
  clientVersion: VERSION,
  log,
});
const imagegen = new ImagegenService(client);

const server = new McpServer({ name: "codex-imagegen", version: VERSION });
const designClient = new AppServerClient({ command: config.codexBin, args: buildAppServerArgs(readConfiguredMcpServerNames()), env: buildCodexEnv(), clientVersion: VERSION, log });
const designTasks = new DesignTasks(designClient, process.env.CODEX_DESIGN_STATE_DIR || join(homedir(), ".cache", "codex-imagegen-mcp", "tasks"), config.model);
registerDesignTools(server, designTasks);

const effortSchema = z.enum(["low", "medium", "high"]).optional()
  .describe("Codex reasoning effort for writing the image prompt. Default low; raise it for dense UI or text-heavy images.");
const outDirSchema = z.string().optional()
  .describe("Directory to save into. Default: $CODEX_IMAGEGEN_OUT_DIR or ./generated-images under the server's working directory.");
const nameSchema = z.string().optional().describe("Base filename (slugified). Files are never overwritten; -2, -3… are appended.");
const previewSchema = z.boolean().optional().describe("Return downscaled JPEG previews inline (default true).");

interface RunArgs {
  planned: PlannedImage[];
  referenceImages: string[];
  effort?: Effort;
  outDir?: string;
  baseName: string;
  preview: boolean;
  progress?: (done: number, total: number, message: string) => Promise<void>;
}

async function runPlanned(args: RunArgs) {
  const dir = resolveOutDir(args.outDir);
  const total = args.planned.length;
  let done = 0;
  const outcomes = await mapWithConcurrency(args.planned, config.concurrency, async (p) => {
    try {
      const r = await imagegen.generate({
        prompt: p.prompt,
        referenceImages: args.referenceImages,
        effort: args.effort ?? config.defaultEffort,
        model: config.model,
        timeoutMs: config.timeoutMs,
      });
      const base = total > 1 ? `${args.baseName}-${p.index + 1}` : args.baseName;
      const path = await copyWithoutOverwrite(r.savedPath, dir, base);
      const size = await imageSize(path).catch(() => null);
      return { ok: true as const, index: p.index + 1, variation: p.variation, path, size, revised_prompt: r.revisedPrompt };
    } catch (err) {
      const e = err as Error;
      return {
        ok: false as const,
        index: p.index + 1,
        variation: p.variation,
        error: e instanceof ImagegenError ? e.code : "error",
        message: e.message,
        ...(e instanceof ImagegenError && e.details ? { details: e.details } : {}),
      };
    } finally {
      done++;
      await args.progress?.(done, total, `${done}/${total} image(s) finished`).catch(() => {});
    }
  });

  const images = outcomes.filter((o) => o.ok);
  const errors = outcomes.filter((o) => !o.ok);
  const content: any[] = [{ type: "text", text: JSON.stringify({ out_dir: dir, images, errors }, null, 2) }];
  if (args.preview) {
    for (const img of images) {
      const prev = await makePreview(img.path).catch(() => null);
      if (!prev) continue;
      content.push({ type: "text", text: `Variant ${img.index}${img.variation ? ` — ${img.variation}` : ""}: ${img.path}` });
      content.push({ type: "image", data: prev.data, mimeType: prev.mimeType });
    }
  }
  return { content, isError: images.length === 0 };
}

function progressReporter(extra: any) {
  const token = extra?._meta?.progressToken;
  if (token === undefined) return undefined;
  return (progress: number, total: number, message: string) =>
    extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, total, message } });
}

function checkPaths(paths: string[]): string | null {
  for (const p of paths) {
    if (!isAbsolute(p)) return `Path must be absolute: ${p}`;
    if (!existsSync(p)) return `File not found: ${p}`;
  }
  return null;
}

server.registerTool(
  "generate_image",
  {
    title: "Generate image with Codex",
    description: [
      "Generate one or more raster images with Codex's built-in image generation (billed to the signed-in ChatGPT plan, no API key).",
      "Each image takes roughly 20-90s. Use `variations` for distinct design directions (one image each, run in parallel), or `count` for repeats of the same brief.",
      "This is a single-shot worker, without repository research or self-review. For product UI use design_task_start. For prepared mockup briefs, e.g.:",
      "Use case: ui-mockup / Asset type: web app screen 1440x900 / Primary request: ... / Layout: sections in order / Text (verbatim): \"...\" / Style: ... / Constraints: realistic product UI, legible text, no logos, no watermark.",
      "Returns saved file paths plus inline previews.",
    ].join("\n"),
    inputSchema: {
      prompt: z.string().min(1).describe("The image brief shared by every variant."),
      variations: z.array(z.string().min(1)).min(1).max(4).optional()
        .describe("Up to 4 design directions; one image per entry, each = prompt + its direction."),
      count: z.number().int().min(1).max(4).optional().describe("Number of images when `variations` is omitted (default 1)."),
      reference_images: z.array(z.string()).max(5).optional()
        .describe("Absolute paths of images to attach as visual references (style, layout, brand)."),
      aspect_ratio: z.string().optional().describe("Advisory aspect ratio such as 16:9, 9:16, 4:3. The tool picks the final size."),
      transparent_background: z.boolean().optional(),
      effort: effortSchema,
      name: nameSchema,
      out_dir: outDirSchema,
      preview: previewSchema,
    },
  },
  async (input, extra) => {
    const refs = input.reference_images ?? [];
    const bad = checkPaths(refs);
    if (bad) return { content: [{ type: "text", text: bad }], isError: true };
    const planned = planGenerate({
      prompt: input.prompt,
      variations: input.variations,
      count: input.count,
      aspectRatio: input.aspect_ratio,
      transparentBackground: input.transparent_background,
    });
    return runPlanned({
      planned,
      referenceImages: refs,
      effort: input.effort,
      outDir: input.out_dir,
      baseName: slugify(input.name ?? input.prompt.split("\n")[0] ?? "image"),
      preview: input.preview ?? true,
      progress: progressReporter(extra),
    });
  },
);

server.registerTool(
  "edit_image",
  {
    title: "Edit image with Codex",
    description:
      "Edit an existing local image with Codex's built-in image generation. The source is attached to the request; the result is saved as a new file and the source is never modified.",
    inputSchema: {
      image: z.string().describe("Absolute path of the image to edit."),
      instructions: z.string().min(1).describe("What to change. Everything else is asked to stay identical."),
      extra_references: z.array(z.string()).max(4).optional().describe("Additional absolute image paths to use as references."),
      count: z.number().int().min(1).max(4).optional().describe("Number of edited variants (default 1)."),
      transparent_background: z.boolean().optional(),
      effort: effortSchema,
      name: nameSchema,
      out_dir: outDirSchema,
      preview: previewSchema,
    },
  },
  async (input, extra) => {
    const refs = [input.image, ...(input.extra_references ?? [])];
    const bad = checkPaths(refs);
    if (bad) return { content: [{ type: "text", text: bad }], isError: true };
    const planned = planEdit({
      instructions: input.instructions,
      count: input.count,
      transparentBackground: input.transparent_background,
    });
    const sourceName = input.image.split("/").pop()?.replace(/\.[^.]+$/, "") ?? "image";
    return runPlanned({
      planned,
      referenceImages: refs,
      effort: input.effort,
      outDir: input.out_dir,
      baseName: slugify(input.name ?? `${sourceName}-edit`),
      preview: input.preview ?? true,
      progress: progressReporter(extra),
    });
  },
);

server.registerTool(
  "imagegen_status",
  {
    title: "Codex image generation status",
    description: "Check the Codex sign-in, plan, rate-limit windows, and whether image generation is available. Call before a large batch.",
    inputSchema: {},
  },
  async () => {
    try {
      const { account, limits, caps } = await imagegen.status();
      const summary = {
        signed_in: Boolean(account?.account),
        requires_openai_auth: account?.requiresOpenaiAuth ?? null,
        auth_type: account?.account?.type ?? null,
        plan: account?.account?.planType ?? limits?.rateLimits?.planType ?? null,
        image_generation: caps?.imageGeneration ?? null,
        ordinary_usage_allowed: limits?.ordinaryUsageAllowed ?? null,
        rate_limits: limits?.rateLimitsByLimitId ?? limits?.rateLimits ?? limits,
        settings: { concurrency: config.concurrency, timeout_seconds: config.timeoutMs / 1000, effort: config.defaultEffort, model: config.model ?? "(Codex default)" },
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Codex app-server unavailable: ${(err as Error).message}` }], isError: true };
    }
  },
);

const shutdown = async () => {
  await designTasks.close();
  await client.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
log(`ready (codex=${config.codexBin}, concurrency=${config.concurrency})`);
