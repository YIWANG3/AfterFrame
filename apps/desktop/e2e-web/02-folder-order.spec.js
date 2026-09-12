const { test, expect } = require('@playwright/test');
const { exerciseFolderOrder } = require('../e2e/helpers/folder-order');

test('browser folders reorder in both views without interfering with photo drops', async ({ page }) => {
  await page.goto('/web.html');
  await page.getByRole('button', { name: 'Browse Sample Library' }).click();
  await expect(page.locator('[data-gallery-item="true"]').first()).toBeVisible({ timeout: 15000 });
  await exerciseFolderOrder(page);
});
