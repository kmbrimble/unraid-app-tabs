import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { render } from 'preact'
import { act } from 'preact/test-utils'
import { App } from './App'
import type { Tab } from './lib'
import { installCore } from './testcore'

type Req = Record<string, string>
const tab = (o: Partial<Tab> = {}): Tab => ({ label: 'Backrest', kind: 'url', url: 'http://[HOST]:9898/', open: 'iframe', container: '', session: '', shell: 'sh', enabled: true, ...o })
let stored: Tab[]
let configError: string | null
let calls: Req[]
let saveReply: (d: Req) => unknown
let root: HTMLElement

const fetchStub = (async (_u: string, init: RequestInit) => {
  const d = Object.fromEntries(new URLSearchParams(String(init.body))) as Req
  calls.push(d)
  let body: unknown
  if (d.action === 'get') body = { ok: true, tabs: stored, config_error: configError, config_path: '/x/tabs.json', pages: [], max_tabs: 3, first_rank: 93 }
  else body = saveReply(d)
  return { status: 200, text: async () => JSON.stringify(body) }
}) as unknown as typeof fetch

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const click = (el: Element | null | undefined) => act(() => { (el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const type = (el: HTMLInputElement, v: string) => act(() => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })) })
const byText = (sel: string, t: string) => Array.from(root.querySelectorAll(sel)).find((e) => (e.textContent ?? '').trim() === t) as HTMLElement | undefined
const byLabel = (l: string) => root.querySelector(`[aria-label="${l}"]`) as HTMLElement
const names = () => Array.from(root.querySelectorAll('.atb-name')).map((e) => e.textContent)
const saves = () => calls.filter((c) => c.action === 'save').map((c) => JSON.parse(c.tabs) as Tab[])
const submitForm = () => act(() => { root.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })

async function mount() {
  await act(async () => { render(<App csrf="TOK" fetchImpl={fetchStub} />, root) })
  await flush(); await flush()
}

beforeEach(() => {
  installCore()
  localStorage.clear()
  root = document.createElement('div'); document.body.appendChild(root)
  calls = []
  configError = null
  stored = [tab(), tab({ label: 'Second', url: 'https://example.com/', open: 'newtab' }), tab({ label: 'Third', enabled: false })]
  saveReply = () => ({ ok: true, message: 'Saved.' })
})
afterEach(() => { render(null, root); root.remove() })

describe('list', () => {
  it('shows every tab in order with its state in words', async () => {
    await mount()
    expect(names()).toEqual(['Backrest', 'Second', 'Third'])
    expect(root.textContent).toContain('Disabled')
    expect(root.textContent).toContain('New browser tab')
    expect(root.textContent).toContain('/AppTab-Backrest')
    expect(root.textContent).toContain('3 of 3')
  })
  it('sends the token with get', async () => {
    await mount()
    expect(calls[0]).toMatchObject({ action: 'get', csrf_token: 'TOK' })
  })
  it('shows an empty state', async () => {
    stored = []
    await mount()
    expect(root.textContent).toContain('No tabs yet')
  })
  it('a config error is visible, hides the list and switches editing off (no reset offered)', async () => {
    configError = '/boot/x/tabs.json is not usable (bad)'
    await mount()
    expect(root.querySelector('[role=alert]')!.textContent).toContain('tabs.json is not usable')
    expect(root.querySelector('.atb-rows')).toBeNull()
    expect((byText('button', 'Add tab') as HTMLButtonElement).disabled).toBe(true)
    expect(root.textContent!.toLowerCase()).not.toContain('reset')
  })
  it('a failed load can be retried', async () => {
    const f = (async () => ({ status: 200, text: async () => '' })) as unknown as typeof fetch
    await act(async () => { render(<App csrf="TOK" fetchImpl={f} />, root) })
    await flush(); await flush()
    expect(root.textContent).toContain('empty response')
    expect(byText('button', 'Try again')).toBeTruthy()
  })
  it('the https-GUI-with-http-app warning shows on the row (happy-dom location is http, so simulate https)', async () => {
    const orig = window.location
    Object.defineProperty(window, 'location', { value: { ...orig, protocol: 'https:', hostname: 'nas' }, configurable: true })
    try {
      await mount()
      expect(root.textContent).toContain('Blocked: http in https')
    } finally {
      Object.defineProperty(window, 'location', { value: orig, configurable: true })
    }
  })
})

