// One image = one ephemeral Codex thread with one turn. The image path comes
// from the structured `imageGeneration` item (savedPath), never from scanning
// generated_images/ or asking the model to copy files.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerClient, type Notification } from "./appServer.js";
import { codexHome } from "./codexLaunch.js";

export type Effort = "low" | "medium" | "high";

export interface ImageTurnRequest {
  prompt: string;
  referenceImages?: string[];
  effort?: Effort;
  model?: string;
  timeoutMs: number;
}

export interface ImageTurnResult {
  savedPath: string;
  revisedPrompt: string | null;
  transparentBackground: boolean | null;
  agentMessage: string;
}

export type ImagegenErrorCode = "usage_limit" | "no_image" | "turn_failed" | "timeout" | "disconnected";

export class ImagegenError extends Error {
  constructor(readonly code: ImagegenErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
    this.name = "ImagegenError";
  }
}

const DEVELOPER_INSTRUCTIONS = [
  "You are an image generation worker. Produce exactly one image per request with the built-in image_gen tool.",
  "Never use the imagegen CLI fallback, never run shell commands, and never read, write, move, or copy files; the caller collects the image from the tool result.",
  "When reference images are attached, use them as the edit source or style reference as the request says.",
  "Do not ask questions. After the image is generated, reply with one short sentence.",
].join("\n");

export class ImagegenService {
  #isolationChecked = false;

  constructor(private readonly client: AppServerClient) {}

  async #ready() {
    await this.client.ensureStarted();
    if (this.#isolationChecked) return;
    // Fail closed: if any MCP server still came up, a thread could reach it.
    const status = await this.client.request<any>("mcpServerStatus/list", {});
    const list: any[] = status?.data ?? status?.servers ?? [];
    const running = list.filter((s) => s?.serverInfo).map((s) => s.name);
    if (running.length > 0) {
      await this.client.close();
      throw new Error(`Refusing to run: MCP servers are still active in the Codex app-server (${running.join(", ")}).`);
    }
    this.#isolationChecked = true;
  }

  async status() {
    await this.#ready();
    const [account, limits, caps] = await Promise.all([
      this.client.request<any>("account/read", {}),
      this.client.request<any>("account/rateLimits/read", {}).catch((e: Error) => ({ error: e.message })),
      this.client.request<any>("modelProvider/capabilities/read", {}).catch((e: Error) => ({ error: e.message })),
    ]);
    return { account, limits, caps };
  }

  async generate(req: ImageTurnRequest): Promise<ImageTurnResult> {
    await this.#ready();
    const cwd = mkdtempSync(join(tmpdir(), "codex-imagegen-"));
    try {
      return await this.#runTurn(req, cwd);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }

  async #runTurn(req: ImageTurnRequest, cwd: string): Promise<ImageTurnResult> {
    const thread = await this.client.request<any>("thread/start", {
      cwd,
      sandbox: "read-only",
      approvalPolicy: "never",
      ephemeral: true,
      developerInstructions: DEVELOPER_INSTRUCTIONS,
      ...(req.model ? { model: req.model } : {}),
    });
    const threadId: string = thread.thread.id;

    const images: any[] = [];
    let agentMessage = "";
    let turnId: string | null = null;
    let settle!: (outcome: { status: string; error?: any }) => void;
    const finished = new Promise<{ status: string; error?: any }>((r) => (settle = r));

    const unsubscribe = this.client.onThread(threadId, (n: Notification) => {
      if (n.method === "item/completed") {
        const item = n.params.item;
        if (item?.type === "imageGeneration") images.push(item);
        else if (item?.type === "agentMessage" && item.text) agentMessage = item.text;
      } else if (n.method === "turn/completed") {
        settle({ status: n.params.turn?.status, error: n.params.turn?.error });
      } else if (n.method === "client/disconnected") {
        settle({ status: "disconnected", error: { message: n.params.message } });
      }
    });

    let timer: NodeJS.Timeout | undefined;
    try {
      const turn = await this.client.request<any>("turn/start", {
        threadId,
        input: this.#buildInput(req),
        ...(req.effort ? { effort: req.effort } : {}),
      });
      turnId = turn?.turn?.id ?? null;

      const timeout = new Promise<{ status: string; error?: any }>((r) => {
        timer = setTimeout(() => r({ status: "timeout" }), req.timeoutMs);
      });
      const outcome = await Promise.race([finished, timeout]);

      if (outcome.status === "timeout") {
        if (turnId) await this.client.request("turn/interrupt", { threadId, turnId }, 10_000).catch(() => {});
        throw new ImagegenError("timeout", `Codex did not finish within ${Math.round(req.timeoutMs / 1000)}s`);
      }
      if (outcome.status === "disconnected") {
        throw new ImagegenError("disconnected", outcome.error?.message ?? "app-server disconnected");
      }

      const failed = images.find((i) => i.failure);
      if (failed?.failure?.type === "usageLimitExceeded") {
        const resetsAt = failed.failure.resetsAt as number | null;
        throw new ImagegenError(
          "usage_limit",
          `Image generation limit reached${resetsAt ? `; resets at ${new Date(resetsAt * 1000).toISOString()}` : ""}`,
          { limitId: failed.failure.limitId, resetsAt },
        );
      }
      const image = images.find((i) => i.status === "completed" && i.savedPath && existsSync(i.savedPath));
      if (!image) {
        if (outcome.status !== "completed") {
          throw new ImagegenError("turn_failed", outcome.error?.message ?? `turn ${outcome.status}`, {
            codexErrorInfo: outcome.error?.codexErrorInfo ?? null,
          });
        }
        throw new ImagegenError("no_image", `Codex finished without an image. Agent said: ${agentMessage || "(nothing)"}`);
      }
      return {
        savedPath: image.savedPath,
        revisedPrompt: image.revisedPrompt ?? null,
        transparentBackground: image.transparentBackground ?? null,
        agentMessage,
      };
    } finally {
      clearTimeout(timer);
      unsubscribe();
    }
  }

  #buildInput(req: ImageTurnRequest) {
    const input: object[] = [];
    // The skill carries Codex's own prompting playbook (structured prompts,
    // edit invariants). The image_gen tool itself is built in either way.
    const skillPath = join(codexHome(), "skills", ".system", "imagegen", "SKILL.md");
    if (existsSync(skillPath)) input.push({ type: "skill", name: "imagegen", path: skillPath });
    for (const path of req.referenceImages ?? []) input.push({ type: "localImage", path });
    input.push({ type: "text", text: req.prompt, text_elements: [] });
    return input;
  }
}
