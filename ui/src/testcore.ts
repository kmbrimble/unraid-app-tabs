// Test-only: loads the real shared core (plugin/app-tabs-core.js) the way app/index.php does in the browser.
import { createRequire } from 'node:module'
import type { Core } from './lib'

const req = createRequire(import.meta.url)
export const realCore = req('../../plugin/app-tabs-core.js') as Core
export function installCore(): void {
  ;(window as unknown as { appTabs: Core }).appTabs = realCore
}
