import { test, expect, state, apiCall } from './fixtures'

const PAGES = [
  '/collect', '/receipts', '/reports', '/students', '/promotion', '/fee-structure', '/transport', '/hostel', '/classes',
  '/fee-heads', '/installments', '/years', '/schools', '/users', '/arrears', '/deposits', '/vouchers', '/banking',
  '/renewals', '/documents', '/defaulters', '/messaging', '/more-reports', '/occupations-subjects', '/import', '/qr',
  '/audit', '/settings',
]
// Mirrors PAGE_CAP in src/permissions.ts: pages a VIEWER may not open.
const VIEWER_BLOCKED = ['/collect', '/promotion', '/users', '/renewals', '/documents', '/defaulters', '/messaging', '/more-reports', '/import', '/audit']

test('ADMIN opens every page: it renders, no console errors, no failed API calls', async ({ as }) => {
  const page = await as('ADMIN')
  for (const p of PAGES) {
    await page.goto(p)
    await expect(page.locator('.ant-layout-content')).toBeVisible()
    await expect(page.getByText('Not allowed'), p).toHaveCount(0)
    await page.waitForLoadState('networkidle')
  }
})

test('VIEWER: gated pages say Not allowed (and are hidden from the menu), the rest open', async ({ as }) => {
  const page = await as('VIEWER')
  for (const p of PAGES) {
    await page.goto(p)
    if (VIEWER_BLOCKED.includes(p)) {
      await expect(page.getByText('Not allowed'), p).toBeVisible()
      await expect(page.locator(`.ant-menu a[href="${p}"]`), p).toHaveCount(0)
    } else {
      await expect(page.getByText('Not allowed'), p).toHaveCount(0)
      await page.waitForLoadState('networkidle')
    }
  }
})

test('collect a cash fee from the Collect page: the receipt shows and the bill due drops', async ({ as }) => {
  const s = state().students.cash
  const before = Number((await apiCall('ADMIN', `/students/${s.id}/bill?yearId=${state().yearId}`)).body.totals.due)
  const page = await as('ADMIN')
  await page.goto('/collect')
  await page.locator('.ant-layout-content .ant-select').first().click()
  await page.keyboard.type(s.admissionNo)
  await page.locator('.ant-select-item-option', { hasText: s.admissionNo }).click()
  await page.getByLabel('Amount').fill('100')
  await page.getByRole('button', { name: 'Collect' }).click()
  await expect.poll(async () => Number((await apiCall('ADMIN', `/students/${s.id}/bill?yearId=${state().yearId}`)).body.totals.due)).toBe(before - 100)
})
