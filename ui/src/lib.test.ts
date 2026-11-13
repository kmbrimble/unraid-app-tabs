import { beforeAll, describe, expect, it } from 'vitest'
import { ApiError, applyTheme, mixedWarning, moveTab, parseThemePref, postJson, postRaw, readThemePref, saveThemePref, savePayload, tabPath, validateTab, type Tab } from './lib'
import { installCore, realCore } from './testcore'

const tab = (o: Partial<Tab> = {}): Tab => ({ label: 'Backrest', url: 'http://[HOST]:9898/', open: 'iframe', enabled: true, ...o })
beforeAll(installCore)

describe('moveTab', () => {
  const l = [tab({ label: 'A' }), tab({ label: 'B' }), tab({ label: 'C' })]
  it('swaps with the neighbour', () => {
    expect(moveTab(l, 1, -1).map((t) => t.label)).toEqual(['B', 'A', 'C'])
    expect(moveTab(l, 1, 1).map((t) => t.label)).toEqual(['A', 'C', 'B'])
  })
  it('does nothing at the ends and never mutates', () => {
    expect(moveTab(l, 0, -1)).toBe(l)
    expect(moveTab(l, 2, 1)).toBe(l)
    expect(l.map((t) => t.label)).toEqual(['A', 'B', 'C'])
  })
})

describe('savePayload', () => {
  it('trims and keeps order and only the four keys', () => {
    const j = JSON.parse(savePayload([{ ...tab({ label: ' Z ', url: ' http://x/ ' }), extra: 1 } as Tab, tab()]))
    expect(j[0]).toEqual({ label: 'Z', url: 'http://x/', open: 'iframe', enabled: true })
    expect(j[1].label).toBe('Backrest')
  })
})

describe('validateTab', () => {
  it('accepts a good tab', () => expect(validateTab(tab(), [])).toEqual({}))
  it('flags label and url', () => {
    const e = validateTab(tab({ label: 'a"b', url: 'ftp://x' }), [])
    expect(e.label).toBeTruthy()
    expect(e.url).toBeTruthy()
  })
  it('flags a duplicate label, case-insensitively', () => expect(validateTab(tab({ label: 'backrest' }), [tab()]).label).toMatch(/already/))
})

describe('tabPath and mixedWarning', () => {
  it('derives the file-name address', () => expect(tabPath('My App')).toBe('/AppTab-My-App'))
  it('warns only for an http app under an https GUI', () => {
    expect(mixedWarning('http://[HOST]:9898/', 'https:', 'nas')).toBe(true)
    expect(mixedWarning('https://[HOST]:9898/', 'https:', 'nas')).toBe(false)
    expect(mixedWarning('http://[HOST]:9898/', 'http:', 'nas')).toBe(false)
    expect(mixedWarning('http://', 'https:', 'nas')).toBe(false)
  })
  it('exposes the shared core', () => expect(realCore.MAX_TABS).toBe(12))
})

describe('post helpers', () => {
  const ok = (text: string) => (async () => ({ status: 200, text: async () => text })) as unknown as typeof fetch
  it('sends the token as a field and a header, urlencoded', async () => {
    let seen: RequestInit | undefined
    const f = (async (_u: string, init: RequestInit) => { seen = init; return { status: 200, text: async () => '{"ok":true}' } }) as unknown as typeof fetch
    await postRaw('x', { action: 'get' }, 'TOK', f)
    expect((seen!.headers as Record<string, string>)['X-CSRF-Token']).toBe('TOK')
    expect((seen!.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(String(seen!.body)).toContain('csrf_token=TOK')
  })
  it('names an empty body as an expired session', async () => {
    await expect(postRaw('x', {}, 't', ok(''))).rejects.toThrow(/empty response/)
  })
  it('rejects unreadable JSON and ok:false', async () => {
    await expect(postRaw('x', {}, 't', ok('<html>'))).rejects.toThrow(/unreadable/)
    await expect(postJson('x', {}, 't', ok('{"ok":false,"error":"nope"}'))).rejects.toThrow(new ApiError('nope'))
  })
})

describe('theme', () => {
  it('parses and persists', () => {
    expect(parseThemePref('dark')).toBe('dark')
    expect(parseThemePref('x')).toBe('auto')
    const s: Record<string, string> = {}
    expect(saveThemePref('light', { setItem: (k, v) => { s[k] = v } })).toBe(true)
    expect(readThemePref({ getItem: (k) => s[k] ?? null })).toBe('light')
    expect(saveThemePref('dark', { setItem: () => { throw new Error('blocked') } })).toBe(false)
  })
  it('auto follows the server theme', () => {
    const el = document.createElement('div')
    el.dataset.serverTheme = 'dark'
    applyTheme('auto', el)
    expect(el.getAttribute('data-theme')).toBe('dark')
    applyTheme('light', el)
    expect(el.getAttribute('data-theme')).toBe('light')
  })
})