describe('guards from review', () => {
  it('Add stays disabled until the first load succeeds (no overwrite of an unread list)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const slow = (async (_u: string, init: RequestInit) => {
      const d = Object.fromEntries(new URLSearchParams(String(init.body))) as Req
      if (d.action === 'get') await gate
      return { status: 200, text: async () => JSON.stringify({ ok: true, tabs: stored, config_error: null, config_path: '', pages: [], max_tabs: 12, first_rank: 93 }) }
    }) as unknown as typeof fetch
    await act(async () => { render(<App csrf="TOK" fetchImpl={slow} />, root) })
    expect((byText('button', 'Add tab') as HTMLButtonElement).disabled).toBe(true)
    release(); await flush(); await flush()
    expect((byText('button', 'Add tab') as HTMLButtonElement).disabled).toBe(false)
  })
  it('a failed initial load leaves Add disabled', async () => {
    const f = (async () => ({ status: 200, text: async () => '' })) as unknown as typeof fetch
    await act(async () => { render(<App csrf="TOK" fetchImpl={f} />, root) })
    await flush(); await flush()
    expect((byText('button', 'Add tab') as HTMLButtonElement).disabled).toBe(true)
  })
  it('row toggles are disabled while a save is in flight (no stale whole-list overwrite)', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const f = (async (_u: string, init: RequestInit) => {
      const d = Object.fromEntries(new URLSearchParams(String(init.body))) as Req
      calls.push(d)
      if (d.action === 'save') await gate
      const body = d.action === 'get' ? { ok: true, tabs: stored, config_error: null, config_path: '', pages: [], max_tabs: 3, first_rank: 93 } : { ok: true }
      return { status: 200, text: async () => JSON.stringify(body) }
    }) as unknown as typeof fetch
    await act(async () => { render(<App csrf="TOK" fetchImpl={f} />, root) })
    await flush(); await flush()
    const boxes = () => root.querySelectorAll<HTMLInputElement>('.atb-row input[type=checkbox]')
    await act(() => { boxes()[2].click() })
    expect(Array.from(boxes()).every((b) => b.disabled)).toBe(true)
    release(); await flush(); await flush()
    expect(Array.from(boxes()).every((b) => !b.disabled)).toBe(true)
    expect(saves()).toHaveLength(1)
  })
  it('after a failed save the list is reloaded from the server (it may have been stored before the failure)', async () => {
    saveReply = () => ({ ok: false, error: 'Saved to /x, but generating the tab pages failed: boom' })
    await mount()
    const gets = () => calls.filter((c) => c.action === 'get').length
    expect(gets()).toBe(1)
    await click(byLabel('Move Second up')); await flush(); await flush()
    expect(gets()).toBe(2)
  })
  it('Escape does not close the form while it is saving', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => { release = r })
    const f = (async (_u: string, init: RequestInit) => {
      const d = Object.fromEntries(new URLSearchParams(String(init.body))) as Req
      if (d.action === 'save') await gate
      const body = d.action === 'get' ? { ok: true, tabs: stored, config_error: null, config_path: '', pages: [], max_tabs: 12, first_rank: 93 } : { ok: true }
      return { status: 200, text: async () => JSON.stringify(body) }
    }) as unknown as typeof fetch
    await act(async () => { render(<App csrf="TOK" fetchImpl={f} />, root) })
    await flush(); await flush()
    await click(byLabel('Edit Backrest'))
    await submitForm()
    await act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(root.querySelector('.modal')).not.toBeNull()
    release(); await flush(); await flush()
    expect(root.querySelector('.modal')).toBeNull()
  })
})

