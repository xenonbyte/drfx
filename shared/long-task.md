# Long-Task Protocol

Long tasks must be resumable from project files, not from chat history or runtime memory. Create target-local state only when persistent state is needed: long or multi-round work, `resume`, `ledger=`, an auditable trail, context pressure, interruption, or a blocker.

One-shot `read-only` without `ledger=`, without `resume`, and without `reset` is no-state: do not create `.drfx`, target directories, manifests, ledgers, continuity files, summaries, receipts, or locks.

No-state read-only uses command-generated `reviewGuard` and `stateToken` values kept only in coordinator memory. These tokens are redacted normalized state, not document content. Do not write them to disk, do not edit them, and never finalize no-state as `pass`; clean read-only status is `read-only-clean`.

## Route Target Contexts

A route resolves one of four target contexts. The protocol below is identical across them; only the target identity differs.

- Document routes (`review-fix-spec`/`plan`/`design`/`doc`): the target context is a single file. Its identity is the normalized target path relative to the project root.
- PR route (`review-fix-pr`): the target context is the file set of a local PR diff (`base=<branch>` vs `HEAD`, via the local merge base). Its identity is the route kind plus the base ref, with a deterministic file-set fingerprint over the diff. PR resolution is local and read-only: never fetch, push, or mutate refs.
- CODE route (`review-fix-code`): the target context is the file set discovered by traversing in-root source `scope=<path>` directories under mandatory exclusions. Its identity is the route kind plus the normalized scopes and a deterministic file-set fingerprint over the discovered files; stored exclusions describe the resolver policy used for audit, but default exclusion-list drift alone does not make resume stale when the file-set fingerprint is unchanged.
- r2p route (`review-fix-r2p`): the target context is an active `workId=<WF-...>` run. The reviewed anchor is `07-plan.md` (against COMMON+PLAN); `03-07` are review files, `run.md` is a read-only protected dependency, and direct artifact writes are forbidden. Its identity is the route kind plus the `workId`, with manifest freshness gates over the `03-07` review-set fingerprint and the `run.md` content hash.

## Target State Directory

All persistent state for one target context lives under:

```text
.drfx/targets/<target-key>/
```

For a document route the target key is derived from the normalized target path relative to the project root, not from content. For a file-set route (PR/CODE) the target key is derived from the route kind plus the base/scope identity, not from content. In both cases use a readable slug or route-kind prefix plus a 12-hex SHA-256 prefix of that identity.

Target-local layout:

```text
.drfx/targets/<target-key>/
├── MANIFEST.md
├── ISSUES.md
├── CONTINUITY.md
├── SUMMARY.md
├── LOCK/
│   └── lease.json
├── stale-locks/
└── rounds/
```

Project-root `.drfx/rules/` is shared project configuration, not target state. Do not write target review state to project-root `.drfx/ISSUES.md`, `.drfx/CONTINUITY.md`, `.drfx/SUMMARY.md`, or `.drfx/rules/`.

## Manifest Fields

`MANIFEST.md` records enough state to resume safely. The manifest carries an optional `Target context kind` discriminator (`document`, `pr`, `code`, or `r2p`); absent means `document`, so existing document manifests are unchanged. The identity block varies by kind; the shared workflow fields below apply to every kind.

Shared fields (all kinds):

- Manifest schema: `2`.
- Target context kind: `document`, `pr`, `code`, or `r2p` (omitted for document, which is the default).
- Strictness: `normal` or `strict`.
- Mode: `review-and-fix` or `read-only`.
- Assurance: `practical`, `strict-verified`, or `advisory`.
- Runtime platform: `codex`, `claude-code`, `gemini`, `opencode`, or `manual`.
- Runtime subagent probe, stdin handoff, fingerprint guard, downgrade reason, assurance proof, blocking reason, and status reason.
- Target key.
- Ledger path, defaulting to `.drfx/targets/<target-key>/ISSUES.md`.
- Status: `review`, `triage`, `fix`, `diff-review`, `full-re-review`, `pass`, `stopped-with-deferrals`, `stopped-no-progress`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, or `checkpoint`.
- Read-only clean status: `read-only-clean`.
- Current round.
- Current phase.
- Round limit when `rounds=<n>` is supplied; omitted otherwise.
- Last modified timestamp.
- Created and updated timestamps.

