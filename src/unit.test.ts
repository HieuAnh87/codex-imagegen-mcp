import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildAppServerArgs, buildCodexEnv, parseMcpServerNames } from "./codexLaunch.js";
import { copyWithoutOverwrite, resolveOutDir, slugify } from "./files.js";
import { mapWithConcurrency, planEdit, planGenerate } from "./prompts.js";

test("parseMcpServerNames reads top-level tables only, bare and quoted", () => {
  const toml = [
    'model = "x"',
    "[mcp_servers.gitnexus]",
    'command = "gitnexus"',
    "[mcp_servers.gitnexus.env]",
    'A = "b"',
    '[mcp_servers."postgres-mcp.prod"]',
    "[mcp_servers.chrome-devtools]",
    "[features]",
  ].join("\n");
  assert.deepEqual(parseMcpServerNames(toml), ["gitnexus", "postgres-mcp.prod", "chrome-devtools"]);
});

test("buildAppServerArgs disables every server by name and risky features", () => {
  const args = buildAppServerArgs(["gitnexus", "postgres-mcp.prod"]);
  assert.equal(args[0], "app-server");
  assert.ok(args.includes("mcp_servers.gitnexus.enabled=false"));
  assert.ok(args.includes('mcp_servers."postgres-mcp.prod".enabled=false'));
  for (const f of ["hooks", "plugins", "apps", "computer_use", "browser_use", "multi_agent"]) {
    const i = args.indexOf(f);
    assert.ok(i > 0 && args[i - 1] === "--disable", `missing --disable ${f}`);
  }
});

test("buildCodexEnv never forwards OPENAI_API_KEY or unrelated secrets", () => {
  const env = buildCodexEnv({ HOME: "/h", PATH: "/bin", OPENAI_API_KEY: "sk-x", AWS_SECRET_ACCESS_KEY: "s", LC_ALL: "C" });
  assert.deepEqual(env, { HOME: "/h", PATH: "/bin", LC_ALL: "C" });
});

test("planGenerate builds one prompt per variation with constraints", () => {
  const plan = planGenerate({ prompt: "Brief", variations: ["dark", "light"], aspectRatio: "16:9" });
  assert.equal(plan.length, 2);
  assert.match(plan[0]!.prompt, /^Brief\nCanvas aspect ratio: 16:9\n\nVariation direction \(this image only\): dark$/);
  assert.equal(plan[1]!.variation, "light");
});

test("planGenerate count repeats the brief and labels variants", () => {
  assert.equal(planGenerate({ prompt: "Brief" })[0]!.prompt, "Brief");
  const plan = planGenerate({ prompt: "Brief", count: 3, transparentBackground: true });
  assert.equal(plan.length, 3);
  assert.match(plan[2]!.prompt, /transparent/);
  assert.match(plan[2]!.prompt, /variant 3 of 3/);
});

test("planEdit keeps everything but the instructions", () => {
  const [p] = planEdit({ instructions: "make the button green" });
  assert.match(p!.prompt, /keep everything else/);
  assert.match(p!.prompt, /make the button green/);
});

test("mapWithConcurrency preserves order and respects the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapWithConcurrency([30, 10, 20, 5], 2, async (ms) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, ms));
    inFlight--;
    return ms * 2;
  });
  assert.deepEqual(out, [60, 20, 40, 10]);
  assert.equal(peak, 2);
});

test("slugify handles Vietnamese and empty input", () => {
  assert.equal(slugify("Màn hình Đăng nhập — Agent picker!"), "man-hinh-dang-nhap-agent-picker");
  assert.equal(slugify("!!!"), "image");
});

test("resolveOutDir prefers argument, then env, then cwd", () => {
  assert.equal(resolveOutDir("/abs", {}, "/cwd"), "/abs");
  assert.equal(resolveOutDir("rel", {}, "/cwd"), "/cwd/rel");
  assert.equal(resolveOutDir(undefined, { CODEX_IMAGEGEN_OUT_DIR: "/env" }, "/cwd"), "/env");
  assert.equal(resolveOutDir(undefined, {}, "/cwd"), "/cwd/generated-images");
});

test("copyWithoutOverwrite never replaces an existing file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cim-test-"));
  const src = join(dir, "src.png");
  writeFileSync(src, "x");
  const out = join(dir, "out");
  const a = await copyWithoutOverwrite(src, out, "hero");
  const b = await copyWithoutOverwrite(src, out, "hero");
  assert.equal(a, join(out, "hero.png"));
  assert.equal(b, join(out, "hero-2.png"));
  assert.deepEqual(readdirSync(out).sort(), ["hero-2.png", "hero.png"]);
});
