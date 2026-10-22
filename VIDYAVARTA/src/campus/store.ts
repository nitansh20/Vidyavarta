import Database from 'better-sqlite3';
import { mkdirSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { Actor, Audit } from './types';
export const id = (prefix: string) => `${prefix}_${randomUUID().slice(0, 8)}`;
export const now = () => new Date().toISOString();
export const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class Store {
  db: Database.Database;
  readonly hive: string;
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.hive = join(directory, 'hive');
    mkdirSync(this.hive, { recursive: true });
    this.db = new Database(join(directory, 'campus.sqlite'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit BEGIN SELECT RAISE(ABORT,'Append-only audit'); END;
      CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit BEGIN SELECT RAISE(ABORT,'Append-only audit'); END;`);
    // SQLite is authoritative; recover the export after an interrupted append.
    writeFileSync(join(this.hive, 'log.jsonl'), this.audits().map(a => JSON.stringify(a)+'\n').join(''));
    if (!existsSync(join(this.hive, '.git'))) spawnSync('git', ['init', '-q', this.hive]);
  }
  get<T>(kind: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM records WHERE kind=? AND id=?').get(kind, key) as {data: string} | undefined;
    return row && JSON.parse(row.data);
  }
  all<T>(kind: string): T[] { return (this.db.prepare('SELECT data FROM records WHERE kind=? ORDER BY rowid DESC').all(kind) as {data:string}[]).map(r => JSON.parse(r.data)); }
  put<T extends {id:string}>(kind: string, record: T): T { this.db.prepare('INSERT INTO records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data').run(kind, record.id, JSON.stringify(record)); return record; }
  remove(kind: string) { this.db.prepare('DELETE FROM records WHERE kind=?').run(kind); }
  audits(): Audit[] { return (this.db.prepare('SELECT data FROM audit ORDER BY id').all() as {data:string}[]).map(r => JSON.parse(r.data)); }
  audit(actor: Actor, action: string, resourceId: string, detail: string): Audit {
    const last = this.db.prepare('SELECT id,data FROM audit ORDER BY id DESC LIMIT 1').get() as {id:number;data:string} | undefined;
    const entry = { id: (last?.id ?? 0)+1, at: now(), agent: actor.agent, behalf: actor.behalf, action, resourceId, detail, prevHash: last ? (JSON.parse(last.data) as Audit).hash : 'genesis' };
    const result = { ...entry, hash: hash(entry) };
    this.db.prepare('INSERT INTO audit(id,data) VALUES(?,?)').run(result.id, JSON.stringify(result));
    appendFileSync(join(this.hive, 'log.jsonl'), JSON.stringify(result)+'\n');
    return result;
  }
  verify() { let prev = 'genesis'; for (const { hash: digest, ...entry } of this.audits()) { if (entry.prevHash !== prev || hash(entry) !== digest) return false; prev = digest; } return true; }
  checkpoint() {
    for (const kind of ['students','courses','notices','approvals','events','receipts','posts','reminders']) writeFileSync(join(this.hive, `${kind}.json`), JSON.stringify(this.all(kind), null, 2));
    // Single writer; git failure is visible, not mistaken for success.
    const add = spawnSync('git', ['-C', this.hive, 'add', '.']);
    if (add.status !== 0) return { ok: false, error: 'Git unavailable; SQLite and JSONL audit are intact.' };
    const status = spawnSync('git', ['-C', this.hive, 'status', '--porcelain'], { encoding: 'utf8' });
    if (status.stdout.trim()) {
      const commit = spawnSync('git', ['-C', this.hive, '-c', 'user.name=VidyaVarta', '-c', 'user.email=demo@vidyavarta.invalid', 'commit', '-qm', 'Campus checkpoint']);
      if (commit.status !== 0) return { ok: false, error: 'Git checkpoint failed; JSONL audit is intact.' };
    }
    return { ok: true };
  }
  close() { this.db.close(); }
}
