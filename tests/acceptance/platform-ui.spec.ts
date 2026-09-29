/** Platform UI: run a cycle through every screen and all four human gates, then navigate from the report back to the requirement. */
import { test, expect, Page } from '@playwright/test';
import { startPlatform } from '../../src/platform/app';
import { HUMAN, config, tempStore } from './helpers';

test.describe.configure({ mode: 'serial' });
let platform: Awaited<ReturnType<typeof startPlatform>>;
test.beforeAll(async () => (platform = await startPlatform(0, { store: tempStore('platform-ui'), config })));
test.afterAll(async () => platform?.close());

async function approveGate(page: Page, gateText: RegExp) {
  await expect(page.getByTestId('gate-blocked')).toContainText(gateText, { timeout: 180_000 });
  await page.getByTestId('approver').fill(HUMAN);
  await page.getByTestId('comments').fill('Reviewed in acceptance test');
  await page.getByTestId('approve').click();
}

test('end-to-end through the UI: Home, Run, Human Review, Cycle Details, Test Data, Execution, Reporting, trace', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto(platform.url);
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.getByTestId('agents')).toContainText('Defect Intelligence Agent');

  await page.getByTestId('nav').getByText('Run', { exact: true }).click();
  await page.getByTestId('requested-by').fill(HUMAN);
  await page.getByTestId('start-cycle').click();

  // Gate 1: approve is disabled until every finding has a decision; agents cannot approve.
  await expect(page.getByTestId('gate-blocked')).toContainText(/Gate 1/, { timeout: 60_000 });
  await expect(page.getByTestId('approve')).toBeDisabled();
  for (const sel of await page.locator('[data-decision]').all()) await sel.selectOption('accept');
  await expect(page.getByTestId('approve')).toBeEnabled();
  await page.getByTestId('approver').fill('Review Agent');
  await page.getByTestId('approve').click();
  await expect(page.getByTestId('gate-error')).toContainText(/cannot approve/);
  await approveGate(page, /Gate 1/);
  await approveGate(page, /Gate 2/);
  await approveGate(page, /Gate 3/);
  await expect(page.getByTestId('gate-blocked')).toContainText(/Gate 4/, { timeout: 180_000 });
  await expect(page.getByTestId('gate-recommendation')).toHaveText('No-go');

  const cycleId = new URL(page.url()).hash.split('/')[2];
  await page.goto(`${platform.url}/#/cycle/${cycleId}`);
  await expect(page.getByTestId('cycle-details')).toContainText('Execute against local demo service');
  await expect(page.getByTestId('artifact-link').first()).toBeVisible();

  await page.goto(`${platform.url}/#/data/${cycleId}`);
  await expect(page.getByTestId('classification').first()).toHaveText('SYNTHETIC');
  await page.getByTestId('probe-provenance').click();
  await expect(page.getByTestId('probe-result')).toContainText(/rejected/i);

  await page.goto(`${platform.url}/#/execution/${cycleId}`);
  await expect(page.getByTestId('failed-count')).toHaveText('2');
  await expect(page.getByTestId('screenshot').first()).toBeVisible();
  await expect(page.getByTestId('defect-actual').first()).toContainText('success=true');

  await page.goto(`${platform.url}/#/reporting/${cycleId}`);
  await expect(page.getByTestId('recommendation')).toHaveText('No-go');
  await page.getByTestId('trace-search').fill('DEF-001');
  await page.getByTestId('trace-link').filter({ hasText: 'DEF-001' }).first().click();
  await expect(page.getByTestId('trace-node')).toContainText('DEF-001');
  const lineage = page.getByTestId('trace-lineage');
  for (const id of ['EX-TC-', 'AS-TC-', 'DS-TC-', 'TC-', 'BR-002', 'REQ-']) await expect(lineage).toContainText(id);

  await page.goto(`${platform.url}/#/review/${cycleId}`);
  await approveGate(page, /Gate 4/);
  await expect(page.getByTestId('no-gate')).toContainText('completed');

  await page.goto(`${platform.url}/#/audit`);
  await expect(page.getByTestId('audit')).toContainText('approval');
});

test('Test Lab: scenario to executed test with traceability chain', async ({ page }) => {
  await page.goto(`${platform.url}/#/lab`);
  await page.getByTestId('lab-scenario').fill('A reservation with customer count 0 should be rejected');
  await page.getByTestId('lab-approver').fill(HUMAN);
  await page.getByTestId('lab-run').click();
  await expect(page.getByTestId('lab-result')).toHaveAttribute('data-status', 'failed', { timeout: 120_000 });
  for (const t of ['requirement', 'rule', 'test-case', 'dataset', 'script', 'execution', 'evidence', 'defect']) await expect(page.getByTestId(`chain-${t}`).first()).toBeVisible();
});
