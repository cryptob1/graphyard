# Graphyard

Graphyard runs AI coding agents on your repository and takes each goal from a sentence to production. The human keeps three decisions: goals and priorities, money and accounts, and credentials for people. The **master** (AI) decides everything else. The **loop** (plain code) dispatches **workers**, requests spec checks, independent review and proof, and drives the **merge writer**, which trials every change on the latest main before it merges. Main deploys on its own, a failing release is reverted automatically, and every failure goes back to the master.

[![How Graphyard works: a 90-second walkthrough](docs/diagrams/how-graphyard-works.gif)](docs/diagrams/how-graphyard-works.mp4)

## Setup

1. Prepare a Linux host with systemd user services, bubblewrap, Node 24+, Git, the GitHub CLI and Docker Engine with Compose. Clone Graphyard, run `npm ci` and put its `bin/` on your PATH. Run `gh auth login --scopes repo` as an administrator of your repository.
2. In your repository's checkout, install:

   ```sh
   graphyard up --repo OWNER/NAME --provider compose --master claude
   ```

   Use `--provider local` for embedded Postgres instead of Docker, or `--master codex` for Codex. Rerun the same command to resume; `graphyard doctor` prints one PASS or FAIL line per prerequisite.
3. Open the printed Setup link and connect AI coding accounts for the worker and reviewer roles (one account can serve both). Wait until the checklist is green.
4. File a goal in the dashboard's **New work item** form with a title, description, acceptance criteria and required proof names. Watch it move with `graphyard master status`.
5. Update later with `graphyard upgrade --plan`, then `graphyard upgrade`.

## Help

- `graphyard guide` lists the procedures agents follow; `graphyard guide TOPIC` prints one.
- `graphyard master guide` prints the master's complete operating loop.
- `graphyard --help` lists every command. Contributors read [AGENTS.md](AGENTS.md).

## The walkthrough video

The video is rendered from `scripts/walkthrough/how-graphyard-works.html`. After editing it, with Playwright Chromium, ffmpeg and uv installed:

```sh
frames=$(mktemp -d)
node scripts/walkthrough/render.mjs "$PWD/scripts/walkthrough/how-graphyard-works.html" "$frames" 10
ffmpeg -y -framerate 10 -i "$frames/f%05d.png" -vf scale=1200:-2:flags=lanczos,format=yuv420p -c:v libx264 -crf 24 -preset slow -movflags +faststart docs/diagrams/how-graphyard-works.mp4
uv run --no-project --with pillow python -I scripts/walkthrough/makegif.py "$frames" 10 800 docs/diagrams/how-graphyard-works.gif
```

Licence: [Apache 2.0](LICENSE).
