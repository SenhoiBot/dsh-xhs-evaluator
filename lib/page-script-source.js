/**
 * The injected controller source, plus a build id derived from its bytes.
 *
 * Served through `GET /xhs/hosted.js`; the build id is stamped into the source
 * (replacing the `__DSH_XHS_BUILD__` placeholder) and published by `/xhs/state`,
 * so the client half can tell whether the version running inside a browser page
 * is stale and hot-swap it. Editing `page-script.js` therefore never needs a
 * manual version bump.
 */

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Injected controller source on disk. */
export const PAGE_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'page-script.js')

/** Placeholder the served source carries instead of a literal build id. */
export const BUILD_TOKEN = '__DSH_XHS_BUILD__'

/**
 * Read the controller source and stamp it with its own content hash.
 * @returns {Promise<{source: string, build: string}>}
 */
export async function loadPageScript() {
  const raw = await readFile(PAGE_SCRIPT_PATH, 'utf8')
  const build = createHash('sha1').update(raw).digest('hex').slice(0, 12)
  return { source: raw.split(BUILD_TOKEN).join(build), build }
}
