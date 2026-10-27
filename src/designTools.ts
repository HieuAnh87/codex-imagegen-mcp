import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { DesignTasks } from "./designTasks.js";
import { makePreview } from "./files.js";

export function registerDesignTools(server: McpServer, tasks: DesignTasks) {
  const result = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  });
  const safe = async (fn: () => unknown | Promise<unknown>) => {
    try {
      return result(await fn());
    } catch (e) {
      return { ...result({ error: (e as Error).message }), isError: true };
    }
  };
  server.registerTool(
    "design_task_start",
    {
      description:
        "Start a persistent Codex design agent: read project sources, generate UI options, inspect its own images and refine. Returns immediately with task ID; poll design_task_status. Source repos are read-only; output has its own writable workspace. No Paseo required. Use this for product-grounded UI; generate_image is for prepared briefs/assets.",
      inputSchema: {
        brief: z.string().min(1).max(30000),
        source_dirs: z
          .array(z.string())
          .min(1)
          .max(8)
          .describe(
            "Absolute project directories to read; include product and UI repos as needed.",
          ),
        reference_images: z.array(z.string()).max(5).default([]),
        criteria: z
          .array(z.string().min(1))
          .min(1)
          .max(30)
          .describe(
            "Required copy, unchanged regions, option differences and acceptance criteria.",
          ),
        max_rounds: z.number().int().min(1).max(5).default(3),
        max_images: z.number().int().min(1).max(12).default(6),
        timeout_seconds: z.number().int().min(10).max(3600).default(900),
        effort: z.enum(["low", "medium", "high", "xhigh"]).default("high"),
      },
    },
    async (input) => safe(() => tasks.start(input)),
  );
  server.registerTool(
    "design_task_status",
    {
      description:
        "Read progress, persisted image paths, review evidence and unresolved issues. completed means the agent reported passing criteria, not independent verification. Optional previews are downscaled; inspect original images for text. Tasks survive MCP restarts; interrupted tasks require explicit continue.",
      inputSchema: { task_id: z.string(), preview: z.boolean().default(false) },
    },
    async (input) => {
      try {
        const task = tasks.get(input.task_id);
        const content: any[] = result(task).content;
        if (input.preview)
          for (const img of task.images.slice(-4)) {
            const p = await makePreview(img.path);
            content.push(
              { type: "text", text: img.path },
              { type: "image", data: p.data, mimeType: p.mimeType },
            );
          }
        return { content };
      } catch (e) {
        return { ...result({ error: (e as Error).message }), isError: true };
      }
    },
  );
  server.registerTool(
    "design_task_continue",
    {
      description:
        "Continue a terminal task in the SAME Codex thread with user feedback (e.g. edit option B). Starts a new bounded run using the original per-run image/time/round limits; earlier artifacts and reviews remain. Does not auto-retry failed tasks.",
      inputSchema: {
        task_id: z.string(),
        feedback: z.string().min(1).max(30000),
      },
    },
    async (input) => safe(() => tasks.continue(input.task_id, input.feedback)),
  );
  server.registerTool(
    "design_task_cancel",
    {
      description:
        "Request interruption of a running design task, including from another MCP process. Poll until terminal. Existing artifacts remain; already dispatched image calls may still finish.",
      inputSchema: { task_id: z.string() },
    },
    async (input) => safe(() => tasks.cancel(input.task_id)),
  );
}
