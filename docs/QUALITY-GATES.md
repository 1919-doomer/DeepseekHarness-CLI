# Engineering quality gates

Before implementation milestones are closed, relevant changes should satisfy automated gates.

## M1 minimum

- TypeScript typecheck passes;
- build passes;
- unit/contract tests pass;
- runtime smoke path is reproducible;
- process exits cleanly;
- no secrets appear in default logs.

## M3 minimum

Add terminal-specific checks:

- escape-sequence sanitization tests;
- resize/large-output behavior;
- transcript projection correctness;
- Ctrl+C/EOF behavior;
- Windows Terminal validation.

## M5 minimum

Add release gates:

- supported OS CI matrix;
- pinned upstream compatibility smoke test;
- fresh-install test;
- package/release workflow;
- current compatibility and known-limitations documentation.