describe('add and edit', () => {
  it('Add opens a form; an invalid label and URL are refused client-side and nothing is sent', async () => {
    await mount()
    await click(byText('button', 'Add tab'))
    await type(root.querySelector('#atb-f-label') as HTMLInputElement, 'bad"label')
    await type(root.querySelector('#atb-f-url') as HTMLInputElement, 'ftp://x')
    await submitForm()
    expect(root.querySelectorAll('.atb-err').length).toBe(2)
    expect(saves()).toHaveLength(0)
  })
  it('a valid add saves the whole list with the new tab last, and closes with a toast', async () => {
    stored = [tab()]
    await mount()
    await click(byText('button', 'Add tab'))
    await type(root.querySelector('#atb-f-label') as HTMLInputElement, 'ZzTest')
    await type(root.querySelector('#atb-f-url') as HTMLInputElement, 'http://[HOST]:81/Dashboard')
    await submitForm(); await flush()
    expect(saves()[0].map((t) => t.label)).toEqual(['Backrest', 'ZzTest'])
    expect(saves()[0][1]).toEqual({ label: 'ZzTest', kind: 'url', url: 'http://[HOST]:81/Dashboard', open: 'iframe', enabled: true })
    expect(root.querySelector('.modal')).toBeNull()
    expect(names()).toEqual(['Backrest', 'ZzTest'])
    expect(root.textContent).toContain('Added ZzTest.')
    expect(root.textContent).toContain('Reload Unraid now')
  })
  it('refuses a duplicate label', async () => {
    await mount()
    await click(byText('button', 'Add tab'))
    await type(root.querySelector('#atb-f-label') as HTMLInputElement, 'backrest')
    await type(root.querySelector('#atb-f-url') as HTMLInputElement, 'http://h/')
    await submitForm()
    expect(root.textContent).toContain('already uses that label')
    expect(saves()).toHaveLength(0)
  })
  it('Add is disabled at the maximum', async () => {
    await mount()
    expect((byText('button', 'Add tab') as HTMLButtonElement).disabled).toBe(true)
  })
  it('edit changes one tab in place', async () => {
    await mount()
    await click(byLabel('Edit Second'))
    expect((root.querySelector('#atb-f-label') as HTMLInputElement).value).toBe('Second')
    await type(root.querySelector('#atb-f-url') as HTMLInputElement, 'https://example.org/')
    await submitForm(); await flush()
    expect(saves()[0].map((t) => t.url)).toEqual(['http://[HOST]:9898/', 'https://example.org/', 'http://[HOST]:9898/'])
  })
  it('a server-side refusal keeps the form open and shows the message', async () => {
    saveReply = () => ({ ok: false, error: 'Not saved: nope' })
    await mount()
    await click(byLabel('Edit Backrest'))
    await submitForm(); await flush()
    expect(root.querySelector('.modal')).not.toBeNull()
    expect(root.textContent).toContain('Not saved: nope')
  })
  it('Escape closes the form without saving', async () => {
    await mount()
    await click(byLabel('Edit Backrest'))
    await act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(root.querySelector('.modal')).toBeNull()
    expect(saves()).toHaveLength(0)
  })
  it('warns (without blocking) about http under https', async () => {
    const orig = window.location
    Object.defineProperty(window, 'location', { value: { ...orig, protocol: 'https:', hostname: 'nas' }, configurable: true })
    try {
      stored = [tab({ url: 'https://ok/' })]
      await mount()
      await click(byLabel('Edit Backrest'))
      await type(root.querySelector('#atb-f-url') as HTMLInputElement, 'http://[HOST]:9898/')
      expect(root.querySelector('.atb-warn')!.textContent).toContain('will block it')
      await submitForm(); await flush()
      expect(saves()).toHaveLength(1)
    } finally {
      Object.defineProperty(window, 'location', { value: orig, configurable: true })
    }
  })
})

