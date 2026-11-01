# GY-3048 documentation review

Reviewed README and every Markdown file under docs, including protocol. No docs/history directory exists at base `1eb4f41b9a91`. Generated indexes were regenerated, not hand-edited. Counts use Python `len(text.split())`, including code and metadata.

The existing handwritten set went from **10,971 to 7,961 words (27.4% shorter)**. The new rendering guide adds 308 words. This report is outside that guide count.

| Reviewed file | Before | After |
| --- | ---: | ---: |
| `README.md` | 277 | 417 |
| `docs/README.md` | 167 | 213 |
| `docs/coordination.md` | 447 | 343 |
| `docs/delivery-redesign.md` | 310 | 168 |
| `docs/delivery.md` | 679 | 561 |
| `docs/deployment.md` | 797 | 554 |
| `docs/development.md` | 485 | 392 |
| `docs/glossary.md` | 542 | 510 |
| `docs/how-graphyard-works.md` | 560 | 533 |
| `docs/install.md` | 457 | 369 |
| `docs/master-agent-reference.md` | 303 | 238 |
| `docs/master-agent-sessions.md` | 2019 | 808 |
| `docs/master-agent.md` | 646 | 556 |
| `docs/onboarding.md` | 641 | 448 |
| `docs/operations.md` | 551 | 502 |
| `docs/protocol/work-commands.md` | 615 | 538 |
| `docs/protocol.md` | 44 | 47 |
| `docs/setup-from-zero.md` | 521 | 398 |
| `docs/validation.md` | 1121 | 626 |

Setup-from-zero is the setup checklist; install owns provider/key steps; onboarding owns fleet setup. Delivery owns trial/revert behavior, deployment owns serving, and sessions owns runtime recovery. Other guides link there. Removed issue narration, the old brief word-count table and references to deleted docs tests. Existing section anchors remain.

Checked live source for dispatch, trial acceptance, supervision and serving: master dispatch accepts eligible system-driven items; control-plane acceptance counts trial proofs rather than producer evidence; the watchdog detects incomplete cycles; the deploy service serves main. Source snapshot and pending GY-3047 candidate ca55ddb7c2a7 are explicitly distinguished. No domain behavior or requirement changed.

Validation:

- npm run build passed.
- npm run docs:check passed after regeneration.
- Six related regression files ran 40 cases: 39 passed. The existing unit:executor-trial-runs-criterion-tests case failed outside changed files because this sandbox cannot create `/home/vish/.gy/tmp/gy-*` (EROFS). Retrying the merge-executor file with TMPDIR=/var/tmp hit the same fixed fallback. This is separate from the passing documentation proof.
- graphyard verify GY-3048 passed integration:documentation-validation; the check fails against base. It exercises the actual renderer and browser controls, populated opening and constant frame dimensions.
- MP4: H.264, 1200×838, 120.1 seconds. GIF: 800×559, 416 encoded frames, 120.1 seconds. ffprobe inspected both; ffmpeg decoded both fully without errors.
- Visually inspected MP4 frames at 0, 15, 28, 55, 75, 90, 103 and 116 seconds, plus decoded GIF opening and later failure scene. Captions fit, roles remain distinct and the first frame is populated. Local fonts remove rendering's network dependency.

Reproduce with [the rendering guide](../../docs/walkthrough.md).
