import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/campus/store';
import { SecretBroker } from '../src/campus/secrets';
import { Integrations } from '../src/campus/integrations';
import { CampusService } from '../src/campus/service';
import type { Actor, Notice, Receipt, WatchSource } from '../src/campus/types';
interface CapturedMessage { from: string; to: string[]; data: string }
/** A minimal but faithful SMTP server: greets, EHLO (no STARTTLS), AUTH PLAIN, MAIL, RCPT, DATA, QUIT. */
function fakeSmtp(options: { rejectRecipients?: string[]; failData?: boolean } = {}): Promise<{ close: () => void; port: number; messages: CapturedMessage[] }> {
  const messages: CapturedMessage[] = [];
  const server = net.createServer(socket => {
    let buffer = ''; let inData = false; let from = ''; let to: string[] = []; let body = '';
    socket.write('220 fake.vidyavarta.test ESMTP\r\n');
    socket.on('data', chunk => {
      if (inData) {
        body += chunk.toString();
        if (body.endsWith('\r\n.\r\n')) {
          inData = false;
          if (options.failData) socket.write('451 4.3.0 temporary local problem\r\n');
          else { messages.push({ from, to: [...to], data: body }); socket.write('250 2.0.0 OK queued\r\n'); }
          to = []; from = ''; body = '';
        }
        return;
      }
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-fake.vidyavarta.test\r\n250-SIZE 10485760\r\n250 8BITMIME\r\n');
        else if (verb === 'AUTH') socket.write('235 2.7.0 Accepted\r\n');
        else if (verb === 'MAIL') { from = line; socket.write('250 2.1.0 OK\r\n'); }
        else if (verb === 'RCPT') {
          const address = (/<([^>]+)>/.exec(line)?.[1] ?? line.slice(8)).trim().toLowerCase();
          if (options.rejectRecipients?.includes(address)) socket.write('550 5.1.1 recipient rejected\r\n');
          else { to.push(address); socket.write('250 2.1.5 OK\r\n'); }
        }
        else if (verb === 'DATA') { inData = true; body = ''; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (verb === 'QUIT') { socket.write('221 2.0.0 Bye\r\n'); socket.end(); }
        else if (verb === 'RSET') { to = []; from = ''; socket.write('250 2.0.0 OK\r\n'); }
        else socket.write('250 2.0.0 OK\r\n');
      }
    });
  });
  return new Promise(resolve => { server.listen(0, '127.0.0.1', () => resolve({ close: () => server.close(), port: (server.address() as net.AddressInfo).port, messages })); });
}
const operator: Actor = { agent: 'Michael', behalf: 'operator', human: true, role: 'operator' };
const notice = { title: 'DBMS practical reminder', body: 'Review the Unit 3 SQL practical references before the next lab.', audience: { branch: 'CSE' as const, year: 3, sections: ['A', 'B'] }, urgency: 'normal' as const, deadline: '2026-10-01', channels: ['board', 'email'] as ('board' | 'email')[] };
function smtpEnv(port: number, extra: Record<string, string> = {}): Record<string, string> {
  return { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: 'campus', SMTP_PASS: 'app-password', SMTP_FROM: 'VidyaVarta <office@vidyavarta.invalid>', SMTP_ALLOWLIST: '@example.invalid', SMTP_REQUIRE_TLS: '0', ...extra };
}
function cohort(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `2301031800${String(i + 1).padStart(3, '0')}`, name: `Test Student ${i + 1}`, email: `student${String(i + 1).padStart(2, '0')}@example.invalid`, college: 'SOU', branch: 'CSE' as const, year: 3, section: (i % 2 ? 'B' : 'A') as 'A' | 'B' }));
}
function liveFixture(t: test.TestContext, env: Record<string, string>, students = 6) {
  const dir = mkdtempSync(join(tmpdir(), 'vidyavarta-email-'));
  const store = new Store(dir), broker = new SecretBroker(dir, randomBytes(32));
  const integrations = new Integrations(broker, env);
  const service = new CampusService(store, integrations);
  if (students) service.importStudents(cohort(students), operator);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, store, integrations, broker };
}
const disableScans = (store: Store) => { for (const s of store.all<WatchSource>('sources')) { s.enabled = false; store.put('sources', s); } };
const approveAndPublish = async (service: CampusService) => { const n = service.createNotice(notice, operator) as Notice; service.resolveApproval(n.approvalId!, 'approved', operator); await service.publishNotice(n.id, operator); return n; };

