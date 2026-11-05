# Hybrid Ruby Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Execute continuously; the user explicitly requested project integration and a real-account PDF test.

**Goal:** After body correction and segmentation, generate ruby locally and ask the configured annotation role to return only corrections, preserving canonical text, manual/source readings and page/source mappings.

**Architecture:** A local JSON-lines Python worker provides UTF-16-addressed Han readings. A pure HTML annotation service prepares serializable local candidates, then checks a reading page in one LLM batch. The source scheduler persists local preparation independently and commits each source range only when its version and edit lock still match.

**Tech Stack:** Node.js, SQLite source steps, pyopenjtalk-plus, SudachiPy/core, existing provider queues and canonical HTML helpers.

---

### Task 1: Local runtime

Files: `server/ocr/ruby.mjs`, `server/ocr/ruby-worker.py`, `scripts/ruby-requirements.txt`, `scripts/install-document-runtime.sh`, `tests/local-ruby.test.mjs`.

- [x] Verify failing tests for input preservation, supplementary Han offsets, missing/alignment failures, close and worker restart.
- [x] Implement `createLocalRuby().annotate(text)` returning `{annotations:[{start,end,surface,reading}],engine,versions,elapsedMs}`. Offsets use JavaScript UTF-16.
- [x] Install pinned dependencies into `.venv-documents`; inference uses local files and no provider authorization.
- [x] Run `node --test tests/local-ruby.test.mjs` and a real local worker check.

### Task 2: Hybrid HTML annotation

Files: `server/ai/hybrid-annotation.mjs`, `tests/hybrid-annotation.test.mjs`.

- [x] Verify failing tests for sparse correction, missing readings, protected readings, full context, multiple source items, Unicode, malformed IDs and unchanged text/marks.
- [x] Implement `prepareBodies(items)` with serializable items, `proofreadPrepared(userId,{prepared,context,priority})` and `annotateBodies(userId,{items,context,priority})`.
- [x] Send corrected text with inline `[id|Han|candidate]` annotations; accept only `changes` and `uncertain`. Keep position mapping server-side.
- [x] Run `node --test tests/hybrid-annotation.test.mjs`.

### Task 3: Provider and source integration

Files: `server/ai/routes.mjs`, `server/ai/source-processing.mjs`, `server/app.mjs`, `server/sources.mjs`, relevant role/source workflow tests.

- [x] Verify failing tests for injected hybrid source handling, configured provider/model/explicit reasoning, page-level batching, stale results, cached retry and re-entry reuse.
- [x] Expose `prepareAnnotationBodies`, `proofreadAnnotationBodies` and `annotateBodies` on the internal AI service; keep legacy image tasks on their existing flow.
- [x] For hybrid proofreading only, when reasoning is unspecified and the selected model advertises `none`, use that supported fast request setting; preserve explicit role reasoning and record the effective setting. Never switch provider on failure.
- [x] Persist each range's local preparation before LLM proofreading. A reading page spanning multiple sources uses one batch; save valid source ranges independently.
- [x] Preserve progress/automatic display, background completion after leaving, independent-article parallelism and existing provider queue limits.
- [x] Run targeted tests, then `npm test` and `npm run build`; browser checks cover reading progress and source editing.

### Task 4: Real project acceptance

Files: ignored artifacts under `artifacts/hybrid-project-acceptance/`, README/runtime documentation.

- [x] Use the current owner's configured roles and the fixture scanned PDF, through the project API and reader UI.
- [x] Prepare an unprocessed chapter, inspect source steps for body correction → segmentation → persisted local ruby → one page proofreading call.
- [x] Confirm current-page completion automatically reveals text, leaving does not interrupt the requested page, and re-entry reuses results.
- [x] Check body text, manual readings, source IDs and existing QA records remain intact; report actual timings and remaining limits.

No commits, deployment or role-configuration mutation are requested.


### Acceptance follow-up: PDF sentence continuation

- [x] Keep an unfinished final AI sentence out of newly published pages while later sources are unprepared.
- [x] Carry that unpublished sentence into the next segmentation batch without guessing from punctuation; preserve published pages and release the final sentence at end of article.
- [x] Verify the PDF 15–20 page-boundary reproduction, punctuation-free endings, cached ruby and QA protection, then rerun relevant and full tests.


Final verification: 511/511 Node tests passed with no skips; 46/46 desktop/mobile browser checks passed; production build and diff whitespace checks passed. Live account: hyang, saved role configuration version 3 unchanged. Fixture SHA-256: d0418ccae2a3a6b464ffb6c3b9423b526e8ed0298dec79332b42a286f9cd981c. Live reading-page checks: 6 PDF sources / 994 UTF-16 chars / 465 ms local + 406 ms model execution; 4 sources / 753 chars / 1234 ms local + 412 ms model execution. Times exclude correction, segmentation and provider queue wait. Saved output and source-step/page hashes remain identical after leaving and reopening the completed page. Evidence: artifacts/hybrid-project-acceptance/.
