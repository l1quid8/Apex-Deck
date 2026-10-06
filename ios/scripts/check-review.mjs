import { chromium, expect } from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({viewport:{width:393,height:852}});
const base = process.env.MOCKUP_URL || 'http://127.0.0.1:5187';
expect.configure({timeout:1200});
const failures = [];
const check = async (name, fn) => {
  try { await fn(); console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error.message}`); }
};
await check('step 18 deep link enables large text and leaving resets it', async () => {
  await page.goto(`${base}/#pick-eighteen`);
  await expect(page.getByRole('button',{name:'Type: large',exact:true})).toBeVisible();
  await expect(page.locator('.mf-name-short')).toBeVisible();
  await expect(page.locator('.mf-header-path')).toBeHidden();
  await page.getByRole('combobox',{name:'Review step'}).selectOption('pick-twelve');
  await expect(page.getByRole('button',{name:'Type: default',exact:true})).toBeVisible();
});
for (const step of ['pick-twelve','pick-nineteen']) await check(`${step} header stays visible after scrolling`, async () => {
  await page.goto(`${base}/#${step}`);
  await page.locator('.phone-content').evaluate(n => n.scrollTop = n.scrollHeight);
  const title = await page.locator('.chat-heading').boundingBox();
  const top = await page.locator('.phone-header').boundingBox();
  expect(title.y).toBeGreaterThanOrEqual(top.y + top.height);
});
await check('Mac fork does not inherit a pending server approval',async () => {
  await page.goto(`${base}/#pick-sixteen`);
  await page.getByRole('textbox',{name:'Message this thread'}).fill('Continue here');
  await page.getByRole('button',{name:'Send to machine'}).click();
  await expect(page.locator('.approval-card')).toHaveCount(0);
});
for (const [label, value] of [
  ['Copy folder path','root@hetzner-eu:/root/apex-deck'],
  ['Copy last reply','Pretend clipboard: Starting it in Hetzner-EU’s copy of apex-deck.'],
  ['Copy thread ID',/thr_[a-z0-9]+/],
  ['Copy as Markdown','apex-deck · Hetzner-EU · /root/apex-deck'],
]) await check(`step 14 opens Copy and ${label}`,async () => {
  await page.goto(`${base}/#pick-fourteen`);
  await page.reload();
  await page.getByRole('button',{name:label,exact:true}).click({timeout:1200});
  await expect(page.getByRole('status')).toContainText(value);
});
await check('pinned threads do not repeat under projects and load test starts hidden', async () => {
  await page.goto(`${base}/#pick-one`);
  await expect(page.locator('.mf-nested').getByRole('button',{name:/Signing check/})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/Load test the new PDF export/})).toHaveCount(0);
});
await check('sending load test strips tool tokens and reveals one canonical thread',async () => {
  await page.goto(`${base}/#pick-eleven`);
  await page.getByRole('button',{name:'Docker · Claude',exact:true}).click();
  await page.getByRole('button',{name:'Send to machine'}).click();
  await expect(page.locator('.chat-heading h2')).toHaveText('Load test the new PDF export');
  await page.getByRole('button',{name:'Threads',exact:true}).first().click();
  await expect(page.locator('.mf-nested').getByRole('button',{name:/^Load test the new PDF export/})).toHaveCount(1);
});
await check('asleep projects show offline and scratch selection explains pause',async () => {
  await page.goto(`${base}/#pick-nineteen`);
  await page.getByRole('button',{name:/^Project /}).click();
  await page.getByRole('button',{name:'Don’t work in a project',exact:true}).click();
  await expect(page.locator('.toast')).toContainText('asleep');
  await page.getByRole('button',{name:'Close sheet'}).click();
  await page.getByRole('button',{name:'Threads',exact:true}).first().click();
  const mac = page.locator('.mf-project-group').filter({has:page.getByRole('button',{name:'Project actions apex-deck Tyler’s MacBook'})});
  await expect(mac.locator('.mf-dot').first()).toHaveClass(/mf-off/);
  await mac.locator('.mf-item').first().dispatchEvent('contextmenu');
  await expect(page.getByRole('dialog')).toContainText('Asleep');
  await expect(page.getByRole('button',{name:'Pin project',exact:true})).toBeVisible();
});
await check('Settings connection Cancel returns to Machines',async () => {
  await page.goto(`${base}/#machines`);
  await page.getByRole('button',{name:/Edit connection.*Apex-Terminal/}).click();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Machines',exact:true})).toBeVisible();
});
await browser.close();
if(failures.length) throw Error(`${failures.length} review regressions: ${failures.join(', ')}`);
console.log('Review regressions passed');
