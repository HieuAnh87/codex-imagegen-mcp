// Stand-in for `codex app-server` used by integration tests. Behaviour is
// selected with FAKE_MODE: ok | usage_limit | no_image | mcp_leak | hang.
import { createInterface } from "node:readline";

const mode = process.env.FAKE_MODE ?? "ok";
const image = process.env.FAKE_IMAGE;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
let threads = 0;

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  const reply = (result) => send({ id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return reply({ userAgent: "fake" });
    case "mcpServerStatus/list":
      return reply({ data: [{ name: "pg", serverInfo: mode === "mcp_leak" ? { name: "pg" } : null }] });
    case "thread/start": {
      if (msg.params.sandbox !== "read-only" || msg.params.approvalPolicy !== "never" || msg.params.ephemeral !== true) {
        return send({ id: msg.id, error: { code: -1, message: "unsafe thread params" } });
      }
      return reply({ thread: { id: `t${++threads}` }, model: "fake" });
    }
    case "turn/start": {
      const threadId = msg.params.threadId;
      const texts = msg.params.input.filter((i) => i.type === "text").map((i) => i.text);
      reply({ turn: { id: `turn-${threadId}`, status: "inProgress" } });
      if (mode === "hang") return;
      setTimeout(() => {
        if (mode !== "no_image") {
          const item = mode === "usage_limit"
            ? { type: "imageGeneration", id: "i", status: "failed", revisedPrompt: null, result: "", failure: { type: "usageLimitExceeded", limitId: "codex", resetsAt: 1900000000 } }
            : { type: "imageGeneration", id: "i", status: "completed", revisedPrompt: `revised: ${texts.join(" ")}`, result: "", failure: null, savedPath: image };
          send({ method: "item/completed", params: { threadId, turnId: `turn-${threadId}`, item, completedAtMs: Date.now() } });
        }
        send({ method: "item/completed", params: { threadId, item: { type: "agentMessage", id: "a", text: "done" } } });
        send({ method: "turn/completed", params: { threadId, turn: { id: `turn-${threadId}`, status: "completed", error: null } } });
      }, 20);
      return;
    }
    case "turn/interrupt":
      return reply({});
    default:
      return send({ id: msg.id, error: { code: -32601, message: `unknown ${msg.method}` } });
  }
});
