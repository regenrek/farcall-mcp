export const codex = {
  executable: () => process.env.CODEX_WORKER_BINARY || "codex",
  args(input) {
    // Keep exec-level options before resume. The CLI applies them to either path.
    return [
      "exec",
      "--json",
      "--model",
      input.model,
      "--sandbox",
      input.sandbox,
      "-c",
      `model_reasoning_effort=${JSON.stringify(input.effort)}`,
      "-c",
      'approval_policy="never"',
      ...(input.allow_non_git ? ["--skip-git-repo-check"] : []),
      ...(input.resume_session_id
        ? ["resume", input.resume_session_id, "-"]
        : ["-"]),
    ];
  },
  consume(state, event) {
    if (event.type === "thread.started") state.session_id = event.thread_id;
    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message"
    ) {
      state.result = event.item.text;
    }
    if (event.type === "turn.completed" || event.type === "turn.failed") {
      state.native_result = event;
      state.failed ||= event.type === "turn.failed";
      state.native_usage = event.usage ?? null;
    }
    // Standard exec JSONL does not report a verified model ID or an API price.
  },
  modelMatches(requested, reported) {
    return requested === reported;
  },
};