describe('reorder, enable, delete', () => {
  it('Up and Down buttons move a tab and save the new order; ends are disabled', async () => {
    await mount()
    expect((byLabel('Move Backrest up') as HTMLButtonElement).disabled).toBe(true)
    expect((byLabel('Move Third down') as HTMLButtonElement).disabled).toBe(true)
    await click(byLabel('Move Second up')); await flush()
    expect(saves()[0].map((t) => t.label)).toEqual(['Second', 'Backrest', 'Third'])
    expect(names()).toEqual(['Second', 'Backrest', 'Third'])
    await click(byLabel('Move Second down')); await flush()
    expect(saves()[1].map((t) => t.label)).toEqual(['Backrest', 'Second', 'Third'])
  })
  it('the enabled toggle saves immediately', async () => {
    await mount()
    const boxes = root.querySelectorAll<HTMLInputElement>('.atb-row input[type=checkbox]')
    await act(() => { boxes[2].click() }); await flush()
    expect(saves()[0].map((t) => t.enabled)).toEqual([true, true, true])
    expect(root.textContent).toContain('Enabled Third.')
  })
  it('delete asks first and Cancel changes nothing', async () => {
    await mount()
    await click(byLabel('Delete Second'))
    expect(root.querySelector('.modal')!.textContent).toContain('Delete Second?')
    await click(byText('.modal button', 'Cancel'))
    expect(saves()).toHaveLength(0)
    expect(names()).toHaveLength(3)
  })
  it('confirming delete saves the list without it', async () => {
    await mount()
    await click(byLabel('Delete Second'))
    await click(byText('.modal button', 'Delete')); await flush()
    expect(saves()[0].map((t) => t.label)).toEqual(['Backrest', 'Third'])
    expect(names()).toEqual(['Backrest', 'Third'])
  })
  it('a failed save keeps the list as it was and says why', async () => {
    saveReply = () => ({ ok: false, error: 'disk full' })
    await mount()
    await click(byLabel('Move Second up')); await flush()
    expect(names()).toEqual(['Backrest', 'Second', 'Third'])
    expect(root.textContent).toContain('disk full')
    expect(root.textContent).not.toContain('Reload Unraid now')
  })
  it('every icon-only control has an accessible name and a 44px floor class', async () => {
    await mount()
    root.querySelectorAll('.btn-icon').forEach((b) => expect(b.getAttribute('aria-label')).toBeTruthy())
  })
})

