# 04 — Risk Discovery

## Risks

### R1 — Link interception

A magic link is a bearer credential. If intercepted (shared inbox, forwarded
email, leaked logs) it grants a session.

- Mitigation: single-use links, short expiry, bind to the requesting browser
  where practical.

### R2 — Enumeration

The email-entry response must not reveal whether an address has an account.

- Mitigation: identical response and timing for known and unknown addresses.

### R3 — Email-channel abuse

An attacker can request links for a victim's address repeatedly, flooding their
inbox and burning send quota.

- Mitigation: rate-limit link requests per address and per source.

## Rollback

The feature sits behind a flag on the sign-in page. Disabling the flag restores
the password-only flow with no data migration.
