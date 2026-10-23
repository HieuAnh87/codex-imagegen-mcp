import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { AppServerClient } from "./appServer.js";
import { ImagegenError, ImagegenService } from "./imagegen.js";

const fake = resolve(fileURLToPath(import.meta.url), "../../test/fake-app-server.mjs");
let image: string;
const clients: AppServerClient[] = [];

before(async () => {
  image = join(mkdtempSync(join(tmpdir(), "cim-fake-")), "img.png");
  await sharp({ create: { width: 8, height: 8, channels: 3, background: "#0000ff" } }).png().toFile(image);
});
after(async () => {
  for (const c of clients) await c.close();
});

function service(mode: string) {
  const client = new AppServerClient({
    command: process.execPath,
    args: [fake],
    env: { ...process.env, FAKE_MODE: mode, FAKE_IMAGE: image },
    clientVersion: "test",
  });
  clients.push(client);
  return new ImagegenService(client);
}

test("returns the savedPath and revised prompt from the imageGeneration item", async () => {
  const r = await service("ok").generate({ prompt: "blue square", timeoutMs: 5000 });
  assert.equal(r.savedPath, image);
  assert.equal(r.revisedPrompt, "revised: blue square");
  assert.equal(r.agentMessage, "done");
});

test("parallel turns on one app-server are routed to the right thread", async () => {
  const svc = service("ok");
  const rs = await Promise.all(["a", "b", "c"].map((p) => svc.generate({ prompt: p, timeoutMs: 5000 })));
  assert.deepEqual(rs.map((r) => r.revisedPrompt), ["revised: a", "revised: b", "revised: c"]);
});

test("usage limit surfaces as a typed error with reset time", async () => {
  await assert.rejects(service("usage_limit").generate({ prompt: "x", timeoutMs: 5000 }), (e: unknown) => {
    assert.ok(e instanceof ImagegenError);
    assert.equal(e.code, "usage_limit");
    assert.equal(e.details?.resetsAt, 1900000000);
    return true;
  });
});

test("a completed turn without an image is an error, not a silent success", async () => {
  await assert.rejects(service("no_image").generate({ prompt: "x", timeoutMs: 5000 }), (e: unknown) =>
    e instanceof ImagegenError && e.code === "no_image");
});

test("times out and interrupts a hung turn", async () => {
  await assert.rejects(service("hang").generate({ prompt: "x", timeoutMs: 300 }), (e: unknown) =>
    e instanceof ImagegenError && e.code === "timeout");
});

test("refuses to run when an MCP server is active in the app-server", async () => {
  await assert.rejects(service("mcp_leak").generate({ prompt: "x", timeoutMs: 5000 }), /MCP servers are still active/);
});
