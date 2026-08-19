# Upstream review checklist

Before changing the pinned DeepSeek Harness version, review the official repository for changes to:

- SDK protocol methods and payloads;
- TypeScript client lifecycle;
- JSON-RPC runtime entry point;
- session event vocabulary;
- subagent notifications;
- cancellation/session-close support;
- approval/request flow;
- provider/model initialization;
- runtime Cordis composition.

Then update compatibility tests and `UPSTREAM-COMPATIBILITY.md` before widening support.