Document target context identity:

- Target path and normalized target path.
- Document type: `SPEC`, `PLAN`, `DESIGN`, or `COMMON`.
- Initial, last known, last reviewed, and last passed content sha256.
- File size when available.
- Reference paths. The manifest records reference paths; read-only role is preserved in context packs/normalized references, not as per-reference manifest flags.

File-set (PR/CODE) target context identity:

- Document type is `none`; PR/CODE routes have no fixed document type and record no single-file content sha256 or file size.
- A deterministic file-set fingerprint over the resolved files identifies the reviewed set; a changed fingerprint means the set drifted.
- PR records the base ref plus the resolved base, merge-base, and HEAD commits.
- CODE records the normalized scopes and the mandatory exclusion list.

R2P target context identity:

- Document type is `PLAN`; the reviewed anchor is `07-plan.md` inside the active run.
- Target context kind is `r2p`, and the manifest records `workId`.
- The `03-07` review-set fingerprint and the `run.md` sha256 gate repair commands; any mismatch blocks repair and requires rerun or r2p lifecycle recovery.

If `ledger=` is supplied, record the resolved target-local ledger path. A custom ledger must stay inside `.drfx/targets/<target-key>/` and must not point to reserved state files, `LOCK/`, `stale-locks/`, or `rounds/`.

## Issue Ledger

The issue ledger records durable issue state, not a transcript. Default path:

```text
.drfx/targets/<target-key>/ISSUES.md
```

Recommended table:

```markdown
## Issue Ledger

| ID | Severity | Status | Location | Summary | Resolution |
| --- | --- | --- | --- | --- | --- |
| ISSUE-001 | high | fixed | Requirements | Missing failure path | Added invalid-token behavior |
```

Allowed statuses are `accepted`, `fixed`, `merged`, `rejected`, `deferred`, and `reopened`. Every accepted issue receives a stable ID. Reopened issues keep their original ID. Rejected issues need a short reason. Deferred issues need a reason and owner.

Redact all sensitive values as `[REDACTED:<kind>]`. Store location anchors, not raw secrets, raw logs, partial tokens, checksums, or transcript excerpts.

## Lock Lease

Before any target modification, acquire `.drfx/targets/<target-key>/LOCK/` by atomically creating the directory. `LOCK/lease.json` contains:

- `schemaVersion`
- `targetKey`
- `targetPath`
- `ownerId`
- `processId` when available
- `hostname`
- `startedAt`
- `updatedAt`
- `expiresAt`
- `mode`
- `strictness`
- `targetFingerprintAtAcquire`

Default lease duration is 15 minutes. Refresh the lease before each write and at least once every 60 seconds during delegated fixer work.

If an unexpired lock exists, stop as `blocked` with reason `lock-held`. If `lease.json` is missing or corrupt, stop as `blocked` with reason `corrupt-lock`. If an expired lock exists, archive the stale lease under `stale-locks/<timestamp>.json` only after confirming the current target fingerprint still matches the last known fingerprint; otherwise stop as `externally-changed`.

Immediately before each fix, recompute the target fingerprint. If it differs from `targetFingerprintAtAcquire` or the manifest's last known fingerprint, stop as `externally-changed`. Release a lock only when `ownerId` matches the coordinator owner.

One-shot `read-only` without persistent state never acquires a lock.

## Receipts

Round receipts live under `.drfx/targets/<target-key>/rounds/` when an auditable trail is requested, the loop reaches round 2, the coordinator stops due to interruption or context pressure, or a blocker state needs durable proof.

Receipts should record:

- Round number and phase.
- Reviewer result or fixer report summary.
- Issue IDs touched.
- Files changed.
- Verification performed.
- Next action.
- Redacted blocker or residual-risk details.

Receipts must be compact and must not store raw secrets, raw logs, or transcripts.

