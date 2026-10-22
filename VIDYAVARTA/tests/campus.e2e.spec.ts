import {test,expect} from '@playwright/test';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
const ADMIN_PASSWORD=process.env.CAMPUS_ADMIN_PASSWORD??'e2e-operator-password';
async function signIn(page:import('@playwright/test').Page,user='admin',password=ADMIN_PASSWORD){await page.goto('/');await expect(page.getByTestId('login-screen')).toBeVisible();await page.getByTestId('login-user').fill(user);await page.getByTestId('login-pass').fill(password);await page.getByTestId('login-submit').click();await expect(page.getByTestId('login-screen')).toBeHidden();}

test('live sign-in: no quick accounts, wrong passwords refused, operator welcomed',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/');await expect(page.getByTestId('login-screen')).toBeVisible();
  await expect(page.getByTestId('quick-admin')).toHaveCount(0);
  await page.getByTestId('login-user').fill('admin');await page.getByTestId('login-pass').fill('totally-wrong-password');await page.getByTestId('login-submit').click();
  await expect(page.getByRole('alert')).toContainText(/Invalid username or password/);
  await page.getByTestId('login-pass').fill(ADMIN_PASSWORD);await page.getByTestId('login-submit').click();
  await expect(page.getByTestId('login-screen')).toBeHidden();
  await expect(page.getByText('Good things are happening.')).toBeVisible();
  await expect(page.getByText('LIVE · LOCAL')).toBeVisible();
  expect(errors).toEqual([]);
});

test('import a class, publish a notice, and read honest receipts on the real board',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const csv='name,email,branch,year,section\nE2E Student One,e2e1@student.example.edu,CSE,3,A\nE2E Student Two,e2e2@student.example.edu,CSE,3,B\n';
  const csvPath=join(tmpdir(),`vidyavarta-e2e-${Date.now()}.csv`);writeFileSync(csvPath,csv);
  const title=`E2E SQL lab notice ${Date.now()}`;
  await signIn(page);
  await page.getByRole('button',{name:'Student directory',exact:true}).click();
  await page.setInputFiles('input[aria-label="Import students CSV file"]',csvPath);
  await expect(page.getByText('2 students ready to import')).toBeVisible();
  await page.getByRole('button',{name:'Import 2 students'}).click();
  await expect(page.locator('.recipient-total strong')).toHaveText('2');
  await page.getByRole('button',{name:'Campus overview',exact:true}).click();
  await page.getByRole('button',{name:'Create notice',exact:true}).click();
  const dialog=page.getByRole('dialog');
  await dialog.getByLabel('Notice title').fill(title);
  await dialog.getByLabel('Message',{exact:true}).fill('Practice SQL joins and normalization before the next DBMS laboratory session.');
  await expect(dialog.getByText('2 recipients')).toBeVisible();
  await dialog.getByRole('button',{name:'Create & review'}).click();
  const card=page.locator('.approval-card').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await card.getByRole('button',{name:'Approve & publish'}).click();await expect(card).toHaveCount(0);
  await page.getByRole('button',{name:'Notices & delivery',exact:true}).click();
  const notice=page.locator('.notice-card').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await expect(notice.getByText('published',{exact:true})).toBeVisible();
  await notice.getByRole('button',{name:'View receipts'}).click();
  await expect(page.getByRole('dialog').locator('tbody tr')).toHaveCount(3);
  await expect(page.getByRole('dialog').getByText('blocked',{exact:true})).toHaveCount(2);
  await page.getByRole('button',{name:'Close dialog'}).click();
  await page.getByRole('button',{name:'Open notice board',exact:false}).first().click();
  const frame=page.frameLocator('iframe[title="Public campus notice board"]');
  await expect(frame.getByRole('heading',{name:title,exact:true})).toBeVisible();
  await page.screenshot({path:'artifacts/notice-board.png'});expect(errors).toEqual([]);
});

test('watcher is live-only, audit verifies, and navigation works on mobile',async({page})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await signIn(page);
  await page.getByRole('button',{name:'Circular watcher',exact:true}).click();
  await expect(page.getByRole('button',{name:'Replay demo'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Scan now'}).first()).toBeVisible();
  await page.getByRole('button',{name:'Activity & audit',exact:true}).click();
  await page.getByRole('button',{name:'Verify & checkpoint'}).click();
  await expect(page.getByRole('status')).toContainText('Audit chain verified');
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Toggle navigation'}).click();
  await page.getByRole('button',{name:'Campus overview',exact:true}).click();
  await expect(page.getByText('Good things are happening.')).toBeVisible();
  await expect(page.locator('body')).toHaveJSProperty('scrollWidth',390);
  await page.screenshot({path:'artifacts/campus-mobile.png',fullPage:true});
  expect(errors).toEqual([]);
});
