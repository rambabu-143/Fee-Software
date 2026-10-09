import { cloneElement, createContext, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { Tooltip } from 'antd'
import { api, auth } from './api'
import { can, needs, type Cap, type Role } from './permissions'

export type Session = { username: string; role: Role; schoolId: number | null }

// Reads the logged-in user from the JWT payload (no signature check: the API verifies every request).
// Missing, malformed or expired token -> null.
export function readSession(token: string | null = auth.token): Session | null {
  try {
    const p = JSON.parse(atob(token!.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    if (typeof p.exp === 'number' && p.exp * 1000 < Date.now()) return null
    if (typeof p.username !== 'string' || typeof p.role !== 'string') return null
    return { username: p.username, role: p.role, schoolId: p.schoolId ?? null }
  } catch {
    return null
  }
}

const Ctx = createContext<Session | null>(null)

// Starts from the token so the first render already knows the role, then confirms with /auth/me
// (the API re-reads role and school on every request, so a role change shows without re-login).
export function SessionProvider({ children }: { children: ReactNode }) {
  const [s, setS] = useState(() => readSession())
  useEffect(() => {
    api<Session>('/auth/me').then((m) => setS({ username: m.username, role: m.role, schoolId: m.schoolId ?? null })).catch(() => {})
  }, [])
  return <Ctx.Provider value={s}>{children}</Ctx.Provider>
}

export const useSession = () => useContext(Ctx)

// useCan()('payments.cancel') -> boolean
export function useCan() {
  const role = useContext(Ctx)?.role
  return (cap: Cap) => can(role, cap)
}

// Wraps one action. Allowed -> unchanged. Not allowed -> hidden with `hide`, otherwise
// disabled with a "Needs ADMIN" tooltip (the span carries the tooltip because disabled buttons swallow hover).
// ponytail: backend still enforces; this is only so people don't click into a 403.
export function Gate({ cap, hide, children }: { cap: Cap; hide?: boolean; children: ReactElement<{ disabled?: boolean }> }) {
  const ok = useCan()(cap)
  if (ok) return children
  if (hide) return null
  return (
    <Tooltip title={`Needs ${needs(cap)}`}>
      <span style={{ display: 'inline-block', cursor: 'not-allowed' }}>{cloneElement(children, { disabled: true })}</span>
    </Tooltip>
  )
}
