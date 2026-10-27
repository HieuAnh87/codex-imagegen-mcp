import { createInterface } from "node:readline";
import { appendFileSync, copyFileSync } from "node:fs";
const mode = process.env.FAKE_MODE || "ok";
let turn = 0;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (process.env.FAKE_LOG)
    appendFileSync(process.env.FAKE_LOG, JSON.stringify(m) + "\n");
  const reply = (result) => send({ id: m.id, result });
  if (m.method === "initialize") return reply({});
  if (m.method === "mcpServerStatus/list")
    return reply({ data: mode === "leak" ? [{ serverInfo: {} }] : [] });
  if (m.method === "thread/start" || m.method === "thread/resume") {
    if (
      m.params.sandbox !== "workspace-write" ||
      m.params.approvalPolicy !== "never" ||
      m.params.ephemeral === true
    )
      return send({ id: m.id, error: { message: "unsafe params" } });
    return reply({ thread: { id: m.params.threadId || "design-thread" } });
  }
  if (m.method === "turn/interrupt") return reply({});
  if (m.method !== "turn/start")
    return send({ id: m.id, error: { message: "unknown method" } });
  const id = `turn-${++turn}`;
  const threadId = m.params.threadId;
  if (
    m.params.sandboxPolicy?.type !== "workspaceWrite" ||
    m.params.sandboxPolicy.networkAccess !== false
  )
    return send({ id: m.id, error: { message: "unsafe sandbox" } });
  reply({ turn: { id } });
  if (mode === "hang") return;
  setTimeout(() => {
    if (mode === "disconnect") return process.exit(2);
    const notify = (method, params) =>
      send({ method, params: { threadId, turnId: id, ...params } });
    if (mode !== "no_image") {
      notify("item/started", {
        item: { type: "imageGeneration", id: "image" },
      });
      if (mode === "over_budget")
        for (let i = 0; i < 3; i++)
          notify("item/started", {
            item: { type: "imageGeneration", id: `extra-${i}` },
          });
      notify("item/completed", {
        item: {
          type: "imageGeneration",
          id: "image",
          status: "completed",
          savedPath: process.env.FAKE_IMAGE,
          revisedPrompt: "grounded brief",
        },
      });
    }
    const input = JSON.parse(
      m.params.input.find((x) => x.type === "text").text,
    );
    const imagePath =
      mode === "alias"
        ? m.params.cwd + "/selected.png"
        : process.env.FAKE_IMAGE;
    if (mode === "alias") copyFileSync(process.env.FAKE_IMAGE, imagePath);
    if (mode !== "no_view")
      notify("item/completed", {
        item: { type: "imageView", path: imagePath },
      });
    const review = {
      decision:
        mode === "blocked"
          ? "blocked"
          : mode === "revise" && turn === 1
            ? "revise"
            : "done",
      summary: "inspected",
      inspected_images: mode === "uninspected" ? [] : [imagePath],
      source_files: ["src/ui.tsx"],
      checks: input.criteria.map((criterion) => ({
        criterion,
        result: "pass",
        evidence: "checked",
      })),
      remaining_issues: [],
      selected_images: [imagePath],
    };
    notify("item/completed", {
      item: {
        type: "agentMessage",
        text: mode === "invalid" ? "not json" : JSON.stringify(review),
      },
    });
    notify("turn/completed", { turn: { id, status: "completed" } });
  }, 20);
});
