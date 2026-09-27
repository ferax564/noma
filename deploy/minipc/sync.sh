#!/usr/bin/env bash
# Two-way sync between each project's wiki/ directory and its Noma Cloud space.
#
# For every line of projects.conf:
#   1. keep a clone under $NOMA_DOGFOOD_HOME/repos/<name> on a local branch (noma-wiki-sync-<name>),
#   2. commit any wiki edits pulled on the previous run, merge the upstream branch,
#   3. create the space if needed (by key) and run `noma cloud sync --state`, so the
#      files carry no sync keys and upstream merges stay clean,
#   4. commit what the wiki changed; with NOMA_DOGFOOD_PUSH=1 push the branch so the
#      edits can be reviewed as a pull request.
# Conflicts (edited in Git and in the wiki since the last run) are left as
# <page>.noma.conflict next to the page and make the script exit 1.
# Run it from cron every 15 minutes (see README.md); a lock prevents overlapping runs.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "$here/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$here/.env"
  set +a
fi
conf="${NOMA_DOGFOOD_PROJECTS:-$here/projects.conf}"
home="${NOMA_DOGFOOD_HOME:-$HOME/.local/share/noma-dogfood}"
branch_prefix="${NOMA_DOGFOOD_BRANCH:-noma-wiki-sync}"
push="${NOMA_DOGFOOD_PUSH:-0}"
only="${1:-}"

[[ -f "$conf" ]] || { echo "error: $conf is missing (copy projects.conf.example)" >&2; exit 2; }
[[ -s "$here/secrets/sync-token" ]] || { echo "error: secrets/sync-token is missing (README.md, First run)" >&2; exit 2; }
mkdir -p "$home/repos" "$home/state"
exec 9>"$home/sync.lock"
flock -n 9 || { echo "another sync is running"; exit 0; }

git_identity=(-c "user.name=${NOMA_DOGFOOD_GIT_NAME:-$(git config --global user.name || echo 'Noma wiki sync')}"
              -c "user.email=${NOMA_DOGFOOD_GIT_EMAIL:-$(git config --global user.email || echo 'noma-wiki-sync@localhost')}")

# The CLI runs inside the noma-cloud image by default. NOMA_DOGFOOD_CLI (e.g. "npx noma")
# runs it on the host instead, against NOMA_CLOUD_URL (default: the loopback port).
if [[ -n "${NOMA_DOGFOOD_CLI:-}" ]]; then
  root="$home"
  noma() {
    NOMA_CLOUD_URL="${NOMA_CLOUD_URL:-http://127.0.0.1:${NOMA_PUBLISH_PORT:-8140}}" \
    NOMA_CLOUD_TOKEN="$(cat "$here/secrets/sync-token")" \
    NOMA_CLOUD_ACCESS_TOKEN="$(cat "$here/secrets/access-token")" \
      $NOMA_DOGFOOD_CLI "$@"
  }
else
  root="/dogfood"
  noma() {
    docker compose -f "$here/compose.yaml" run --rm --no-deps -T \
      --user "$(id -u):$(id -g)" \
      -v "$home:/dogfood" \
      -e NOMA_CLOUD_URL=http://noma-cloud:3000 \
      -e NOMA_CLOUD_TOKEN="$(cat "$here/secrets/sync-token")" \
      -e NOMA_CLOUD_ACCESS_TOKEN="$(cat "$here/secrets/access-token")" \
      --entrypoint node noma-cloud dist/cli.js "$@"
  }
fi

commit_wiki() {
  local repo="$1" wiki="$2" message="$3"
  [[ -d "$repo/$wiki" ]] || return 0
  git -C "$repo" add -A -- "$wiki"
  git -C "$repo" diff --cached --quiet && return 0
  git -C "$repo" "${git_identity[@]}" commit -q -m "$message"
  echo "  committed: $message"
}

failures=0
while read -r name key url branch wiki title; do
  [[ -z "${name:-}" || "$name" == \#* ]] && continue
  [[ -n "$only" && "$only" != "$name" ]] && continue
  echo "== $name ($key) ← $url $branch:$wiki"
  repo="$home/repos/$name"
  branch_local="$branch_prefix-$name"
  if [[ ! -d "$repo/.git" ]]; then
    git clone -q --branch "$branch" "$url" "$repo"
    git -C "$repo" checkout -q -b "$branch_local"
    echo '*.noma.conflict' >> "$repo/.git/info/exclude"
  fi
  git -C "$repo" checkout -q "$branch_local"
  commit_wiki "$repo" "$wiki" "docs(wiki): sync with Noma Cloud"
  git -C "$repo" fetch -q origin "$branch"
  if ! git -C "$repo" "${git_identity[@]}" merge -q --no-edit "origin/$branch" >/dev/null; then
    git -C "$repo" merge --abort || true
    echo "  error: origin/$branch does not merge into $branch_local; resolve in $repo" >&2
    failures=$((failures + 1))
    continue
  fi
  if [[ ! -d "$repo/$wiki" ]]; then
    echo "  skipped: no $wiki/ directory on $branch yet"
    continue
  fi
  site="$(noma cloud create-space --title "$title" --key "$key" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')"
  [[ -n "$site" ]] || { echo "  error: could not create or find space $key" >&2; failures=$((failures + 1)); continue; }
  if ! noma cloud sync --site "$site" --dir "$root/repos/$name/$wiki" --state "$root/state/$name.json"; then
    echo "  conflicts: see $repo/$wiki/**/*.noma.conflict" >&2
    failures=$((failures + 1))
  fi
  commit_wiki "$repo" "$wiki" "docs(wiki): sync with Noma Cloud"
  if [[ "$push" == 1 ]] && [[ -n "$(git -C "$repo" log --oneline "origin/$branch..$branch_local" -- "$wiki")" ]] \
     && [[ "$(git -C "$repo" rev-parse "$branch_local")" != "$(git -C "$repo" rev-parse -q --verify "refs/remotes/origin/$branch_local" || true)" ]]; then
    git -C "$repo" push -q origin "$branch_local" && echo "  pushed $branch_local (open a pull request to $branch)"
  fi
done < "$conf"

exit $((failures > 0 ? 1 : 0))
