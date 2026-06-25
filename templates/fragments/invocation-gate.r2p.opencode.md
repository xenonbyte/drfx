Full form: `{{ROUTE_NAME}} target=<requirement-dir> ...`. A bare requirement directory is accepted as shorthand for `target=<requirement-dir>`. The target names an r2p requirement directory (`<project>/.req-to-plan/WF-*`); there is no `ref=` form for this route.

This route accepts only a bare requirement directory or `target=<requirement-dir>`, optional `read-only` or `review-and-fix`, optional `guard=git|snapshot` (default `snapshot`), optional `resume` or `reset`, optional `rounds=<n>`, optional `root=<project-root>`, and optional `debug`. `resume` and `reset` are mutually exclusive. It does not accept `ref=`, `strict`, `normal`, `assurance=`, `ledger=`, `scope=`, or `base=`.

If a valid `target=<requirement-dir>` invocation omits mode, missing mode selects `review-and-fix`. This route has a fixed PLAN rubric: there is no user-facing `assurance=` token. For `review-and-fix`, the route internally materializes `practical` assurance (or `strict-verified` only via the same-flow strict proof path); it never runs `review-and-fix` with advisory assurance, so auto-fix is not rejected as `advisory-review-and-fix-unsupported`.

This route reviews the requirement plan (`07-plan.md`) and fixes backward into the owning upstream docs (`03–06`) inside the resolved requirement directory; it never edits `run.md` or any file outside `03–07`. `run.md` is read only to confirm the plan stage is generated/approved.

Help-style or invalid invocations still explain usage only. Do not read requirement-directory bodies, run workflow commands, run probes, create state, or declare a review result for missing `target=`, unknown usage, or explicit help.

Before any `drfx workflow` command, materialize effective `<selectedMode>`, `<selectedAssurance>`, and `<selectedGuard>`. Compute `<selectedMode>` from explicit mode or the default `review-and-fix`. Set `<selectedAssurance>` to `practical` for materialized `review-and-fix`, or `strict-verified` only on the same-flow strict proof path; for `read-only` use `practical`. Compute `<selectedGuard>` from explicit guard or default `snapshot`. Always pass those explicit materialized values to workflow commands; never pass omitted mode, assurance, or guard through to `drfx workflow`.

`rounds=<n>` sets the maximum repair-loop count and is unsupported with `read-only`. When `rounds=<n>` is present, materialize `<roundLimit>` from it and include `rounds=<roundLimit>` on workflow start; otherwise omit the token.
