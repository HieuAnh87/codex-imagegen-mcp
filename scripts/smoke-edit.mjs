// Real edit_image check. Usage: node scripts/smoke-edit.mjs <abs image path> "<instructions>"
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname } from "node:path";

const [image, instructions = "Change the accent color of the toggles to purple."] = process.argv.slice(2);
const transport = new StdioClientTransport({ command: process.execPath, args: [new URL("../dist/index.js", import.meta.url).pathname], stderr: "inherit" });
const client = new Client({ name: "smoke-edit", version: "0" });
await client.connect(transport);
const t0 = Date.now();
const res = await client.callTool({ name: "edit_image", arguments: { image, instructions, out_dir: dirname(image) } }, undefined, { timeout: 600000, resetTimeoutOnProgress: true });
console.log(((Date.now() - t0) / 1000).toFixed(1) + "s", "isError:", res.isError ?? false);
for (const c of res.content) console.log(c.type === "image" ? `<image ${c.data.length} b64 chars>` : c.text.slice(0, 600));
await client.close();
