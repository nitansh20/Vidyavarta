import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Store } from './store';
import type { Actor, Role } from './types';
export type AccountRole = Role;
export interface UserAccount { id: string; username: string; name: string; role: AccountRole; teacherId?: string; passwordHash: string; active: boolean; createdAt: string; lastLoginAt?: string; failedAttempts: number; lockedUntil?: string }
export interface PublicUser { id: string; username: string; name: string; role: AccountRole; teacherId?: string; lastLoginAt?: string }
export interface LoginResult { token: string; expiresAt: string; user: PublicUser }
export class AuthError extends Error { constructor(message: string, readonly status: number) { super(message); } }
const credentials = z.object({ username: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{3,32}$/, 'Username must be 3-32 characters (letters, numbers, dash, underscore).'), password: z.string().min(6).max(200) });
const newUserSchema = credentials.extend({ name: z.string().trim().min(2).max(80), role: z.enum(['operator', 'teacher', 'leadership', 'viewer']), teacherId: z.enum(['faculty-01', 'faculty-02']).optional(), password: z.string().min(10).max(200) });
const N = 16384, R = 8, P = 1, KEYLEN = 64;
export class AuthService {
  private attempts = new Map<string, number[]>();
  readonly sessionHours: number; readonly lockAttempts: number; readonly lockSeconds: number; private adminPassword?: string;
  constructor(private store: Store, options: { sessionHours?: number; lockAttempts?: number; lockSeconds?: number; adminPassword?: string } = {}) {
    this.sessionHours = options.sessionHours ?? 12; this.lockAttempts = options.lockAttempts ?? 5; this.lockSeconds = options.lockSeconds ?? 300; this.adminPassword = options.adminPassword;
    store.db.exec(`CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(tokenHash TEXT PRIMARY KEY,userId TEXT NOT NULL,createdAt TEXT NOT NULL,expiresAt TEXT NOT NULL);`);
    if (!this.all().length) this.seed();
    this.purgeExpired();
  }
  private hash(password: string, salt?: Buffer) { const s = salt ?? randomBytes(16); const key = scryptSync(password, s, KEYLEN, { N, r: R, p: P }); return `scrypt$${N}$${R}$${P}$${s.toString('hex')}$${key.toString('hex')}`; }
  private verify(password: string, stored: string) { const [tag, n, r, p, salt, key] = stored.split('$'); if (tag !== 'scrypt') return false; const computed = scryptSync(password, Buffer.from(salt, 'hex'), KEYLEN, { N: Number(n), r: Number(r), p: Number(p) }); return computed.length === key.length / 2 && timingSafeEqual(computed, Buffer.from(key, 'hex')); }
  private seed() {
    // Live mode seeds ONLY the operator. The team creates the real faculty/leadership
    // accounts from the UI, so no account is ever locked behind an unknown password.
    // Set CAMPUS_ADMIN_PASSWORD in .env to choose the initial password (headless setups);
    // otherwise a strong random password is generated and printed once.
    const accounts: Array<Omit<UserAccount, 'id' | 'passwordHash' | 'active' | 'createdAt' | 'failedAttempts'>> = [
      { username: 'admin', name: 'Campus Operator', role: 'operator' }];
    for (const account of accounts) this.write({ ...account, id: `user_${account.username}`, passwordHash: this.hash(randomBytes(18).toString('base64url')), active: true, createdAt: new Date().toISOString(), failedAttempts: 0 });
    const envPassword = process.env.CAMPUS_ADMIN_PASSWORD;
    const chosen = this.adminPassword ?? envPassword;
    if (envPassword && envPassword.length < 10) { console.error('[auth] CAMPUS_ADMIN_PASSWORD must be at least 10 characters - using a random password instead.'); }
    const password = chosen && chosen.length >= 10 ? chosen : randomBytes(12).toString('base64url').replace(/[^a-zA-Z0-9]/g, 'A');
    this.store.db.prepare("UPDATE users SET data=json_set(data,'$.passwordHash',?) WHERE username='admin'").run(this.hash(password));
    console.log(`[auth] Initial admin password (change it after first sign-in): admin / ${password}`);
    try { writeFileSync(join(this.store.directory, 'admin-password.txt'), `One-time initial admin password (printed at first live start on ${new Date().toISOString()})\n\n  admin / ${password}\n\nChange the password after signing in, then delete this file.\n`, { mode: 0o600 }); console.log('[auth] A copy was saved to ' + join(this.store.directory, 'admin-password.txt')); } catch { /* the terminal copy above still stands */ }
  }
  private write(user: UserAccount) { this.store.db.prepare('INSERT INTO users(id,username,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET username=excluded.username,data=excluded.data').run(user.id, user.username, JSON.stringify(user)); return user; }
  private read(row: { data: string }): UserAccount { return JSON.parse(row.data); }
  private all(): UserAccount[] { return (this.store.db.prepare('SELECT data FROM users ORDER BY username').all() as { data: string }[]).map(r => this.read(r)); }
  private byUsername(username: string) { const row = this.store.db.prepare('SELECT data FROM users WHERE username=?').get(username) as { data: string } | undefined; return row ? this.read(row) : undefined; }
  private byId(id: string) { const row = this.store.db.prepare('SELECT data FROM users WHERE id=?').get(id) as { data: string } | undefined; return row ? this.read(row) : undefined; }
  publicUser(user: UserAccount): PublicUser { const { id, username, name, role, teacherId, lastLoginAt } = user; return { id, username, name, role, ...(teacherId ? { teacherId } : {}), ...(lastLoginAt ? { lastLoginAt } : {}) }; }
  listUsers(actor: PublicUser): PublicUser[] {
    if (actor.role !== 'operator') { this.store.audit(this.actorFor(actor), 'auth.access_denied', 'users', `Account listing denied for role ${actor.role}.`); throw new AuthError('Only the campus operator can manage accounts.', 403); }
    return this.all().filter(u => u.active).map(u => this.publicUser(u));
  }
  actorFor(user: PublicUser): Actor { const role = user.role; const behalf = role === 'teacher' ? (user.teacherId ?? 'faculty-01') : role === 'operator' ? 'operator' : role === 'leadership' ? 'leadership' : user.username; return { agent: 'Michael', behalf, role, human: true }; }
  login(input: unknown, ip: string): LoginResult {
    const nowMs = Date.now(); const window = (this.attempts.get(ip) ?? []).filter(t => nowMs - t < 5 * 60_000);
    if (window.length >= 30) { this.attempts.set(ip, [...window, nowMs]); throw new AuthError('Too many sign-in attempts from this device. Wait five minutes.', 429); }
    this.attempts.set(ip, [...window, nowMs]);
    const { username, password } = credentials.parse(input);
    const user = this.byUsername(username);
    if (!user || !user.active) { this.store.audit({ agent: 'System', behalf: 'auth' }, 'auth.login.failed', username || 'unknown', 'Unknown or disabled account.'); throw new AuthError('Invalid username or password.', 401); }
    if (user.lockedUntil && Date.parse(user.lockedUntil) > nowMs) throw new AuthError(`Account temporarily locked. Try again after ${new Date(user.lockedUntil).toLocaleTimeString('en-IN')}.`, 423);
    if (!this.verify(password, user.passwordHash)) {
      const failedAttempts = user.failedAttempts + 1;
      const locked = failedAttempts >= this.lockAttempts; const lockedUntil = locked ? new Date(nowMs + this.lockSeconds * 1000).toISOString() : user.lockedUntil;
      this.write({ ...user, failedAttempts: locked ? 0 : failedAttempts, ...(locked ? { lockedUntil } : {}) });
      this.store.audit({ agent: 'System', behalf: 'auth' }, locked ? 'auth.login.locked' : 'auth.login.failed', username, locked ? `Account locked for ${this.lockSeconds}s after ${failedAttempts} failed attempts.` : `Failed sign-in (${failedAttempts}/${this.lockAttempts}).`);
      throw new AuthError(locked ? `Too many failed attempts. Account locked for ${this.lockSeconds} seconds.` : 'Invalid username or password.', locked ? 423 : 401);
    }
    const token = randomBytes(32).toString('hex'); const createdAt = new Date(nowMs); const expiresAt = new Date(nowMs + this.sessionHours * 3600_000);
    this.store.db.prepare('INSERT INTO sessions(tokenHash,userId,createdAt,expiresAt) VALUES(?,?,?,?)').run(createHash('sha256').update(token).digest('hex'), user.id, createdAt.toISOString(), expiresAt.toISOString());
    this.write({ ...user, failedAttempts: 0, lastLoginAt: createdAt.toISOString() });
    this.store.audit({ agent: 'System', behalf: 'auth' }, 'auth.login.success', user.username, `Signed in with role ${user.role} from ${ip === '127.0.0.1' ? 'this machine' : ip}.`);
    return { token, expiresAt: expiresAt.toISOString(), user: this.publicUser({ ...user, lastLoginAt: createdAt.toISOString() }) };
  }
  private tokenHash(token: string) { return createHash('sha256').update(token).digest('hex'); }
  userForToken(token: string): PublicUser | null {
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const row = this.store.db.prepare('SELECT userId,expiresAt FROM sessions WHERE tokenHash=?').get(this.tokenHash(token)) as { userId: string; expiresAt: string } | undefined;
    if (!row) return null;
    if (Date.parse(row.expiresAt) <= Date.now()) { this.store.db.prepare('DELETE FROM sessions WHERE tokenHash=?').run(this.tokenHash(token)); return null; }
    const user = this.byId(row.userId); return user && user.active ? this.publicUser(user) : null;
  }
  logout(token: string) {
    const user = this.userForToken(token);
    this.store.db.prepare('DELETE FROM sessions WHERE tokenHash=?').run(this.tokenHash(token));
    if (user) this.store.audit({ agent: 'System', behalf: 'auth' }, 'auth.logout', user.username, 'Session ended.');
    return user;
  }
  changePassword(user: PublicUser, input: unknown) {
    const { current, next } = z.object({ current: z.string().min(1), next: z.string().min(10).max(200) }).parse(input);
    const account = this.byId(user.id); if (!account) throw new AuthError('Account not found.', 401);
    if (!this.verify(current, account.passwordHash)) throw new AuthError('Current password is incorrect.', 400);
    this.write({ ...account, passwordHash: this.hash(next), failedAttempts: 0 });
    this.store.db.prepare('DELETE FROM sessions WHERE userId=?').run(user.id);
    this.store.audit({ agent: 'System', behalf: 'auth' }, 'auth.password.changed', user.username, 'Password changed; all sessions signed out.');
    return true;
  }
  createUser(actor: PublicUser, input: unknown): PublicUser {
    if (actor.role !== 'operator') { this.store.audit(this.actorFor(actor), 'auth.access_denied', 'users', `Account creation denied for role ${actor.role}.`); throw new AuthError('Only the campus operator can manage accounts.', 403); }
    const parsed = newUserSchema.parse(input);
    if (this.byUsername(parsed.username)) throw new AuthError('That username is already taken.', 400);
    const user = this.write({ id: `user_${randomBytes(6).toString('hex')}`, username: parsed.username, name: parsed.name, role: parsed.role, ...(parsed.teacherId ? { teacherId: parsed.teacherId } : {}), passwordHash: this.hash(parsed.password), active: true, createdAt: new Date().toISOString(), failedAttempts: 0 });
    this.store.audit(this.actorFor(actor), 'auth.user.created', user.username, `Account created with role ${user.role}.`);
    return this.publicUser(user);
  }
  private purgeExpired() { this.store.db.prepare('DELETE FROM sessions WHERE expiresAt<=?').run(new Date().toISOString()); }
}
