const baseUrl = (process.env.AGENT_RIDER_STAGING_URL ?? 'http://127.0.0.1:15173').replace(/\/$/, '')
const healthUrl = `${baseUrl}/store/state`

let response
try {
  response = await fetch(healthUrl, { signal: AbortSignal.timeout(15_000) })
} catch (error) {
  throw new Error(`Staging service is unreachable at ${healthUrl}: ${error instanceof Error ? error.message : String(error)}`)
}

// A password-protected instance returns 401 before the state payload, which is
// still a healthy server response and matches the production upgrader's check.
if (response.status !== 200 && response.status !== 401) {
  throw new Error(`Staging health check failed: ${healthUrl} returned HTTP ${response.status}`)
}

console.log(`Staging service is healthy at ${healthUrl} (HTTP ${response.status}).`)
