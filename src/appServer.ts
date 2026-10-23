// Minimal client for `codex app-server` over stdio: newline-delimited JSON-RPC
// messages without the "jsonrpc" field. One child process serves many threads;
// notifications are routed to listeners by threadId.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

export interface Notification {
  method: string;
  params: any;
}

type NotificationListener = (n: Notification) => void;

interface Pending {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface AppServerOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  clientVersion: string;
  requestTimeoutMs?: number;
  log?: (msg: string) => void;
}

export class AppServerError extends Error {
  constructor(message: string, readonly code?: number, readonly data?: unknown) {
    super(message);
    this.name = "AppServerError";
  }
}

export class AppServerClient {
  #child: ChildProcessWithoutNullStreams | null = null;
  #ready: Promise<void> | null = null;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #threadListeners = new Map<string, Set<NotificationListener>>();
  #stderrTail: string[] = [];

  constructor(private readonly opts: AppServerOptions) {}

  /** Starts the child on first use and after it exits. */
  ensureStarted(): Promise<void> {
    if (!this.#ready) {
      this.#ready = this.#start().catch((err) => {
        this.#ready = null;
        throw err;
      });
    }
    return this.#ready;
  }

  async #start(): Promise<void> {
    const child = spawn(this.opts.command, this.opts.args, {
      env: this.opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.#child = child;

    createInterface({ input: child.stdout }).on("line", (line) => this.#onLine(line));
    createInterface({ input: child.stderr }).on("line", (line) => {
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > 20) this.#stderrTail.shift();
    });
    child.on("error", (err) => this.#onExit(`failed to spawn ${this.opts.command}: ${err.message}`));
    child.on("exit", (code, signal) => this.#onExit(`app-server exited (code=${code}, signal=${signal})`));

    await this.request("initialize", {
      clientInfo: { name: "codex-imagegen-mcp", title: "Codex ImageGen MCP", version: this.opts.clientVersion },
      capabilities: null,
    });
    this.#write({ method: "initialized" });
  }

  #onExit(reason: string) {
    if (!this.#child) return;
    this.#child = null;
    this.#ready = null;
    const tail = this.#stderrTail.slice(-5).join("\n");
    const err = new AppServerError(tail ? `${reason}\n${tail}` : reason);
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.#pending.delete(id);
    }
    for (const listeners of this.#threadListeners.values()) {
      for (const l of listeners) l({ method: "client/disconnected", params: { message: err.message } });
    }
    this.opts.log?.(reason);
  }

  #write(msg: object) {
    if (!this.#child) throw new AppServerError("app-server is not running");
    this.#child.stdin.write(JSON.stringify(msg) + "\n");
  }

  request<T = any>(method: string, params: unknown, timeoutMs = this.opts.requestTimeoutMs ?? 60_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new AppServerError(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      try {
        this.#write({ id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(id);
        reject(err as Error);
      }
    });
  }

  /** Subscribes to notifications whose params carry this threadId. */
  onThread(threadId: string, listener: NotificationListener): () => void {
    let set = this.#threadListeners.get(threadId);
    if (!set) this.#threadListeners.set(threadId, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.#threadListeners.delete(threadId);
    };
  }

  #onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const isResponse = msg.id !== undefined && msg.method === undefined;
    if (isResponse) {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new AppServerError(msg.error.message ?? "app-server error", msg.error.code, msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    if (msg.id !== undefined && msg.method) {
      this.#answerServerRequest(msg.id, msg.method);
      return;
    }
    if (msg.method) {
      const threadId = msg.params?.threadId;
      if (typeof threadId === "string") {
        for (const l of this.#threadListeners.get(threadId) ?? []) l(msg as Notification);
      }
    }
  }

  // Threads run with approvalPolicy "never" in a read-only sandbox, so the
  // server should never ask. If it does, refuse rather than hang the turn.
  #answerServerRequest(id: number | string, method: string) {
    this.opts.log?.(`declining unexpected server request: ${method}`);
    if (/requestApproval$/i.test(method)) this.#write({ id, result: { decision: "decline" } });
    else this.#write({ id, error: { code: -32601, message: `codex-imagegen-mcp does not handle ${method}` } });
  }

  async close(): Promise<void> {
    const child = this.#child;
    if (!child) return;
    child.stdin.end();
    child.kill();
  }
}
