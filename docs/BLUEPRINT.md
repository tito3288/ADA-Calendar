# ADA Calendar — approved version one

## Purpose

Bryan wears four hats: Web (edits/builds), IT, Landings, and Software. Kyle, William, and clients independently assign work. This application makes the full workload visible while keeping work inside Monday–Friday, 9–5. All agreed V1 functionality ships together, implemented and tested in reviewable increments. Gmail/Slack reading, public links, and client-scoped portals are deferred.

**Deployment correction:** Railway replaces Vercel. Use native Next.js App Router, React, TypeScript, Tailwind and a Node 24 container. Supabase remains the database/auth/private storage/queue platform; Resend provides mail. Do not provision paid accounts or send real stakeholder mail from tests.

**September 7 environment decision:** Bryan will use one real Supabase project named **ADA Calendar** and one Railway application, connected to the existing public GitHub repository `tito3288/ADA-Calendar`. A separate hosted staging project/application is not required. Verify the real integrations in this environment while retaining isolated local automated tests and captured or explicitly allowlisted email until Bryan authorizes normal live delivery. Review the selected Supabase GitHub integration's automatic deployment settings before further pushes. Source visibility does not change invite-only application access; secrets and workload data never belong in Git. Recovery rehearsal may use an isolated local Supabase instance and remains a separate, unverified release check.

## Locked product decisions

- Timezone America/Indiana/Indianapolis; weekdays 9–17, lunch 12–12:30. September 8 owner preference: no automatic interruption reserve (reserveMinutes 0), making 450 minutes/day available for ordinary projects; unexpected work is added as it arises. Persisted workspace settings remain authoritative and are editable by Bryan; changing code must not silently replace saved settings or move existing bookings. A workspace configured with a 60-minute reserve still has 390 minutes/day.
- Owner Bryan; Kyle/William requesters; invited teammates may be viewers/requesters. All see the shared agency workload; transcripts/drafts are private.
- September 7 sign-in decision: use email and password with persistent, server-managed sessions. No public signup. Initial invitations let each person create their own password; forgotten passwords use recovery email. Normal sign-in does not request an email link. Passwords are handled by Supabase Auth, never saved in workload records or returned in API responses.
- Requesters supply effort. Clean-fit submissions commit automatically, notifying Bryan. A request that changes existing commitments waits for Bryan's approval. Requesters never edit/delete scheduled work, even their own. Requested priority is advisory; effective priority defaults Normal.
- Explicit owner instructions authorize ordinary replanning. Urgent alone never overrides protected sessions or firm deadlines. Clarify/preview exceptions unless the owner explicitly authorizes them.
- Project spans and actual work sessions are different. Thin faded month ribbons communicate open work; thicker day segments show hours and protection. Week/day show exact sessions. Spans reserve zero capacity. Month opens first on desktop; mobile uses agenda.
- Distinguish targets, forecasts, firm deadlines, actual completion, and client-update checkpoints. Landings are client batches with progress/checklists; weekly reporting does not imply all pages due.
- Completion is explicit. Elapsed time never completes work or decrements effort without a report. Waiting work stays visible without executable sessions.
- September 8 ongoing-project decision: the owner may leave total and remaining effort unknown while booking explicitly dated work sessions. Only those sessions reserve time; their duration is not the project estimate and cannot predict a project finish. Unknown-total reservations must not be silently lost during replanning. Requesters still need positive effort estimates, and lunch/protected-time rules are unchanged.
- Minimum scheduling increment 15 minutes. Software/build focus defaults to 120-minute blocks (or smaller remainder), independent of protection. Preserve unaffected sessions and never schedule in the past.
- Unexpected work can exchange still-usable reserve capacity for time earlier that day; count each minute once. Only the owner consumes reserve.
- Voice/typing share one validated command path. Multiple tasks may be entered together. Client aliases ground matching. Ambiguous dates, names, effort, and intent require clarification before dependent writes.
- September 8 selected-date decision: Month view has an explicit Select dates mode. One click selects a day; the second selects an inclusive range, including across months. Normal day navigation is unchanged outside that mode. Ask ADA receives typed date context for one instruction and retains it through private clarification replies, with Change/Clear controls. A work window fits the stated total effort within the range, never repeats it on every day. The owner may instead select a display-only project timeline; without separately stated work sessions it remains waiting and reserves no hours. Requesters retain positive-estimate, clean-fit-only rules. Selection alone changes no work or mail, supplies no override permission, and conflicts with spoken dates require clarification. Terminal replies, explicit cancellation, and a new instruction clear the context; errors and closing the dialog retain the unfinished draft. No provider/model, scheduler permissions, or database schema change is required.
- “I have to tell her about the completed landings” must not mark complete, claim client contact, or send mail. Offer a draft with Send/Edit/Dismiss. Clear saved work changes notify automatically without another confirmation.
- Kyle and William receive email for every saved addition, edit/reschedule, progress, completion, cancellation, and recorded client update. One operation can list all affected items. Every distinct operation remains notified. Friday 15:00 weekly summary supplements event mail.
- New external bookings and priority requests notify Bryan. Email links require login. Preview/failed transaction causes no work event/mail. Successful undo causes a corrective event; sent email cannot be recalled.
- Attach Markdown/PDF/PNG/JPEG/WebP, max five files and 20 MB per work item. Safe Markdown preview, immutable private originals, recoverable removal, external references. Audio uses separate transient private storage.

## Architecture contract

`src/lib/types.ts` defines WorkCommand, ScheduleSnapshot, ScheduleProposal, WorkEvent and AppState. Pure TypeScript scheduling is independent of providers. Model tools propose domain commands, never raw database/email operations. All mutation paths revalidate authorization, schedule version and constraints.

Persist committed changes, immutable event and per-recipient notification jobs in one database transaction. Prevent overlap and concurrent stale commits. Retry using stable operation/event IDs. Recompute stale previews; never turn a stale clean-fit request into an authorized displacement. Undo is a version-aware compensating change.

Supabase Queues and Cron run bounded mail workers independently of the browser. Track provider IDs, retries, failures and uncertain outcomes. Resend idempotency lasts 24h; uncertain older sends require reconciliation. Verify webhook signatures and handle repeated/out-of-order callbacks. Keep production credentials server-side.

OpenAI Responses model `gpt-5.6-sol`, medium reasoning, strict schema; `gpt-transcribe` recorded speech. Warn at $20 monthly usage and pause new AI calls at $25 until owner raises allowance. Manual operations remain available. Approximate total operating target $100; Railway is usage-priced, so report observed costs, not a guaranteed fixed total.

## Verification gates

1. Foundation, versions and typed rules. 2. Auth/data permissions and transactional schema. 3. Scheduler constraints, reserve, concurrency and undo. 4. Owner month/week/detail/attachments UI. 5. Requester/viewer booking and approvals. 6. Voice/text intent safety and drafts. 7. Durable emails and weekly summary. 8. Full workflows, accessibility, production build, Railway packaging and setup/restore runbook.

Mandatory examples: Drive and Shine September ribbon with protected September 9/11 sessions; six landing clients crossing week boundaries; no capacity from span alone; blocked client dependency; interruption and past reserve; explicit protection override; concurrent same-slot booking; clean fit vs displacement; future-tense no-op; retries/webhooks/browser closure; undo after later booking; timezone/DST; keyboard/touch/narrow layout.

Real account addresses, complete client list, Supabase/Railway credentials and a verified sender domain are setup inputs. Local sample data and captured mail must remain visibly identified. Never claim live integrations, delivery, deployment, or real-model evaluations were verified without evidence.
