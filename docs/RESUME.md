# ADA Calendar — saved stopping point

Saved September 5, 2026 at Bryan's request to pause for the day. **Do not restart implementation or switch hosting platforms.** Resume from the existing code after Bryan returns and asks to continue. Nothing is scheduled to run automatically.

## Outcome so far

The initially empty folder now contains a native Next.js App Router / React / TypeScript / Tailwind application, deterministic scheduler, Supabase backend, voice/text integration, private attachments, request approvals, and durable outgoing email infrastructure. **Hosting is Railway, not Vercel.** Production uses the Node 24 standalone Docker image.

This is a working local implementation with sample data, not a deployed or fully production-verified release. No real OpenAI calls, stakeholder emails, invitations, paid provisioning, or Railway deployment have occurred.

## Latest verified evidence

- Final `npm run check` **passed** after the last implementation changes: full ESLint, `next typegen` plus TypeScript, **108 tests in seven files**, and optimized Next.js production build.
- Last integrated Playwright run: **17/17 API/browser tests passed**, including protected keyboard moves, requester clean fit, conflicts/revised approvals, stale-preview recovery, competing bookings, retries, captured notifications/undo, safe original Markdown attachments, and pending-file retention. Desktop/mobile axe scans had zero violations in the tested screens. Month/day/mobile screenshots were inspected.
- The browser run preceded the final transcription-cost helper and trusted live AI-accounting RPC changes. Those later changes have passing unit/route/database tests, but rerun the browser suite before final handoff.
- All **six** SQL migrations applied successfully to the isolated local ADA Supabase stack. Expanded real database smoke tests passed: invite-only Auth/RLS, transactional outbox/replay, concurrent booking, overlap exclusion, private files, more than 1,000 historical sessions preserved across reads and commits, coherent concurrent schedule snapshots, direct requester protected/history injection denied, and server-only AI ledger/privacy/cache/budget enforcement. SQL lint: zero errors.
- Earlier actual local Edge-worker capture test passed: authentication/method restrictions and six jobs captured/acknowledged. No provider mail was sent.
- Earlier Node 24 Docker image `ada-calendar:v1-local` built and passed production startup checks: setup page 200 without configuration; no production demo bypass; unauthenticated `/api/state` 401; ffprobe available; runtime Supabase configuration exposes sign-in without a rebuild. **Rebuild this image for the final code**, since security/UI/cost changes landed afterward.
- `npm audit --omit=dev`: **zero vulnerabilities** reported.
- Five-case deterministic intent evaluation passed, but this is **not a real-model accuracy evaluation**.

## Important recent fixes to preserve

1. Preview fingerprints bind manual bookings and owner approvals to the reviewed semantic plan. Recompute at both the route and final store boundary; reject changed placements with 409 and a fresh preview, including changes caused only by time passing. Ignore regenerated IDs/lifecycle timestamps; retain idempotent retries. UI preserves local edits and handles refreshed previews.
2. Live schedule state is read by authenticated atomic `read_schedule_snapshot` RPC, not separate version/session queries. All sessions are aggregated without the REST 1,000-row cap. This prevents mixed-version overwrites and historical-session loss.
3. Live attachment signing uses the server admin client **only after** an authorized, atomic metadata/limit reservation. Ordinary users have no Storage INSERT authority. Completion/download remain access-checked; originals are immutable/private.
4. AI operation reservation/settlement is service-only, with actor identity obtained from server authentication. Direct authenticated callers cannot forge a zero-cost settlement. Generic `mutate_workspace` reserve/settle actions are blocked in live mode.
5. Only Bryan can explicitly consume interruption reserve, for **any** of the four work categories. Requesters cannot reserve protected, historical/completed, or reserve-consuming sessions through direct SQL RPCs.
6. Scheduling order handles supplied exact sessions first, then hard constraints, effective priority, target date, stable creation time, and ID. Existing commitments/protection remain enforced. Session resizing is not progress; missing effort must still fit.
7. Successful transcription uses server-verified audio duration and a documented cost estimate ($0.0045/minute at verification), with a small padded pre-call reservation. Unknown outcomes retain the reservation. Interpretation uses returned token counts and Standard-tier short/long-context rates. Costs are estimates, not audited invoices. Models remain `gpt-5.6-sol` and `gpt-transcribe`; API credentials are still missing.

## Where to resume

1. Read this file, `docs/BLUEPRINT.md`, `docs/VERIFICATION.md`, `docs/RUNBOOK.md`, and current Git status. Preserve all work. The first four phase checkpoints already exist; the pause checkpoint saves the later integrated work.
2. Review the latest changes and finish the verification record. Update phase/evidence wording where earlier entries still describe browser verification as outstanding; do not claim hosted tests happened.
3. Run the final browser suite again, then rebuild the Railway Docker image and repeat bounded startup/auth checks against that exact image. Avoid sharing build output directories between the demo and isolated E2E server.
4. Finish focused reviewable Git checkpoints / final local handoff. No remote push has been requested or performed.
5. Collect real account emails (Bryan/Kyle/William), initial client names/aliases, selected Supabase/Railway project information, credentials through secure environment/provider settings, and a controlled verified sending domain. Do not ask Bryan to paste secrets into chat.
6. Configure isolated hosted staging/capture mode, run actual model/transcription evaluations, hosted invitations/auth, private uploads, Cron/worker, allowlisted delivery, and database **plus Storage-object** restore rehearsal. Enable normal team mail only after these safety gates pass. Production deployment and these external gates are still pending.

## Local environment and cleanup

- Workspace: `/Users/bryanarambula/Projects/ada-calendar`; Git branch `main`; no remote configured by this task.
- Preview: `http://127.0.0.1:3000/`, using the development-only sample workspace. The in-app browser is on Month view. The local dev server was left running; if it is no longer available, use `npm run dev`.
- `.env.local` is ignored and contains only demo/capture configuration. `.data/ada-demo.json` is ignored sample persistence. Neither belongs in Git.
- E2E uses port 3100, `.data-e2e`, and `.next-e2e`, isolated from the visible preview. Its server has stopped.
- ADA's local Supabase containers are **stopped**, preserving volumes. The unrelated **SimplAssist** containers were left running and must not be stopped/reset. ADA uses project-specific names and ports 55421–55424.
- An earlier failed generated Next cache was moved recoverably to `/private/tmp/ada-calendar-build-cache-20260905-0840`; it contains no source work and is not a blocker.
- The final verification shell process completed successfully. No further implementation, paid calls, notifications, or deployment should happen while paused.

## Product boundaries not to reopen

Weekdays 9–5 in America/Indiana/Indianapolis; lunch 12–12:30; reserve 16–17; ordinary capacity 6.5h/day. Thin project ribbons consume no capacity; actual sessions do. Completion/progress are explicit. All invited users see shared agency work, with private author drafts/transcripts. Requesters may auto-book only clean fits and cannot edit/delete existing work. Displacement needs Bryan; urgency alone never overrides protection/deadlines. Both Kyle and William receive each committed work update plus a weekly overview. Draft/failure/preview sends nothing. Gmail and Slack reading, public links, and client portals are deferred.
