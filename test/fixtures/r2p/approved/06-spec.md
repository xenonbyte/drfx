# 06 — Spec

## Acceptance criteria

### SPEC-1 — Request a link

GIVEN a returning user on the sign-in page
WHEN they submit a syntactically valid email address
THEN the system issues a single-use sign-in link to that address
AND the browser response is identical whether or not the address has an account.

### SPEC-2 — Consume a valid link

GIVEN an unexpired, unused sign-in link
WHEN the user opens it
THEN the system establishes an authenticated session for the link's address
AND marks the link consumed so it cannot be reused.

### SPEC-3 — Reject an invalid link

GIVEN a link that is expired, already consumed, or unrecognized
WHEN the user opens it
THEN the system establishes no session
AND shows a generic "link no longer valid" message.

## Notes

Token storage, expiry, and hashing are specified in `05-design.md`. Enumeration
resistance (R2) is covered by the identical-response clause of SPEC-1.

<!--
PLANTED GAP (do not "fix" in the fixture): risk R3 (email-channel abuse) in
04-risk-discovery.md calls for rate-limiting link requests, but there is NO
acceptance criterion here that states the observable rate-limit behavior. The
plan (07-plan.md, step 4) nonetheless implements a per-address request cap. That
plan step therefore executes acceptance behavior with no spec backing — a PLAN
rubric finding whose ROOT CAUSE is this missing criterion, owned by 06-spec.md.
-->
