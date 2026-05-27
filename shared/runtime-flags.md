Use the materialized `<selectedAssurance>` to choose runtime fields, and pass the materialized `<selectedGuard>` to every no-state workflow command:

- Advisory read-only no-state path uses `--assurance advisory --runtime-subagent-probe not-required --runtime-stdin-handoff ready --runtime-downgrade-reason none`. Do not use the practical/strict-verified ready-probe commands for advisory read-only. Advisory skips the subagent probe, but review-backed semantic payload commands still require proven stdin handoff.
- Practical read-only no-state path uses `<selectedAssurance>` set to `practical` with `--runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none`.
- Strict-verified read-only is state-backed: use the Strict Verified Proof workflow start with ready probe/handoff fields. Do not use no-state commands for `strict-verified`.

Advisory read-only no-state path starts with:

```text
drfx workflow context --no-state {{ROUTE_NAME}} target=<path> read-only guard=<selectedGuard> --assurance advisory --runtime-platform {{RUNTIME_PLATFORM}} --runtime-subagent-probe not-required --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --json
```

Submit advisory review, triage, and final response by repeating the same advisory runtime fields:

```text
drfx workflow record-review --no-state {{ROUTE_NAME}} target=<path> read-only guard=<selectedGuard> --assurance advisory --runtime-platform {{RUNTIME_PLATFORM}} --runtime-subagent-probe not-required --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --review-guard <reviewGuard> --result-stdin --json
drfx workflow record-triage --no-state {{ROUTE_NAME}} target=<path> read-only guard=<selectedGuard> --assurance advisory --runtime-platform {{RUNTIME_PLATFORM}} --runtime-subagent-probe not-required --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --state-token <latestStateToken> --triage-stdin --json
drfx workflow finalize --no-state {{ROUTE_NAME}} target=<path> read-only guard=<selectedGuard> --assurance advisory --runtime-platform {{RUNTIME_PLATFORM}} --runtime-subagent-probe not-required --runtime-stdin-handoff ready --runtime-downgrade-reason none --state-token <latestStateToken> --final-response-stdin --json
```

Practical read-only no-state path starts with:

```text
drfx workflow context --no-state {{ROUTE_NAME}} target=<path> read-only guard=<selectedGuard> --assurance <selectedAssurance> --runtime-platform {{RUNTIME_PLATFORM}} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --json
```

Submit practical review, triage, and final response by repeating the same practical runtime fields:

```text
drfx workflow record-review --no-state {{ROUTE_NAME}} target=<path> read-only guard=<selectedGuard> --assurance <selectedAssurance> --runtime-platform {{RUNTIME_PLATFORM}} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --review-guard <reviewGuard> --result-stdin --json
drfx workflow record-triage --no-state {{ROUTE_NAME}} target=<path> read-only guard=<selectedGuard> --assurance <selectedAssurance> --runtime-platform {{RUNTIME_PLATFORM}} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --phase initial-review --state-token <latestStateToken> --triage-stdin --json
drfx workflow finalize --no-state {{ROUTE_NAME}} target=<path> read-only guard=<selectedGuard> --assurance <selectedAssurance> --runtime-platform {{RUNTIME_PLATFORM}} --runtime-subagent-probe ready --runtime-stdin-handoff ready --runtime-downgrade-reason none --state-token <latestStateToken> --final-response-stdin --json
```
