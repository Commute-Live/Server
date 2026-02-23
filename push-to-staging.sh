#!/bin/bash
set -euo pipefail

CURRENT=$(git rev-parse --abbrev-ref HEAD)

if [ "$CURRENT" = "staging" ]; then
    echo "Already on staging — nothing to merge."
    exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
    echo "Uncommitted changes detected. Commit or stash before pushing to staging."
    exit 1
fi

echo "Merging '$CURRENT' into staging..."
git fetch
git checkout staging
git pull origin staging
git merge "$CURRENT" --no-edit
git push origin staging

echo "Done. Returning to '$CURRENT'."
git checkout "$CURRENT"
