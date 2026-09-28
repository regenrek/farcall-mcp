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
      if (event.model !== undefined && typeof event.model !== "string")
        throw new Error("Claude init model must be a string");
      state.session_id = event.session_id;
      state.reported_model = event.model;
    }
    if (event.type === "result") {
      state.session_id ??= event.session_id;
      state.native_result = event;
      if (
        event.permission_denials !== undefined &&
        !Array.isArray(event.permission_denials)
      )
        throw new Error("Claude permission_denials must be an array");
      state.permission_denials = event.permission_denials ?? [];
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
