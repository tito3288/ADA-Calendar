# Daily hours and session management

Ask ADA distinguishes a flexible total from a daily reservation:

- “Two hours each selected day” → two hours on every selected date.
- “Spread ten hours evenly” over five selected days → two hours per date.
- “Ten hours sometime within these dates” → existing flexible placement.

No clock times are necessary for daily amounts. The shared scheduler chooses clean openings, respects working hours, lunch, saved reserve settings and protected work, and reports the exact date if its quota cannot fit. It does not silently move those hours to another day. A failed daily capacity check becomes a private ADA clarification with no workload change. Weekends are not silently omitted; say “weekdays” to exclude nonworking days.

## Persistence and safety

`WorkItem.dailyPlan` is an optional array of `{date, minutes}` representing exact remaining reservation budgets, not completed work or a project’s total effort. Missing/empty means the existing flexible behavior. Each date is unique, uses 15-minute increments, and remains subject to allowed dates and firm deadlines. Owner unknown-total work can have daily bookings without inventing an estimate; requester estimates remain required.

Daily rules survive automatic replanning. Explicit session completion releases that booking’s daily budget but does not complete the project or reduce its effort estimate without a progress report. Elapsed time does not count as completion. If dates have passed or a revised remaining estimate no longer matches the quota, explicitly revise the future sessions/daily plan.

Owners can open a task → **Manage sessions** to add, split, remove or redistribute draft rows, preview the shared scheduler’s result, and confirm once. Known remaining effort must be covered by the replacement future sessions; deleting a row does not erase effort. Unknown totals remain null. Protected changes require an explicit override. History stays read-only; managing a project while its session is underway is intentionally blocked to avoid partial-minute ambiguity. Existing daily quotas are visibly rebuilt from the edited future sessions. The editor does not widen allowed work dates.

## Deployment

Apply `supabase/migrations/202609080001_daily_hours.sql` through the normal reviewed database deployment process. It adds optional daily-plan validation at the existing authenticated scheduling RPC; no data backfill or production workload edits are needed. The application continues to use the shared scheduler and atomic existing commit transaction.

This change was verified with offline compiler/scheduler/route tests, mocked local desktop/mobile browser workflows, accessibility checks, lint, type checking and a production build. No real AI provider evaluation, email sends, production changes or database migration execution were performed during development. The SQL migration requires database-side verification before deployment.
