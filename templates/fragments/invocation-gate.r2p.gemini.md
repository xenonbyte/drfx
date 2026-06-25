Full form: {{ROUTE_NAME}} target=<requirement-dir> ... . A bare requirement directory is accepted as shorthand for target=<requirement-dir>. The target names an r2p requirement directory (<project>/.req-to-plan/WF-*). There is no ref= form for this route.

This route accepts only a bare requirement directory or target=<requirement-dir>, optional read-only, optional guard=git|snapshot, optional root=<project-root>, and optional debug. It does not accept ref=, strict, normal, assurance=, ledger=, scope=, base=, review-and-fix, resume, reset, or rounds=.

If a valid target=<requirement-dir> invocation omits mode, missing mode selects read-only. Gemini is advisory-only: review-and-fix is unsupported, workflow PASS is unavailable, and Gemini must not edit 07-plan.md, the upstream docs (03–06), or run.md.

run.md is a read-only gate that is never written. This route reviews the requirement plan (07-plan.md) only.

Help-style or invalid invocations explain usage only. Do not read the requirement-directory bodies, do not run workflow commands, do not run probes, do not create state, and do not declare a review result.

Before any drfx workflow command, materialize <selectedGuard> from explicit guard or default snapshot, and pass guard=<selectedGuard> to the workflow command.
