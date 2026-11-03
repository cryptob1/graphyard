# GY-3048 documentation review

Reviewed README and every Markdown file under docs, including protocol. Generated indexes (`docs/README.md` and `docs/protocol.md`) were regenerated, not hand-edited. Counts use Python `len(text.split())`, including code and metadata, against synced base `73ca5f5cb1aa`.

The handwritten set went from **13,930 to 11,291 words (18.9% shorter)**, including the new rendering guide. This report is outside that guide count. Counts include shipped documentation through the current base.

| Reviewed file | Before | After |
| --- | ---: | ---: |
| `README.md` | 277 | 427 |
| `docs/coordination.md` | 683 | 600 |
| `docs/delivery-redesign.md` | 334 | 193 |
| `docs/delivery.md` | 820 | 674 |
| `docs/deployment.md` | 886 | 650 |
| `docs/development.md` | 775 | 682 |
| `docs/glossary.md` | 542 | 510 |
| `docs/how-graphyard-works.md` | 545 | 540 |
| `docs/install.md` | 469 | 382 |
| `docs/master-agent-reference.md` | 668 | 561 |
| `docs/master-agent-sessions.md` | 3102 | 2017 |
| `docs/master-agent.md` | 1103 | 907 |
| `docs/onboarding.md` | 641 | 448 |
| `docs/operations.md` | 541 | 494 |
| `docs/protocol/work-commands.md` | 696 | 619 |
| `docs/setup-from-zero.md` | 521 | 398 |
| `docs/validation.md` | 1327 | 838 |
| `docs/walkthrough.md` | 0 | 351 |

Setup-from-zero is the setup checklist; install owns provider/key steps; onboarding owns fleet setup. Delivery owns trial/revert behavior, deployment owns serving, and sessions owns runtime recovery. Other guides link there. Removed issue narration, the old brief word-count table and references to deleted docs tests. Existing section anchors remain.

Checked live source for dispatch, trial acceptance, supervision and serving: master dispatch accepts eligible system-driven items; control-plane acceptance counts trial proofs rather than producer evidence; the watchdog detects incomplete cycles; the deploy service serves main. Epoch 3 synced merged GY-3047 (`1e80c20737cf`) and replaced the temporary pending-candidate text with implemented changed-cause wakes and the bounded heartbeat. No domain behavior or requirement changed.

## Current validation and rework (epoch 34)

The saved epoch-18 head `4065cdef87db` was already HEAD; no cherry-pick was needed. `graphyard sync GY-3048` confirms the branch contains base `73ca5f5cb1aa`. Earlier reconciliation retains shipped reviewer tokens, the continuing master conversation, the E2E rule and filesystem isolation.

The trial refusal named twenty test files. Reproducing it found two defects in this change:

- The rewrite omitted the automatic reviewer's concurrency. Restored `run.reviewerProfile`'s four-session default, explicit overrides and other profiles' one-session default. Its existing documentation check passes.
- The documentation proof and renderer looked for Chromium in the private trial's empty cache. They now select the locked browser at `/opt/graphyard-browsers` inside the trial image, before importing Playwright. Host rendering still uses Playwright's configured cache; the rendering guide explains setup. No browser download or host-home mount is added to trials.

Also corrected the trial-cache summary and documented the renderer's image browser. No runtime gate or requirement changed.

Validation in this attempt:

- `npm run build` and `npm run docs:check` passed.
- The documentation proof passes with the host's installed Chromium, rendering thirteen sample frames and exercising chapters, scrubbing and playback. Its base exercise fails as expected.
- Reran all nineteen other files named in the trial refusal: sixteen files passed, including the twenty consecutive slow-tick executions. The remaining failures are outside changed code: automatic reviewer launches see ancestor Claude settings under an untrusted scratch HOME; submit-head fixtures cannot migrate Git objects (`Invalid cross-device link`); the filesystem-isolation E2E session ends before its command. The reviewer documentation assertion from that run is now fixed and passes separately. These sandbox failures are named in the commit messages; CI retains the full-suite gate.
- Both committed assets fully decode with ffmpeg. ffprobe confirms H.264 MP4 1200×838 and GIF 800×559, both 120.1 seconds. Inspected MP4 at 0, 55, 100 and 116 seconds, and GIF opening and failure-handoff frames: readable captions, distinct roles, populated opening, independent review and exactly three human decisions. The media from the earlier attempt remains unchanged because this rework changes browser selection and operational prose only.

Reproduce with [the rendering guide](../../docs/walkthrough.md).

Self-review: AC-1 met (roles, independent ownership, concrete failed-check handoff, shipped master wakes and three human decisions); AC-2 met (corrected storyboard and regenerated assets retained, readable samples, decoding and repeatable rendering); AC-3 met (all handwritten guides reviewed, operational details preserved, counts refreshed and generated links valid). No blocking finding remains.
