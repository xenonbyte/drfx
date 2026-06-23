# 05 — Design

## Components

- `SignInForm` — adds an "email me a link" path alongside the password field.
- `MagicLinkService` — issues, stores, and validates one-time tokens.
- `SessionService` — establishes the authenticated session on valid consumption.

## Flow

1. User submits their email from `SignInForm`.
2. `MagicLinkService.issue(email)` mints a single-use token, stores its hash with
   a short expiry, and sends the link by email.
3. The response to the browser is identical for known and unknown addresses (R2).
4. User clicks the link; `MagicLinkService.consume(token)` validates it (unused,
   unexpired, hash match) and marks it consumed.
5. On success, `SessionService` establishes the session.

## Token model

- Stored as a salted hash, never in plaintext.
- Fields: `tokenHash`, `email`, `issuedAt`, `expiresAt`, `consumedAt`.
- Expiry is enforced at consume time against `expiresAt`.

## Interfaces

- `MagicLinkService.issue(email): void`
- `MagicLinkService.consume(token): { email } | null`
- `SessionService.establish(email): Session`
