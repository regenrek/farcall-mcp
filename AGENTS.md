# Project guidance

Use Node 24 or newer. Keep src/ readable and provider-neutral outside adapters/.
Run pnpm check after changes. Generated servers in dist/ and plugins/ are release
artifacts, not files to edit manually. Do not invoke real paid model jobs during
tests. Keep raw prompts, sessions, credentials and benchmark data out of commits.
Do not claim a host avoids polling without checking its parent trace.
