# GY-3048 documentation review

Reviewed README and every Markdown file under docs, including protocol. Generated indexes (`docs/README.md` and `docs/protocol.md`) were regenerated, not hand-edited. Counts use Python `len(text.split())`, including code and metadata, against synced base `2982438bc640`.

The handwritten set went from **14,347 to 11,727 words (18.3% shorter)**, including the new rendering guide. This report is outside that guide count. Counts include shipped documentation through the current base.

| Reviewed file | Before | After |
| --- | ---: | ---: |
| `README.md` | 277 | 427 |
| `docs/coordination.md` | 683 | 600 |
| `docs/delivery-redesign.md` | 334 | 193 |
| `docs/delivery.md` | 820 | 674 |
| `docs/deployment.md` | 886 | 650 |
| `docs/development.md` | 1192 | 1099 |
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
| `docs/walkthrough.md` | 0 | 370 |

Setup-from-zero is the setup checklist; install owns provider/key steps; onboarding owns fleet setup. Delivery owns trial/revert behavior, deployment owns serving, and sessions owns runtime recovery. Other guides link there. Removed issue narration, the old brief word-count table and references to deleted docs tests. Existing section anchors remain.

Checked live source for dispatch, trial acceptance, supervision and serving: master dispatch accepts eligible system-driven items; control-plane acceptance counts trial proofs rather than producer evidence; the watchdog detects incomplete cycles; the deploy service serves main. Epoch 3 synced merged GY-3047 (`1e80c20737cf`) and replaced the temporary pending-candidate text with implemented changed-cause wakes and the bounded heartbeat. No domain behavior or requirement changed.

## Current validation and rework (epoch 110)

`graphyard sync GY-3048` merged main `2982438bc640` without conflicts. Preserved candidate `537e5fc5e41e` and epoch-18 commit `4065cdef87db` are ancestors. The concise guides, storyboard, regenerated GIF/MP4 and browser-cache setup remain intact. Main's native trial runner and current architecture are unchanged; this round adds no unrelated source changes.

`npm run build`, `npm run docs:check` and `graphyard verify GY-3048` pass. The documentation proof executes its full test file, renders thirteen sample frames, exercises chapters/scrubbing/playback, and fails its base exercise as expected. Verification uses `WALKTHROUGH_BROWSERS_PATH=/home/vish/.cache/ms-playwright`; no dependency install or privileged access was needed.

Reran all twenty test files named in the rework refusal with `npm test --`: **94 passed, 1 failed, none skipped**, including twenty consecutive slow-tick executions. The sole failure is unchanged `tests/graphyard-e2e-serve.test.ts`: its temporary bare-repository initialization cannot migrate Git objects (`Invalid cross-device link`), before the server starts. This ordinary worker boundary failure is outside the documentation changes and is recorded in the commit message. Canonical gates must still verify the actual head; no requirement is waived.

Both committed media assets fully decode with ffmpeg. ffprobe reports H.264 MP4 1200×838 and GIF 800×559, both 120.1 seconds. Visually inspected MP4 at 0, 55, 100 and 116 seconds and the GIF opening: populated first frame, distinct roles, readable captions, independent review and exactly three human decisions. Rendering commands remain in [the rendering guide](../../docs/walkthrough.md).

Self-review after `review self GY-3048`: AC-1 met (roles, independent ownership, failed-check handoff, shipped master wakes and three human decisions); AC-2 met (actual corrected storyboard and rendered assets, readable samples, full decoding and repeatable commands); AC-3 met (all handwritten guides reviewed, operational details and latest main additions preserved, counts refreshed and generated links valid). No blocking finding remains. Canonical exact-head tests/E2E and ordinary checks remain required under normal gates before push.
