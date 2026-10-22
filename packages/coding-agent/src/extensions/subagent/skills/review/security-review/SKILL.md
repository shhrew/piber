---
name: security-review
description: Security review guidance for input handling, path traversal, command injection, and secrets. Use when a change touches untrusted input, the filesystem, subprocesses, or credentials.
tags: [review, security]
---

# Security review

## Untrusted input
- Trace every value from outside the process (CLI args, files, network, model output) to where it is used.
- Paths built from input must be resolved and checked against the intended root before use.

## Subprocesses
- Prefer argument arrays over shell strings. Flag any `shell: true` or string interpolation into a command.

## Secrets
- Secrets must not reach logs, error messages, session files, or tool output.
