// Live, bounded proof. Uses the signed-in Codex plan (up to two images).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
const source = join(homedir(), ".cache", "codex-imagegen-mcp", "smoke-source");
mkdirSync(source, { recursive: true });
writeFileSync(
  join(source, "design.md"),
  '# Smoke design\nCreate a simple square UI card with exact title "SOURCE CHECK" and one blue button labelled "Continue". Background #f4f7fc. No other copy.\n',
);
const client = new Client({ name: "design-agent-smoke", version: "1" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [resolve("dist/index.js")],
    stderr: "inherit",
  }),
);
let id;
try {
  const parse = (r) => {
    if (r.isError) throw new Error(JSON.stringify(r.content));
    return JSON.parse(r.content.find((c) => c.type === "text").text);
  };
  const start = process.argv[2]
    ? parse(
        await client.callTool({
          name: "design_task_continue",
          arguments: {
            task_id: process.argv[2],
            feedback:
              "Do not generate more images. Open the original generated image using the image viewer tool, inspect the two exact required labels again, and return the original image path among inspected_images and selected_images. Keep all original criteria.",
          },
        }),
      )
    : parse(
        await client.callTool({
          name: "design_task_start",
          arguments: {
            brief:
              "Read design.md in the provided source directory. Generate the requested card using built-in image_gen. Open and inspect your output. Return the required structured review with exact image paths; do not edit source files.",
            source_dirs: [source],
            criteria: ["Title reads SOURCE CHECK", "Button reads Continue"],
            max_rounds: 2,
            max_images: 2,
            timeout_seconds: 240,
            effort: "high",
          },
        }),
      );
  id = start.id;
  console.log(JSON.stringify({ task_id: id, status: start.status }));
  let prior = "";
  for (let i = 0; i < 150; i++) {
    const task = parse(
      await client.callTool({
        name: "design_task_status",
        arguments: { task_id: id },
      }),
    );
    if (task.lastEvent !== prior) {
      console.log(
        JSON.stringify({ status: task.status, progress: task.lastEvent }),
      );
      prior = task.lastEvent;
    }
    if (!["starting", "running"].includes(task.status)) {
      console.log(
        JSON.stringify({
          status: task.status,
          images: task.images,
          reviews: task.reviews,
          error: task.error,
        }),
      );
      if (task.status !== "completed") process.exitCode = 1;
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
} finally {
  if (id)
    await client
      .callTool({ name: "design_task_cancel", arguments: { task_id: id } })
      .catch(() => {});
  await client.close();
}
