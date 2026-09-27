# Noma Cloud on the minipc (dogfooding)

Runs Noma Cloud on one home server with Docker Compose, reachable only over the
tailnet, with one space per project. Each space is fed from the project's `wiki/`
directory in Git and synced both ways, so the wiki and the repository stay the
same `.noma` source.

```
 GitHub repos (wiki/*.noma)                      minipc
 ┌───────────────────────┐   git fetch/merge   ┌──────────────────────────────────────────┐
 │ noma     wiki/        │ ◄────────────────── │ sync.sh (cron, every 15 min)             │
 │ ezkeel   wiki/        │   push branch       │   ~/.local/share/noma-dogfood/repos/<p>  │
 │          workspace/   │   noma-wiki-sync-*  │   noma cloud sync --state state/<p>.json │
 │ Stratos  wiki/        │ ──────────────────► │              │ HTTP (compose network)     │
 │ OrgFlow  wiki/        │   (opt-in, → PR)    │              ▼                            │
 └───────────────────────┘                     │ noma-cloud container  :3000               │
                                               │   volume noma-data → /data/noma (SQLite)  │
                                               │   127.0.0.1:8140 ◄── tailscale serve 8444 │
                                               └──────────────────────────────────────────┘
```

| File | What it does |
|------|--------------|
| `compose.yaml` | The `noma-cloud` service, built from this repo's `Dockerfile`; data in the `noma-data` volume; loopback-only port |
| `install.sh` | Install or update: secrets, `.env`, build, start, wait for `/healthz`; `--tailscale` publishes HTTPS on the tailnet |
| `sync.sh` | Two-way sync of every project in `projects.conf` with its space |
| `backup.sh` | Online SQLite snapshot + documents/blobs tarball, keeps the newest 14 |
| `github-runner.sh` | Registers the minipc as a self-hosted GitHub Actions runner for a private repo |
| `.env.example`, `projects.conf.example` | Templates; the real files are local and ignored by Git |

## Install

On the minipc, as the user that owns the other app checkouts:

```bash
git clone git@github.com:ferax564/noma.git ~/noma && cd ~/noma
deploy/minipc/install.sh --tailscale
```

