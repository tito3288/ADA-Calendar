# Daily hours and session management

Ask ADA distinguishes a flexible total from a daily reservation:

- “Two hours each selected day” → two hours on every selected date.
- “Spread ten hours evenly” over five selected days → two hours per date.
- “Ten hours sometime within these dates” → existing flexible placement.

No clock times are necessary for daily amounts. The shared scheduler chooses clean openings, respects working hours, lunch, saved reserve settings and protected work, and reports the exact date if its quota cannot fit. It does not silently move those hours to another day. A failed daily capacity check becomes a private ADA clarification with no workload change. Weekends are not silently omitted; say “weekdays” to exclude nonworking days.

## Persistence and safety

`WorkItem.dailyPlan` is an optional array of `{date, minutes}` representing exact remaining reservation budgets, not completed work or a project’s total effort. Missing/empty means the existing flexible behavior. Each date is unique, uses 15-minute increments, and remains subject to allowed dates and firm deadlines. Owner unknown-total work can have daily bookings without inventing an estimate; requester estimates remain required.

Daily rules survive automatic replanning. Explicit session completion releases that booking’s daily budget but does not complete the project or reduce its effort estimate without a progress report. Elapsed time does not count as completion. Planned bookings stay movable after their scheduled time. Owners can move missed work to future available openings, including when organizing the calendar after 5 PM.

Owners can open a task → **Edit hours** to edit one row per booked day, including missed planned work. Changing a date preserves those hours; increasing or reducing hours adjusts known remaining effort by the net change while preserving the original estimate and any unbooked balance. Existing legacy overbooked balances do not create a new move restriction. Unknown totals remain null. **Advanced → Set exact times** offers clock control.

Completed/cancelled work stays read-only. The clock alone never claims a planned session was actually started. Past days may be reduced or removed, but new placement requires future available working time. Protected changes need an explicit override, and real date constraints/deadlines still apply. Every manual change is reviewed and confirmed atomically. Exact latest-event Undo may restore an existing planned booking's original elapsed time without recording completion.

## Finish a booked day

Use **Finish this day → Confirm day finished** beside the date in task details. For three one-hour days, finishing day one leaves a muted **✓ 1h done** on that date, keeps the next two one-hour bookings active, and changes remaining effort from three hours to two. The original estimate stays three hours. Unknown-total ongoing projects stay unknown.

Finishing a day never completes the entire project or books replacement time. **Mark project complete** is the separate action for closing the whole job. Completed dates remain visible in the calendar and details without reserving time.

## Deployment

Daily validation was introduced in `202609080001_daily_hours.sql`. The later `202609090003_simple_day_hours.sql` separates display dates from explicit restrictions and removes focus requirements. `202609090004_move_unfinished_bookings.sql` makes planned sources editable after their scheduled time and preserves recorded completion/cancellation. The later `202609090005_complete_booked_day.sql` adds scoped day-completion validation, and `202609090006_undo_booked_day_completion.sql` permits exact latest-event Undo of that completion's own status and effort changes while preserving older history. Apply database compatibility before application changes; these migrations do not rewrite work or saved settings.

See [VERIFICATION.md](VERIFICATION.md) for test and release evidence. Development uses isolated fixtures and captured mail.
