# 07 — Plan

## Tasks

### Step 1 — Email-entry path on the sign-in form

Add the "email me a link" control to `SignInForm`. On submit, call
`MagicLinkService.issue(email)`. Acceptance: SPEC-1.

### Step 2 — Issue and store tokens

Implement `MagicLinkService.issue`: mint a single-use token, store its salted
hash with `expiresAt`, send the link by email. Acceptance: SPEC-1.

### Step 3 — Consume and establish a session

Implement `MagicLinkService.consume` and wire it to `SessionService.establish`.
Reject expired/consumed/unknown tokens with the generic message.
Acceptance: SPEC-2, SPEC-3.

### Step 4 — Cap link requests per address

Before issuing, count link requests for the address inside a rolling window and
refuse to issue a new link once the cap is reached, returning the same identical
response as the issue path. This blocks email-channel abuse (R3).
Acceptance: (none stated in 06-spec.md).

<!--
PLANTED GAP marker: Step 4 implements a request-cap behavior — an observable
acceptance behavior — that 06-spec.md never states as a criterion. r2q's PLAN
rubric flags this; the finding-to-owner-doc map routes the root cause UPSTREAM to
06-spec.md (acceptance criteria / observable behavior gap), so the backward fix
edits BOTH 06-spec.md (add the criterion) AND this file (reference it from Step 4).
-->
