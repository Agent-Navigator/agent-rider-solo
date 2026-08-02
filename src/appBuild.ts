export const APP_BUILD_CHECK_INTERVAL_MS = 3_000
export const APP_BUILD_RELOAD_PARAM = '_agrider_build'

function normalizeCommit(value: string) {
  return value.trim().toLowerCase()
}

export function appBuildChanged(
  sourceCommit: string,
  frontendCommit: string = __APP_VERSION__,
) {
  const backend = normalizeCommit(sourceCommit)
  const frontend = normalizeCommit(frontendCommit)
  if (!backend || !frontend || backend === 'unknown' || frontend === 'unknown') return false
  return !backend.endsWith(frontend)
}

/**
 * Returns a cache-busting navigation target for a newly detected application
 * build. The commit marker also makes the navigation one-shot: if an
 * intermediary serves the old frontend again, that client will not reload in a
 * loop for the same backend commit.
 */
export function applicationUpgradeReloadUrl(
  sourceCommit: string,
  currentUrl: string,
  frontendCommit: string = __APP_VERSION__,
) {
  if (!appBuildChanged(sourceCommit, frontendCommit)) return null
  const backend = normalizeCommit(sourceCommit)
  try {
    const target = new URL(currentUrl)
    if (normalizeCommit(target.searchParams.get(APP_BUILD_RELOAD_PARAM) ?? '') === backend) {
      return null
    }
    target.searchParams.set(APP_BUILD_RELOAD_PARAM, backend)
    return target.toString()
  } catch {
    return null
  }
}
