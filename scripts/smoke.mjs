// Real end-to-end check through the MCP protocol. Spends real image quota.
// Usage: node scripts/smoke.mjs [out_dir]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { homedir } from "node:os";
import { join } from "node:path";

const outDir = process.argv[2] ?? join(homedir(), ".cache", "codex-imagegen-smoke");
const transport = new StdioClientTransport({ command: process.execPath, args: [new URL("../dist/index.js", import.meta.url).pathname], stderr: "inherit" });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);
const t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
const status = await client.callTool({ name: "imagegen_status", arguments: {} });
console.log(secs(), "status:", status.content[0].text.slice(0, 900));

const res = await client.callTool(
  { name: "generate_image", arguments: {
    prompt: "Use case: ui-mockup\nAsset type: mobile app settings screen\nPrimary request: minimal settings screen with 4 toggle rows\nText (verbatim): \"Settings\", \"Notifications\", \"Dark mode\", \"Sync\", \"Location\"\nConstraints: realistic product UI, legible text, no logos, no watermark",
    variations: ["light iOS style, blue accent", "dark mode, green accent"],
    aspect_ratio: "9:16", name: "smoke-settings", out_dir: outDir } },
  undefined,
  { timeout: 600000, resetTimeoutOnProgress: true, onprogress: (p) => console.log(secs(), "progress", JSON.stringify(p)) },
);
console.log(secs(), "isError:", res.isError ?? false);
for (const c of res.content) console.log(c.type === "image" ? `<image ${c.mimeType} ${c.data.length} b64 chars>` : c.text);
await client.close();
