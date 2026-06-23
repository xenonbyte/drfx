# 03 — Requirement Brief

## Requirement

Add passwordless email sign-in ("magic link") to the web app. A returning user
enters their email, receives a one-time link, and clicking it signs them in
without a password.

## Goal

Reduce password-reset support load and abandoned sign-ins by removing the
password from the returning-user flow.

## In scope

- Email entry form on the existing sign-in page.
- One-time sign-in link delivered by email.
- Link consumption that establishes an authenticated session.

## Out of scope

- New-account registration (covered by the existing sign-up flow).
- Social / OAuth providers.
- Native mobile clients.

## Primary actors

- Returning user with a known, verified email address.

## Success signal

A returning user can sign in from email alone, with no password, in a single
round trip from their inbox.
