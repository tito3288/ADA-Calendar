# ADA Calendar engineering rules

This is Bryan's private workload calendar. The approved implementation specification is in `docs/BLUEPRINT.md`. Railway is the deployment target, not Vercel or Sites. Use native Next.js with a Node.js runtime.

- Never execute real sends during development; use captured messages or explicit test allowlists. Never commit secrets.
- All calendar mutations must use the shared scheduler and server authorization. AI output is a proposal, never independent authority.
- Requesters may book clean-fit work only. They cannot edit existing work. Displacement needs owner approval. Protected time requires an explicit owner override.
- Faded project spans do not reserve time. Only work sessions consume capacity. Time passing is not completed work.
- Preserve the 9–5 weekday boundary, 30-minute lunch, and the saved interruption-reserve setting. The owner approved a zero-minute reserve on September 8, making 7.5 hours available; do not silently override persisted workspace settings.
- Do not change shared types without coordinating dependent code. Keep SQL migrations and server validation consistent.
- Use npm and the lockfile. Run appropriate tests, type checking, lint, and a production build. Verify browser workflows for UI changes.
- Keep demo fixtures and captured mail clearly labeled and isolated from production. Production without credentials must fail closed.
- Local Node 22 can run tooling; Railway's container uses Node 24.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
