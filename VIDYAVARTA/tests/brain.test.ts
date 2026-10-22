import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../src/campus/store';
import { CampusService } from '../src/campus/service';
import { Integrations } from '../src/campus/integrations';
import { SecretBroker } from '../src/campus/secrets';
import { extractJson, type Brain, type BrainStatus } from '../src/campus/brain';
import type { Actor, WatchEvent } from '../src/campus/types';

function fixture(t:test.TestContext,brain?:Brain){
  const dir=mkdtempSync(join(tmpdir(),'vidyavarta-brain-'));
  const store=new Store(dir),broker=new SecretBroker(dir,randomBytes(32));
  const service=new CampusService(store,new Integrations(broker,{}),true,brain);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  return {service,store};
}
const operator:Actor={agent:'Michael',behalf:'operator',human:true,role:'operator'};
const goodStatus=(available:boolean):BrainStatus=>({configured:true,model:'fake-model',host:'http://127.0.0.1:9',available,checkedAt:new Date().toISOString(),error:available?null:'not reachable'});
function fakeBrain(answer:object|string|(object|string)[],available=true):Brain{
  const queue=Array.isArray(answer)?answer.slice():[answer];
  return { model:'fake-model', status:()=>goodStatus(available), probe:async()=>goodStatus(available), chat:async()=>{ const next=queue.length>1?queue.shift()!:queue[0]; if(next instanceof Error)throw next; return typeof next==='string'?next:JSON.stringify(next); } } as unknown as Brain;
}
function seedEvent(store:Store){const e:WatchEvent={id:'ev-brain-1',sourceId:'sou-academic',title:'Academic Calendar 2026-27 published',url:'https://silveroakuni.ac.in/circulars/academic/academic-calendar-2026-27',change:'new',category:'academic',urgency:'normal',detectedAt:new Date().toISOString(),noticeId:'',date:'2026-05-15'};store.put('events',e);return e;}

test('extractJson accepts plain, fenced and rejects garbage',()=> {
  assert.deepEqual(extractJson('{"kind":"topic"}'),{kind:'topic'});
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'),{a:1});
  assert.equal(extractJson('the model said no json'),null);
  assert.equal(extractJson('{"cut'),null);
});

test('Scribe uses the brain when reachable, keeps identity fields server-side',async t=>{
  const {service}=fixture(t,fakeBrain({kind:'assignment',title:'SQL joins practice set',body:'Solve every exercise in the joins worksheet before the next lab.',links:[],dueDate:'2026-08-10',points:20,courseId:'networks',points2:null}));
  const r=await service.command('Create a 20 points assignment on SQL joins due 2026-08-10','dbms',operator);
  assert.equal(r.engine,'ollama');
  assert.equal(r.action.kind,'assignment');
  assert.equal(r.action.points,20);
  assert.equal(r.action.dueDate,'2026-08-10');
  assert.equal(r.action.courseId,'dbms');
  assert.ok(r.issues.some(i=>i.includes('Ollama brain')));
});

test('Unsafe or unusable brain answers fall back to the template draft',async t=>{
  const garbage=fixture(t,fakeBrain('this is not json at all'));
  const g=await garbage.service.command('Announce a DBMS lab in Room 204. Bring your laptop.','dbms',operator);
  assert.equal(g.engine,'template');
  assert.ok(g.issues.some(i=>i.includes('not usable')));
  const broken=fixture(t,fakeBrain(new Error('boom'),true));
  const b=await broken.service.command('Announce a DBMS lab in Room 204.','dbms',operator).catch(e=>{throw e;});
  assert.equal(b.engine,'template');
  assert.ok(b.issues.some(i=>i.includes('could not be reached')));
  const away=fixture(t,fakeBrain('{}',false));
  const a=await away.service.command('Announce a DBMS lab in Room 204.','dbms',operator);
  assert.equal(a.engine,'template');
});

test('mergeBrainDraft never takes points, dates or links that fail validation',async t=>{
  const {service}=fixture(t,fakeBrain({kind:'assignment',title:'OK title for the set',body:'A completely valid and long enough body.',points:150,dueDate:'tomorrow',links:['http://insecure.example','https://safe.example/page']}));
  const r=await service.command('Create an assignment on normalization','dbms',operator);
  assert.equal(r.action.points,undefined);
  assert.equal(r.action.dueDate,undefined);
  assert.deepEqual(r.action.links,['https://safe.example/page']);
});

test('brainNotice drafts from the latest watched circular and audits it',async t=>{
  const {service,store}=fixture(t,fakeBrain({title:'Academic calendar 2026-27 is published',body:'The university has published the academic calendar for 2026-27 on the official website. Students should check the key teaching and examination dates.',urgency:'critical'}));
  seedEvent(store);
  const r=await service.brainNotice(operator);
  assert.ok(r.title.length>=4 && r.body.length>=10);
  assert.equal(r.urgency,'critical');
  assert.ok(r.url.startsWith('https://'));
  assert.ok(service.snapshot().audit.some(a=>a.action==='notice.brain_drafted'));
});

test('brainNotice refuses to run without a brain, offline brain, or events',async t=>{
  const none=fixture(t);
  await assert.rejects(()=>none.service.brainNotice(operator),/brain is not available/);
  const offline=fixture(t,fakeBrain('{}',false));
  await assert.rejects(()=>offline.service.brainNotice(operator),/not reachable/);
  const empty=fixture(t,fakeBrain({title:'A title that is long enough',body:'A body that is also long enough to pass.'}));
  await assert.rejects(()=>empty.service.brainNotice(operator),/No circulars have been watched/);
});

