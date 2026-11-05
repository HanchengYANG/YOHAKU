# Processing diagnostics

Goal: when a reading page stops preparing, identify its blocking source and step, distinguish queued/running/failed states, and retain a safe failure record after retry.

Scope:

- Classify API failures using status, SDK error types, timeout/cancellation signals and known network codes. Keep unknown causes explicit. Never persist raw SDK messages, headers, bodies, prompts, URLs, keys or stacks.
- Give source AI calls a stable operation ID and queue/start/completion timing. Preserve configured roles, provider limits and retry behavior.
- Persist per-source step attempts separately from existing source-step results. Keep failures after successful retry and restart; mark interrupted attempts accurately.
- Return `diagnostics.current` and up to five article failures with source labels, step, execution metadata and safe diagnostic fields. Keep existing preparation percentages and page readiness unchanged.
- Show accurate status and a collapsed details/history view in the reader, including after recovery. Older responses and records remain readable.

Implementation ownership:

1. Provider classification, source execution lifecycle and associated tests.
2. Source processing lifecycle, persistence, source/page API projection and tests.
3. Reader rendering, status/details/history presentation and desktop/mobile checks.
4. Root integration review, full tests/build and GUI acceptance.

Verification:

- [x] Observe failing regression tests before each implementation.
- [x] Test HTTP errors, invalid JSON/response, incomplete output, timeout versus cancellation and known network failures; prove sensitive exception data is excluded.
- [x] Test queued/running transitions, precise blocking source, restart recovery, retry history, source version protection and prefetch isolation.
- [x] Test failure is not displayed as running, timing and source details, legacy responses, recovered-page history, desktop and phone.
- [x] Run complete Node suite, production build and appropriate browser suite.
- [x] Inspect the real project through GUI and save visible evidence. Do not modify saved roles or fabricate a failure in the user's real account.

Acceptance evidence:

- Full Node suite: 540/540, no skips (`artifacts/processing-diagnostics-node-final.log`). The final PDF blocker guard was then verified with the complete sources suite: 64/64 (`artifacts/processing-diagnostics-sources-final.log`).
- Production build: exit 0 (`artifacts/processing-diagnostics-build-final.log`); `git diff --check` passed.
- Source browser suite: 52/52 (`artifacts/reading-diagnostics-browser-full.log`); final timing/static-progress changes: 6/6 desktop and phone (`artifacts/reading-diagnostics-browser-green.log`).
- CUA on the project's production UI with an isolated mock API: queued/running/failure, safe details, retry auto-load and retained history confirmed. Screenshots: `artifacts/processing-diagnostics-gui-failed.jpg` and `artifacts/processing-diagnostics-gui-recovered.jpg`. Simulated HTTP 503 is test evidence, not a claim about the user's earlier failure.
- The isolated visual server was stopped after verification; real documents and saved role choices were not changed by these diagnostics tests.
- Independent read-only code review found no blocking issues in diagnostic safety, status/source selection, version protection or retained history.
