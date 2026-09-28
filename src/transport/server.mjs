import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  claudeInput,
  codexInput,
  preflightInput,
  VERSION,
} from "../core/contracts.mjs";
import { delegate } from "../application/delegate.mjs";

export async function startServer(provider) {
  const server = new McpServer({
    name: `${provider}_worker`,
    version: VERSION,
  });
  const active = new Map();
  let closing = false;
  async function handle(input, context, preflight) {
    if (closing)
      return {
        isError: true,
        content: [{ type: "text", text: "Server is closing" }],
      };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    context.signal.addEventListener("abort", cancel, { once: true });
    if (context.signal.aborted) cancel();
    const pending = delegate(provider, input, {
      signal: controller.signal,
      preflight,
    });
    active.set(controller, pending);
    try {
      const result = await pending;
      return {
        isError: result.status !== "completed",
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [{ type: "text", text: error.message }],
      };
    } finally {
      active.delete(controller);
      context.signal.removeEventListener("abort", cancel);
    }
  }
  server.registerTool(
    "run",
    {
      description: `Run an authorized ${provider} task and wait for completion in this single call. Call directly, outside Code Mode. Do not issue status or sleep loops. Provide prompt text or a prompt_file under cwd/artifacts. Full logs are opt-in with trace: true. Resume only the returned exact session with its previous delegation ID.`,
      inputSchema: provider === "claude" ? claudeInput : codexInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    (input, context) => handle(input, context, false),
  );
  server.registerTool(
    "preflight",
    {
      description:
        "Wait for a deterministic local child. No model or API call. Verify host waiting separately from model work.",
      inputSchema: preflightInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input, context) => handle(input, context, true),
  );
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    for (const controller of active.keys()) controller.abort();
    await Promise.allSettled(active.values());
    await server.close();
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
    process.stdin.off("end", shutdown);
    process.stdin.off("close", shutdown);
    process.stdin.pause();
  };
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  // Keep the error listener through shutdown: a late tool response may hit EPIPE.
  process.stdout.on("error", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  // The MCP SDK exposes this callback property, not an EventTarget.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  server.server.onclose = shutdown;
  await server.connect(new StdioServerTransport());
  return server;
}
