# Release criteria

This file defines release blockers for the first public alpha.

## Required before alpha

### Runtime contract

- official Harness runtime launches from documented setup;
- initialize/prompt/events/idle/shutdown path is covered by integration tests;
- tested upstream version is pinned and documented;
- unsupported protocol/runtime drift fails clearly.

### Terminal correctness

- committed assistant output is not duplicated;
- tool/subagent activity is ordered correctly;
- local UI does not invent prompt/result causality;
- non-TTY mode has predictable stdout/stderr behavior;
- Ctrl+C/EOF/shutdown semantics are documented and tested.

### Security

- untrusted terminal control sequences are sanitized;
- secrets and full environments are excluded from default diagnostics;
- state-changing tool execution is visible;
- no known high-severity command/process cleanup flaw remains.

### Platform support

- Windows is tested as a first-class target;
- Linux is tested;
- macOS is tested where the pinned upstream runtime supports the path;
- filesystem paths, subprocess invocation and terminal behavior do not assume POSIX-only semantics.

### Distribution

- package/binary names finalized;
- fresh installation tested;
- update/uninstall instructions exist;
- license and unofficial affiliation statement are present;
- compatibility matrix is current;
- release notes list known limitations.

## Not required before alpha

- feature parity with the Web UI;
- graceful prompt-level cancellation before upstream supports it;
- every possible model/provider;
- themes/plugins marketplace;
- advanced session browsing;
- complete subagent orchestration UI.
