export class ApiError extends Error {}

export type OpenIn = 'iframe' | 'newtab'
export interface Tab { label: string; url: string; open: OpenIn; enabled: boolean }
export interface FieldError { index: number; field: string; message: string }
export interface GetResponse {
  ok: boolean
  tabs: Tab[]
  config_error: string | null
  config_path: string
  pages: string[]
  max_tabs: number
  first_rank: number
}

/** The shared label/URL rules (plugin/app-tabs-core.js, loaded by app/index.php); the PHP twin enforces them again on save. */
export interface Core {
  MAX_TABS: number
  validateLabel(label: string): string | null
  slugOf(label: string): string
  validateUrl(url: string): string | null
  resolveUrl(url: string, hostname: string): string
  isMixedContent(guiProtocol: string, resolvedUrl: string): boolean
}
export const core = (): Core => (window as unknown as { appTabs: Core }).appTabs

/**
 * POST urlencoded with the CSRF token as both a body field and a header. Never multipart: this host's nginx
 * auth_request times out on multipart bodies. A CSRF failure is HTTP 200 with an empty body (csrf_terminate()
 * exits without a status), so an empty body is reported as exactly that.
 */
export async function postRaw<T extends { ok?: boolean; error?: string | null }>(
  url: string,
  data: Record<string, string>,
  csrf: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const body = new URLSearchParams({ ...data, csrf_token: csrf }).toString()
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrf },
      body,
    })
  } catch {
    throw new ApiError('Could not reach the server. Check your connection and try again.')
  }
  const text = await res.text()
  if (text === '') {
    throw new ApiError('The server returned an empty response: your session or security token has probably expired. Reload this page.')
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new ApiError(`The server returned something unreadable (HTTP ${res.status}).`)
  }
}

/** Like postRaw, but ok:false becomes an ApiError carrying the server's message. */
export async function postJson<T extends { ok?: boolean; error?: string | null } = { ok: boolean }>(
  url: string,
  data: Record<string, string>,
  csrf: string,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const json = await postRaw<T>(url, data, csrf, fetchImpl)
  if (!json.ok) throw new ApiError(json.error || 'The request failed.')
  return json
}

/** Swap tab i with its neighbour; out-of-range moves return the list unchanged (and the same array). */
export function moveTab(list: Tab[], i: number, dir: -1 | 1): Tab[] {
  const j = i + dir
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list
  const out = list.slice()
  ;[out[i], out[j]] = [out[j], out[i]]
  return out
}

/** The payload for `save`: the whole list, trimmed, in order. */
export function savePayload(list: Tab[]): string {
  return JSON.stringify(list.map((t) => ({ label: t.label.trim(), url: t.url.trim(), open: t.open, enabled: t.enabled })))
}

/** Field-level validation for the add/edit form. `others` is the rest of the list (for the duplicate check). */
export function validateTab(t: Tab, others: Tab[], c: Core = core()): { label?: string; url?: string } {
  const out: { label?: string; url?: string } = {}
  const label = t.label.trim()
  const le = c.validateLabel(label)
  if (le) out.label = le
  else if (others.some((o) => c.slugOf(o.label).toLowerCase() === c.slugOf(label).toLowerCase())) out.label = 'Another tab already uses that label.'
  const ue = c.validateUrl(t.url.trim())
  if (ue) out.url = ue
  return out
}

/** The tab's address inside Unraid, which is also its generated file name. */
export const tabPath = (label: string, c: Core = core()): string => '/AppTab-' + c.slugOf(label)

/** True when the GUI is https and the (resolved) app URL is http: the browser will block the iframe. */
export function mixedWarning(url: string, guiProtocol: string = location.protocol, hostname: string = location.hostname, c: Core = core()): boolean {
  return c.validateUrl(url.trim()) === null && c.isMixedContent(guiProtocol, c.resolveUrl(url.trim(), hostname))
}

export type ThemePref = 'auto' | 'light' | 'dark'
export const THEME_KEY = 'apptabs-theme'
export const parseThemePref = (raw: string | null | undefined): ThemePref => (raw === 'light' || raw === 'dark' ? raw : 'auto')

export function readThemePref(storage?: Pick<Storage, 'getItem'>): ThemePref {
  try { return parseThemePref((storage ?? localStorage).getItem(THEME_KEY)) } catch { return 'auto' }
}
export function saveThemePref(pref: ThemePref, storage?: Pick<Storage, 'setItem'>): boolean {
  try { (storage ?? localStorage).setItem(THEME_KEY, pref); return true } catch { return false }
}
/** auto = the theme the server derived from the Unraid setting (data-server-theme); light/dark override it. */
export function applyTheme(pref: ThemePref, root: HTMLElement = document.documentElement): void {
  root.setAttribute('data-theme', pref === 'auto' ? (root.dataset.serverTheme === 'dark' ? 'dark' : 'light') : pref)
}
