# Long-Task Protocol

Long tasks must be resumable from project files, not from chat history or runtime memory. Create target-local state only when persistent state is needed: long or multi-round work, `resume`, `ledger=`, an auditable trail, context pressure, interruption, or a blocker.

One-shot `read-only` without `ledger=` and without `resume` is no-state: do not create `.docs-review-fix`, target directories, manifests, ledgers, continuity files, summaries, receipts, or locks.

No-state read-only uses command-generated `reviewGuard` and `stateToken` values kept only in coordinator memory. These tokens are redacted normalized state, not document content. Do not write them to disk, do not edit them, and never finalize no-state as `pass`; clean read-only status is `read-only-clean`.

## Target State Directory

All persistent state for one target lives under:

```text
.docs-review-fix/targets/<target-key>/
```

The target key is derived from the normalized target path relative to the document project root, not from content. Use a readable slug plus a 12-hex SHA-256 prefix of the normalized path.

Target-local layout:

```text
.docs-review-fix/targets/<target-key>/
├── MANIFEST.md
├── ISSUES.md
├── CONTINUITY.md
├── SUMMARY.md
├── LOCK/
│   └── lease.json
├── stale-locks/
└── rounds/
```

Project-root `.docs-review-fix/RULE.md` is shared project configuration, not target state. Do not write target review state to project-root `.docs-review-fix/ISSUES.md`, `.docs-review-fix/CONTINUITY.md`, or `.docs-review-fix/SUMMARY.md`.

## Manifest Fields

`MANIFEST.md` records enough state to resume safely:

- Manifest schema: `2`.
- Target path.
- Normalized target path.
- Document type: `SPEC`, `PLAN`, `DESIGN`, or `COMMON`.
- Strictness: `normal` or `strict`.
- Mode: `review-and-fix` or `read-only`.
- Assurance: `practical`, `strict-verified`, or `advisory`.
- Runtime platform: `codex`, `claude-code`, `gemini`, or `manual`.
- Runtime subagent probe, stdin handoff, fingerprint guard, downgrade reason, assurance proof, blocking reason, and status reason.
- Target key.
- Ledger path, defaulting to `.docs-review-fix/targets/<target-key>/ISSUES.md`.
- Status: `review`, `triage`, `fix`, `diff-review`, `full-re-review`, `pass`, `stopped-with-deferrals`, `read-only-findings`, `blocked`, `unsupported`, `externally-changed`, `possible-target-replacement`, or `checkpoint`.
- Read-only clean status: `read-only-clean`.
- Current round.
- Current phase.
- Initial content sha256.
- Last known content sha256.
- Last reviewed content sha256.
- Last passed content sha256.
- Last modified timestamp and file size when available.
- Reference paths. The manifest records reference paths; read-only role is preserved in context packs/normalized references, not as per-reference manifest flags.
- Created and updated timestamps.

If `ledger=` is supplied, record the resolved target-local ledger path. A custom ledger must stay inside `.docs-review-fix/targets/<target-key>/` and must not point to reserved state files, `LOCK/`, `stale-locks/`, or `rounds/`.

## Issue Ledger

The issue ledger records durable issue state, not a transcript. Default path:

```text
.docs-review-fix/targets/<target-key>/ISSUES.md
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

Before any target modification, acquire `.docs-review-fix/targets/<target-key>/LOCK/` by atomically creating the directory. `LOCK/lease.json` contains:

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

Round receipts live under `.docs-review-fix/targets/<target-key>/rounds/` when an auditable trail is requested, the loop reaches round 2, the coordinator stops due to interruption or context pressure, or a blocker state needs durable proof.

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

On `resume`:

1. Derive the target key from the requested target path.
2. Read that target's `MANIFEST.md`.
3. Read the manifest `Ledger path`, defaulting to target-local `ISSUES.md`.
4. Read `CONTINUITY.md` when present.
5. Confirm the manifest target path matches the requested target.
6. Restore strictness and mode from the manifest unless the user explicitly asks to change them.
7. Rebuild the merged rule set from current shared rubrics, user-global rules, and project-local rules.
8. Compute the current target fingerprint and compare it with manifest fingerprints.
9. Continue from the recorded next action only when state is still valid.

If the current invocation supplies different strictness or mode from the manifest, stop and ask whether to resume with manifest values or start a new review round. A `read-only` manifest must not resume into `review-and-fix` without explicit user confirmation.

## Stale PASS Clearing

If manifest status is `pass` but the current content fingerprint differs from `Last passed content sha256`, clear the old PASS. Start a new full review round before claiming any current PASS.

If the target changed while status was not `pass`, set status to `externally-changed`, require a full re-review, and reopen affected issues when uncertain.

If the file appears to be a different document at the same path, set `possible-target-replacement` and ask whether to restart, archive, or migrate state. Do not silently reuse old issue IDs for a different document.

## Continuity

Use target-local `CONTINUITY.md` only as a compact handoff brief. Include current goal, decisions, recent done items, now, next, open questions, working set, and receipts. Keep it bounded and current; it is not a transcript.
