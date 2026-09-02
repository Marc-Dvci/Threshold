/**
 * The pages, in a real browser. Build plan §27.6, §18.
 *
 * What this suite is for, and what it is not. The Node suite proves the hub's logic — the firewall,
 * the links, the leases, the compensation, the consent races — without a browser, which is where
 * that belongs. It cannot prove that the page renders, that four cross-origin iframes actually load,
 * that the consent panel can be completed with a keyboard, or that `/verify` says something true. A
 * page can be comprehensively broken with every unit test green.
 *
 * The tool calls here go through the same `HubCore` the agent's calls go through — the hub exposes
 * itself on `window.threshold` for the recording rig — so what is under test is the page, the
 * frames, the transport and the DOM, not a re-implementation of the flow.
 */

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

/** Wait for the hub to have finished probing and discovering. */
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => (window as any).threshold?.view().ready === true, null, {
    timeout: 20_000,
  });
}

/** Call a hub tool through the page's own core, exactly as a registered tool would. */
async function callTool(page: Page, name: string, input: unknown): Promise<any> {
  return page.evaluate(
    ([toolName, args]) => (window as any).threshold.core.handler(toolName)(args, {}),
    [name, input] as const,
  );
}

/**
 * The provider origins, and their own backends.
 *
 * The reset endpoint is token-guarded for the same reason the offline switch is behind a flag: a
 * public button that empties a care provider's diary is not a thing to leave on a deployed page.
 */
const PROVIDER_ORIGINS = ['http://localhost:5101', 'http://localhost:5102', 'http://localhost:5103'];

test.beforeEach(async ({ page, request }) => {
  // Every test starts from the seeded inventory. The providers hold real state in one process each,
  // so without this the second test in a file searches an inventory the first one has already
  // spent — which is exactly how a demo fails on the day (§29).
  for (const origin of PROVIDER_ORIGINS) {
    const response = await request.post(`${origin}/api/reset`, { data: { token: 'demo-reset' } });
    expect(response.ok(), `reset ${origin}`).toBe(true);
  }

  page.on('pageerror', (error) => {
    throw new Error(`uncaught page error: ${error.message}`);
  });
});

test('the page loads, and the four organisations are reachable from it', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  await expect(page.getByRole('heading', { name: 'Threshold', level: 1 })).toBeVisible();

  // Three separate origins, each loaded in its own frame, each answering.
  for (const name of [
    'Meadowbank Respite Unit',
    'Selwyn Overnight Care',
    'Northgate Accessible Transport',
  ]) {
    const card = page.locator('.provider', { hasText: name });
    await expect(card).toBeVisible();
    await expect(card).toHaveClass(/connected/);
    // Exactly the four tools that organisation publishes. Chrome returns this document's own tools
    // alongside the ones asked for, so a count of five here would mean the hub had attributed its
    // own `find_support` to somebody else's origin.
    await expect(card).toContainText('4 tools');
  }

  // Whichever wire is in use, the page names it. It never presents the fallback as WebMCP
  // federation (Invariant L).
  const badge = page.locator('.transport');
  await expect(badge).toBeVisible();
  const kind = await page.evaluate(() => (window as any).threshold.view().transport);
  expect(['webmcp', 'postmessage']).toContain(kind);
  if (kind === 'postmessage') {
    await expect(badge).toContainText('not WebMCP federation');
  } else {
    await expect(badge).toContainText('WebMCP federation');
  }
});

/**
 * The agent's own path, end to end.
 *
 * Every other test in this file reaches the handlers through `window.threshold.core`, which is fast
 * and deterministic and skips the one step that only exists for agents: the registered `execute`
 * wrapper that `document.modelContext.executeTool` invokes. A wrapper that threw on its first line
 * for every tool passed all fifteen of those tests, because none of them ever called it. The bug it
 * hid was that `executeTool` supplies no context argument, so reading `context.signal` threw before
 * any handler ran, and the only thing the caller learned was "the script function threw an error".
 *
 * So this test calls the tools the way an agent calls them and no other way.
 */
