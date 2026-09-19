#!/bin/sh
# Cut a release: version bump, tag, push.
#
# Usage: scripts/release.sh <patch|minor|major> [--dry-run|--yes]
#
# - Bumps version in package.json
# - Commits, tags v<ver>, pushes main + tag
# - The CI workflow auto-publishes to npm on the tag push
#
# Pushes via the gh-credential URL recipe (plain `git push origin` fails
# under some gh-auth setups).

set -eu

SCRIPT_DIR=$( # shellcheck disable=SC1007
  CDPATH= cd -- "$(dirname -- "$0")" && pwd
)
ROOT="$SCRIPT_DIR/.."
REPO_URL="https://github.com/georgeharker/pi-permissions-analyzer"

# ── args ────────────────────────────────────────────────────────────────────

BUMP="${1:-patch}"
shift 2>/dev/null || shift $# 2>/dev/null || true
DRY_RUN=0
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
  --dry-run) DRY_RUN=1 ;;
  --yes | -y) ASSUME_YES=1 ;;
  *)
    echo "unknown flag: $arg" >&2
    exit 2
    ;;
  esac
done

case "$BUMP" in
patch | minor | major) ;;
*)
  echo "usage: scripts/release.sh <patch|minor|major> [--dry-run|--yes]" >&2
  exit 2
  ;;
esac

# ── helpers ─────────────────────────────────────────────────────────────────

json_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$1" | head -1; }

bump_version() { # $1=version $2=patch|minor|major
  v_major=$(echo "$1" | cut -d. -f1)
  v_minor=$(echo "$1" | cut -d. -f2)
  v_patch=$(echo "$1" | cut -d. -f3)
  case "$2" in
  major) echo "$((v_major + 1)).0.0" ;;
  minor) echo "${v_major}.$((v_minor + 1)).0" ;;
  patch) echo "${v_major}.${v_minor}.$((v_patch + 1))" ;;
  esac
}

# ── plan ────────────────────────────────────────────────────────────────────

VERSION_NOW=$(json_version "$ROOT/package.json")
VERSION_NEW=$(bump_version "$VERSION_NOW" "$BUMP")

echo "Release plan ($BUMP):"
echo "  $VERSION_NOW -> $VERSION_NEW   tag v$VERSION_NEW"

# ── preflight ───────────────────────────────────────────────────────────────

cd "$ROOT"
if git status --porcelain | grep -qv '^??'; then
  echo "ERROR: uncommitted changes — commit or stash first." >&2
  exit 1
fi
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != main ]; then
  echo "ERROR: on branch '$BRANCH' — cut releases from main." >&2
  exit 1
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "dry run — no changes made."
  exit 0
fi

if [ "$ASSUME_YES" != 1 ]; then
  printf "Proceed? [y/N] "
  read -r ANSWER
  case "$ANSWER" in
  y | Y | yes | YES) ;;
  *)
    echo "aborted."
    exit 1
    ;;
  esac
fi

# ── cut ─────────────────────────────────────────────────────────────────────

sed -i '' "s/\"version\": \"$VERSION_NOW\"/\"version\": \"$VERSION_NEW\"/" package.json
git add package.json
git commit -m "chore(release): $VERSION_NEW" >/dev/null
git tag -a "v$VERSION_NEW" -m "Release $VERSION_NEW"
echo "cut v$VERSION_NEW"

# ── push ────────────────────────────────────────────────────────────────────

echo "pushing main + v$VERSION_NEW"
env -u GH_TOKEN git -c credential.helper='!gh auth git-credential' \
  push "$REPO_URL" main "v$VERSION_NEW"
echo ""
echo "Pushed v$VERSION_NEW. CI will auto-publish to npm."
echo "Watch: gh run list --limit 4"
