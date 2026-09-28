export const claude = {
  executable: () => process.env.CLAUDE_WORKER_BINARY || "claude",
  args(input) {
    return [
      "-p",
      "--model",
      input.model,
      "--effort",
      input.effort,
      "--permission-mode",
      input.permission_mode,
      "--output-format",
      "stream-json",
      "--verbose",
      ...(input.allowed_tools.length
        ? ["--allowedTools", input.allowed_tools.join(",")]
        : []),
      ...(input.chrome ? ["--chrome"] : []),
      ...(input.resume_session_id ? ["--resume", input.resume_session_id] : []),
    ];
  },
  consume(state, event) {
    if (event.type === "system" && event.subtype === "init") {
      state.session_id = event.session_id;
      state.reported_model = event.model;
    }
    if (event.type === "result") {
      state.session_id ??= event.session_id;
      state.native_result = event;
      state.result = event.result ?? null;
      state.failed ||= event.is_error === true;
      state.native_usage = event.usage ?? null;
      state.native_model_usage = event.modelUsage ?? null;
      state.native_total_cost_usd = event.total_cost_usd ?? null;
    }
  },
  modelMatches(requested, reported) {
    return (
      requested.replace(/\[[^\]]+\]$/, "") ===
      reported.replace(/\[[^\]]+\]$/, "")
    );
  },
};
