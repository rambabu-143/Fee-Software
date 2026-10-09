// Calls the real API as ADMIN / ACCOUNTANT / VIEWER and checks 403 <=> !can(role, cap) for every capability.
// Run: API=http://localhost:3407 USERS=admin:pw,accountant:pw,viewer:pw node web/scripts/live-check.mjs
// (users must already exist; handler runs after the role guard, so ids/bodies can be dummies: allowed => 2xx/400/404, denied => 403)
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CAP_ROUTES } from './cap-routes.mjs'
const { PERMS, can } = await import(pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../src/permissions.ts')).href)
const API = process.env.API
const login = async (u, p) => (await (await fetch(`${API}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) })).json()).token
const out = []
for (const pair of process.env.USERS.split(',')) {
  const [u, p, role] = pair.split(':')
  const token = await login(u, p)
  if (!token) { out.push(`login failed for ${u}`); continue }
  for (const cap of Object.keys(PERMS)) {
    const [m, path] = CAP_ROUTES[cap][0].split(' ')
    const r = await fetch(`${API}/api${path.replace(/:p/g, '1')}?schoolId=1&yearId=1`, {
      method: m, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: m === 'GET' ? undefined : '{}',
    })
    const denied = r.status === 403
    if (r.status >= 500 || r.status === 401) out.push(`${role} ${cap}: unexpected ${r.status}`)
    else if (denied === can(role, cap)) out.push(`${role} ${cap}: UI says ${can(role, cap) ? 'allowed' : 'denied'} but API ${r.status}`)
  }
}
console.log(out.length ? `FAIL\n  ${out.join('\n  ')}` : `OK: ${Object.keys(PERMS).length} capabilities x ${process.env.USERS.split(',').length} roles match the live API`)
process.exit(out.length ? 1 : 0)
