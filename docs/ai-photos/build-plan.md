# AI Photos build — September 30, 2026

Spec: the user's AI Photos requirements in this task; see `architecture.md`
in this directory for the architecture and full product roadmap.

## Global constraints

- Keep Ente's encrypted sync, original storage, streaming, cleanup, and sharing.
- Use `gemini-3.8-flash` for explicitly opted-in cloud image understanding.
- No production API key in a bundle. The development lab accepts a user's own key
  in memory only. A production relay and encrypted-index adapter are later work.
- No automatic uploads, bulk selection of a library, or deletion of originals.
- Build the first slice against synthetic fixtures; do not read personal photos.
- Work on `codex/ai-photos`, preserve upstream licensing, keep SDKs and credentials ignored.

### Task 1: Repeatable development loop

Files: `scripts/ai-photos.mjs`, `docs/ai-photos/README.md`, `.gitignore`.
Interfaces: local SDKs under `.tools`; local service config under `.dev/my-ente`;
source web on 4300, Museum on 4800, MinIO on 4320, accounts on 4391.

Steps:
1. Add doctor, web setup, services, web, test, and mobile setup commands.
2. Reuse upstream quickstart to generate random credentials; isolate published ports.
3. Verify doctor, local API health, source web HTTP 200, and existing photos tests.

Completion: documented commands work in this checkout; secrets stay ignored.

### Task 2: Working browser photo-intelligence slice

Files: `web/apps/photos/src/services/photo-intelligence.ts`,
`web/apps/photos/src/pages/intelligence.tsx`, `web/apps/photos/tests/photo-intelligence.test.ts`.
Interfaces: selected images -> EXIF-free JPEG derivative -> 3.8 structured result
-> in-memory search index; SHA-256 exact duplicate detection; no originals uploaded.

Steps:
1. Write failing behavior tests for opt-in, model request, response validation,
   failures, search, and exact duplicate grouping.
2. Implement the service and browser UI, using existing React/MUI dependencies.
3. Verify tests, TypeScript, and the rendered page using the in-app browser.
4. Document limits: session-only index, user-owned development key, no remote account
   integration yet; main Ente app continues to provide encrypted sync.

Completion: selected images can be indexed with 3.8 and searched locally;
no network call before explicit opt-in and an action; tests use fake transport only.

### Task 3: Review and record

Files: development guide, model decision, progress ledger.
Interfaces: previous tasks' commands and UI.

Steps:
1. Request one fresh-context whole-branch review required by executing-plans.
2. Address material findings and repeat affected checks.
3. Record verified behavior and remaining product milestones; commit this slice locally.

Completion: reviewed development slice, concrete run guide, no claim of a finished app.