test('live publish delivers 30 real SMTP messages and records honest sent receipts', async t => {
  const smtp = await fakeSmtp(); t.after(() => smtp.close());
  const { service, store } = liveFixture(t, smtpEnv(smtp.port));
  const n = await approveAndPublish(service);
  assert.equal(smtp.messages.length, 6, 'one SMTP transaction per recipient');
  assert.equal(new Set(smtp.messages.map(m => m.to[0])).size, 6, 'recipients are unique');
  const receipts = store.all<Receipt>('receipts').filter(r => r.noticeId === n.id);
  assert.equal(receipts.filter(r => r.channel === 'email' && r.status === 'sent').length, 6);
  assert.ok(receipts.filter(r => r.channel === 'email').every(r => r.messageId && r.attempts === 1));
  const sample = smtp.messages[0];
  assert.match(sample.data, /From: VidyaVarta <office@vidyavarta\.invalid>/);
  assert.match(sample.data, /Subject: \[UNOFFICIAL STUDENT PROJECT\] DBMS practical reminder/);
  assert.match(sample.data, /Content-Type: text\/html/, 'an HTML alternative part is included');
  assert.match(sample.data, /Deadline: 2026-10-01/);
  assert.match(sample.data, /not issued by Silver Oak University/);
  assert.ok(store.audits().filter(a => a.action === 'email.sent').length >= 6);
  const digest = service.snapshot().digest;
  assert.equal(digest.recipients, 6);
  assert.equal(digest.failed, 0);
});

test('a rejected recipient fails with a recorded error and a later tick retries it successfully', async t => {
  const smtp = await fakeSmtp(); t.after(() => smtp.close());
  const { service, store } = liveFixture(t, smtpEnv(smtp.port));
  const probe = liveFixture(t, smtpEnv(smtp.port));
  const victim = probe.service.resolve(notice.audience)[0].email;
  const rejecting = await fakeSmtp({ rejectRecipients: [victim] }); t.after(() => rejecting.close());
  const { service: serviceB, store: storeB, broker: brokerB } = liveFixture(t, smtpEnv(rejecting.port));
  const n = await approveAndPublish(serviceB);
  const failed = storeB.all<Receipt>('receipts').find(r => r.noticeId === n.id && r.recipient === victim)!;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error!, /550|recipient/i);
  assert.equal(failed.attempts, 1);
  assert.ok(failed.retryAt && Date.parse(failed.retryAt) > Date.now(), 'backoff is scheduled');
  assert.equal(storeB.all<Receipt>('receipts').filter(r => r.status === 'sent').length, 5, 'the other 5 were not affected');
  // Time travel past the backoff, then let the scheduler retry against the healthy server.
  disableScans(storeB);
  storeB.put<Receipt>('receipts', { ...failed, retryAt: new Date(Date.now() - 1000).toISOString() });
  serviceB.useIntegrations(new Integrations(brokerB, smtpEnv(smtp.port)));
  await serviceB.tick();
  const retried = storeB.all<Receipt>('receipts').find(r => r.noticeId === n.id && r.recipient === victim)!;
  assert.equal(retried.status, 'sent');
  assert.equal(retried.attempts, 2);
  assert.equal(smtp.messages.length, 1, 'the retry reached the healthy server');
});

