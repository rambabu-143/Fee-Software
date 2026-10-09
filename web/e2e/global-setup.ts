import { writeFileSync } from 'node:fs'

const API = `http://localhost:${process.env.UI_API_PORT ?? '3501'}/api`

async function call(path: string, token: string | null, method = 'GET', body?: unknown) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : null }
}

// Creates the users, bank and students the UI specs rely on. Idempotent: reruns reuse what exists.
export default async function globalSetup() {
  const admin = (await call('/auth/login', null, 'POST', { username: 'admin', password: 'admin123' })).body.token as string
  const schools = (await call('/schools', admin)).body as { id: number; code: string }[]
  const school = schools.find((s) => s.code === 'DEMO1')!
  const years = (await call('/years', admin)).body as { id: number; isCurrent: boolean }[]
  const year = years.find((y) => y.isCurrent)!

  for (const [username, role] of [['uiacct', 'ACCOUNTANT'], ['uiview', 'VIEWER'], ['uiadmin', 'ADMIN']] as const) {
    await call('/users', admin, 'POST', { username, password: 'ui-pass-1234', role, schoolId: school.id }) // 409 on rerun is fine
  }
  const banks = (await call(`/banks?schoolId=${school.id}`, admin)).body as { id: number; name: string }[]
  if (!banks.some((b) => b.name === 'UI Bank')) await call('/banks', admin, 'POST', { schoolId: school.id, name: 'UI Bank' })

  const std = await call(`/standards?schoolId=${school.id}`, admin)
  const sectionId = (std.body as { sections: { id: number }[] }[])[0].sections[0].id

  const run = Date.now().toString(36)
  const mk = async (tag: string) => {
    const r = await call('/students', admin, 'POST', {
      schoolId: school.id, yearId: year.id, admissionNo: `UI-${tag}-${run}`, name: `UI ${tag} ${run}`,
      sectionId, isNewAdmission: false, optionalHeadIds: [],
    })
    if (r.status !== 201) throw new Error(`student ${tag}: ${r.status} ${JSON.stringify(r.body)}`)
    return { id: r.body.id as number, admissionNo: r.body.admissionNo as string, name: r.body.name as string }
  }
  const students = { cash: await mk('CASH'), cheque: await mk('CHEQ'), bounce: await mk('BNCE'), spare: await mk('SPAR') }
  writeFileSync(new URL('./.state.json', import.meta.url), JSON.stringify({ schoolId: school.id, yearId: year.id, sectionId, run, students }, null, 1))
}