`install.sh` stops if two Docker engines are running and the CLI is talking to the
wrong one (the apt/snap race described in Stratos's `docs/DEPLOY.md`). Restart the
apt engine's socket, or set `NOMA_DOCKER_ENGINE=snap` if Noma should live there.

The server runs with `NODE_ENV=production`, so it requires the access token and
the invitation code (both generated into `deploy/minipc/secrets/`, mode 600). Only
tailnet devices can reach it (`tailscale serve`, not `funnel`); cookies are `Secure`,
which works because `tailscale serve` terminates HTTPS.

## First run

1. Open the URL printed by `install.sh` with `?access=<secrets/access-token>` once
   (the browser keeps a cookie), and register the owner with `secrets/invitation-code`.
2. Read the owner id and make it the admin:
   ```bash
   # in the browser devtools console, or with the session's bearer token
   fetch('/api/users/me').then(r => r.json()).then(u => console.log(u.id))
   ```
   Put it in `NOMA_CLOUD_ADMIN_USER_IDS` in `deploy/minipc/.env` and re-run `install.sh`.
3. Create a personal access token for the sync (Settings → Tokens, scopes read + write,
   or `POST /api/tokens {"name":"minipc wiki sync","scopes":["read","write"],"expiresInDays":365}`)
   and save it:
   ```bash
   umask 077 && printf '%s' '<token>' > deploy/minipc/secrets/sync-token
   ```
4. Run the first sync. It clones each repo, creates the space by key, and uploads the pages:
   ```bash
   deploy/minipc/sync.sh            # all projects
   deploy/minipc/sync.sh stratos    # one project
   ```
5. Schedule sync and backups (`crontab -e`):
   ```cron
   */15 * * * * $HOME/noma/deploy/minipc/sync.sh >> $HOME/.local/share/noma-dogfood/sync.log 2>&1
   17 3 * * *   $HOME/noma/deploy/minipc/backup.sh >> $HOME/.local/share/noma-dogfood/backup.log 2>&1
   ```

The sync clones need Git access to every repo in `projects.conf` (the minipc already
clones Stratos over SSH; use the same key or per-repo deploy keys). Set
`NOMA_DOGFOOD_PUSH=1` in `.env` once those keys can push.

## How the wiki sync works

- A project's `wiki/<name>.noma` is the space home; `wiki/<name>/*.noma` are its child
  pages (a directory is the children of the page with the same name).
- `noma cloud sync --state <file>` keeps the sync keys (page id, last synced hash,
  parent, labels) in `~/.local/share/noma-dogfood/state/<project>.json`, so the files in
  the clone are exactly the page sources and upstream merges stay conflict-free.
- Each run, per project: commit wiki edits pulled last time → merge `origin/<branch>`
  into the local `noma-wiki-sync-<project>` branch → sync → commit what the wiki
  changed. With `NOMA_DOGFOOD_PUSH=1` the branch is pushed; open a pull request from
  it. Once merged, the next merge brings the same content and nothing changes.
- A page edited both in Git and in the wiki since the last run is a conflict: the
  server version is written next to it as `<page>.noma.conflict` (ignored by Git) and
  the script exits 1. Merge the two by hand in the clone, then re-run; the sync pushes
  the result with the server hash as base.
- New pages, renames, moves, and deletes are mirrored both ways (`docs/noma-cloud.noma`,
  "Git-native spaces"): a file deleted in Git trashes its page, a page trashed in the
  wiki deletes its file, and a rename in Git keeps the page's ID and history. A change
  is never mirrored over an edit: a deleted file whose page was edited in the wiki
  comes back (`restored`), and an edited file whose page was trashed stays
  (`remote_missing`).

## Update

```bash
cd ~/noma && git pull --ff-only && deploy/minipc/install.sh
```

The container restarts; sessions and data survive (they are in the volume).

## Backup and restore

`backup.sh` uses SQLite's online backup API, so it is consistent while the server
writes. It keeps the newest `NOMA_BACKUP_KEEP` (14) archives in `NOMA_BACKUP_DIR`
(`~/backups/noma`). Copy that directory off the box (the secrets in
`deploy/minipc/secrets/` are backed up separately, not in the archive).

Restore into the volume:

```bash
docker compose -f deploy/minipc/compose.yaml down
docker run --rm -v noma_noma-data:/data/noma -v ~/backups/noma:/backup alpine \
  sh -c 'rm -rf /data/noma/* && tar -xzf /backup/<archive>.tar.gz -C /data/noma'
deploy/minipc/install.sh
```

## Checks

```bash
curl -s http://127.0.0.1:8140/healthz                       # {"ok":true,"storage":"sqlite",...}
docker compose -f deploy/minipc/compose.yaml ps              # healthy
tailscale serve status                                       # :8444 → 127.0.0.1:8140
tail -n 30 ~/.local/share/noma-dogfood/sync.log              # last sync: no conflicts
```

## GitHub and Slack webhooks

The box is tailnet-only, but GitHub (PR and CI events → Work issues and project
threads) and Slack (the two-way bridge) must reach `POST /api/hooks/…`. Expose only
those paths through the minipc's Cloudflare tunnel with
`cloudflared-hooks.example.yml`: one hostname whose path rule admits
`/api/hooks/github/<projectId>` and `/api/hooks/slack`, and `404` for everything
else. The hooks are authenticated by their own secrets, not by the access token.
Then link a repository in the project's settings and give GitHub the webhook URL
`https://noma-hooks.<your-domain>/api/hooks/github/<projectId>` with the secret Noma
shows.

## GitHub Actions runner for private repositories

GitHub-hosted minutes for private repositories are used up, so CI for the private
repos (EZKeel, Stratos) runs on the minipc. Their workflows ask for
`runs-on: [self-hosted, linux, minipc]` unless the repository variable `CI_RUNS_ON`
overrides it (set it to `"ubuntu-latest"` to go back to hosted runners). Public repos
(Noma, OrgFlow) stay on GitHub-hosted runners, which are free for public repositories
and also cover macOS.

```bash
# per repository: Settings → Actions → Runners → New self-hosted runner → copy the token
sudo deploy/minipc/github-runner.sh ferax564/ezkeel  <token> 2
sudo deploy/minipc/github-runner.sh ferax564/Stratos <token> 2
systemctl list-units 'actions.runner.*'
```

- Never register it for a public repository: fork pull requests would run their code
  on this machine. The script refuses repos the GitHub API reports as public.
- Runners run as `gh-runner` under systemd, in `/srv/gh-runner/<repo>-<n>`. The user is
  in the `docker` group because the EZKeel tests start containers; that is
  root-equivalent, which is acceptable only because every job comes from a private repo.
- The script installs build tools, `jq`, `gh`, and Playwright's browser libraries once;
  workflows skip `playwright install --with-deps` on self-hosted runners.
- Jobs use whichever Docker engine owns `/var/run/docker.sock`. With the two-engine
  problem unresolved, a reboot can move CI containers to the other engine.
- Upgrade or remove: `cd /srv/gh-runner/<repo>-<n> && sudo ./svc.sh stop && sudo ./svc.sh uninstall`,
  then `sudo -u gh-runner ./config.sh remove --token <removal-token>`.

## `/deploy` and `/test` from Chat

They run on EZKeel: set `NOMA_CLOUD_EZKEEL_URL` and a token file
(`NOMA_CLOUD_EZKEEL_TOKEN_FILE`, see `.env.example`) and re-run `install.sh`. Use a
dedicated EZKeel account on a tier that allows several apps, because each preview and
each test run is an app. Runs happen on that account's servers, not on the minipc.

To run them on the minipc itself, the EZKeel control plane has to reach it over SSH.
A self-hosted control plane that is on the tailnet can register the minipc as a BYOV
server once its operator sets `EZKEEL_BYOV_ALLOWED_CIDRS` (e.g. `100.64.0.0/10`).
Never set that on the shared multi-tenant control plane.
