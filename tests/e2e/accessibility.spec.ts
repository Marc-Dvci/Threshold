/**
 * Accessibility. Build plan §18.
 *
 * Part of execution quality, not polish after the fact. The person this product is for is arranging
 * care for someone else at eleven at night, and the one screen they must be able to complete is the
 * consent gate. A visually impressive page that a keyboard user cannot get out of is a page that has
 * failed at the only moment that counts.
 *
 * axe finds the machine-checkable half: contrast, labels, roles, heading order, region landmarks. It
 * cannot find the half that matters most, so the keyboard flow through the consent panel is asserted
 * by hand in `hub.spec.ts` — focus moving in on open, staying inside while it is open, Escape
 * cancelling, and every field reachable and editable without a mouse.
 */

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const GOLDEN_NEED = {
  service_area: 'demo_central',
  support_kinds: ['respite_bed', 'accessible_transport', 'overnight_homecare'],
  starts_within_hours: 24,
  duration_hours: 48,
  deadline: { day: 1, at: '08:00' },
  dementia_trained: true,
  wheelchair_access: true,
  hoist_required: true,
  same_gender_staff_required: false,
  accepts_pets_required: false,
  spoken_language: 'en',
};

const PROVIDER_ORIGINS = ['http://localhost:5101', 'http://localhost:5102', 'http://localhost:5103'];

/** WCAG 2.1 A and AA. The tags a public service would actually be held to. */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).threshold?.view().ready === true, null, {
    timeout: 20_000,
  });
}

async function callTool(page: Page, name: string, input: unknown): Promise<any> {
  return page.evaluate(
    ([toolName, args]) => (window as any).threshold.core.handler(toolName)(args, {}),
    [name, input] as const,
  );
}

/** Report the rule and the element, so a failure is actionable rather than a count. */
async function auditable(page: Page): Promise<string[]> {
  const results = await new AxeBuilder({ page })
    .withTags(TAGS)
    // The provider frames are other origins' documents, deliberately off-screen and aria-hidden.
    // Auditing them here would report another site's markup as this page's failure.
    .exclude('#provider-frames')
    .analyze();
  return results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

test.beforeEach(async ({ request }) => {
  for (const origin of PROVIDER_ORIGINS) {
    await request.post(`${origin}/api/reset`, { data: { token: 'demo-reset' } });
  }
});

test('the hub, before anything has been asked', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  expect(await auditable(page)).toEqual([]);
});

test('the hub, with results and a failing plan on screen', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  const search = await callTool(page, 'find_support', GOLDEN_NEED);
  await callTool(page, 'check_plan', {
    search_id: search.data.search_id,
    parts: [
      { role: 'placement', provider_id: 'respite-a', resource_id: 'R17' },
      { role: 'transport', provider_id: 'transport-a', resource_id: 'T4' },
      { role: 'cover', provider_id: 'homecare-a', resource_id: 'H3' },
    ],
  });
  await expect(page.locator('.link.bad')).toHaveCount(1);

  // The failing link is red *and* carries a glyph and a sentence. Nothing on this page is encoded
  // by colour alone, which axe checks in part and the markup guarantees in full.
  expect(await auditable(page)).toEqual([]);
});

test('the consent panel, which is the screen that has to work', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  const search = await callTool(page, 'find_support', GOLDEN_NEED);
  const held = await callTool(page, 'place_hold', {
    search_id: search.data.search_id,
    match_id: 'R17',
  });

  const pending = page.evaluate(
    (holdId) =>
      (window as any).threshold.core.handler('make_referral')(
        {
          hold_id: holdId,
          person_name: 'Ada Okafor',
          contact_method: 'phone',
          contact_value: '07700 900461',
          preferred_contact_window: 'now',
        },
        {},
      ),
    held.data.hold_id,
  );

  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await auditable(page)).toEqual([]);

  // And with a validation error showing, since an error message that is not associated with its
  // field is an error message a screen reader user never hears.
  await page.locator('#consent-name').fill('');
  await page.getByRole('button', { name: 'Send referral' }).click();
  await expect(page.locator('.field-error')).toBeVisible();
  expect(await auditable(page)).toEqual([]);

  await page.keyboard.press('Escape');
  await pending;
});

test('the provider pages, which are somebody else’s website', async ({ page }) => {
  for (const origin of PROVIDER_ORIGINS) {
    await page.goto(`${origin}/?control`);
    await expect(page.locator('#status')).toBeVisible();
    const violations = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    expect(
      violations.violations.map((v) => `${origin} ${v.id}`),
      `accessibility violations on ${origin}`,
    ).toEqual([]);
  }
});

test('/verify, which a judge reads without touching anything', async ({ page }) => {
  await page.goto('/verify.html');
  await expect(page.locator('.verdict')).toBeVisible({ timeout: 20_000 });
  expect(await auditable(page)).toEqual([]);
});