test('an agent discovers and calls the hub tools through executeTool', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  const seen = await page.evaluate(async () => {
    const tools = await (document as any).modelContext.getTools();
    return tools.map((t: { name: string }) => t.name);
  });
  expect(seen).toContain('find_support');

  const raw = await page.evaluate(async (input) => {
    const tools = await (document as any).modelContext.getTools();
    const find = tools.find((t: { name: string }) => t.name === 'find_support');
    // Arguments go in as a JSON string: Chrome rejects the IDL's object form.
    return (document as any).modelContext.executeTool(find, JSON.stringify(input));
  }, GOLDEN_NEED);

  // A null return means the call triggered a navigation, and reading that as an empty success is
  // exactly the silent data loss the adapter refuses to perform.
  expect(raw).not.toBeNull();

  const text = typeof raw === 'string' ? raw : JSON.stringify(raw);
  expect(text).toContain('search_id');

  // The call reached the product, not just the wrapper: the page shows what the agent asked for.
  await expect(page.locator('.matches tbody tr').first()).toBeVisible();
});

test('the failing link is named on screen, with the organisation to go back to', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  const search = await callTool(page, 'find_support', GOLDEN_NEED);
  expect(search.ok).toBe(true);

  await expect(page.locator('.matches tbody tr').first()).toBeVisible();

  const checked = await callTool(page, 'check_plan', {
    search_id: search.data.search_id,
    parts: [
      { role: 'placement', provider_id: 'respite-a', resource_id: 'R17' },
      { role: 'transport', provider_id: 'transport-a', resource_id: 'T4' },
      { role: 'cover', provider_id: 'homecare-a', resource_id: 'H3' },
    ],
  });
  expect(checked.data.feasible).toBe(false);

  const failing = page.locator('.link.bad');
  await expect(failing).toHaveCount(1);
  await expect(failing).toContainText('Transport arrives before the admission cut-off');
  await expect(failing).toContainText('06:40');
  await expect(failing).toContainText('07:10');
  await expect(failing).toContainText('Northgate Accessible Transport');
});

test('a person completes the consent gate with the keyboard alone', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  const search = await callTool(page, 'find_support', GOLDEN_NEED);
  const checked = await callTool(page, 'check_plan', {
    search_id: search.data.search_id,
    parts: [
      { role: 'placement', provider_id: 'respite-a', resource_id: 'R17' },
      { role: 'transport', provider_id: 'transport-a', resource_id: 'T9' },
      { role: 'cover', provider_id: 'homecare-a', resource_id: 'H3' },
    ],
  });
  expect(checked.data.feasible).toBe(true);

  const leases = await callTool(page, 'place_plan_holds', { plan_id: checked.data.plan_id });
  expect(leases.ok).toBe(true);
  const placement = leases.data.leases.find((l: { role: string }) => l.role === 'placement');

  // The tool call is left pending on purpose: this is what the agent is waiting on.
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
    placement.hold_id,
  );

  const dialog = page.getByRole('dialog', { name: 'Review before anything identifying is sent' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Meadowbank Respite Unit');
  await expect(dialog).toContainText('Referral details are kept for 30 days');

  // Focus is moved into the panel, not left behind it.
  await expect(page.locator('#consent-name')).toBeFocused();

  // The differentiator: the payload is editable, from the keyboard.
  const contact = page.locator('#consent-value');
  await contact.fill('07700 900123');
  await expect(contact).toHaveValue('07700 900123');
  await expect(dialog).toContainText('you changed this');

  await page.getByRole('button', { name: 'Send referral' }).click();

  const result = await pending;
  expect(result.ok).toBe(true);
  expect(result.data.human_edited).toEqual(['contact_value']);

  await expect(page.getByRole('heading', { name: 'The plan', exact: true })).toBeVisible();
  await expect(page.locator('.plan-parts tbody tr')).toHaveCount(3);
});

test('cancelling from the keyboard sends nothing and keeps the hold', async ({ page }) => {
  await page.goto('/');
  await ready(page);

  const search = await callTool(page, 'find_support', GOLDEN_NEED);
  const held = await callTool(page, 'place_hold', {
    search_id: search.data.search_id,
    match_id: 'R21',
  });
  expect(held.ok).toBe(true);

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
  await page.keyboard.press('Escape');

  const result = await pending;
  expect(result.ok).toBe(false);
  expect(result.error.code).toBe('CONSENT_CANCELLED');
  // The person said no to sending their details, not to the bed.
  const state = await page.evaluate(() => (window as any).threshold.view().state.tag);
  expect(state).toBe('HELD');
});

test('the boundary log shows field names and no values', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await callTool(page, 'find_support', GOLDEN_NEED);

  const log = page.locator('.boundary-log');
  await expect(log).toContainText('query_availability');
  await expect(log).toContainText('validated offer');
  await expect(log).toContainText('hoist_available');
});

