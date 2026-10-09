import { test, expect } from './fixtures'

test('login page renders and a wrong password shows the API message', async ({ page, guard }) => {
  guard.expect(/401 POST \/api\/auth\/login/)
  await page.goto('/login')
  await page.getByLabel('Username').fill('uiadmin')
  await page.getByLabel('Password').fill('definitely-wrong')
  await page.getByRole('button', { name: 'Login' }).click()
  await expect(page.locator('.ant-message')).toContainText(/invalid|unauthor/i)
  await expect(page).toHaveURL(/\/login/)
})
