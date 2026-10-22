import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Store } from './store';
import { CampusService } from './service';
import { SecretBroker } from './secrets';
import { AuthService } from './auth';
import { Integrations } from './integrations';
import { Brain } from './brain';
import { parseSelector } from './directory';
import { boardHTML } from './board';
import type { Actor, Approval, Course, Notice, WatchSource } from './types';
const eq=(a:string,b:string)=>a.length===b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
export interface Bridge { service:CampusService;auth:AuthService;server:Server;token:string;humanToken:string;port:number;request:(method:string,path:string,body:unknown,actor:Actor)=>Promise<unknown>;close:()=>Promise<void> }
export async function createBridge(options:{directory:string;port?:number;broker?:SecretBroker;scheduled?:boolean;integrations?:Integrations}):Promise<Bridge>{
  const store=new Store(options.directory), broker=options.broker??new SecretBroker(options.directory,process.env.CAMPUS_SECRET_KEY?Buffer.from(process.env.CAMPUS_SECRET_KEY,'hex'):undefined);
  const brain=new Brain(process.env);
  const service=new CampusService(store,options.integrations??new Integrations(broker),true,brain);
  const auth=new AuthService(store);
  const token=randomBytes(32).toString('hex'),humanToken=randomBytes(32).toString('hex');
  // Serialize mutations, including the scheduler. This makes one-use approvals atomic across awaits.
  let queue:Promise<unknown>=Promise.resolve();
  const serialize=<T>(fn:()=>Promise<T>):Promise<T>=>{const next=queue.then(fn);queue=next.catch(()=>{});return next;};
  async function dispatch(method:string,path:string,body:unknown,actor:Actor):Promise<unknown>{
    const u=new URL(path,'http://127.0.0.1');const p=u.pathname;const input=(body??{}) as Record<string,any>;
    if(method==='GET'){
      if(p==='/api/state')return service.snapshot();
      if(p==='/api/health'){const st=brain.status();void brain.probe().catch(()=>{});return {ok:true,mode:'live',version:'1.0.0',brain:{available:st.available,model:brain.model}};}
      if(p==='/api/audit')return {verified:store.verify(),events:store.audits()};
      if(p==='/api/board')return {html:boardHTML(store.all<Notice>('notices').filter(n=>n.channels.includes('board')))};
      if(p==='/api/watch/events')return store.all('events');
      if(p==='/api/channels/receipts')return store.all('receipts');
      if(p==='/api/directory/resolve')return service.resolve(parseSelector(u.searchParams.get('selector')??''));
      if(p==='/api/classroom/courses')return store.all<Course>('courses').map(c=>({...c,connected:service.integrations.connected(c.teacherId)}));
      const m=/^\/api\/classroom\/courses\/([^/]+)\/(students|studentSubmissions|topics)$/.exec(p);
      if(m){const c=store.get<Course>('courses',m[1]);if(!c)throw new Error('Unknown course.');if(!c.liveId)throw new Error('Map the real course ID first.');if(actor.behalf!==c.teacherId&&actor.behalf!=='operator')throw new Error('Teacher mismatch.');const suffix=m[2]==='studentSubmissions'?`courseWork/${encodeURIComponent(u.searchParams.get('courseWorkId')??'-')}/studentSubmissions`:m[2];const result=await service.integrations.google(c.teacherId,`courses/${encodeURIComponent(c.liveId)}/${suffix}`);store.audit({...actor,agent:'Scribe'},`classroom.read_${m[2]}`,c.id,'Authenticated read from Google Classroom');return result;}
    }
    if(method==='POST'){
      if(p==='/api/notices')return service.createNotice(body,actor);
      if(p==='/api/directory/resolve')return service.resolve(input.audience);
      if(p==='/api/directory/import')return service.importStudents(input.students,actor);
      if(p==='/api/watch/scan')return service.scan(z.string().parse(input.sourceId),actor);
      if(p==='/api/watch/sources')return service.addSource(body,actor);
      if(p==='/api/watch/toggle'){service.requireHuman(actor);if(actor.role!=='operator')throw new Error('Only the campus operator can enable or disable watch sources.');const s=store.get<WatchSource>('sources',z.string().parse(input.sourceId));if(!s)throw new Error('Source not found');s.enabled=z.boolean().parse(input.enabled);store.put('sources',s);return s;}
      if(p==='/api/approvals/resolve')return service.resolveApproval(z.string().parse(input.id),z.enum(['approved','rejected']).parse(input.decision),actor);
      if(p==='/api/approvals/execute')return service.executeApproval(z.string().parse(input.id),actor);
      if(p==='/api/channels/board'||p==='/api/channels/email'||p==='/api/notices/publish')return service.publishNotice(z.string().parse(input.noticeId),actor);
      if(p==='/api/classroom/actions')return service.classroom(body,actor);
      const m=/^\/api\/classroom\/courses\/([^/]+)\/(announcements|courseWork|courseWorkMaterials|topics)$/.exec(p);
      if(m)return service.classroom({...input,courseId:m[1],kind:({announcements:'announcement',courseWork:'assignment',courseWorkMaterials:'material',topics:'topic'} as Record<string,string>)[m[2]]},actor);
      if(p==='/api/channels/test-email'){
        service.requireHuman(actor); const recipient=z.email().parse(input.recipient);
        const testNotice:Notice={id:'smtp-test-'+Date.now(),title:'VidyaVarta connection test',body:'This is a manually requested, unofficial student project email connection test. No student records are included.',audience:{branch:'ALL',year:null,sections:['A','B']},urgency:'normal',deadline:null,status:'published',channels:['email'],createdAt:new Date().toISOString()};
        store.audit(actor,'email.test_requested',testNotice.id,'Consenting test recipient: '+recipient);
        try {const messageId=await service.integrations.sendEmail(testNotice,recipient);store.audit(actor,'email.test_accepted',testNotice.id,'Connection test; SMTP acceptance is not a read receipt.');return {messageId};}
        catch(e){store.audit(actor,'email.test_failed',testNotice.id,(e as Error).message);throw e;}
      }
      if(p==='/api/brain/probe'){service.requireHuman(actor);return brain.probe(true);}
      if(p==='/api/brain/notice'){service.requireHuman(actor);if(actor.role!=='operator')throw new Error('Only the campus operator can draft notices from circulars.');const target={sourceId:typeof input.sourceId==='string'?input.sourceId:undefined,url:typeof input.url==='string'?input.url:undefined};return service.brainNotice(actor,target.sourceId||target.url?target:undefined);}
      if(p==='/api/command')return service.command(z.string().parse(input.text),z.string().parse(input.courseId),actor,brain);
      if(p==='/api/faq')return service.question(z.string().parse(input.courseId),z.string().min(4).max(2000).parse(input.text),actor);
      if(p==='/api/oauth/connect'){service.requireHuman(actor);const teacherId=z.enum(['faculty-01','faculty-02']).parse(input.teacherId);return {url:await service.integrations.oauthStart(teacherId)};}
      if(p==='/api/classroom/discover'){service.requireHuman(actor);const requested=z.enum(['faculty-01','faculty-02']).safeParse(input.teacherId);const teacherId=actor.role==='teacher'?(actor.behalf==='faculty-02'?'faculty-02':'faculty-01'):(requested.success?requested.data:'faculty-01');if(!service.integrations.connected(teacherId))throw new Error('This teacher is not connected to Google yet. Use the Authorize Google account button first.');
      const result=await service.integrations.google(teacherId,'courses?pageSize=80');const raw=Array.isArray((result as {courses?:unknown}).courses)?(result as {courses:{id?:string;name?:string;section?:string}[]}).courses:[];const items=raw.filter(c=>c.id).map(c=>({id:String(c.id),name:String(c.name??'Untitled course'),section:c.section?String(c.section):''}));
      store.audit({...actor,agent:'Scribe'},'classroom.discovered',teacherId,`${items.length} real course(s) read from Google Classroom`);return {items};}
            if(p==='/api/classroom/map'){service.requireHuman(actor);const c=store.get<Course>('courses',z.string().parse(input.courseId));if(!c)throw new Error('Unknown course.');c.liveId=z.string().regex(/^[a-zA-Z0-9_-]{3,100}$/).parse(input.liveId);
        let note='Course mapped. Connect the teacher to verify access.';
        if(service.integrations.connected(c.teacherId)){try{await service.integrations.google(c.teacherId,`courses/${encodeURIComponent(c.liveId)}`);note='Course mapped and verified: the connected teacher can see this course.';}catch(e){throw new Error('Google rejected this mapping - nothing was saved. '+(e as Error).message);}}
        store.put('courses',c);store.audit(actor,'classroom.course_mapped',c.id,note);return {...c,note};}
      if(p==='/api/audit/checkpoint'){service.requireHuman(actor);return {verified:store.verify(),...store.checkpoint()};}
    }
    throw new Error('Unknown endpoint or method.');
  }
  const request=(method:string,path:string,body:unknown,actor:Actor)=>method==='GET'?dispatch(method,path,body,actor):serialize(()=>dispatch(method,path,body,actor));
  const server=createServer(async(req,res)=>{
    const respond=(status:number,data:unknown)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
    try{
      const url=new URL(req.url??'/','http://127.0.0.1');
      if(url.pathname==='/oauth/callback'&&req.method==='GET'){
        const teacher=await service.integrations.oauthCallback(url.searchParams.get('state')??'',url.searchParams.get('code')??'');store.audit({agent:'System',behalf:teacher},'oauth.connected',teacher,'Refresh token stored encrypted; never exported to hive.');res.writeHead(200,{'Content-Type':'text/plain'});res.end('Google Classroom connected. Return to VidyaVarta.');return;
      }
      const auth=(req.headers.authorization??'').replace(/^Bearer /,'');
      const human=eq(auth,humanToken);if(!human&&!eq(auth,token)){respond(401,{error:'Missing or invalid harness token.'});return;}
      // No browser origins are accepted by the internal service; trusted dev gateway removes Origin.
      if(req.headers.origin){respond(403,{error:'Direct browser access to the bridge is forbidden.'});return;}
      const role=z.enum(['operator','teacher','leadership','viewer']).parse(req.headers['x-campus-role']??'operator');
      const actor:Actor={agent:z.enum(['Michael','Watcher','Scribe','Composer','Courier','System']).parse(req.headers['x-agent-id']??'Michael'),behalf:role==='teacher'?z.enum(['faculty-01','faculty-02']).parse(req.headers['x-teacher-id']??'faculty-01'):'operator',human,role};
      let data='';for await(const chunk of req){data+=chunk;if(Buffer.byteLength(data)>100_000){respond(413,{error:'Request too large.'});return;}}
      const result=await request(req.method??'GET',url.pathname+url.search,data?JSON.parse(data):undefined,actor);respond(200,result);
    }catch(e){const error=e instanceof z.ZodError?e.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '):(e as Error).message;respond(400,{error});}
  });
  try { await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??4318,'127.0.0.1',resolve);}); } catch(e) { store.close(); throw e; }
  const port=(server.address() as {port:number}).port;
  // Only the agent token is written. CLI processes cannot resolve their own approvals.
  mkdirSync(options.directory,{recursive:true,mode:0o700});writeFileSync(join(options.directory,'bridge-session.json'),JSON.stringify({url:`http://127.0.0.1:${port}`,token}),{mode:0o600});
  let timer:NodeJS.Timeout|undefined;
  if(options.scheduled!==false){timer=setInterval(()=>{void serialize(()=>service.tick()).catch(e=>console.error('[campus scheduler]',e.message));},60_000);timer.unref();}
  let shutdown:Promise<void>|undefined;
  const close=()=>shutdown??=(async()=>{if(timer)clearInterval(timer);await queue;await new Promise<void>(r=>server.close(()=>r()));store.checkpoint();store.close();})();
  return {service,auth,server,token,humanToken,port,request,close};
}
