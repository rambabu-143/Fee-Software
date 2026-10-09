// ponytail: token in localStorage, fine for an internal staff app. Move to httpOnly cookie if exposed publicly.
export const auth = {
  get token() {
    return localStorage.getItem('token')
  },
  set(token: string | null) {
    if (token) localStorage.setItem('token', token)
    else localStorage.removeItem('token')
  },
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
      ...init.headers,
    },
  })
  if (res.status === 401 && path !== '/auth/login') {
    auth.set(null)
    location.href = '/login'
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(Array.isArray(body?.message) ? body.message.join(', ') : body?.message ?? res.statusText)
  return body as T
}

// PDFs need the auth header, so fetch as a blob and open that.
export async function openPdf(path: string) {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${auth.token}` } })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? res.statusText)
  window.open(URL.createObjectURL(await res.blob()))
}

// Authenticated blob fetch (GET or POST). Returns the response headers so callers can read e.g. X-Serial-No.
async function fetchBlob(path: string, init: RequestInit = {}) {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${auth.token}` },
  })
  if (!res.ok) {
    const m = (await res.json().catch(() => null))?.message
    throw new Error(Array.isArray(m) ? m.join(', ') : (m ?? res.statusText))
  }
  return { blob: await res.blob(), headers: res.headers }
}

// ponytail: window.open after an await can be blocked by popup blockers; reprint from the list if so.
export async function openBlob(path: string, init: RequestInit = {}) {
  const { blob, headers } = await fetchBlob(path, init)
  window.open(URL.createObjectURL(blob))
  return headers
}

export async function saveBlob(path: string, filename: string) {
  const { blob } = await fetchBlob(path)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}

// Authenticated file download (CSV etc.): fetch as a blob, then click a temporary link.
export async function downloadFile(path: string, name: string) {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${auth.token}` } })
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? res.statusText)
  const a = document.createElement('a')
  a.href = URL.createObjectURL(await res.blob())
  a.download = name
  a.click()
}

// POST that returns a PDF (e.g. defaulter letters): open it, and hand back the X-Letters / X-Skipped counts.
export async function postPdf(path: string, body: unknown) {
  const res = await fetch(`/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth.token}` },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const b = await res.json().catch(() => null)
    throw new Error(Array.isArray(b?.message) ? b.message.join(', ') : (b?.message ?? res.statusText))
  }
  window.open(URL.createObjectURL(await res.blob()))
  return { letters: Number(res.headers.get('X-Letters')), skipped: Number(res.headers.get('X-Skipped')) }
}

// GET for paginated lists: the body plus the X-Total-Count header (0 if the endpoint doesn't send it).
export async function apiWithTotal<T>(path: string) {
  const res = await fetch(`/api${path}`, { headers: { Authorization: `Bearer ${auth.token}` } })
  if (res.status === 401) {
    auth.set(null)
    location.href = '/login'
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new Error(Array.isArray(body?.message) ? body.message.join(', ') : (body?.message ?? res.statusText))
  return { data: body as T, total: Number(res.headers.get('X-Total-Count') ?? 0) }
}
