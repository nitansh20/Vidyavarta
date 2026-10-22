import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/campus/store';
import { SecretBroker } from '../src/campus/secrets';
import { Integrations } from '../src/campus/integrations';
import { CampusService } from '../src/campus/service';
import { createBridge } from '../src/campus/server';
import { AuthService, AuthError } from '../src/campus/auth';
import type { Actor } from '../src/campus/types';
const operator: Actor = { agent: 'Michael', behalf: 'operator', human: true, role: 'operator' };
const FIRST_PASSWORD = 'initial-operator-password';
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'vidyavarta-auth-'));
  const store = new Store(dir), broker = new SecretBroker(dir, randomBytes(32));
  const service = new CampusService(store, new Integrations(broker, {}));
  const auth = new AuthService(store, { adminPassword: FIRST_PASSWORD });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, store, auth, dir };
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function operatorUser(auth: AuthService) {
  const row = (auth as unknown as { byUsername: (u: string) => { id: string; username: string; name: string; role: string } }).byUsername('admin');
  return { id: row.id, username: row.username, name: row.name, role: row.role } as Parameters<AuthService['listUsers']>[0];
}

test('passwords are scrypt-hashed with unique salts and never stored in plain text', () => {
  const { auth } = fixture(test);
  const admin = auth.listUsers(operatorUser(auth)).find(u => u.username === 'admin');
  assert.ok(admin);
  const row = (auth as unknown as { byUsername: (u: string) => { passwordHash: string } }).byUsername('admin');
  assert.match(row.passwordHash, /^scrypt\$16384\$8\$1\$/);
  const again = (auth as unknown as { hash: (p: string) => string }).hash('some-other-password');
  assert.notEqual(again.split('$')[4], row.passwordHash.split('$')[4], 'each account uses its own salt');
});

test('live seed creates exactly one operator account without leaking hashes', () => {
  const { auth } = fixture(test);
  const users = auth.listUsers(operatorUser(auth));
  assert.deepEqual(users.map(u => u.username).sort(), ['admin']);
  assert.deepEqual(Object.keys(users.find(u => u.username === 'admin')!).sort(), ['id', 'name', 'role', 'username'], 'public shape only');
  assert.equal(JSON.stringify(users).includes('scrypt'), false, 'no password material in public users');
});

test('correct credentials sign in, set lastLoginAt and audit the sign-in', () => {
  const { auth, store } = fixture(test);
  const result = auth.login({ username: 'Admin', password: FIRST_PASSWORD }, '127.0.0.1');
  assert.equal(result.user.username, 'admin');
  assert.equal(result.user.role, 'operator');
  assert.match(result.token, /^[a-f0-9]{64}$/);
  assert.ok(auth.userForToken(result.token));
  assert.ok(store.audits().some(a => a.action === 'auth.login.success' && a.resourceId === 'admin'));
});

test('wrong password is a generic 401, increments the failure counter and is audited', () => {
  const { auth, store } = fixture(test);
  assert.throws(() => auth.login({ username: 'admin', password: 'wrong-password' }, '127.0.0.1'), (e: AuthError) => e.status === 401 && /Invalid username or password/.test(e.message));
  assert.throws(() => auth.login({ username: 'ghost', password: 'wrong-password' }, '127.0.0.1'), (e: AuthError) => e.status === 401);
  assert.ok(store.audits().filter(a => a.action === 'auth.login.failed').length >= 2);
});

test('five consecutive failures lock the account even for the correct password', () => {
  const { auth } = fixture(test);
  const op = operatorUser(auth);
  auth.createUser(op, { username: 'faculty', name: 'Faculty One', role: 'teacher', teacherId: 'faculty-01', password: 'faculty-password-1' });
  for (let i = 0; i < 5; i++) assert.throws(() => auth.login({ username: 'faculty', password: `wrong-${i}` }, '127.0.0.1'), /Invalid username or password|locked/);
  assert.throws(() => auth.login({ username: 'faculty', password: 'faculty-password-1' }, '127.0.0.1'), (e: AuthError) => e.status === 423 && /locked/i.test(e.message), 'correct password does not bypass the lock');
  const other = auth.login({ username: 'admin', password: FIRST_PASSWORD }, '127.0.0.1');
  assert.ok(other.token, 'lockout is per account, not global');
});