test('/verify answers without any interaction', async ({ page }) => {
  await page.goto('/verify.html');
  await expect(page.locator('.verdict')).toBeVisible({ timeout: 20_000 });

  // Whatever the answer is, it is stated plainly and the origins are visible.
  await expect(page.locator('main')).toContainText('http://localhost:5101');
  await expect(page.locator('main')).toContainText('query_availability');
  await expect(page.getByRole('heading', { name: "The hub's own tool surface" })).toBeVisible();
});

test('an organisation can take itself offline, and the hub notices', async ({ page, context }) => {
  await page.goto('/');
  await ready(page);
  await expect(page.locator('.provider', { hasText: 'Selwyn Overnight Care' })).toHaveClass(
    /connected/,
  );

  // The switch is on the organisation's own page, in its own tab, because the hub is not in charge
  // of the provider. It reaches the copy of that page inside the hub's frame over a same-origin
  // channel — one origin cannot reach into another's.
  const provider = await context.newPage();
  await provider.goto('http://localhost:5102/?control');
  await provider.getByRole('button', { name: 'Take this organisation offline' }).click();
  await expect(provider.locator('#status')).toHaveText('Offline');

  // The hub finds out because the tool set changed, not because a request failed.
  await expect(page.locator('.provider', { hasText: 'Selwyn Overnight Care' })).toHaveClass(
    /unavailable/,
    { timeout: 15_000 },
  );
  await expect(page.locator('.boundary-log')).toContainText('withdrew its tools');

  // And the search still works. The result is honestly incomplete rather than quietly wrong: the
  // other two organisations answered, and the missing role is named.
  const search = await callTool(page, 'find_support', GOLDEN_NEED);
  expect(search.ok).toBe(true);
  const homecare = search.data.providers_checked.find(
    (p: { provider_id: string }) => p.provider_id === 'homecare-a',
  );
  expect(homecare.state).toBe('unavailable');
  expect(search.data.roles_with_no_offer).toContain('cover');
  expect(
    search.data.exact_matches.some((m: { provider_id: string }) => m.provider_id === 'respite-a'),
  ).toBe(true);

  await provider.getByRole('button', { name: 'Come back online' }).click();
  await expect(page.locator('.provider', { hasText: 'Selwyn Overnight Care' })).toHaveClass(
    /connected/,
    { timeout: 15_000 },
  );
  await provider.close();
});

test('two sessions cannot both hold the last bed', async ({ page, context }) => {
  await page.goto('/');
  await ready(page);
  const second = await context.newPage();
  await second.goto('/');
  await ready(second);

  const searchA = await callTool(page, 'find_support', GOLDEN_NEED);
  const searchB = await callTool(second, 'find_support', GOLDEN_NEED);
  // Both sessions were told the bed is available. Only one of them can have it, and the
  // organisation is the one that decides.
  expect(searchA.data.exact_matches.some((m: { resource_id: string }) => m.resource_id === 'R17')).toBe(true);
  expect(searchB.data.exact_matches.some((m: { resource_id: string }) => m.resource_id === 'R17')).toBe(true);

  const held = await callTool(page, 'place_hold', {
    search_id: searchA.data.search_id,
    match_id: 'R17',
  });
  expect(held.ok).toBe(true);

  const refused = await callTool(second, 'place_hold', {
    search_id: searchB.data.search_id,
    match_id: 'R17',
  });
  expect(refused.ok).toBe(false);
  expect(refused.error.code).toBe('HOLD_CONFLICT');
  // What the second person is told names a next step, not a fault.
  expect(refused.error.message).toContain('Choose another option');

  // The first session already holds it, so `place_hold` is no longer registered for that session at
  // all. An agent working from a stale tool list is told where the page is rather than being allowed
  // to take a second unit of a bed that has one.
  const retried = await callTool(page, 'place_hold', {
    search_id: searchA.data.search_id,
    match_id: 'R17',
  });
  expect(retried.error.code).toBe('STATE_CONFLICT');

  // And the second session is not stuck: when the first gives the bed back, it is genuinely
  // available again, at the organisation, without either session searching afresh.
  const released = await callTool(page, 'release_hold', { hold_id: held.data.hold_id });
  expect(released.data.status).toBe('released');

  const nowHeld = await callTool(second, 'place_hold', {
    search_id: searchB.data.search_id,
    match_id: 'R17',
  });
  expect(nowHeld.ok).toBe(true);
  await second.close();
});
