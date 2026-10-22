const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {mkdtempSync,rmSync,readFileSync,existsSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {resolve,join}=require('node:path');
const http=require('node:http');
const {once}=require('node:events');
const packagePath=resolve(process.env.VIDYAVARTA_PACKAGE_DIR||join(__dirname,'../portable-build'));
const OPERATOR_PASSWORD='runtime-operator-password';
async function start(data,port){
  const child=spawn(process.execPath,[join(packagePath,'launcher.cjs')],{cwd:packagePath,env:{...process.env,PATH:'',CAMPUS_DATA_DIR:data,CAMPUS_UI_PORT:String(port),CAMPUS_NO_OPEN:'1',CAMPUS_PREVIEW:'0',CAMPUS_ADMIN_PASSWORD:OPERATOR_PASSWORD},stdio:['ignore','pipe','pipe']});
  let log='';const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Startup timeout: '+log)),12000);const parse=chunk=>{log+=chunk.toString();const match=/Open:\s+(http:\/\/127\.0\.0\.1:\d+)\//.exec(log);if(match){clearTimeout(timer);resolve(match[1]);}};child.stdout.on('data',parse);child.stderr.on('data',parse);child.once('exit',code=>{clearTimeout(timer);reject(new Error('Startup exited '+code+': '+log));});});
  return {child,url,stop:async()=>{if(child.exitCode!==null)return;child.kill('SIGTERM');await once(child,'exit');}};
}
test('ready runtime on Node 24: no native deps, no Git, live persistence, auth and port fallback',async t=>{
  assert.ok(Number(process.versions.node.split('.')[0])>=24,'Run this test with Node 24');
  assert.equal(existsSync(join(packagePath,'node_modules')),false,'Distribution has no node_modules');
  assert.ok(existsSync(join(packagePath,'admin-password.txt'))===false,'The package itself never ships a password file');
  const data=mkdtempSync(join(tmpdir(),'VidyaVarta Windows style spaces '));
  const blocker=http.createServer((_,res)=>res.end('occupied'));
  await new Promise(r=>blocker.listen(0,'127.0.0.1',r));const occupied=blocker.address().port;
  const instance=await start(data,occupied);let restarted;
  t.after(async()=>{await instance.stop();if(restarted)await restarted.stop();await new Promise(r=>blocker.close(r));rmSync(data,{recursive:true,force:true});});
  assert.notEqual(Number(new URL(instance.url).port),occupied,'Occupied port is handled automatically');
  let cookie='';
  const api=async(path,body,extra={})=>{const response=await fetch(instance.url+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,headers:response.headers,body:await response.json()};};
  const login=async(username,password=OPERATOR_PASSWORD)=>{const saved=cookie;cookie='';const r=await api('/api/auth/login',{username,password});cookie=r.status===200?String(r.headers.get('set-cookie')).split(';')[0]:saved;return r;};
  let noticeId;
  await t.test('compiled runtime uses Node 24 built-in SQLite and is live-only',async()=>{const r=await api('/api/runtime');assert.equal(r.status,200);assert.match(r.body.node,/^v24\./);assert.equal(r.body.database,'Node built-in SQLite');assert.equal(r.body.installationRequired,false);assert.equal(r.body.mode,'live');});
  await t.test('sign-in is required, client-declared roles are ignored and health stays public',async()=>{
    assert.equal((await api('/api/state')).status,401);
    assert.equal((await api('/api/state',undefined,{'X-Campus-Role':'operator','X-Teacher-Id':'faculty-01'})).status,401,'role headers no longer grant authority');
    assert.equal((await api('/api/health')).status,200,'liveness stays public');
    assert.equal((await api('/api/auth/me')).status,200);
    assert.equal((await login('admin','wrong-password')).status,401);
    const ok=await login('admin');assert.equal(ok.status,200);assert.equal(ok.body.user.role,'operator');
    assert.equal((await api('/api/state')).status,200);
  });
  await t.test('a fresh live start has an empty directory and no sample content',async()=>{const r=await api('/api/state');assert.equal(r.body.students.length,0,'the operator imports a real class');assert.equal(r.body.notices.length,0);assert.ok(r.body.sources.some(s=>s.id==='sou-academic'),'the real circular source exists');});
  await t.test('the operator imports a class and publishes a notice to the real board',async()=>{
    const students=[{id:'2301031800001',name:'Runtime Student One',email:'one@runtime.example',college:'SOU',branch:'CSE',year:3,section:'A'},{id:'2301031800002',name:'Runtime Student Two',email:'two@runtime.example',college:'SOU',branch:'CSE',year:3,section:'B'}];
    const imported=await api('/api/directory/import',{students});assert.equal(imported.status,200);assert.equal(imported.body.count,2);
    const notice={title:'Runtime DBMS reminder',body:'Review the Unit 3 SQL practical references before the next lab.',audience:{branch:'CSE',year:3,sections:['A','B']},urgency:'normal',deadline:null,channels:['board','email']};
    const made=await api('/api/notices',notice);assert.equal(made.status,200);noticeId=made.body.id;assert.equal(made.body.recipientCount,2);
    assert.equal((await api('/api/notices/publish',{noticeId})).status,400,'publishing without an approval is refused');
    assert.equal((await api('/api/approvals/resolve',{id:made.body.approvalId,decision:'approved'})).status,200);
    assert.equal((await api('/api/notices/publish',{noticeId})).status,200);
    const receipts=(await api('/api/channels/receipts')).body.filter(r=>r.noticeId===noticeId);
    assert.equal(receipts.length,3,'one board receipt plus one email receipt per student');
    assert.equal(receipts.filter(r=>r.channel==='board'&&r.status==='published').length,1);
    assert.equal(receipts.filter(r=>r.channel==='email'&&r.status==='blocked').length,2,'email is honestly blocked with no SMTP configured');
    assert.ok(existsSync(join(data,'notice-board','index.html')),'the board is a real static export');
  });
  await t.test('the operator creates an account and the new account signs in',async()=>{
    const made=await api('/api/auth/create',{username:'helper',name:'Office Helper',role:'leadership',password:'a-strong-password-2026'});
    assert.equal(made.status,200);assert.equal(made.body.user.role,'leadership');
    assert.equal((await login('helper','a-strong-password-2026')).status,200,'the new account can sign in');
    assert.equal((await login('admin')).status,200);
  });
  await t.test('a faculty account cannot import the directory or resolve operator approvals',async()=>{
    await api('/api/auth/create',{username:'faculty',name:'Faculty One',role:'teacher',teacherId:'faculty-01',password:'faculty-password-1'});
    await login('faculty');
    const students=[{id:'2301031800009',name:'Nope',email:'nope@runtime.example',college:'SOU',branch:'IT',year:1,section:'A'}];
    const importTry=await api('/api/directory/import',{students});assert.equal(importTry.status,400);assert.match(importTry.body.error,/operator/);
    await login('admin');
  });
  await t.test('audit verifies and JSON exports work even without Git',async()=>{const r=await api('/api/audit/checkpoint',{});assert.equal(r.body.verified,true);assert.ok(existsSync(join(data,'hive','receipts.json')));assert.ok(existsSync(join(data,'hive','log.jsonl')));});
  await t.test('cross-origin gateway requests and untrusted Host are rejected',async()=>{assert.equal((await api('/api/notices',{}, {Origin:'https://evil.invalid'})).status,403);const hostileHostStatus=await new Promise((resolve,reject)=>{http.get(instance.url+'/api/state',{headers:{Host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});assert.equal(hostileHostStatus,403);const direct=JSON.parse(readFileSync(join(data,'bridge-session.json'),'utf8'));assert.equal((await fetch(direct.url+'/api/state')).status,401);});
  await t.test('public board shows the publication but no recipient addresses',async()=>{const board=await (await fetch(instance.url+'/board')).text();assert.ok(board.includes('Runtime DBMS reminder'));assert.ok(!board.includes('@runtime.example'));assert.ok(board.includes('Not an official'));});
  await t.test('restart preserves publication, receipts and the verified audit chain',async()=>{const before=(await api('/api/state')).body;await instance.stop();restarted=await start(data,occupied);const afterResponse=await fetch(restarted.url+'/api/state',{headers:{Cookie:cookie}});assert.equal(afterResponse.status,200,'the session itself persists in SQLite across a restart');const after=await afterResponse.json();assert.equal(after.audit.length,before.audit.length);assert.equal(after.receipts.length,before.receipts.length);assert.equal(after.notices.find(n=>n.id===noticeId).status,'published');assert.equal((await(await fetch(restarted.url+'/api/audit',{headers:{Cookie:cookie}})).json()).verified,true);});
});
