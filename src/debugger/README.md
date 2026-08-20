# Session Debugger

M4 debugger consumes normalized Harness events instead of reconstructing hidden reasoning.

Pipeline:

Harness Runtime -> NormalizedEvent -> Debug Inspector -> Terminal View

Supported observations:

- turn failures
- tool failures
- tool activity count
- session event timeline

The debugger only exposes public runtime events.
