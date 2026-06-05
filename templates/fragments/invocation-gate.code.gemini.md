Full form: {{ROUTE_NAME}} [scope=<path>...] ... . scope=<path> names a source root to review; repeat scope=<path> for multiple roots. Omit scope= to review the whole project root, capped at 300 files or 1,500,000 bytes. Larger whole-root file sets block as file-set-too-large and require a narrower scope=<path> or a project-root .drfxignore file (one root-relative directory path per line; # comments; no globs or negation) that shrinks the file set. An explicit scope= overrides any .drfxignore entry that covers it; .gitignore is never read. There is no bare-path or target= form for this route. Before workflow commands, materialize <scopeTokens> as the repeated scope=<path> tokens exactly as requested, or as an empty string when scope is omitted.

This route accepts only scope=<path> (repeatable), optional read-only, optional guard=git|snapshot, optional root=<project-root>, and optional debug. It does not accept ref=, base=, strict, normal, assurance=, ledger=, or rounds=. Explicit review-and-fix is unsupported on Gemini and must render the unsupported result instead of starting a fix loop.

This is a Gemini code route and is advisory-only. When no mode token is present, materialize read-only. When no assurance token is present, materialize advisory. Use Claude Code or Codex for review-and-fix. workflow PASS is unavailable; Gemini must not claim workflow PASS and must not run automatic fixes.

Help-style or invalid invocations explain usage only. Do not read scope files, do not run workflow commands, do not run probes, do not create state, and do not declare a review result.

Before any drfx workflow command, materialize <selectedGuard> from explicit guard or default git, and pass guard=<selectedGuard> to the workflow command.
