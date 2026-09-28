# Release steps

1. Use Node 24 & run `pnpm install --frozen-lockfile`, then `pnpm check`.
2. Validate both plugin directories with `claude plugin validate --strict`. Validate the Claude marketplace at `.claude-plugin/marketplace.json` too.
3. Run the packaged smoke checks in `docs/verification.md`. Inspect `pnpm pack` output for prompts, credentials or local paths.
4. Update the version in `package.json`. The build reads that version for the runtime & synchronizes all four plugin manifests. Rebuild & commit the generated servers, manifests & dependency notices.
5. Publish this repository to your chosen GitHub remote. Users can add that repository as a marketplace. No npm publication is required for the plugins.

For an npm release, publish the reviewed tarball separately. `agent-worker-mcp claude` & `agent-worker-mcp codex` are the installed commands. Until a package is actually published, use the local tarball or repository, not an assumed `npx` registry entry.

Keep the model-assisted host acceptance separate from deterministic tests. Record host version, CLI version, model, effort, parent response IDs, worker session & raw usage. Passing a local transport test does not prove that every host parks its parent model.
