// Fails if web/src/permissions.ts disagrees with the @Roles(...) decorators in api/src/**/*.controller.ts.
// Run: node web/scripts/check-permissions.mjs   (Node >= 22.18, imports the .ts file directly)
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { PERMS, can } = await import(pathToFileURL(join(here, '../src/permissions.ts')).href)

import { CAP_ROUTES } from './cap-routes.mjs'

// ---- read the controllers: route key -> roles (null = any authenticated role)
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.controller.ts') ? [p] : []
  })
}
const rolesOf = (decorators) => {
  const m = decorators.map((d) => d.match(/^@Roles\((.*)\)/)).find(Boolean)
  return m ? [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]) : null
}
const norm = (prefix, path) => ('/' + [prefix, path].filter(Boolean).join('/')).replace(/\/+/g, '/').replace(/:\w+/g, ':p').replace(/\/$/, '') || '/'

const routes = new Map() // "METHOD /path" -> roles | null
for (const file of walk(join(here, '../../api/src'))) {
  const lines = readFileSync(file, 'utf8').split('\n')
  let classRoles = null
  let prefix = ''
  // A controller file may hold several classes; decorators are the @-lines directly above each declaration.
  let deco = []
  for (const raw of lines) {
    const line = raw.trim()
    if (line.startsWith('@')) { deco.push(line); continue }
    if (/^export class \w+/.test(line)) {
      classRoles = rolesOf(deco)
      prefix = (deco.map((d) => d.match(/^@Controller\((?:'([^']*)')?\)/)).find(Boolean) ?? [])[1] ?? ''
    } else if (deco.some((d) => /^@(Get|Post|Put|Patch|Delete)\(/.test(d)) && /^(async\s+)?\w+\(/.test(line)) {
      const v = deco.map((d) => d.match(/^@(Get|Post|Put|Patch|Delete)\((?:'([^']*)')?\)/)).find(Boolean)
      if (v) routes.set(`${v[1].toUpperCase()} ${norm(prefix, v[2])}`, rolesOf(deco) ?? classRoles)
    }
    if (line && !line.startsWith('//')) deco = []
  }
}

// ---- compare
const problems = []
const covered = new Set()
for (const cap of Object.keys(PERMS)) if (!CAP_ROUTES[cap]) problems.push(`${cap}: in permissions.ts but has no CAP_ROUTES entry`)
for (const [cap, list] of Object.entries(CAP_ROUTES)) {
  if (!(cap in PERMS)) { problems.push(`${cap}: in CAP_ROUTES but not in permissions.ts`); continue }
  for (const r of list) {
    const key = r.replace(/:\w+/g, ':p')
    covered.add(key)
    if (!routes.has(key)) { problems.push(`${cap}: route not found in controllers: ${key}`); continue }
    const backend = routes.get(key)
    if (backend === null) { problems.push(`${cap}: ${key} has no @Roles on the backend (any role may call it) but the UI gates it`); continue }
    // Compare through can(): every role must get the same answer from the UI map and from the controller.
    for (const role of ['ADMIN', 'ACCOUNTANT', 'VIEWER', 'SUPERADMIN']) {
      const api = role === 'SUPERADMIN' || backend.includes(role)
      if (can(role, cap) !== api) problems.push(`${cap}: ${role} UI=${can(role, cap)} backend=${api} (${key} @Roles ${backend.join(',')})`)
    }
  }
}
// Role-restricted write routes nobody maps: a new @Roles route would silently stay un-gated in the UI.
const unmapped = [...routes].filter(([k, r]) => r && !k.startsWith('GET ') && !covered.has(k)).map(([k, r]) => `${k} (${r.join(',')})`)

console.log(`${routes.size} controller routes read, ${Object.keys(PERMS).length} capabilities, ${covered.size} routes checked`)
if (unmapped.length) console.log(`warning: role-restricted write routes with no capability:\n  ${unmapped.join('\n  ')}`)
if (problems.length) { console.error(`FAIL\n  ${problems.join('\n  ')}`); process.exit(1) }
console.log('OK: permissions.ts matches the controllers')
