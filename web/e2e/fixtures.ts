import { test as base, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'

export const state = () =>
  JSON.parse(readFileSync(new URL('./.state.json', import.meta.url), 'utf8')) as {
    schoolId: number; yearId: number; sectionId: number; run: string
    students: Record<'cash' | 'cheque' | 'bounce' | 'spare', { id: number; admissionNo: string; name: string }>
  }

const API = `http://localhost:${process.env.UI_API_PORT ?? '3501'}/api`
export const CREDS = {
  ADMIN: ['uiadmin', 'ui-pass-1234'], ACCOUNTANT: ['uiacct', 'ui-pass-1234'], VIEWER: ['uiview', 'ui-pass-1234'],
  SUPERADMIN: ['admin', 'admin123'],
} as const
export type Role = keyof typeof CREDS

export async function tokenFor(role: Role) {
  const [username, password] = CREDS[role]
  const res = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) })
  return ((await res.json()) as { token: string }).token
}

// Fetches the API directly (not through the browser), for arranging and asserting data.
export async function apiCall(role: Role, path: string, method = 'GET', body?: unknown) {
  const res = await fetch(API + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await tokenFor(role)}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json: unknown = null
  try { json = text ? JSON.parse(text) : null } catch { /* binary */ }
  return { status: res.status, body: json as any }
}

// Console errors and 4xx/5xx responses fail the test unless the test names them in `expected`.
// ponytail: antd dev-mode warnings are console.warn/error with this prefix; they are noise, not app bugs.
export type Guard = { problems: string[]; expect: (pattern: RegExp) => void }
export const test = base.extend<{ guard: Guard; as: (role: Role) => Promise<Page> }>({
  guard: async ({ page }, use) => {
    const problems: string[] = []
    const allow: RegExp[] = []
    const ok = (s: string) => allow.some((r) => r.test(s))
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
    page.on('console', (m) => {
      const t = m.text()
      if (m.type() === 'error' && !/\[antd:/.test(t) && !/Failed to load resource/.test(t) && !ok(t)) problems.push(`console.error: ${t}`)
    })
    page.on('response', (r) => {
      const u = r.url()
      if (u.includes('/api/') && r.status() >= 400) {
        const line = `${r.status()} ${r.request().method()} ${u.replace(/^https?:\/\/[^/]+/, '')}`
        if (!ok(line)) problems.push(line)
      }
    })
    page.on('requestfailed', (r) => { const l = `requestfailed ${r.url()} ${r.failure()?.errorText}`; if (!ok(l) && !/net::ERR_ABORTED/.test(l)) problems.push(l) })
    await use({ problems, expect: (p) => { allow.push(p) } })
    expect(problems, 'unexpected console errors / failed requests').toEqual([])
  },
  as: async ({ page, guard: _g }, use) => {
    await use(async (role: Role) => {
      const token = await tokenFor(role)
      await page.addInitScript((t) => localStorage.setItem('token', t), token)
      return page
    })
  },
})
export { expect }