test('lockout expires and a successful sign-in clears the failure counter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vidyavarta-authlock-'));
  const store = new Store(dir); const auth = new AuthService(store, { adminPassword: FIRST_PASSWORD, lockAttempts: 2, lockSeconds: 1 });
  try {
    assert.throws(() => auth.login({ username: 'admin', password: 'nope-1' }, '127.0.0.1'), /Invalid/);
    assert.throws(() => auth.login({ username: 'admin', password: 'nope-2' }, '127.0.0.1'), /locked/i);
    await sleep(1100);
    const ok = auth.login({ username: 'admin', password: FIRST_PASSWORD }, '127.0.0.1');
    assert.ok(ok.token);
    assert.throws(() => auth.login({ username: 'admin', password: 'nope-3' }, '127.0.0.1'), /Invalid/, 'counter restarted, not still locked');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('sign-in attempts from one device are rate limited', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vidyavarta-authrate-'));
  const store = new Store(dir); const auth = new AuthService(store, { adminPassword: FIRST_PASSWORD });
  try {
    let limited = false;
    for (let i = 0; i < 35; i++) { try { auth.login({ username: 'admin', password: FIRST_PASSWORD }, '10.9.9.9'); } catch (e) { if ((e as AuthError).status === 429) { limited = true; break; } } }
    assert.equal(limited, true, '30 attempts per 5 minutes then 429');
    assert.ok(auth.login({ username: 'admin', password: FIRST_PASSWORD }, 'other-device'), 'other devices unaffected');
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('sessions expire, sign-out invalidates, and tokens are stored hashed', async () => {
  const { auth, store } = fixture(test);
  const { token } = auth.login({ username: 'admin', password: FIRST_PASSWORD }, '127.0.0.1');
  const rows = store.db.prepare('SELECT tokenHash,userId,expiresAt FROM sessions').all() as { tokenHash: string; expiresAt: string }[];
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(token), 'raw session token is never persisted');
  store.db.prepare('UPDATE sessions SET expiresAt=?').run(new Date(Date.now() - 1000).toISOString());
  assert.equal(auth.userForToken(token), null, 'expired session is rejected');
  assert.equal((store.db.prepare('SELECT COUNT(*) c FROM sessions').get() as { c: number }).c, 0, 'expired session row is purged');
  const { token: live } = auth.login({ username: 'admin', password: FIRST_PASSWORD }, '127.0.0.1');
  assert.ok(auth.userForToken(live));
  auth.logout(live);
  assert.equal(auth.userForToken(live), null, 'sign-out invalidates immediately');
  assert.ok(store.audits().some(a => a.action === 'auth.logout'));
  auth.logout('not-a-real-token');
});

test('actors derive from the account: teacher maps to their course identity, viewer is read-only', () => {
  const { auth, service, store } = fixture(test);
  const op = operatorUser(auth);
  auth.createUser(op, { username: 'rmehta', name: 'Dr. Ravi Mehta', role: 'teacher', teacherId: 'faculty-01', password: 'faculty-password-1' });
  auth.createUser(op, { username: 'guest', name: 'Read Only', role: 'viewer', password: 'guest-password-123' });
  const teacherUser = auth.login({ username: 'rmehta', password: 'faculty-password-1' }, '127.0.0.1').user;
  const actor = auth.actorFor(teacherUser);
  assert.deepEqual([actor.role, actor.behalf, actor.human], ['teacher', 'faculty-01', true]);
  const guest = auth.login({ username: 'guest', password: 'guest-password-123' }, '127.0.0.1').user;
  assert.equal(auth.actorFor(guest).role, 'viewer');
  const students = [{ id: '2301031800001', name: 'Asha Patel', email: 'asha@student.example.edu', college: 'SOU', branch: 'CSE' as const, year: 3, section: 'A' as const }];
  service.importStudents(students, operator);
  const notice = service.createNotice({ title: 'DBMS practical reminder', body: 'Review the Unit 3 SQL practical references before the next lab.', audience: { branch: 'CSE', year: 3, sections: ['A'] }, urgency: 'normal', deadline: null, channels: ['board'] }, operator);
  assert.throws(() => service.resolveApproval(notice.approvalId!, 'approved', auth.actorFor(guest)), /responsible role/, 'viewer cannot approve');
  assert.throws(() => service.resolveApproval(notice.approvalId!, 'approved', auth.actorFor(teacherUser)), /responsible role/, 'teacher cannot approve an operator approval');
  service.resolveApproval(notice.approvalId!, 'approved', auth.actorFor(auth.login({ username: 'admin', password: FIRST_PASSWORD }, '127.0.0.1').user));
  assert.ok(store.audits().some(a => a.action === 'approval.approved'));
});

test('password change verifies the current password and signs out other sessions', () => {
  const { auth } = fixture(test);
  const first = auth.login({ username: 'admin', password: FIRST_PASSWORD }, '127.0.0.1');
  assert.throws(() => auth.changePassword(first.user, { current: 'wrong-current', next: 'brand-new-password-2026' }), /Current password is incorrect/);
  assert.ok(auth.changePassword(first.user, { current: FIRST_PASSWORD, next: 'brand-new-password-2026' }));
  assert.equal(auth.userForToken(first.token), null, 'old sessions are signed out');
  assert.ok(auth.login({ username: 'admin', password: 'brand-new-password-2026' }, '127.0.0.1').token);
  assert.throws(() => auth.login({ username: 'admin', password: FIRST_PASSWORD }, '127.0.0.1'), /Invalid/);
});

test('only the operator can create accounts; duplicates and weak passwords are refused', () => {
  const { auth } = fixture(test);
  const admin = auth.login({ username: 'admin', password: FIRST_PASSWORD }, '127.0.0.1').user;
  auth.createUser(admin, { username: 'rmehta', name: 'Dr. Ravi Mehta', role: 'teacher', teacherId: 'faculty-01', password: 'faculty-password-1' });
  const teacher = auth.login({ username: 'rmehta', password: 'faculty-password-1' }, '127.0.0.1').user;
  assert.throws(() => auth.createUser(teacher, { username: 'helper', name: 'Helper', role: 'viewer', password: 'long-enough-password' }), (e: AuthError) => e.status === 403);
  const created = auth.createUser(admin, { username: 'helper', name: 'Team Helper', role: 'leadership', password: 'long-enough-password' });
  assert.equal(created.role, 'leadership');
  assert.ok(auth.login({ username: 'helper', password: 'long-enough-password' }, '127.0.0.1').token);
  assert.throws(() => auth.createUser(admin, { username: 'helper', name: 'Dup', role: 'viewer', password: 'long-enough-password' }), /already taken/);
  assert.throws(() => auth.createUser(admin, { username: 'weakpw', name: 'Weak', role: 'viewer', password: 'short' }), /10/);
});

test('a fresh live start prints a one-time operator password file and stays single-account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vidyavarta-bridge-seed-'));
  const bridge = await createBridge({ directory: dir, port: 0, scheduled: false });
  try {
    assert.deepEqual(bridge.auth.listUsers(operatorUser(bridge.auth)).map(u => u.username), ['admin']);
    const passwordFile = readFileSync(join(dir, 'admin-password.txt'), 'utf8');
    const initial = /admin \/ (\S+)/.exec(passwordFile)?.[1];
    assert.ok(initial, 'the initial password is recoverable from the data folder');
    const { user } = bridge.auth.login({ username: 'admin', password: initial }, '127.0.0.1');
    assert.equal(user.role, 'operator');
  } finally { await bridge.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('only the operator creates accounts; lists are denied to teachers', () => {
  const { auth } = fixture(test);
  const op = operatorUser(auth);
  const created = auth.createUser(op, { username: 'rmehta', name: 'Dr. Ravi Mehta', role: 'teacher', teacherId: 'faculty-02', password: 'strong-passphrase-1' });
  assert.equal(created.role, 'teacher');
  assert.equal(created.teacherId, 'faculty-02');
  const users = auth.listUsers(op);
  assert.ok(users.some(u => u.username === 'rmehta'));
  const teacher = auth.listUsers(op).find(u => u.username === 'rmehta')!;
  assert.throws(() => auth.listUsers(teacher as never), /operator/);
  assert.throws(() => auth.createUser({ ...op, role: 'teacher' } as never, { username: 'nope', name: 'No Right', role: 'viewer', password: 'strong-passphrase-2' }), /operator/);
  const login = auth.login({ username: 'rmehta', password: 'strong-passphrase-1' }, '127.0.0.1');
  assert.equal(login.user.role, 'teacher');
  assert.throws(() => auth.login({ username: 'rmehta', password: 'wrong-password-long' }, '127.0.0.1'), AuthError);
});