test('snapshot exposes the brain status and health keeps working without one',t=>{
  const withBrain=fixture(t,fakeBrain('{}'));
  const snap=withBrain.service.snapshot();
  assert.equal(snap.integrations.ollama?.model,'fake-model');
  const without=fixture(t);
  assert.equal(without.service.snapshot().integrations.ollama,null);
});

const draftAnswer={kind:'assignment',title:'SQL joins practice set',body:'Solve the exercises on SQL joins.',links:[],dueDate:null,points:20,topic:null,issues:[]};
const paperAnswer={mcqs:[{question:'Which join returns only matching rows?',options:['INNER JOIN','FULL JOIN','CROSS JOIN','NONE'],answer:1},{question:'A LEFT JOIN keeps unmatched rows from which table?',options:['Right','Left','Neither','Both'],answer:2}],short:[{question:'Explain the difference between WHERE and HAVING.',marks:3},{question:'Define a composite key with one example.',marks:2}]};

test('assignment requests build a real question paper with MCQs and short answers',async t=>{
  const {service}=fixture(t,fakeBrain([draftAnswer,paperAnswer]));
  const r=await service.command('Create a 20 points assignment on SQL joins with 5 MCQs and 2 short answers','dbms',operator);
  assert.equal(r.engine,'ollama');
  assert.match(r.action.body,/Section A - Multiple choice questions/);
  assert.match(r.action.body,/Q1\. Which join returns only matching rows\?/);
  assert.match(r.action.body,/Answer: A/);
  assert.match(r.action.body,/Section B - Short answer questions/);
  assert.match(r.action.body,/SQ2\. Define a composite key with one example\. \(2 marks\)/);
  assert.ok(r.issues.some(i=>i.includes('question paper')));
});

test('invalid MCQs are dropped and an unusable paper leaves the body untouched',async t=>{
  const bad={mcqs:[{question:'Too few options?',options:['A','B'],answer:1},{question:'Bad answer index',options:['A','B','C','D'],answer:9}],short:[{question:'ok question here',marks:400}]};
  const dropped=fixture(t,fakeBrain([draftAnswer,bad]));
  const d=await dropped.service.command('Create an assignment with mcqs on joins','dbms',operator);
  assert.equal(d.engine,'ollama');
  assert.equal(d.action.body,draftAnswer.body);
  const garbage=fixture(t,fakeBrain([draftAnswer,'not json']));
  const g=await garbage.service.command('Create an assignment with mcqs on joins','dbms',operator);
  assert.equal(g.action.body,draftAnswer.body);
  assert.ok(g.issues.some(i=>i.includes('after 2 tries')));
  const offline=fixture(t,fakeBrain([draftAnswer,paperAnswer],false));
  const o=await offline.service.command('Create an assignment with mcqs','dbms',operator);
  assert.equal(o.engine,'template');
  assert.ok(!o.action.body.includes('Section A'));
});

test('brainNotice can draft from any watched document of a source',async t=>{
  const {service,store}=fixture(t,fakeBrain({title:'Exam form notice drafted',body:'The examination section has published the exam form schedule on the university website. Students should verify dates and submit on time.',urgency:'normal'}));
  const src=store.all<import('../src/campus/types').WatchSource>('sources').find(s=>s.id==='sou-academic')!;
  const first={url:'https://silveroakuni.ac.in/circulars/academic/exam-form.pdf',title:'Exam form circular',date:'2026-10-01'};
  store.put('sources',{...src,items:[first,...src.items]});
  const r=await service.brainNotice(operator,{sourceId:'sou-academic',url:first.url});
  assert.equal(r.url,first.url);
  assert.ok(r.title.length>=4);
  const wrong=fixture(t,fakeBrain({title:'x',body:'y'}));
  await assert.rejects(()=>wrong.service.brainNotice(operator,{sourceId:'sou-academic',url:'https://silveroakuni.ac.in/not-watched.pdf'}),/not in the watched list/);
});

test('the model cannot downgrade an assignment request to an announcement',async t=>{
  const {service}=fixture(t,fakeBrain([{...draftAnswer,kind:'announcement',points:null},paperAnswer]));
  const r=await service.command('Create a 20 points assignment on SQL joins with 5 MCQs and 2 short answers','dbms',operator);
  assert.equal(r.action.kind,'assignment');
  assert.ok(r.issues.some(i=>i.includes('Kept as a grade-bearing assignment')));
  assert.match(r.action.body,/Section A - Multiple choice questions/);
});

test('letter answer keys (A-D) and string marks are accepted from the model',async t=>{
  const letters={mcqs:[{question:'Which join keeps unmatched left rows?',options:['RIGHT','LEFT','INNER','CROSS'],answer:'B'},{question:'What does a foreign key reference?',options:['A primary key','A view','An index','A trigger'],answer:'A'}],short:[{question:'Define third normal form.',marks:'3'}]};
  const {service}=fixture(t,fakeBrain([draftAnswer,letters]));
  const r=await service.command('Create a 20 points assignment on joins with mcqs and short answers','dbms',operator);
  assert.match(r.action.body,/Answer: B/);
  assert.match(r.action.body,/Answer: A/);
  assert.match(r.action.body,/SQ1\. Define third normal form\. \(3 marks\)/);
});

test('unusable paper: one retry, then honest guidance instead of a fake paper',async t=>{
  const {service}=fixture(t,fakeBrain([draftAnswer,'not json','also not json']));
  const r=await service.command('Create a 20 points assignment on joins with mcqs','dbms',operator);
  assert.equal(r.action.kind,'assignment');
  assert.ok(!r.action.body.includes('Section A'));
  assert.ok(r.issues.some(i=>i.includes('after 2 tries')));
  assert.ok(r.issues.some(i=>i.includes('ollama pull qwen2.5:7b')));
});
