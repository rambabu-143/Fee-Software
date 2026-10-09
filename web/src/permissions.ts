// UI capability -> roles allowed, mirroring the @Roles(...) decorators in api/src/**/*.controller.ts.
// The backend stays the source of truth (it re-checks every request); this only decides what the UI shows.
// SUPERADMIN passes every @Roles check (api/src/auth/auth.guard.ts), so it is implicit and never listed;
// an empty list therefore means "SUPERADMIN only".
// Keep in sync: `node web/scripts/check-permissions.mjs` fails if this drifts from the controllers.
// Erasable TypeScript only (no enums), so that script can import this file directly.

export type Role = 'SUPERADMIN' | 'ADMIN' | 'ACCOUNTANT' | 'VIEWER'

const A: Role[] = ['ADMIN']
const AA: Role[] = ['ADMIN', 'ACCOUNTANT']
const ROOT: Role[] = []

export const PERMS = {
  // billing/payments.controller.ts
  'payments.collect': AA, // POST /payments
  'payments.cancel': A, // POST /payments/:id/cancel
  'payments.reconcile': AA, // POST /payments/:id/reconcile
  // students/*.controller.ts
  'students.write': AA, // POST /students, PATCH /students/:id
  'students.withdraw': AA, // POST /students/:id/withdrawal
  'students.withdrawalUndo': A, // DELETE /students/:id/withdrawal
  'students.concessions': A, // PUT /students/:id/concessions
  'students.fines': A, // PUT /students/:id/fines
  'students.facilities': AA, // PUT /students/:id/facilities
  'students.transport': AA, // PUT /students/:id/transport
  'promotions.run': AA, // POST /promotions
  'promotions.undo': A, // POST /promotions/undo
  // guardians/*.controller.ts
  'guardians.write': AA, // POST/PATCH/DELETE guardians, PUT /students/:id/subjects
  'catalog.write': A, // POST/PATCH/DELETE occupations + subjects
  // masters/*.controller.ts
  'feeStructure.write': AA, // PUT /fee-structure
  'facilityStructure.write': AA, // PUT /facilities/structure
  'facilities.write': A, // POST/PATCH/DELETE /facilities
  'stops.write': A, // POST/PATCH/DELETE /stops
  'standards.write': A, // standards + sections
  'feeHeads.write': A,
  'installments.write': A,
  'years.create': ROOT, // POST /years is @Roles('SUPERADMIN')
  'schools.create': ROOT, // POST /schools is @Roles('SUPERADMIN')
  'schools.edit': A, // PATCH /schools/:id
  // auth/users.controller.ts (whole controller is ADMIN)
  'users.manage': A,
  // arrears, deposits, vouchers, banks, renewals
  'arrears.carry': A, // POST /arrears/carry, PATCH /arrears/:enrollmentId
  'deposits.write': AA, // POST /deposits
  'deposits.admin': A, // POST /deposits/import, /deposits/:id/refund
  'vouchers.create': AA,
  'vouchers.cancel': A,
  'banks.read': AA, // GET /banks and the reconcile list
  'banks.write': A,
  'renewals.use': AA, // whole controller is ADMIN/ACCOUNTANT
  'renewals.admin': A, // DELETE + POST /apply
  // documents, defaulters, messaging
  'documents.use': AA,
  'documents.tcIssue': A, // POST /documents/tc
  'defaulters.use': AA, // POST /defaulters/letters, GET /defaulter-templates
  'defaulters.templates': A,
  'sms.use': AA, // POST /sms/send, GET /sms/log, GET /sms-templates
  'sms.templates': A,
  'email.send': AA,
  'email.templates': A, // every /email-templates route is ADMIN
  // reports-extra
  'reports.extra': AA,
  'reports.suggestions': A,
  // admin tools
  'import.run': A,
  'audit.read': A,
  'settings.write': A,
} as const satisfies Record<string, Role[]>

export type Cap = keyof typeof PERMS

export const can = (role: Role | undefined, cap: Cap) =>
  role === 'SUPERADMIN' || (!!role && (PERMS[cap] as readonly Role[]).includes(role))

// Text for the "Needs ..." tooltip.
export const needs = (cap: Cap) => {
  const roles = PERMS[cap] as readonly Role[]
  return roles.length ? roles.join(' or ') : 'SUPERADMIN'
}

// Pages a role may open at all (read-only pages are open to everyone; the backend allows them).
export const PAGE_CAP: Record<string, Cap | undefined> = {
  '/collect': 'payments.collect',
  '/promotion': 'promotions.run',
  '/users': 'users.manage',
  '/renewals': 'renewals.use',
  '/documents': 'documents.use',
  '/defaulters': 'defaulters.use',
  '/messaging': 'sms.use',
  '/more-reports': 'reports.extra',
  '/import': 'import.run',
  '/audit': 'audit.read',
}
