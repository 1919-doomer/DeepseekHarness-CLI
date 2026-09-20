# Alpha.14 review and performance validation

Reviewed the alpha.13 follow-up patch against main `b40f425`, focusing on history
selection/confirmation, transcript visibility, risk tags and tool-side rendering.

## Findings addressed

- Risk/tool glyphs used ambiguous-width emoji characters. Use bracketed labels
  and a text marker, with a regression comparing dshc widths to Ink's dependency.
- Steering-capable runtimes still advertised queueing, and tool-only assistant
  messages left empty headings. Select the hint by capability and hide empty
  headings without hiding errors, retained text or truncation notices.
- Historical selection could lose recent instructions behind large tool results.
  Compact reuse gives separate priority to recent user and assistant messages,
  preserves the first retained request, bounds excerpts and discloses omissions.
- Confirmation command reconstruction lost quoting. Round-trip generated
  instructions through the actual tokenizer, including mixed quotes and Windows
  paths; the confirmation remains bound to the exact evidence and instruction.
- Every text update rebuilt the tool projection, including JSON argument parsing
  and risk classification. Cache the current relevant event references. Results,
  topology, eviction, session and workspace changes invalidate the cache. Memory
  is bounded by the current retained event set, not lifetime tool calls.

## Reproducible performance comparison

Run `pnpm bench:sidebar`. On Windows, Node 24.13.0, Intel Core Ultra 9 275HX:
2,048 retained events, 100 calls, 300 unchanged-tool projections took 156.58 ms
without the cache and 3.13 ms with it (about 50x for this isolated operation).
The benchmark asserts equivalent projections before measurement. This measures
an unchanged tool list during text/reasoning updates, not overall application
speed, model TPS, terminal paint time or input-method latency.

`pnpm bench:replay` separately reports event-reduction and scheduler latency at
normal, synthetic peak and triple-peak load. Machine-specific timings are
observations, not universal CI performance gates.

## Validation boundaries

History reuse is deterministic excerpt selection into a new session, not a
model-written summary or restoration of runtime state. Existing read-only
workspace checks, review fingerprints and queue/session separation remain in
force. The opt-in `DSHC_LIVE_HISTORY=1 pnpm test:live-history` fixture verifies
that a real model re-reads current workspace content and cites the old evidence.
Cross-platform CI and installed-package checks remain required before merging.