Semantic payloads enter workflow commands through real stdin handoff. Do not use shell pipes, heredocs, herestrings, command substitution, argv, environment variables, env vars, or raw temp files for reviewer results, triage, fix reports, diff reviews, or final responses. If stdin handoff is unavailable, stop as `blocked` with `unsafe-handoff-file` or use the no-state preflight terminal path before any file body read.

## Resume Rules

Resume is never silent. A matching target context without an explicit `resume` token is not reused; a fresh start over existing state stops as state-already-exists. An explicit `resume` whose recorded identity is stale (any mismatch, including the round limit) is refused, not silently continued.

When stale state can no longer be resumed (for example after an exclusion-policy change shifted the CODE file set, drifting its fingerprint), use the explicit `reset` token. `reset` archives the existing target state under `.drfx/archived/<target-key>-<timestamp>` — never deleting or overwriting it — and then starts fresh, recomputing identity under the current resolver policy. `resume` and `reset` are mutually exclusive, and `reset` over no existing state is just a fresh start.

`reset` is the escape for non-archived terminal and paused states: `stopped-with-deferrals`, `stopped-no-progress`, `blocked`, `checkpoint`, `externally-changed`, `possible-target-replacement`, `read-only-findings`, and mid-flight states. `reset` is no longer required after `pass` or `read-only-clean` — those are archived automatically at `finalize` time.

On `resume`:

1. Derive the target key from the requested target context identity (document: the normalized target path; PR/CODE: the route kind plus base/scope identity; r2p: the route kind plus workId).
2. Read that target's `MANIFEST.md`.
3. Read the manifest `Ledger path`, defaulting to target-local `ISSUES.md`.
4. Read `CONTINUITY.md` when present.
5. Confirm the manifest target context matches the requested one (document: the manifest target path matches the requested target; PR/CODE: the base/scope identity and file-set fingerprint match; r2p: the workId, review-set fingerprint, and run.md gate hash match).
6. Restore strictness and mode from the manifest unless the user explicitly asks to change them.
7. Rebuild the merged rule set from current shared rubrics (document and r2p routes) or the route-kind rule stack (PR/CODE), plus user-global and project-local rules.
8. Recompute the current target context identity and compare it with the manifest: document routes compare the content fingerprint; PR/CODE routes compare the file-set fingerprint; r2p compares the review-set fingerprint and run.md gate hash.
9. Continue from the recorded next action only when state is still valid.

If the current invocation supplies different strictness or mode from the manifest, stop and ask whether to resume with manifest values or start a new review round. A `read-only` manifest must not resume into `review-and-fix` without explicit user confirmation.

## Stale PASS Clearing

On `finalize`, a `pass` or `read-only-clean` run archives its target state directory to `.drfx/archived/<target-key>-<timestamp>` (renamed, never deleted). The next run starts fresh without requiring `reset`. Archiving is best-effort: if it fails, the run still reports its terminal status plus an `archiveWarning`, the state directory stays in place, and a subsequent bare start falls back to `ERR_STATE_EXISTS` (use `reset` to clear it manually).

On `resume`, if the target state directory contains a live `pass` or `read-only-clean` manifest (a leftover from a failed archive or a pre-upgrade run), the resume handler archives the directory and starts a fresh review — no `reset` needed. If archiving fails, the run blocks with a concrete repair/`reset` next action rather than re-reporting the old PASS or re-reviewing in place.

Pre-existing or legacy leftover `pass` directories are not retroactively migrated; a bare `start` over one still returns `ERR_STATE_EXISTS`. Use `reset` to clear it once, then proceed normally.

If the target changed while status was not `pass`, set status to `externally-changed`, require a full re-review, and reopen affected issues when uncertain.

If the file appears to be a different document at the same path, set `possible-target-replacement` and ask whether to restart, archive, or migrate state. Do not silently reuse old issue IDs for a different document.

## Continuity

Use target-local `CONTINUITY.md` only as a compact handoff brief. Include current goal, decisions, recent done items, now, next, open questions, working set, and receipts. Keep it bounded and current; it is not a transcript.
