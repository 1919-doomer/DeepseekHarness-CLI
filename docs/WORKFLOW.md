# GitHub-first workflow

All project work should follow this loop:

```text
Issue -> branch/implementation -> tests/docs -> Pull Request -> CI/review -> main -> close Issue
```

Architecture changes add/update an ADR. Upstream compatibility changes update `UPSTREAM-COMPATIBILITY.md`. Release-bearing changes update the compatibility matrix and release notes.

Do not keep authoritative project decisions only in chat or local notes.
