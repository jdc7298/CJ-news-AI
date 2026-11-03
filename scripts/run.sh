#!/usr/bin/env bash
# Runs the updater once, or repeatedly for LOOP_MINUTES (used on election night for ~1-minute refreshes).
set -u
LOOP_MINUTES="${LOOP_MINUTES:-0}"
INTERVAL="${INTERVAL_SECONDS:-60}"
BRANCH="${GITHUB_REF_NAME:-main}"

git config user.name "midterm-desk-bot"
git config user.email "midterm-desk-bot@users.noreply.github.com"

publish() {
  node scripts/update.mjs || echo "updater reported an error (continuing)"
  git add data
  if ! git diff --cached --quiet; then
    git commit -q -m "data: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    for _ in 1 2 3; do
      git pull --rebase -q origin "$BRANCH" && git push -q origin "HEAD:$BRANCH" && break
      sleep 3
    done
  fi
}

if [ "$LOOP_MINUTES" -le 0 ]; then
  publish
  exit 0
fi

END=$(( $(date +%s) + LOOP_MINUTES * 60 ))
while [ "$(date +%s)" -lt "$END" ]; do
  publish
  sleep "$INTERVAL"
done
