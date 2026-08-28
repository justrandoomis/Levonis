#!/usr/bin/env bash
# Bounded production build for LEVO Studio.
#
# The old Sites wrappers (sites-env.sh / install-ci.sh) are gone: CI installs
# with a plain `npm ci` and this script only runs the vinext build with a
# timeout so a hung build fails loudly instead of stalling the pipeline.
#
# Select the deploy target with CLOUDFLARE_ENV (e.g. CLOUDFLARE_ENV=staging)
# before running; the Cloudflare Vite plugin bakes that environment into the
# emitted dist/ wrangler config.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "${script_dir}/.." && pwd)"

# Keep wrangler/miniflare state project-local and quiet (non-secret tool
# settings, mirrored from vite.config.ts for the CLI path).
export WRANGLER_WRITE_LOGS="${WRANGLER_WRITE_LOGS:-false}"
export WRANGLER_LOG_PATH="${WRANGLER_LOG_PATH:-${project_root}/.wrangler/logs}"

command -v timeout >/dev/null || {
  echo "build-verified.sh requires GNU timeout." >&2
  exit 69
}

vinext="${project_root}/node_modules/.bin/vinext"
if [[ ! -x "${vinext}" ]]; then
  echo "vinext is unavailable. Run: (cd studio && npm ci) before building." >&2
  exit 69
fi

echo "Running bounded vinext build (CLOUDFLARE_ENV=${CLOUDFLARE_ENV:-<top-level/production>})..."
cd "${project_root}"
timeout \
  --signal=TERM \
  --kill-after="${STUDIO_BUILD_KILL_AFTER:-10s}" \
  "${STUDIO_BUILD_TIMEOUT:-5m}" \
  "${vinext}" build