describe('console tabs', () => {
  const ctab = (o: Partial<Tab> = {}): Tab => tab({ label: 'Claude', kind: 'console', url: '', container: 'claude-code', session: 'claude', ...o })
  const pick = (id: string, v: string) => act(() => { const el = root.querySelector(id) as HTMLSelectElement; el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })) })
  const addConsole = async (label: string) => {
    await click(byText('button', 'Add tab'))
    await type(root.querySelector('#atb-f-label') as HTMLInputElement, label)
    await pick('#atb-f-kind', 'console')
  }
  beforeEach(() => { stored = [tab(), ctab()] })

  it('the list shows the kind and the command a console tab runs', async () => {
    await mount()
    expect(names()).toEqual(['Backrest', 'Claude'])
    const row = root.querySelectorAll('.atb-row')[1]
    expect(row.textContent).toContain('Docker console')
    expect(row.textContent).toContain('docker exec -it claude-code tmux attach -t claude')
    expect(row.textContent).not.toContain('In a tab')
    expect(root.querySelectorAll('.atb-row')[0].textContent).toContain('Web app')
  })
  it('a tab the server sends the 0.1.x way (no kind, no console keys) is a URL tab', async () => {
    stored = [{ label: 'Old', url: 'http://[HOST]:9898/', open: 'iframe', enabled: true } as unknown as Tab]
    await mount()
    expect(root.textContent).toContain('Web app')
    await click(byLabel('Edit Old'))
    expect((root.querySelector('#atb-f-url') as HTMLInputElement).value).toBe('http://[HOST]:9898/')
    expect((root.querySelector('#atb-f-kind') as HTMLSelectElement).value).toBe('url')
  })
  it('the form swaps the URL fields for container/session fields, and a shell only when there is no session', async () => {
    stored = []
    await mount()
    await click(byText('button', 'Add tab'))
    expect(root.querySelector('#atb-f-url')).toBeTruthy()
    expect(root.querySelector('#atb-f-container')).toBeNull()
    await pick('#atb-f-kind', 'console')
    expect(root.querySelector('#atb-f-url')).toBeNull()
    expect(root.querySelector('#atb-f-open')).toBeNull()
    expect(root.querySelector('#atb-f-container')).toBeTruthy()
    expect(root.querySelector('#atb-f-session')).toBeTruthy()
    expect(root.querySelector('#atb-f-shell')).toBeTruthy()
    await type(root.querySelector('#atb-f-session') as HTMLInputElement, 'claude')
    expect(root.querySelector('#atb-f-shell')).toBeNull()
    expect(root.querySelector('.modal')!.textContent).toContain('docker exec -it  tmux attach -t claude')
  })
  it('hostile container and session names are refused before anything is sent', async () => {
    stored = []
    await mount()
    for (const [c, s] of [['a;b', ''], ['$(x)', ''], ['a b', ''], ['-rf', ''], ['.x', ''], ['ünï', ''], ['x'.repeat(129), ''], ['', ''], ['ok', 'a;b'], ['ok', '-t'], ['ok', 'a b']]) {
      calls = []
      await click(byText('button', 'Add tab'))
      await type(root.querySelector('#atb-f-label') as HTMLInputElement, 'Zz')
      await pick('#atb-f-kind', 'console')
      await type(root.querySelector('#atb-f-container') as HTMLInputElement, c)
      await type(root.querySelector('#atb-f-session') as HTMLInputElement, s)
      await submitForm()
      expect(saves(), `container ${JSON.stringify(c)} session ${JSON.stringify(s)}`).toHaveLength(0)
      expect(root.querySelector('.atb-err'), `error shown for ${JSON.stringify([c, s])}`).toBeTruthy()
      await click(byText('button', 'Cancel'))
    }
  })
  it('a valid console tab saves only the console keys, trimmed, with an explicit kind', async () => {
    stored = [tab()]
    await mount()
    await addConsole('Claude')
    await type(root.querySelector('#atb-f-container') as HTMLInputElement, ' claude-code ')
    await type(root.querySelector('#atb-f-session') as HTMLInputElement, 'claude')
    await submitForm(); await flush()
    expect(saves()[0][1]).toEqual({ label: 'Claude', kind: 'console', container: 'claude-code', session: 'claude', shell: 'sh', enabled: true })
    expect(names()).toEqual(['Backrest', 'Claude'])
    expect(root.textContent).toContain('docker exec -it claude-code tmux attach -t claude')
  })
  it('an empty session saves the chosen shell', async () => {
    stored = []
    await mount()
    await addConsole('Shell')
    await type(root.querySelector('#atb-f-container') as HTMLInputElement, 'claude-code')
    await pick('#atb-f-shell', 'bash')
    await submitForm(); await flush()
    expect(saves()[0][0]).toEqual({ label: 'Shell', kind: 'console', container: 'claude-code', session: '', shell: 'bash', enabled: true })
    expect(root.textContent).toContain('docker exec -it claude-code bash')
  })
  it('toggling, reordering and editing never strip a console tab\'s container and session', async () => {
    await mount()
    const want = { label: 'Claude', kind: 'console', container: 'claude-code', session: 'claude', shell: 'sh' }
    await click(byLabel('Move Claude up')); await flush()
    expect(saves()[0][0]).toEqual({ ...want, enabled: true })
    await click(byLabel('Move Claude down')); await flush()
    expect(saves()[1][1]).toEqual({ ...want, enabled: true })
    await act(() => { (root.querySelectorAll('.atb-row')[1].querySelector('input[type=checkbox]') as HTMLInputElement).click() }); await flush()
    expect(saves()[2][1]).toEqual({ ...want, enabled: false })
    expect(saves()[2][0]).toEqual({ label: 'Backrest', kind: 'url', url: 'http://[HOST]:9898/', open: 'iframe', enabled: true })
    await click(byLabel('Edit Claude'))
    expect((root.querySelector('#atb-f-container') as HTMLInputElement).value).toBe('claude-code')
    expect((root.querySelector('#atb-f-session') as HTMLInputElement).value).toBe('claude')
    await type(root.querySelector('#atb-f-session') as HTMLInputElement, 'other')
    await submitForm(); await flush()
    expect(saves()[3][1]).toMatchObject({ container: 'claude-code', session: 'other' })
  })
  it('a URL tab is not sent console keys, and the https/http warning never shows for a console tab', async () => {
    await mount()
    await click(byLabel('Move Backrest down')); await flush()
    expect(Object.keys(saves()[0][1])).toEqual(['label', 'kind', 'url', 'open', 'enabled'])
    expect(root.querySelectorAll('.atb-row')[0].textContent).not.toContain('Blocked')
  })
  it('the form states what the tab can do', async () => {
    await mount()
    await click(byLabel('Edit Claude'))
    expect(root.querySelector('.modal')!.textContent).toContain('writable terminal')
  })
})
