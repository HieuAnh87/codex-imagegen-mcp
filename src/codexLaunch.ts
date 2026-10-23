// How the Codex app-server child is launched: arguments that strip every
// capability image generation does not need, and an environment built from an
// allowlist so an API key on the host can never reach the CLI fallback.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Features that would let the image thread reach tools, other processes, or
// user hooks. Image generation is a built-in tool and needs none of them.
export const DISABLED_FEATURES = [
  "hooks",
  "plugins",
  "apps",
  "computer_use",
  "browser_use",
  "multi_agent",
  "goals",
] as const;

// Variables the child may inherit. OPENAI_API_KEY is deliberately absent: the
// imagegen skill's CLI fallback spends API credit, and the point of this server
// is to stay on the ChatGPT plan.
const ENV_ALLOWLIST = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TERM",
  "CODEX_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
];

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

export function buildCodexEnv(parent: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ENV_ALLOWLIST) {
    if (parent[key] !== undefined) env[key] = parent[key];
  }
  for (const [key, value] of Object.entries(parent)) {
    if (key.startsWith("LC_") && value !== undefined) env[key] = value;
  }
  return env;
}

const MCP_HEADER = /^\s*\[mcp_servers\.(?:"((?:[^"\\]|\\.)+)"|([A-Za-z0-9_-]+))\]\s*$/;

// Top-level `[mcp_servers.<name>]` tables in config.toml. Sub-tables such as
// `[mcp_servers.<name>.env]` do not match. `-c mcp_servers={}` merges instead of
// replacing, so each server has to be disabled by name.
export function parseMcpServerNames(toml: string): string[] {
  const names = new Set<string>();
  for (const line of toml.split(/\r?\n/)) {
    const m = MCP_HEADER.exec(line);
    if (!m) continue;
    const name = m[1] !== undefined ? JSON.parse(`"${m[1]}"`) as string : m[2]!;
    names.add(name);
  }
  return [...names];
}

export function readConfiguredMcpServerNames(home: string = codexHome()): string[] {
  try {
    return parseMcpServerNames(readFileSync(join(home, "config.toml"), "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

export function buildAppServerArgs(mcpServerNames: readonly string[]): string[] {
  const args = ["app-server"];
  for (const name of mcpServerNames) {
    args.push("-c", `mcp_servers.${tomlKey(name)}.enabled=false`);
  }
  for (const feature of DISABLED_FEATURES) {
    args.push("--disable", feature);
  }
  return args;
}
