# Project status

Current phase: **M0 — Contract and architecture lock**

Updated: 2026-08-20

## Complete

- public repository created;
- project positioning documented;
- English and Chinese README present;
- architecture documented;
- protocol dependency documented;
- upstream compatibility policy documented;
- development workflow documented;
- milestone roadmap documented;
- contribution and security policies added;
- ADR mechanism initialized;
- initial architecture decisions recorded;
- issue and pull-request templates added.

## In progress

- GitHub milestone Issues creation;
- final M0 review against current upstream Harness developer-preview contracts.

## Next

M1 begins with the smallest end-to-end runtime slice:

1. scaffold TypeScript package;
2. pin the tested DeepSeek Harness SDK/runtime;
3. launch the official JSON-RPC runtime;
4. initialize against a workspace/provider/model;
5. submit one prompt;
6. consume durable session notifications;
7. render committed assistant output;
8. shut down cleanly;
9. run the path in CI across supported platforms.

No full-screen TUI work should begin before this path is proven.
