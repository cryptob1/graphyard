# GY-3048 documentation review

Reviewed README and every Markdown file under docs, including protocol. Generated indexes (`docs/README.md` and `docs/protocol.md`) were regenerated, not hand-edited. Counts use Python `len(text.split())`, including code and metadata, against synced base `1e80c20737cf`.

The handwritten set went from **11,378 to 8,626 words (24.2% shorter)**, including the new rendering guide. This report is outside that guide count. The earlier attempt's counts used its older base; these counts include the merged wake and runtime-isolation documentation.

| Reviewed file | Before | After |
| --- | ---: | ---: |
| `README.md` | 277 | 427 |
| `docs/coordination.md` | 447 | 339 |
| `docs/delivery-redesign.md` | 310 | 168 |
| `docs/delivery.md` | 679 | 561 |
| `docs/deployment.md` | 797 | 554 |
| `docs/development.md` | 698 | 605 |
| `docs/glossary.md` | 542 | 510 |
| `docs/how-graphyard-works.md` | 560 | 545 |
| `docs/install.md` | 457 | 369 |
| `docs/master-agent-reference.md` | 303 | 238 |
| `docs/master-agent-sessions.md` | 2019 | 808 |
| `docs/master-agent.md` | 840 | 674 |
| `docs/onboarding.md` | 641 | 448 |
| `docs/operations.md` | 551 | 502 |
| `docs/protocol/work-commands.md` | 615 | 538 |
| `docs/setup-from-zero.md` | 521 | 398 |
| `docs/validation.md` | 1121 | 626 |
| `docs/walkthrough.md` | 0 | 316 |

Setup-from-zero is the setup checklist; install owns provider/key steps; onboarding owns fleet setup. Delivery owns trial/revert behavior, deployment owns serving, and sessions owns runtime recovery. Other guides link there. Removed issue narration, the old brief word-count table and references to deleted docs tests. Existing section anchors remain.

Checked live source for dispatch, trial acceptance, supervision and serving: master dispatch accepts eligible system-driven items; control-plane acceptance counts trial proofs rather than producer evidence; the watchdog detects incomplete cycles; the deploy service serves main. Epoch 3 synced merged GY-3047 (`1e80c20737cf`) and replaced the temporary pending-candidate text with implemented changed-cause wakes and the bounded heartbeat. No domain behavior or requirement changed.

Validation:

- npm run build passed.
- npm run docs:check passed after regeneration.
- Six related regression files ran 40 cases: 39 passed. The existing unit:executor-trial-runs-criterion-tests case failed outside changed files because this sandbox cannot create `/home/vish/.gy/tmp/gy-*` (EROFS). Retrying the merge-executor file with TMPDIR=/var/tmp hit the same fixed fallback. This is separate from the passing documentation proof.
- graphyard verify GY-3048 passed integration:documentation-validation; the check fails against base. It exercises the actual renderer and browser controls, populated opening and constant frame dimensions.
- MP4: H.264, 1200×838, 120.1 seconds. GIF: 800×559, 416 encoded frames, 120.1 seconds. ffprobe inspected both; ffmpeg decoded both fully without errors.
- Visually inspected MP4 frames at 0, 15, 28, 55, 75, 90, 103 and 116 seconds, plus decoded GIF opening and later failure scene. Captions fit, roles remain distinct and the first frame is populated. Local fonts remove rendering's network dependency.

Reproduce with [the rendering guide](../../docs/walkthrough.md).
