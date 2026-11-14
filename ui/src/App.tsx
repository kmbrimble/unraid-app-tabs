import { useCallback, useEffect, useRef, useState } from 'preact/hooks'
import { ApiError, blankTab, consoleSummary, core, fromServer, mixedWarning, moveTab, postJson, savePayload, tabPath, trimTab, validateTab, type FieldError, type GetResponse, type Kind, type Tab, type TabErrors } from './lib'
import { Field, Modal, ThemeSwitch, Toasts, Toggle, TrashIcon, type Toast } from './ui'

const API = '../include/api.php'
interface Form { index: number | null; tab: Tab; errors: TabErrors; busy: boolean }

export function App({ csrf, fetchImpl }: { csrf: string; fetchImpl?: typeof fetch }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const seq = useRef(0)
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = ++seq.current
    setToasts((t) => [...t, { id, kind, text }])
    if (kind === 'ok') setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 8000)
  }, [])
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), [])
  const post = useCallback(<T extends { ok?: boolean; error?: string | null }>(action: string, data: Record<string, string> = {}) =>
    postJson<T>(API, { ...data, action }, csrf, fetchImpl), [csrf, fetchImpl])

  const [tabs, setTabs] = useState<Tab[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)
  const [maxTabs, setMaxTabs] = useState(12)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<Form | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<number | null>(null)
  const [changed, setChanged] = useState(false)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const r = await post<GetResponse>('get')
      setTabs(r.tabs.map(fromServer))
      setConfigError(r.config_error)
      setMaxTabs(r.max_tabs)
      setLoaded(true)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }, [post])
  useEffect(() => {
    if (!csrf) push('alert', 'No security token was provided by the page. Reload it from Settings, Utilities, App Tabs.')
    void load()
  }, [])

  /** Persist a whole new list. Resolves true on success; on failure shows why and keeps the old list on screen. */
  const save = useCallback(async (next: Tab[], okText: string): Promise<{ ok: boolean; errors?: FieldError[] }> => {
    setBusy(true)
    try {
      await post('save', { tabs: savePayload(next) })
      setTabs(next.map(trimTab))
      setChanged(true)
      push('ok', okText)
      return { ok: true }
    } catch (e) {
      push('alert', e instanceof ApiError ? e.message : String(e))
      // The server may have stored the change before something later failed (page generation): show what is really
      // saved rather than the list as it was, so the next edit cannot overwrite it by mistake.
      void load()
      return { ok: false }
    } finally {
      setBusy(false)
    }
  }, [post, push, load])

  const openAdd = () => setForm({ index: null, tab: blankTab(), errors: {}, busy: false })
  const openEdit = (i: number) => setForm({ index: i, tab: { ...tabs[i] }, errors: {}, busy: false })
  const others = (index: number | null) => tabs.filter((_, i) => i !== index)

  const submit = async () => {
    if (!form) return
    const errors = validateTab(form.tab, others(form.index))
    if (Object.keys(errors).length > 0) { setForm({ ...form, errors }); return }
    const next = form.index === null ? [...tabs, form.tab] : tabs.map((t, i) => (i === form.index ? form.tab : t))
    setForm({ ...form, busy: true })
    const r = await save(next, form.index === null ? `Added ${form.tab.label.trim()}.` : `Saved ${form.tab.label.trim()}.`)
    if (r.ok) setForm(null)
    else setForm((f) => (f ? { ...f, busy: false } : f))
  }

  const remove = async () => {
    if (confirmDelete === null) return
    const gone = tabs[confirmDelete]
    const r = await save(tabs.filter((_, i) => i !== confirmDelete), `Deleted ${gone.label}.`)
    if (r.ok) setConfirmDelete(null)
  }

  const canAdd = loaded && !loadError && !configError && tabs.length < maxTabs
  const patch = (p: Partial<Tab>) => setForm((f) => (f ? { ...f, tab: { ...f.tab, ...p }, errors: { ...f.errors, ...(p.label !== undefined ? { label: undefined } : {}), ...(p.url !== undefined ? { url: undefined } : {}), ...(p.container !== undefined ? { container: undefined } : {}), ...(p.session !== undefined ? { session: undefined } : {}) } } : f))

  return (
    <div class="atb-wrap">
      <header class="card atb-head">
        <div class="atb-head-top">
          <div>
            <h1 class="atb-title">App Tabs</h1>
            <p class="atb-sub">Turn web apps into tabs in the Unraid top bar, after NetMan. Use <code>[HOST]</code> in an address for the hostname you opened Unraid with.</p>
          </div>
          <div class="atb-head-actions">
            <ThemeSwitch />
            <button type="button" class="btn btn--primary" disabled={!canAdd || busy} onClick={openAdd}>Add tab</button>
          </div>
        </div>
        {changed && (
          <p class="atb-note" role="status">
            The top bar updates the next time an Unraid page loads.{' '}
            <button type="button" class="btn btn--secondary atb-small" onClick={() => { try { window.top!.location.reload() } catch { window.location.reload() } }}>Reload Unraid now</button>
          </p>
        )}
      </header>

      {loadError && (
        <section class="card atb-block" role="alert">
          <span class="chip chip--alert">Error</span> <span>{loadError}</span>{' '}
          <button type="button" class="btn btn--secondary atb-small" onClick={() => void load()}>Try again</button>
        </section>
      )}
      {configError && (
        <section class="card atb-block" role="alert">
          <span class="chip chip--alert">Config problem</span>
          <p class="atb-err-text">{configError}</p>
          <p class="atb-note">Editing is switched off so nothing is overwritten. No tabs are generated while this is unresolved.</p>
        </section>
      )}

      {loaded && !configError && (
        <section class="card atb-block" aria-labelledby="atb-list-h">
          <h2 id="atb-list-h" class="atb-sec-name">Tabs <span class="atb-count">{tabs.length} of {maxTabs}</span></h2>
          {tabs.length === 0 ? (
            <p class="atb-note">No tabs yet. Choose Add tab to create one.</p>
          ) : (
            <ol class="atb-rows">
              {tabs.map((t, i) => (
                <li class={`atb-row${t.enabled ? '' : ' atb-off'}`} key={t.label}>
                  <div class="atb-line">
                    <span class="atb-pos" aria-hidden="true">{i + 1}</span>
                    <div class="atb-main">
                      <span class="atb-name">{t.label}</span>
                      <code class="atb-url">{t.kind === 'console' ? consoleSummary(t) : t.url}</code>
                    </div>
                    <div class="atb-chips">
                      <span class={`chip ${t.enabled ? 'chip--ok' : 'chip--warn'}`}>{t.enabled ? 'Enabled' : 'Disabled'}</span>
                      <span class="chip">{t.kind === 'console' ? 'Docker console' : 'Web app'}</span>
                      {t.kind === 'url' && <span class="chip">{t.open === 'iframe' ? 'In a tab' : 'New browser tab'}</span>}
                      {t.kind === 'url' && t.open === 'iframe' && mixedWarning(t.url) && <span class="chip chip--warn" title="Unraid is open over https and this app is http">Blocked: http in https</span>}
                    </div>
                    <div class="atb-actions-row">
                      <button type="button" class="btn btn--secondary atb-small" disabled={busy || i === 0} aria-label={`Move ${t.label} up`} onClick={() => void save(moveTab(tabs, i, -1), `Moved ${t.label} up.`)}>
                        <span class="atb-arrow atb-arrow-up" aria-hidden="true" /> Up
                      </button>
                      <button type="button" class="btn btn--secondary atb-small" disabled={busy || i === tabs.length - 1} aria-label={`Move ${t.label} down`} onClick={() => void save(moveTab(tabs, i, 1), `Moved ${t.label} down.`)}>
                        <span class="atb-arrow atb-arrow-down" aria-hidden="true" /> Down
                      </button>
                      <Toggle label="Enabled" checked={t.enabled} disabled={busy} onChange={(on) => void save(tabs.map((x, k) => (k === i ? { ...x, enabled: on } : x)), `${on ? 'Enabled' : 'Disabled'} ${t.label}.`)} />
                      <button type="button" class="btn btn--secondary atb-small" disabled={busy} onClick={() => openEdit(i)} aria-label={`Edit ${t.label}`}>Edit</button>
                      <button type="button" class="btn-icon atb-danger" disabled={busy} aria-label={`Delete ${t.label}`} title="Delete" onClick={() => setConfirmDelete(i)}><TrashIcon /></button>
                    </div>
                  </div>
                  <div class="atb-sub-line">Opens at <code>{tabPath(t.label)}</code>{t.enabled ? '' : ' (no top-bar tab while disabled)'}</div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}

      {form && (
        <Modal title={form.index === null ? 'Add tab' : `Edit ${tabs[form.index]?.label ?? 'tab'}`} onClose={() => { if (!form.busy) setForm(null) }}>
          <form noValidate onSubmit={(e) => { e.preventDefault(); void submit() }}>
            <Field label="Label" id="atb-f-label" hint="The name on the top bar. Letters, digits, spaces and . _ + - (up to 24).">
              <input id="atb-f-label" class="input" value={form.tab.label} maxLength={24} autocomplete="off" aria-invalid={!!form.errors.label}
                onInput={(e) => patch({ label: (e.currentTarget as HTMLInputElement).value })} />
              {form.errors.label && <div class="atb-err" role="alert">{form.errors.label}</div>}
            </Field>
            <Field label="Kind" id="atb-f-kind">
              <select id="atb-f-kind" class="input" value={form.tab.kind} onChange={(e) => patch({ kind: (e.currentTarget as HTMLSelectElement).value as Kind })}>
                <option value="url">A web app (URL)</option>
                <option value="console">A Docker console</option>
              </select>
            </Field>
            {form.tab.kind === 'url' ? (
              <>
                <Field label="URL" id="atb-f-url" hint="http or https. [HOST] stands for the hostname you opened Unraid with.">
                  <input id="atb-f-url" class="input" value={form.tab.url} autocomplete="off" spellcheck={false} aria-invalid={!!form.errors.url}
                    onInput={(e) => patch({ url: (e.currentTarget as HTMLInputElement).value })} />
                  {form.errors.url && <div class="atb-err" role="alert">{form.errors.url}</div>}
                  {form.tab.open === 'iframe' && mixedWarning(form.tab.url) && (
                    <div class="atb-warn" role="note"><span class="chip chip--warn">Warning</span> Unraid is open over https and this address is http: the browser will block it inside the tab. You can still save it, or use https for the app.</div>
                  )}
                </Field>
                <Field label="Open in" id="atb-f-open">
                  <select id="atb-f-open" class="input" value={form.tab.open} onChange={(e) => patch({ open: (e.currentTarget as HTMLSelectElement).value as Tab['open'] })}>
                    <option value="iframe">A tab in Unraid (iframe)</option>
                    <option value="newtab">A new browser tab</option>
                  </select>
                </Field>
              </>
            ) : (
              <>
                <Field label="Container" id="atb-f-container" hint="The Docker container's name, as on the Docker tab. It must be running when the tab is opened.">
                  <input id="atb-f-container" class="input" value={form.tab.container} maxLength={core().IDENT_MAX} autocomplete="off" spellcheck={false} aria-invalid={!!form.errors.container}
                    onInput={(e) => patch({ container: (e.currentTarget as HTMLInputElement).value })} />
                  {form.errors.container && <div class="atb-err" role="alert">{form.errors.container}</div>}
                </Field>
                <Field label="tmux session" id="atb-f-session" hint="Optional. Attach to this tmux session in the container. Leave empty to open a shell instead.">
                  <input id="atb-f-session" class="input" value={form.tab.session} maxLength={core().IDENT_MAX} autocomplete="off" spellcheck={false} aria-invalid={!!form.errors.session}
                    onInput={(e) => patch({ session: (e.currentTarget as HTMLInputElement).value })} />
                  {form.errors.session && <div class="atb-err" role="alert">{form.errors.session}</div>}
                </Field>
                {form.tab.session.trim() === '' && (
                  <Field label="Shell" id="atb-f-shell">
                    <select id="atb-f-shell" class="input" value={form.tab.shell} onChange={(e) => patch({ shell: (e.currentTarget as HTMLSelectElement).value as Tab['shell'] })}>
                      <option value="sh">sh</option>
                      <option value="bash">bash</option>
                    </select>
                  </Field>
                )}
                <p class="atb-note">Runs <code>{consoleSummary(form.tab)}</code> through Unraid's own terminal server, behind your Unraid login. It is a writable terminal inside the container, exactly as privileged as the Docker tab's Console.</p>
              </>
            )}
            <Toggle label="Enabled" checked={form.tab.enabled} disabled={form.busy} onChange={(on) => patch({ enabled: on })} />
            {form.tab.label.trim() !== '' && core().validateLabel(form.tab.label.trim()) === null && (
              <p class="atb-note">Address in Unraid: <code>{tabPath(form.tab.label.trim())}</code></p>
            )}
            <div class="atb-actions">
              <button type="button" class="btn btn--secondary" onClick={() => setForm(null)} disabled={form.busy}>Cancel</button>
              <button type="submit" class="btn btn--primary" disabled={form.busy}>{form.busy ? 'Saving…' : 'Save'}</button>
            </div>
          </form>
        </Modal>
      )}

      {confirmDelete !== null && tabs[confirmDelete] && (
        <Modal title="Delete this tab?" onClose={() => setConfirmDelete(null)}>
          <p>Delete <strong>{tabs[confirmDelete].label}</strong>? Its top-bar tab goes away. The app itself is not touched.</p>
          <div class="atb-actions">
            <button type="button" class="btn btn--secondary" onClick={() => setConfirmDelete(null)}>Cancel</button>
            <button type="button" class="btn btn--secondary atb-danger" disabled={busy} onClick={() => void remove()}>Delete</button>
          </div>
        </Modal>
      )}
      <Toasts toasts={toasts} dismiss={dismiss} />
    </div>
  )
}

export { ApiError }
