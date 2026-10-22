import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Store } from '../src/campus/store';
import { SecretBroker } from '../src/campus/secrets';
import { Integrations } from '../src/campus/integrations';
import { CampusService } from '../src/campus/service';
import type { Actor, WatchSource } from '../src/campus/types';
const operator: Actor = { agent: 'Michael', behalf: 'operator', human: true, role: 'operator' };
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), 'vidyavarta-live-'));
  const store = new Store(dir), broker = new SecretBroker(dir, randomBytes(32));
  const service = new CampusService(store, new Integrations(broker, {}));
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { service, store };
}
test('a fresh live start is genuinely empty: no sample notices, no sample students', () => {
  const { service, store } = fixture(test);
  const snapshot = service.snapshot();
  assert.equal(snapshot.notices.length, 0, 'no sample notices in live');
  assert.equal(snapshot.students.length, 0, 'live starts without a directory - the operator imports a real one');
  const academic = store.all<WatchSource>('sources').find(s => s.id === 'sou-academic')!;
  assert.equal(academic.enabled, true, 'the real circular source is watched by default');
  const exam = store.all<WatchSource>('sources').find(s => s.id === 'sou-exam')!;
  assert.equal(exam.enabled, false, 'the exam source ships disabled until the operator turns it on');
});
test('live mode imports a student directory and resolves audience addresses', () => {
  const { service } = fixture(test);
  const realStudents = [
    { id: 'TEST-STUDENT-001', name: 'Real Student One', email: 'student1@example.edu', college: 'SOU', branch: 'CSE' as const, year: 3, section: 'A' as const },
    { id: 'TEST-STUDENT-002', name: 'Real Student Two', email: 'student2@example.edu', college: 'SOU', branch: 'CSE' as const, year: 3, section: 'B' as const },
  ];
  const result = service.importStudents(realStudents, operator);
  assert.equal(result.count, 2);
  assert.equal(service.resolve({ branch: 'CSE', year: 3, sections: ['A'] })[0].email, 'student1@example.edu');
});
test('unconfigured live integrations report exactly what is missing', () => {
  const { service } = fixture(test);
  assert.equal(service.snapshot().integrations.smtp, false, 'SMTP off until configured');
  assert.equal(service.snapshot().integrations.classroom, false, 'Classroom off until configured');
});
