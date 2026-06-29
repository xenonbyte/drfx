Use the materialized `<selectedAssurance>` to choose runtime fields. The r2p route exposes no user-facing `guard=` token; drift detection is internal and always on.

- r2p exposes no user-facing advisory assurance token. Practical read-only no-state path uses `<selectedAssurance>` set to `practical` with `--runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none`.
- Strict-verified read-only is state-backed: use the Strict Verified Proof workflow start with ready probe/handoff fields. Do not use no-state commands for `strict-verified`.

Practical read-only no-state path starts with:

```text
drfx workflow context --no-state {{ROUTE_NAME}} {{WORKFLOW_TARGET_TOKEN}} read-only --assurance practical --runtime-platform {{RUNTIME_PLATFORM}} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --json=compact
```

Submit practical review, triage, and final response by repeating the same practical runtime fields:

```text
drfx workflow record-review --no-state {{ROUTE_NAME}} {{WORKFLOW_TARGET_TOKEN}} read-only --assurance practical --runtime-platform {{RUNTIME_PLATFORM}} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --review-guard <reviewGuard> --result-stdin --json=compact
drfx workflow record-triage --no-state {{ROUTE_NAME}} {{WORKFLOW_TARGET_TOKEN}} read-only --assurance practical --runtime-platform {{RUNTIME_PLATFORM}} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --state-token <latestStateToken> --triage-stdin --json=compact
drfx workflow finalize --no-state {{ROUTE_NAME}} {{WORKFLOW_TARGET_TOKEN}} read-only --assurance practical --runtime-platform {{RUNTIME_PLATFORM}} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --state-token <latestStateToken> --final-response-stdin --json=compact
```
