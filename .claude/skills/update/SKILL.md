---
name: update
description: >
  Restart Max services and rebuild the macOS app. Smart branch handling: pulls from main by default, restarts in-place on feature branches, or switches to a specified branch. Pass --pull to force-pull on the current branch.
---

# Update - Restart Max (with Smart Branch Handling)

Restart Max services and rebuild the macOS app with branch-aware git behavior.

## Arguments

The user may pass `$ARGUMENTS` to control branch behavior:

| Invocation | Behavior |
|---|---|
| `/update` (no args, on `main`) | Pull latest from `origin/main` (default) |
| `/update` (no args, on a feature branch) | Skip git ops - restart with the current checkout |
| `/update <branch>` | Check out that branch, pull if it has a remote |
| `/update --pull` | Force pull on whatever branch you're currently on |

## Steps

0. Ensure Bun is on PATH:
   ```bash
   export PATH="$HOME/.bun/bin:$PATH"
   ```

1. Preflight snapshot - capture current state before making changes:
   ```bash
   max ps
   ```

2. Kill the macOS app and any stale file-watcher processes first (old `build.sh run` watchers will detect git-pulled Swift changes and bounce the app repeatedly). Use `-f` to match against the full command line, catching all environment variants (`Max`, `Max Local`, `Max Dev`, etc.):
   ```bash
   pkill -f "Max.*\.app/Contents/MacOS/" || true
   pkill -f "build\.sh run" || true
   ```

3. Quiesce with `max sleep` - stop assistant and gateway processes. This is directory-agnostic and stops processes globally regardless of CWD:
   ```bash
   max sleep || true
   ```

4. Verify stopped - run `max ps` and confirm no running processes. If `max ps` shows processes still running, run fallback cleanup to force-kill them:
   ```bash
   max ps
   ```

   **Fallback cleanup if `max ps` confirms processes are still running:**
   ```bash
   pkill -x "max-assistant" || true
   pkill -f "gateway/src/index" || true
   lsof -ti :7830 | xargs kill -9 2>/dev/null || true
   lsof -ti :7821 | xargs kill -9 2>/dev/null || true
   ```
   After fallback cleanup, run `max ps` again to confirm all processes are stopped.

5. Smart branch handling - determine what git operations (if any) to perform:

   ```bash
   CURRENT=$(git branch --show-current)
   GIT_OPS_RAN=false
   ```

   **Case A - `--pull` flag:** Force pull on the current branch.
   ```bash
   if [[ "$ARGUMENTS" == "--pull" ]]; then
     git pull
     GIT_OPS_RAN=true
   fi
   ```

   **Case B - Explicit branch name provided:** Check out the requested branch, pulling if possible. Before checking out, verify the working tree is clean - if there are uncommitted changes, **stop and warn the user** rather than silently losing work. Do NOT stash automatically.
   ```bash
   if [[ -n "$ARGUMENTS" && "$ARGUMENTS" != "--pull" ]]; then
     if ! git diff --quiet || ! git diff --cached --quiet; then
       echo "ERROR: Uncommitted changes detected. Commit or stash them before switching branches."
       # Stop and report the error to the user. Do not proceed.
     fi
     git checkout "$ARGUMENTS"
     git pull origin "$ARGUMENTS" 2>/dev/null || true
     GIT_OPS_RAN=true
   fi
   ```

   **Case C - No args, on `main`:** Pull latest from origin (preserves current default behavior).
   ```bash
   if [[ -z "$ARGUMENTS" && "$CURRENT" == "main" ]]; then
     git pull origin main
     GIT_OPS_RAN=true
   fi
   ```

   **Case D - No args, on a feature branch:** Skip git ops entirely - just restart with the current checkout.
   ```bash
   if [[ -z "$ARGUMENTS" && "$CURRENT" != "main" ]]; then
     echo "On branch '$CURRENT' - skipping git pull, restarting with current checkout"
   fi
   ```

6. Install dependencies - only if git operations ran (dependencies are unlikely to have changed for a local-only restart):
   ```bash
   if [[ "$GIT_OPS_RAN" == "true" ]]; then
     cd assistant && bun install && cd ..
     cd gateway && bun install && cd ..
   fi
   ```

7. Restart with `max wake` - start assistant and gateway from the current checkout. `max wake` must be run from the checkout directory that should supply the new assistant code:
   ```bash
   max wake
   ```

8. Build the macOS app (foreground, so compilation errors are caught immediately):
   ```bash
   cd clients/macos && ./build.sh
   ```

   If the build fails, stop and report the error. Do not proceed to launch.

   Then launch with file-watching in the background (the build is cached, so this just launches + watches):
   ```bash
   cd clients/macos && ./build.sh run &
   ```

9. Verify fresh state - run `max ps` to confirm processes are running:
   ```bash
   sleep 5
   echo ""
   echo "=== Startup Summary ==="
   max ps
   echo "======================="
   ```

## Report

Tailor the report to what actually happened:

- **If git pulled (Cases A, B, C):** Report what was pulled (new commits), the branch, and whether dependencies were updated.
- **If restarted in-place (Case D):** Report that services were restarted on the current branch with no git changes.
- **Always include:** The startup summary block output (assistant health, gateway health), whether the macOS app build succeeded or failed (and the error if it failed).
- Note: the macOS app manages its own assistant and gateway. On first launch, the app will hatch and start them automatically.
