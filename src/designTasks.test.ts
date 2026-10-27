import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { AppServerClient } from "./appServer.js";
import { DesignTasks, type DesignRequest } from "./designTasks.js";

async function fixture(mode = "ok") {
  const dir = mkdtempSync(join(tmpdir(), "design-test-"));
  const image = join(dir, "source.png");
  const log = join(dir, "rpc.jsonl");
  const source = join(dir, "repo");
  mkdirSync(source);
  await sharp({
    create: { width: 12, height: 10, channels: 4, background: "#123456" },
  })
    .png()
    .toFile(image);
  const client = new AppServerClient({
    command: process.execPath,
    args: [resolve("test/fake-design-server.mjs")],
    env: { ...process.env, FAKE_MODE: mode, FAKE_IMAGE: image, FAKE_LOG: log },
    clientVersion: "test",
    requestTimeoutMs: 1000,
  });
  const tasks = new DesignTasks(client, join(dir, "tasks"));
  const request: DesignRequest = {
    brief: "Build UI",
    source_dirs: [source],
    reference_images: [image],
    criteria: ["Keep title"],
    max_rounds: 2,
    max_images: 2,
    timeout_seconds: 5,
    effort: "high",
  };
  return {
    dir,
    tasks,
    request,
    log,
    cleanup: async () => {
      await tasks.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function terminal(tasks: DesignTasks, id: string) {
  for (let i = 0; i < 200; i++) {
    const t = tasks.get(id);
    if (!["running", "starting"].includes(t.status)) {
      await new Promise((r) => setTimeout(r, 30));
      return tasks.get(id);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Task did not finish");
}

test("persistent grounded task produces artifacts, reviews and resumes SAME thread after manager restart", async () => {
  const f = await fixture();
  try {
    const t = await terminal(f.tasks, f.tasks.start(f.request).id);
    assert.equal(t.status, "completed");
    assert.equal(t.images.length, 1);
    assert.deepEqual(t.images[0]?.size, { width: 12, height: 10 });
    assert.equal(
      JSON.parse(readFileSync(join(f.dir, "tasks", t.id, "task.json"), "utf8"))
        .threadId,
      t.threadId,
    );
    await f.tasks.close();
    const client = new AppServerClient({
      command: process.execPath,
      args: [resolve("test/fake-design-server.mjs")],
      env: { ...process.env, FAKE_IMAGE: t.images[0]!.source, FAKE_LOG: f.log },
      clientVersion: "test",
    });
    const reopened = new DesignTasks(client, join(f.dir, "tasks"));
    try {
      const next = await terminal(
        reopened,
        reopened.continue(t.id, "Change B only").id,
      );
      assert.equal(next.threadId, t.threadId);
      assert.equal(next.images.length, 2);
      assert.equal(next.followups[0], "Change B only");
    } finally {
      await reopened.close();
    }
    const rpc = readFileSync(f.log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.ok(rpc.some((r) => r.method === "thread/resume"));
    const start = rpc.find((r) => r.method === "thread/start");
    assert.notEqual(start.params.cwd, f.request.source_dirs[0]);
    assert.match(start.params.developerInstructions, /read-only/);
  } finally {
    await f.cleanup();
  }
});
for (const [mode, status] of [
  ["no_image", "needs_review"],
  ["uninspected", "needs_review"],
  ["invalid", "failed"],
  ["disconnect", "failed"],
  ["leak", "failed"],
  ["revise", "completed"],
  ["alias", "completed"],
  ["no_view", "needs_review"],
  ["blocked", "blocked"],
  ["over_budget", "needs_review"],
] as const)
  test(`handles ${mode} without false completion`, async () => {
    const f = await fixture(mode);
    try {
      const t = await terminal(f.tasks, f.tasks.start(f.request).id);
      assert.equal(t.status, status);
      if (mode === "revise") assert.equal(t.reviews.length, 2);
    } finally {
      await f.cleanup();
    }
  });
test("timeout interrupts running turn", async () => {
  const f = await fixture("hang");
  try {
    const t = await terminal(
      f.tasks,
      f.tasks.start({ ...f.request, timeout_seconds: 0.15 }).id,
    );
    assert.equal(t.status, "timed_out");
    assert.match(readFileSync(f.log, "utf8"), /turn\/interrupt/);
  } finally {
    await f.cleanup();
  }
});
test("cross-client cancel is observed and active task cannot be continued", async () => {
  const f = await fixture("hang");
  try {
    const t = f.tasks.start(f.request);
    assert.throws(() => f.tasks.continue(t.id, "again"), /running/);
    await new Promise((r) => setTimeout(r, 100));
    await f.tasks.cancel(t.id);
    assert.equal((await terminal(f.tasks, t.id)).status, "cancelled");
    assert.match(readFileSync(f.log, "utf8"), /turn\/interrupt/);
  } finally {
    await f.cleanup();
  }
});
test("orphaned active tasks are reported interrupted without automatic work", async () => {
  const f = await fixture();
  try {
    const t = await terminal(f.tasks, f.tasks.start(f.request).id);
    const path = join(f.dir, "tasks", t.id, "task.json");
    writeFileSync(
      path,
      JSON.stringify({ ...t, status: "running", ownerPid: 2147483647 }),
    );
    assert.equal(f.tasks.get(t.id).status, "interrupted");
  } finally {
    await f.cleanup();
  }
});

test("rejects source/workspace overlap and relative references", async () => {
  const f = await fixture();
  try {
    assert.throws(
      () => f.tasks.start({ ...f.request, source_dirs: [f.dir] }),
      /must not overlap/,
    );
    assert.throws(
      () => f.tasks.start({ ...f.request, reference_images: ["relative.png"] }),
      /Absolute path/,
    );
  } finally {
    await f.cleanup();
  }
});
