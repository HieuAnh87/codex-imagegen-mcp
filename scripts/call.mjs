// Calls one tool on the built server through MCP. Usage: node scripts/call.mjs <tool> <args.json>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync } from "node:fs";

const [tool, argsFile] = process.argv.slice(2);
const args = argsFile ? JSON.parse(readFileSync(argsFile, "utf8")) : {};
const transport = new StdioClientTransport({ command: process.execPath, args: [new URL("../dist/index.js", import.meta.url).pathname], stderr: "inherit" });
const client = new Client({ name: "call", version: "0" });
await client.connect(transport);
const t0 = Date.now();
const res = await client.callTool({ name: tool, arguments: args }, undefined, {
  timeout: 900000, resetTimeoutOnProgress: true,
  onprogress: (p) => console.error(`${((Date.now() - t0) / 1000).toFixed(1)}s ${p.message ?? ""}`),
});
console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s isError=${res.isError ?? false}`);
for (const c of res.content) if (c.type === "text") console.log(c.text);
await client.close();
