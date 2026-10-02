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
