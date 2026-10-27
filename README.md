# codex-imagegen-mcp

A stdio MCP server that generates and edits images with Codex's built-in image
generation. Usage counts against the ChatGPT plan Codex is signed in with; no
OpenAI API key is used.

It talks to `codex app-server` (JSON-RPC over stdio) instead of spawning
`codex exec` for every image.

## Why app-server instead of `codex exec`

- **Structured result.** Each image arrives as an `imageGeneration` item with
  `savedPath`, `revisedPrompt` and a typed `failure`
  (`usageLimitExceeded` + `resetsAt`). No scanning `generated_images/`, and
  no model instruction to copy files, which Codex can refuse while still
  exiting 0.
- **Read-only sandbox.** Because nothing has to be copied, threads run with
  `sandbox: read-only`, `approvalPolicy: never`, `ephemeral: true` in a
  throwaway temp `cwd`.
- **One process, parallel threads.** Variants run as concurrent threads on a
  single app-server child.
- **Quota visibility.** `imagegen_status` reads sign-in, plan and rate-limit
  windows from the same API.

## Isolation

The app-server child is launched with:

- every `[mcp_servers.*]` from `~/.codex/config.toml` disabled by name
  (`-c mcp_servers={}` merges instead of replacing, so it cannot be used),
- `--disable hooks plugins apps computer_use browser_use multi_agent goals`,
- an environment built from an allowlist (`HOME`, `PATH`, locale, proxy, CA
  vars, `CODEX_HOME`). `OPENAI_API_KEY` is never forwarded, so the imagegen
  skill's paid CLI fallback cannot run.

On first use the server calls `mcpServerStatus/list` and refuses to run if any
MCP server is active.

## Tools

| Tool | Purpose |
| --- | --- |
| `generate_image` | `prompt` plus up to 4 `variations` (one image each, in parallel) or `count`. Optional `reference_images`, `aspect_ratio` (advisory), `transparent_background`, `effort`, `name`, `out_dir`, `preview`. |
| `edit_image` | Attaches `image` (plus `extra_references`) and applies `instructions`, keeping everything else identical. Saves a new file. |
| `imagegen_status` | Sign-in, plan, rate limits, image capability, server settings. |

Results contain the saved paths, Codex's revised prompt per image, and
downscaled JPEG previews (≈10–20 KB each) so a batch of variants fits in one
tool result. Files are never overwritten (`name-2.png`, `name-3.png`, …).

Measured on a ChatGPT Pro plan: about 30 s for one image, about 35 s for two
in parallel; mobile 9:16 output is 941×1672.

## Setup

Requirements: Node 22+, Codex CLI signed in with ChatGPT (`codex login`).

```bash
npm install
npm run build
npm test                     # unit + fake app-server tests, no quota used
node scripts/smoke.mjs       # real run: status + 2 images (uses quota)
```

Register with Claude Code (run from this folder):

```bash
claude mcp add -s user codex-imagegen \
  -e CODEX_IMAGEGEN_OUT_DIR="$HOME/Pictures/codex-imagegen" \
  -- node "$PWD/dist/index.js"
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODEX_BIN` | `codex` | Codex CLI binary |
| `CODEX_HOME` | `~/.codex` | Codex home (auth, config, skills) |
| `CODEX_IMAGEGEN_OUT_DIR` | `./generated-images` | Default output directory |
| `CODEX_IMAGEGEN_CONCURRENCY` | `3` | Images generated at once |
| `CODEX_IMAGEGEN_TIMEOUT_SECONDS` | `300` | Per-image limit; the turn is interrupted after it |
| `CODEX_IMAGEGEN_EFFORT` | `low` | Default reasoning effort for prompt writing |
| `CODEX_IMAGEGEN_MODEL` | Codex default | Model for the prompt-writing turn |

## Limits

- `aspect_ratio` is a prompt hint; the built-in tool chooses the pixel size.
- Every image, including failed retries you trigger, counts against the plan.
- The app-server protocol is marked experimental by Codex; types were checked
  against `codex app-server generate-ts` from codex-cli 0.163.0.


## Persistent design agent (no Paseo required)

For product UI use `design_task_start`, not the single-shot `generate_image` worker.
The task runs a persistent Codex app-server thread with source reading, built-in
image generation, image inspection and bounded refinement in the same context.
The ordinary generate/edit tools remain useful for fully prepared briefs/assets.

```json
{
  "brief": "Design three alternatives for the Agents page, preserving the existing shell.",
  "source_dirs": ["/absolute/path/mosa-be", "/absolute/path/mosa-ui"],
  "reference_images": ["/absolute/path/current-screen.png"],
  "criteria": ["Keep the current sidebar", "Show both primary and secondary actions"],
  "max_rounds": 3,
  "max_images": 6,
  "timeout_seconds": 900,
  "effort": "high"
}
```

- `design_task_start` returns a task ID promptly. Poll `design_task_status` for
  progress, full-resolution artifact paths, provenance and structured reviews.
  Set `preview:true` for the last four downscaled previews; review originals for text.
- `design_task_continue({task_id,feedback})` resumes the SAME saved thread after a
  terminal run, even after the MCP restarts. It renews the original per-run limits;
  previous artifacts/reviews remain. A live task must be cancelled first.
- `design_task_cancel({task_id})` requests interruption. Poll until terminal.
  Cancellation does not roll back images and an already-dispatched call may finish.
- `completed` requires known generated images, an observed image-view tool event plus agent-reported inspection for every selected image, passing
  requested criteria, a known selected image and no reported remaining issues.
  This is self-review, not independent visual proof. `needs_review`, `blocked`,
  `failed`, `timed_out`, `cancelled` and `interrupted` remain explicit outcomes.
- Invalid reviews and disconnected turns preserve artifacts and do not auto-retry.
  Restarted orphan tasks require explicit continuation; work is not silently resumed.

State defaults to `~/.cache/codex-imagegen-mcp/tasks`; override with
`CODEX_DESIGN_STATE_DIR`. Keep this directory to retain task IDs, output and receipts.
Codex keeps persistent thread history in its own home. MCP configuration and API
keys are not forwarded to the child. Nested MCPs, plugins, hooks and delegation
remain disabled. Model inherits `CODEX_IMAGEGEN_MODEL` or Codex's configured default;
reasoning effort is selected per task, without changing the image worker default.

The writable cwd is a new task output directory, NOT the source repository.
Workspace-write sandbox allows output there; source repos are read-only. Network
access for shell commands is disabled. This is a local trusted-user tool: source
paths are instructions, not an OS read allowlist (Codex's sandbox may read other
host files). Do not expose this server to untrusted remote callers. The agent is
instructed to avoid credentials and unrelated files. No external publication occurs.

Each round must read relevant sources, generate/refine, open the images and return
criteria/evidence, selected images and remaining issues. Merely claiming to have looked at an image without an observed image-view event cannot complete the task. Rounds and wall time are
bounded. Image count is monitored at imageGeneration start and interrupted when
exceeded, but is not a provider-side spending cap. If precise UI text/layout stays
wrong, the agent reports blocked and recommends component rendering rather than
silently claiming fidelity. No autonomous browser/harness setup is included here.

Build with `npm test` (includes compilation), then restart your MCP client to load
new tool definitions. `node scripts/smoke-design.mjs` performs a small live MCP →
Codex → image → review task on your signed-in plan (up to two images).
Protocol reference: https://learn.chatgpt.com/docs/app-server (also checked against
`codex app-server generate-ts` from the installed CLI).
