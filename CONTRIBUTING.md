# Contributing

Thanks for contributing to DeepSeek Harness CLI.

This is an unofficial community frontend for DeepSeek Harness. The project intentionally keeps a narrow boundary: the terminal owns interaction and presentation; DeepSeek Harness owns agent semantics.

## Before opening code

1. Check the current roadmap and open GitHub Issues.
2. Prefer an existing issue for substantial work.
3. For architecture/protocol changes, explain the upstream contract involved before implementing.
4. Do not depend on undocumented DeepSeek Harness internals without an explicit compatibility discussion.

## Development principles

- Prefer public upstream SDK/runtime surfaces.
- Keep upstream-specific compatibility code under `src/upstream/`.
- Preserve event ordering and avoid invented prompt/response causality.
- Treat Windows as a first-class platform.
- Treat terminal escape handling, credentials and subprocess behavior as security-sensitive.
- Add tests for protocol and lifecycle behavior, not just snapshots of presentation.

## Pull requests

A good PR should be focused and should state:

- linked issue;
- user-visible change;
- upstream API/protocol assumptions;
- tests run;
- supported platforms checked;
- documentation changes, if any.

Suggested title/commit prefixes:

```text
feat:
fix:
docs:
test:
refactor:
chore:
```

## Documentation

Update documentation in the same change when you alter:

- architecture boundaries;
- protocol assumptions;
- runtime launch behavior;
- slash-command semantics;
- cancellation/shutdown behavior;
- compatibility requirements;
- installation or configuration.

Large design changes should add an ADR under `docs/adr/`.

## Security

Do not post real API keys, access tokens, private repository content or credential-bearing debug logs in public Issues or PRs.

Security-sensitive bugs involving credential leakage, terminal escape injection or unintended command execution should not be demonstrated with real secrets.

## Project status

The project is pre-alpha. Interfaces and source layout may change rapidly until the first public alpha. Compatibility with upstream DeepSeek Harness is intentionally pinned and tested rather than assumed.
