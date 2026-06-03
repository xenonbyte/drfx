Full form: `{{ROUTE_NAME}} scope=<path> [scope=<path>...] ...`. At least one `scope=<path>` is required and names a source root to review; repeat `scope=<path>` for multiple roots. There is no bare-path or `target=` form for this route.

This route accepts only `scope=<path>` (repeatable), optional `read-only` or `review-and-fix`, optional `guard=git|snapshot`, optional `resume`, optional `rounds=<n>`, optional `root=<project-root>`, and optional `debug`. It does not accept `ref=`, `base=`, `strict`, `normal`, `assurance=`, or `ledger=`.

If a valid `scope=<path>` invocation omits mode, missing mode selects `review-and-fix`. This is a code route: there is no user-facing `assurance=` token. For `review-and-fix`, the route internally materializes `practical` assurance (or `strict-verified` only via the same-flow strict proof path); it never runs `review-and-fix` with advisory assurance, so code auto-fix is not rejected as `advisory-review-and-fix-unsupported`.

Help-style or invalid invocations still explain usage only. Do not read scope files, run workflow commands, run probes, create state, or declare a review result for missing `scope=`, unknown usage, or explicit help.

Before any `drfx workflow` command, materialize effective `<selectedMode>`, `<selectedAssurance>`, and `<selectedGuard>`. Compute `<selectedMode>` from explicit mode or the default `review-and-fix`. Set `<selectedAssurance>` to `practical` for materialized `review-and-fix`, or `strict-verified` only on the same-flow strict proof path; for `read-only` use `practical`. Compute `<selectedGuard>` from explicit guard or default `git`. Always pass those explicit materialized values to workflow commands; never pass omitted mode, assurance, or guard through to `drfx workflow`.

`rounds=<n>` sets the maximum repair-loop count and is unsupported with `read-only`. When `rounds=<n>` is present, materialize `<roundLimit>` from it and include `rounds=<roundLimit>` on workflow start; otherwise omit the token.