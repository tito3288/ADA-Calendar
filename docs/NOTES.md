# Personal notes

Notes are standalone, private owner-only documents. They are not work items,
schedule spans, AI context, notifications, or email drafts.

## Use

1. Open **Notes** in the sidebar and choose **New note**.
2. Enter a title and note text, then choose **Save note**.
3. Click a saved title to reopen and edit that same note.
4. Use **New note** for a separate document. Notes can have identical titles;
   their independent IDs prevent one from replacing another.

Text is saved only on explicit Save, preserving spacing and line breaks. Drafts
remain mounted when navigating back to the calendar. Switching notes or starting
another note asks before discarding unsaved edits; browser navigation warns too.
Drafts are not written to localStorage and are not recoverable after the user
confirms leaving without saving.

## Storage and authorization

- `GET /api/notes` lists the authenticated owner's private notes.
- `POST /api/notes` accepts `{ id, title, body, expectedVersion }`.
- Titles are required and limited to 200 characters; bodies to 50,000 JavaScript
  string units. The schema rejects extra fields and null characters, without
  trimming saved text.
- Writes require same-origin verification and a trusted active owner membership.
- Notes are scoped to both workspace and author, and excluded from `/api/state`.
- Saves use expected-version checks. Repeated identical requests are no-ops;
  stale changed text returns 409 without overwriting the stored note. The editor
  keeps the draft and offers reloading or saving the edits as a separate note.
- Demo storage uses the existing serialized atomic transaction and strips the
  private notes collection from all shared-state responses.
- Live storage uses the signed-in Supabase client, owner-only SELECT RLS, and
  the authenticated `save_personal_note` RPC. No browser role has direct table
  write privileges. The RPC derives workspace and author from the session.

## Deployment prerequisite

`supabase/migrations/202609080002_personal_notes.sql` creates the private table,
read policy, and conflict-safe save function. It must be applied to the intended
Supabase environment before Notes can load or save in production. Railway's app
startup does not run SQL migrations. The existing Supabase GitHub integration
can deploy migrations on a push to `main`; verify its deployment check and
migration history before treating persistence as ready. Do not reapply the
migration through a second path if the integration has already applied it.

The migration has not been applied to or verified against a database during
this implementation. No live records, production configuration, or mail were
changed. Test owner access, requester/viewer denial, and stale writes against an
isolated database before deployment.

## Local verification

- `npm run test -- src/lib/notes-store.test.ts src/lib/notes-route.test.ts`
- `npm run test:e2e -- tests/e2e/notes.spec.ts`
- `npm run lint`
- `npm run typecheck`
- `ADA_NEXT_DIST_DIR=.next-e2e npm run build`

Browser checks use only `.data-e2e` demo fixtures with external provider keys
blank. They cover desktop/mobile accessibility, independent saves, reopening and
refresh persistence, unchanged calendar state, private access, failed saves,
unsaved drafts, and conflicting edits in different windows.

The full unit suite retains six pre-existing failures in `src/lib/server.test.ts`
related to date-sensitive scheduling/approval fixtures; the Notes tests pass.
