---
name: review-checklist
description: General code review checklist covering correctness, error handling, tests, and readability. Use for any code review.
tags: [review, quality, tests]
---

# Review checklist

Work through each section for every changed file. Report only real problems, with file and line.

## Correctness
- Does the change do what its description says, including edge cases (empty input, missing files, concurrent calls)?
- Are new branches reachable, and are removed branches really dead?

## Error handling
- Are errors surfaced to the caller or user, not swallowed?
- Are resources (processes, files, listeners, timers) released on every exit path?

## Tests
- Does each behavior change have a test that fails without the change?
- Do tests assert outcomes rather than implementation details?

## Readability
- Do names say what things are? Is any non-obvious decision explained in a comment?