test('three exhausted attempts raise an operator approval and stop retrying', async t => {
  const victim = 'cse3a-07@example.invalid';
  const rejecting = await fakeSmtp({ rejectRecipients: [victim] }); t.after(() => rejecting.close());
  const { service, store } = liveFixture(t, { ...smtpEnv(rejecting.port), SMTP_ALLOWLIST: victim });
  // Narrow the audience to the single victim by importing a one-person directory first,
  // so the approval fingerprint matches the publish-time recipient list.
  service.importStudents([{ id: '2301031800901', name: 'Victim One', email: victim, college: 'SOU', branch: 'CSE' as const, year: 3, section: 'A' as const }], operator);
  const n = service.createNotice({ ...notice, audience: { branch: 'CSE', year: 3, sections: ['A'] } }, operator);
  service.resolveApproval(n.approvalId!, 'approved', operator);
  await service.publishNotice(n.id, operator);
  disableScans(store);
  for (let round = 0; round < 2; round++) {
    const r = store.all<Receipt>('receipts').find(x => x.channel === 'email')!;
    store.put<Receipt>('receipts', { ...r, retryAt: new Date(Date.now() - 1000).toISOString() });
    await service.tick();
  }
  const final = store.all<Receipt>('receipts').find(x => x.channel === 'email')!;
  assert.equal(final.attempts, 3);
  assert.equal(final.status, 'failed');
  assert.ok(store.all('approvals').some(a => a.kind === 'error' && a.status === 'pending' && a.title.includes('Email delivery failed')), 'the operator is asked for help');
  const receiptsBefore = store.all<Receipt>('receipts').filter(x => x.channel === 'email').length;
  await service.tick();
  assert.equal(store.all<Receipt>('receipts').filter(x => x.channel === 'email').length, receiptsBefore, 'no further retries after exhaustion');
});

test('the allowlist blocks outside recipients before any connection is made', async t => {
  const smtp = await fakeSmtp(); t.after(() => smtp.close());
  const { integrations } = liveFixture(t, smtpEnv(smtp.port));
  await assert.rejects(integrations.sendEmail(notice as Notice, 'outsider@gmail.com'), /ALLOWLIST/);
  assert.equal(smtp.messages.length, 0, 'nothing left the machine');
  await assert.rejects(integrations.sendEmail(notice as Notice, 'admin@evil-example.invalid'), /ALLOWLIST/, 'suffix tricks do not pass');
  await assert.doesNotReject(integrations.sendEmail(notice as Notice, 'anyone@example.invalid'), 'whole-domain allowlist works');
});

test('subjects cannot inject headers and HTML bodies are escaped', async t => {
  const smtp = await fakeSmtp(); t.after(() => smtp.close());
  const { integrations } = liveFixture(t, smtpEnv(smtp.port));
  const hostile = { ...notice, title: 'Nice notice\r\nBcc: victim@example.invalid\r\nX-Evil: 1', body: 'Hello <script>alert(1)</script> & "friends"' } as Notice;
  await integrations.sendEmail(hostile, 'student01@example.invalid');
  const data = smtp.messages[0].data;
  const headers = data.split('\r\n\r\n')[0];
  assert.ok(!/^Bcc:/mi.test(headers) && !/^X-Evil:/mi.test(headers), 'header injection through the title is impossible');
  assert.equal(headers.split('\r\n').filter(l => l.startsWith('Subject:')).length, 1, 'exactly one Subject header');
  // The HTML part uses quoted-printable; decode it before asserting on content.
  const qpDecode = (s: string) => s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const htmlPart = qpDecode(data.split('Content-Type: text/html')[1] ?? '');
  assert.match(htmlPart, /&lt;script&gt;/, 'angle brackets are escaped');
  assert.ok(!htmlPart.includes('<script>'), 'the HTML part is escaped');
  assert.match(htmlPart, /&amp; &quot;friends&quot;/, 'ampersands and quotes are escaped');
});

test('unconfigured SMTP fails fast with a clear message', async t => {
  const { integrations } = liveFixture(t, { SMTP_HOST: '', SMTP_FROM: '', SMTP_ALLOWLIST: '' });
  await assert.rejects(integrations.sendEmail(notice as Notice, 'a@example.invalid'), /SMTP not configured|ALLOWLIST/);
});
