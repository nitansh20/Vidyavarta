import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Store, id, now, hash } from './store';
import { audienceSchema, resolveAudience, studentSchema, parseSelector } from './directory';
import { diffItems, classify, fetchCirculars, validateSource } from './watcher';
import { boardHTML } from './board';
import { Integrations } from './integrations';
import { Brain, extractJson } from './brain';
import type { Actor, Approval, Notice, Course, ClassroomAction, ClassroomPost, WatchSource, WatchEvent, Student, Receipt, Reminder, Snapshot, Audience } from './types';
const dateSchema=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>!isNaN(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s,'Invalid calendar date');
export const noticeSchema=z.object({title:z.string().trim().min(4).max(200),body:z.string().trim().min(10).max(8000),audience:audienceSchema,urgency:z.enum(['normal','critical']),deadline:dateSchema.nullable(),channels:z.array(z.enum(['board','email'])).min(1).max(2),sourceUrl:z.url().refine(s=>new URL(s).protocol==='https:').optional()}).strict();
export const actionSchema=z.object({courseId:z.string().min(1).max(100),kind:z.enum(['announcement','material','assignment','topic']),title:z.string().trim().min(3).max(200),body:z.string().max(8000),points:z.number().min(0).max(1000).optional(),dueDate:dateSchema.optional(),links:z.array(z.url().refine(s=>new URL(s).protocol==='https:','Use HTTPS links')).max(10).optional(),topic:z.string().max(100).optional()}).strict();

/** Validate a brain answer as a question paper and format it as assignment text. Returns null when nothing usable remains. */
export function formatQuestionPaper(parsed:Record<string,unknown>):string|null{
  const asAnswer=(v:unknown):number=>{
    if(typeof v==='number'&&Number.isInteger(v)&&v>=1&&v<=4)return v;
    if(typeof v==='string'){const t=v.trim().toUpperCase();if(t==='A')return 1;if(t==='B')return 2;if(t==='C')return 3;if(t==='D')return 4;if(/^[1-4]$/.test(t))return Number(t);}
    return -1;
  };
  const asMarks=(v:unknown):number=>{const n=typeof v==='number'?v:(typeof v==='string'&&/^[0-9]+$/.test(v.trim())?Number(v.trim()):-1);return n>=1&&n<=50?n:-1;};
  const mcqRaw=Array.isArray(parsed.mcqs)?parsed.mcqs.slice(0,8):[];
  const shortRaw=Array.isArray(parsed.short)?parsed.short.slice(0,4):[];
  const mcqs=mcqRaw.map(m=>m&&typeof m==='object'?m as Record<string,unknown>:null).filter((m):m is Record<string,unknown>=>{
    if(!m)return false;
    const q=typeof m.question==='string'?m.question.trim():'';
    const opts=Array.isArray(m.options)?m.options.map(o=>typeof o==='string'?o.trim():'').filter(o=>o.length>0).slice(0,4):[];
    return q.length>=6&&opts.length===4&&asAnswer(m.answer)>0;
  });
  const shorts=shortRaw.map(m=>m&&typeof m==='object'?m as Record<string,unknown>:null).filter((m):m is Record<string,unknown>=>{
    if(!m)return false;
    const q=typeof m.question==='string'?m.question.trim():'';
    return q.length>=6&&asMarks(m.marks)>0;
  });
  if(!mcqs.length&&!shorts.length)return null;
  const letters=['A','B','C','D'];
  const out:string[]=[];
  if(mcqs.length){
    out.push('Section A - Multiple choice questions (1 mark each)');
    mcqs.forEach((m,i)=>{
      out.push(`Q${i+1}. ${(m.question as string).trim()}`);
      ((m.options as unknown[]).map(o=>String(o).trim()).filter(Boolean).slice(0,4) as string[]).forEach((o,j)=>out.push(`   ${letters[j]}) ${o}`));
      out.push(`Answer: ${letters[asAnswer(m.answer)-1]}`);
      out.push('');
    });
  }
  if(shorts.length){
    out.push('Section B - Short answer questions');
    shorts.forEach((m,i)=>out.push(`SQ${i+1}. ${(m.question as string).trim()} (${asMarks(m.marks)} marks)`));
  }
  return out.join('\n').trim();
}

export class CampusService {
  private busy=new Set<string>();
  constructor(readonly store:Store,public integrations:Integrations,seed=true,readonly brain?:Brain){if(seed)this.seed();}
  seed() {
    if(this.store.get('meta','initialized'))return;
    const courses:Course[]=[{id:'dbms',name:'Database Management Systems',teacherId:'faculty-01',teacher:'Dr. Meera Shah',segment:'CSE · Year 3 · A / B',topic:'Unit 3 · SQL & normalization',faq:{deadline:'See the due date on the specific Classroom assignment; no extensions are assumed.',format:'Submit a single PDF with your enrollment number in the filename.',syllabus:'Unit 3 covers SQL joins, functional dependencies, and normalization.'}},{id:'networks',name:'Computer Networks',teacherId:'faculty-01',teacher:'Dr. Meera Shah',segment:'IT · Year 3 · A / B',topic:'Unit 2 · Network layer',faq:{format:'Submit your practical as a PDF with screenshots.'}},{id:'programming',name:'Programming fundamentals',teacherId:'faculty-02',teacher:'Prof. Arjun Desai',segment:'CSE · Year 1 · A / B',topic:'Unit 1 · Getting started',faq:{format:'Submit source code with a short README.'}}];
    for(const course of courses)this.store.put('courses',course);
    this.store.put<WatchSource>('sources',{id:'sou-academic',name:'Academic circulars',url:'https://silveroakuni.ac.in/circulars/academic',type:'live',enabled:true,intervalMinutes:30,lastScan:null,lastHash:null,status:'ready',items:[]});
    this.store.put<WatchSource>('sources',{id:'sou-exam',name:'Examination circulars',url:'https://silveroakuni.ac.in/circulars/exam',type:'live',enabled:false,intervalMinutes:30,lastScan:null,lastHash:null,status:'ready',items:[]});
    this.store.put('meta',{id:'initialized',at:now()});
    this.store.audit({agent:'System',behalf:'operator'},'campus.initialized','campus','live · empty directory (import your class from a CSV) · course catalog ready');
    this.exportBoard();this.store.checkpoint();
  }
  snapshot():Snapshot {
    if(this.brain)void this.brain.probe().catch(()=>{});
    const notices=this.store.all<Notice>('notices'),approvals=this.store.all<Approval>('approvals'),receipts=this.store.all<Receipt>('receipts');
    return {now:now(),students:this.store.all('students'),courses:this.store.all('courses'),notices,approvals,sources:this.store.all<WatchSource>('sources').filter(s=>s.type!=='fixture'),events:this.store.all('events'),receipts,posts:this.store.all('posts'),audit:this.store.audits().reverse(),reminders:this.store.all('reminders'),integrations:{classroom:this.integrations.classroomReady,smtp:this.integrations.smtpReady,broker:this.integrations.broker.available,smtpMissing:this.integrations.smtpMissing,classroomMissing:this.integrations.classroomMissing,ollama:this.brain?this.brain.status():null},digest:{published:notices.filter(n=>n.status==='published').length,recipients:receipts.filter(r=>r.channel==='email'&&['accepted','sent'].includes(r.status)).length,pending:approvals.filter(a=>a.status==='pending').length,failed:receipts.filter(r=>r.status==='failed'||r.status==='blocked').length}};
  }
  requireHuman(actor:Actor){if(!actor.human)throw new Error('Only the local human control room may make this decision.');}
  useIntegrations(next:Integrations){this.integrations=next;}
  approveRequest(title:string,reason:string,role:Approval['role'],kind:Approval['kind'],resourceId:string,payload:unknown,teacherId?:string) {
    const approval:Approval={id:id('ask'),title,reason,role,kind,resourceId,fingerprint:hash(payload),status:'pending',createdAt:now(),...(teacherId?{teacherId}:{}),...(kind==='classroom'?{payload:payload as ClassroomAction}:{})};
    this.store.put('approvals',approval);this.store.audit({agent:'Michael',behalf:teacherId??role},'approval.requested',approval.id,reason);return approval;
  }
  resolveApproval(approvalId:string,decision:'approved'|'rejected',actor:Actor) {
    this.requireHuman(actor);
    const approval=this.store.get<Approval>('approvals',approvalId);if(!approval||approval.status!=='pending')throw new Error('Approval is missing or already resolved.');
    if(actor.role!== 'operator' && actor.role!==approval.role)throw new Error('Switch to the responsible role to resolve this card.');
    if(actor.role==='teacher'&&actor.behalf!==approval.teacherId)throw new Error('This approval belongs to another teacher.');
    approval.status=decision;approval.resolvedAt=now();approval.resolvedBy=actor.behalf;
    this.store.put('approvals',approval);this.store.audit(actor,`approval.${decision}`,approval.id,approval.title);
    if(approval.kind==='notice') {const notice=this.store.get<Notice>('notices',approval.resourceId)!;notice.status=decision==='rejected'?'rejected':'pending';this.store.put('notices',notice);}
    this.store.checkpoint();return approval;
  }
  consume(approvalId:string|undefined,kind:Approval['kind'],resourceId:string,payload:unknown) {
    const a=approvalId?this.store.get<Approval>('approvals',approvalId):undefined;
    if(!a||a.status!=='approved'||a.kind!==kind||a.resourceId!==resourceId||a.fingerprint!==hash(payload))throw new Error('A matching, unused human approval is required.');
    a.status='consumed';this.store.put('approvals',a);
  }
  noticePayload(n:Notice){return {title:n.title,body:n.body,audience:n.audience,urgency:n.urgency,deadline:n.deadline,channels:n.channels,recipients:resolveAudience(this.store.all<Student>('students'),n.audience).map(s=>s.email).sort()};}
  createNotice(input:unknown,actor:Actor) {
    const parsed=noticeSchema.parse(input);const count=resolveAudience(this.store.all('students'),parsed.audience).length;
    if(!count)throw new Error('This audience has no recipients. Choose another segment.');
    const n:Notice={...parsed,id:id('notice'),status:'pending',createdAt:now(),recipientCount:count};
    const a=this.approveRequest(n.title,`${n.urgency==='critical'?'Critical circular. ':''}Confirm ${count} recipients and ${n.channels.join(' + ')} delivery.`,n.urgency==='critical'?'leadership':'operator','notice',n.id,this.noticePayload(n));n.approvalId=a.id;
    this.store.put('notices',n);this.store.audit(actor,'notice.drafted',n.id,`${n.title} · ${count} recipients`);return n;
  }
  async publishNotice(noticeId:string,actor:Actor) {
    const n=this.store.get<Notice>('notices',noticeId);if(!n)throw new Error('Notice not found.');
    if(n.status==='published')return n;
    this.consume(n.approvalId,'notice',n.id,this.noticePayload(n));
    this.store.audit(actor,'notice.publish_started',n.id,`${n.channels.join(' + ')}`);
    n.status='published';n.publishedAt=now();this.store.put('notices',n);
    if(n.channels.includes('board')){this.exportBoard();this.store.put<Receipt>('receipts',{id:id('receipt'),noticeId:n.id,channel:'board',recipient:'Public notice board',status:'published',at:now(),attempts:1});this.store.audit({agent:'Courier',behalf:actor.behalf},'board.published',n.id,'Read-only board updated; no student data included.');}
    if(n.channels.includes('email')) for(const student of resolveAudience(this.store.all<Student>('students'),n.audience))await this.deliverEmail(n,student.email,actor);
    if(n.deadline)for(const daysBefore of [7,3,1]){const at=new Date(`${n.deadline}T09:00:00+05:30`);at.setUTCDate(at.getUTCDate()-daysBefore);if(at.getTime()>Date.now())this.store.put<Reminder>('reminders',{id:id('reminder'),noticeId:n.id,daysBefore,at:at.toISOString(),status:'scheduled'});}
    this.store.audit(actor,'notice.published',n.id,`${n.title} · see channel receipts`);this.store.checkpoint();return n;
  }
  private async deliverEmail(n:Notice,recipient:string,actor:Actor,existing?:Receipt){
    const r:Receipt={id:existing?.id??id('receipt'),noticeId:n.id,channel:'email',recipient,status:'queued',at:now(),attempts:(existing?.attempts??0)+1};
    {
      if(existing)this.store.put('receipts',r);
      try{r.messageId=await this.integrations.sendEmail(n,recipient);r.status='sent';}
      catch(e){r.error=(e as Error).message;r.status=r.error.includes('ALLOWLIST')?'blocked':'failed';if(r.status==='failed'&&r.attempts<3)r.retryAt=new Date(Date.now()+60_000*2**r.attempts).toISOString();}
    }
    this.store.put('receipts',r);this.store.audit({agent:'Courier',behalf:actor.behalf},`email.${r.status}`,r.id,`Notice ${n.id} · recipient ${recipient} · attempt ${r.attempts}`);
    if(r.status==='failed'&&r.attempts===3)this.approveRequest('Email delivery failed','Delivery exhausted 3 attempts. Check SMTP and review receipts.','operator','error',r.id,{receiptId:r.id});
    return r;
  }
  exportBoard(){const directory=join(this.store.directory,'notice-board');mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'index.html'),boardHTML(this.store.all<Notice>('notices').filter(n=>n.channels.includes('board'))));}
  async scan(sourceId:string,actor:Actor){
    if(this.busy.has(sourceId))throw new Error('A scan is already running.');this.busy.add(sourceId);
    const s=this.store.get<WatchSource>('sources',sourceId);if(!s){this.busy.delete(sourceId);throw new Error('Watch source not found.');}
    try{
      const items=await fetchCirculars(s.url);
      const first=s.lastHash===null;const changes=first?[]:diffItems(s.items,items);
      s.items=items;s.lastScan=now();s.lastHash=hash(items);s.status='healthy';delete s.error;this.store.put('sources',s);
      const events:WatchEvent[]=[];
      for(const change of changes){const classification=classify(change.title);const branch=/\bCSE\b/i.test(change.title)?'CSE':/\bIT\b/i.test(change.title)?'IT':'ALL';const yearMatch=/year\s*([1-4])/i.exec(change.title);
        const n=this.createNotice({title:change.title,body:`${change.title}\n\nA new or changed document was found on the public university website. Open the original circular and verify its audience and dates before approving.\n\nSource: ${change.url}`,audience:{branch,year:yearMatch?Number(yearMatch[1]):null,sections:['A','B']},urgency:classification.urgency,deadline:null,channels:['board'],sourceUrl:change.url},{agent:'Composer',behalf:'operator'});
        const event:WatchEvent={id:id('event'),sourceId:s.id,title:change.title,url:change.url,change:change.change,...classification,detectedAt:now(),noticeId:n.id,...(change.date?{date:change.date}:{})};this.store.put('events',event);events.push(event);
      }
      this.store.audit({...actor,agent:'Watcher'},'watch.scan',s.id,first?`Baseline recorded: ${items.length} document links. No historical notices broadcast.`:`${changes.length} new or changed circulars · ${items.length} links checked`);return {baseline:first,checked:items.length,events};
    }catch(e){s.status='error';s.error=(e as Error).message;s.lastScan=now();this.store.put('sources',s);this.store.audit({...actor,agent:'Watcher'},'watch.failed',s.id,s.error);if(!this.store.all<Approval>('approvals').some(a=>a.kind==='error'&&a.resourceId===s.id&&a.status==='pending'))this.approveRequest(`Watcher needs attention: ${s.name}`,'Scan failed: '+s.error+' (source: '+s.url+')','operator','error',s.id,{sourceId:s.id});throw e;}
    finally{this.busy.delete(sourceId);}
  }
  addSource(input:unknown,actor:Actor){this.requireHuman(actor);if(actor.role!=='operator')throw new Error('Only the campus operator can register watch sources.');const p=z.object({name:z.string().min(3).max(100),url:z.url(),intervalMinutes:z.number().int().min(30).max(1440)}).parse(input);validateSource(p.url);return this.store.put<WatchSource>('sources',{...p,id:id('source'),type:'live',enabled:true,lastHash:null,lastScan:null,status:'ready',items:[]});}
  async classroom(input:unknown,actor:Actor){
    const action=actionSchema.parse(input);const course=this.store.get<Course>('courses',action.courseId);if(!course)throw new Error('Unknown course.');
    if(actor.behalf!==course.teacherId && actor.behalf!=='operator')throw new Error('Teacher does not own this course.');
    const post:ClassroomPost={...action,id:id('post'),status:'pending',createdAt:now()};
    // Bridge-enforced floor, even if an agent bypasses the UI draft review.
    const ambiguity = (!action.dueDate && /\b(next|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i.test(action.body)) || (action.kind==='material' && !action.links?.length);
    if(action.kind==='assignment'||ambiguity||(action.dueDate && Date.parse(action.dueDate)<Date.now())){
      const a=this.approveRequest(action.title,ambiguity?'Ambiguous date or missing reference. Review this exact payload; decline and redraft if details are missing.':'Grade-bearing or date-conflicting action. The teacher must review the exact payload before execution.','teacher','classroom',post.id,action,course.teacherId);post.approvalId=a.id;this.store.put('posts',post);this.store.audit({agent:'Scribe',behalf:course.teacherId},'classroom.gated',post.id,action.title);return post;
    }
    this.store.put('posts',post);return this.executePost(post,actor);
  }
  async executePost(post:ClassroomPost,actor:Actor){
    const course=this.store.get<Course>('courses',post.courseId)!;
    this.store.audit({agent:'Scribe',behalf:course.teacherId},'classroom.execute_started',post.id,post.kind);
    try{const result=await this.integrations.post(course,post);post.externalId=String(result.id??result.topicId);post.status='posted';this.store.put('posts',post);this.store.audit({agent:'Scribe',behalf:course.teacherId},'classroom.posted',post.id,`${post.kind}: ${post.title}`);this.store.checkpoint();return post;}
    catch(e){post.status='failed';this.store.put('posts',post);this.store.audit({agent:'Scribe',behalf:course.teacherId},'classroom.failed',post.id,(e as Error).message);this.approveRequest('Classroom connection needs attention',(e as Error).message,'teacher','error',post.id,{postId:post.id},course.teacherId);throw e;}
  }
  async executeApproval(approvalId:string,actor:Actor){const a=this.store.get<Approval>('approvals',approvalId);if(!a)throw new Error('Approval not found.');if(a.kind==='notice')return this.publishNotice(a.resourceId,actor);if(a.kind!=='classroom')return a;const post=this.store.get<ClassroomPost>('posts',a.resourceId);if(!post)throw new Error('Post missing.');const {id:_id,status:_status,createdAt:_createdAt,approvalId:_approvalId,externalId:_externalId,...payload}=post;this.consume(a.id,'classroom',post.id,actionSchema.parse(payload));return this.executePost(post,actor);}
  async command(text:string,courseId:string,actor:Actor,brain:Brain|undefined=this.brain):Promise<{action:ClassroomAction;issues:string[];engine:'ollama'|'template'}>{
    if(text.length<8||text.length>4000)throw new Error('Use a command between 8 and 4,000 characters.');
    const course=this.store.get<Course>('courses',courseId);if(!course)throw new Error('Choose a course.');
    const kind:ClassroomAction['kind']=/assignment|graded|grade-bearing|\d+\s*points/i.test(text)?'assignment':/material|reference|notes/i.test(text)?'material':/topic/i.test(text)?'topic':'announcement';
    const links=text.match(/https:\/\/[^\s,]+/g)??[];
    // The template parser always runs as the safety baseline. Ambiguities remain visible and never silently execute.
    const issues:string[]=[];if(/next |tomorrow|tuesday|monday|wednesday|thursday|friday|saturday|sunday/i.test(text)&&!/\d{4}-\d{2}-\d{2}/.test(text))issues.push('Resolve the relative date using the date field.');if(kind==='material'&&!links.length)issues.push('Attach at least one HTTPS reference link.');if(/\band\b.*\b(announce|post|create|assign)\b/i.test(text))issues.push('This contains multiple actions. Review and submit one action at a time.');
    const title=text.split(/[.!\n]/)[0].slice(0,140);const dueDate=/\b\d{4}-\d{2}-\d{2}\b/.exec(text)?.[0];const points=/\b(\d+)\s*points/i.exec(text)?.[1];
    let action:ClassroomAction={courseId,kind,title,body:text,links,...(dueDate?{dueDate}:{}),...(points?{points:Number(points)}:{})};
    let engine:'ollama'|'template'='template';
    if(brain){
      const status=await brain.probe();
      if(status.available){
        try{
          const prompt=['You are Scribe, the assistant inside a university campus office. Convert the teacher request into ONE Google Classroom action.',
            'Course: '+course.name+'. Subject area: '+(course.topic??course.segment??'university course')+'.',
            'Reply with ONLY one JSON object, no other text, with exactly these keys:',
            'kind: one of "announcement", "material", "assignment", "topic"',
            'title: short title, max 140 characters','body: the complete message students will read',
            'links: array of the https URLs that appear in the request (empty array if none)',
            'dueDate: "YYYY-MM-DD" only if the request states an explicit date, otherwise null',
            'points: integer only if the request states points, otherwise null',
            'topic: topic name only when creating a topic, otherwise null',
            'issues: array of short warnings for the teacher (ambiguities, relative dates, missing links)',
            'Rules: never invent dates, URLs or point values. Never change the course. Output only the JSON object.',
            'Teacher request: """'+text+'"""'].join('\n');
          const parsed=extractJson(await brain.chat(prompt));
          if(parsed){
            action=this.mergeBrainDraft(action,parsed);
            if(kind==='assignment'&&action.kind!=='assignment'){action.kind='assignment';issues.push('Kept as a grade-bearing assignment (your request states points/marks), so the teacher approval gate applies - the model suggested another type.');}
            engine='ollama';
            if(Array.isArray(parsed.issues))issues.push(...parsed.issues.filter((x):x is string=>typeof x==='string'&&x.trim().length>0).slice(0,3));
            issues.push('Drafted by the Ollama brain ('+brain.model+'). It only proposes - check every field before approving.');
            if(action.kind==='assignment'&&(/mcq|quiz|question/i.test(text)||action.body.length<220)){
              const qprompt=['You are Scribe, setting an assignment for a university course.',
                'Course: '+course.name+'. Subject area: '+(course.topic??course.segment??'university course')+'.',
                'Assignment title: '+action.title,
                'Write the assessment content: 4 to 6 multiple choice questions (exactly 4 options each, "answer" is the 1-4 number of the correct option) and 2 or 3 short answer questions with marks (2-5).',
                'Questions must match the subject area and stay at university year-3 level. Never mark an impossible option as correct.',
                'Reply with ONLY one JSON object:', '{"mcqs":[{"question":"...","options":["...","...","...","..."],"answer":2}],"short":[{"question":"...","marks":3}]}'].join('\n');
              let formatted:string|null=null;
              for(let attempt=0;attempt<2&&!formatted;attempt++){
                const q=attempt===0?qprompt:qprompt.concat('','IMPORTANT: your previous reply was not valid. Reply again with ONLY the JSON object: {"mcqs":[{"question":"...","options":["...","...","...","..."],"answer":2}],"short":[{"question":"...","marks":3}]}. The "answer" MUST be a number 1-4. Every MCQ MUST have exactly 4 options.');
                const paper=extractJson(await brain.chat(q));
                formatted=paper?formatQuestionPaper(paper):null;
              }
              if(formatted){
                action={...action,body:(action.body.trim()+'\n\n'+formatted).slice(0,3900)};
                issues.push('The question paper (MCQs and short answers) was generated by the brain - review every answer key before approval.');
                this.store.audit({...actor,agent:'Michael'},'command.drafted',course.id,'Question paper generated by Ollama ('+brain.model+'); teacher review still required.');
              } else issues.push('The brain could not produce a valid question paper after 2 tries ('+brain.model+'). The assignment kept its instruction text. For reliable papers use a bigger model: run  ollama pull qwen2.5:7b  (or llama3.2:8b), set OLLAMA_MODEL in .env, and restart.');
            }
            this.store.audit({...actor,agent:'Michael'},'command.drafted',course.id,'Ollama ('+brain.model+') draft; the template parser cross-checked every field. Nothing sends without approval.');
          } else issues.push('The brain answer was not usable; the template draft is shown.');
        }catch(e){issues.push('The brain could not be reached ('+(e as Error).message+'); the template draft is shown.');}
      }
    }
    if(engine==='template')this.store.audit({...actor,agent:'Michael'},'command.drafted',course.id,'Local template routing; no language model invoked.');
    return {action,issues,engine};
  }
  /** Copy only schema-safe fields out of a model answer. Identity and course are never taken from the model. */
  mergeBrainDraft(base:ClassroomAction,parsed:Record<string,unknown>):ClassroomAction{
    const out:ClassroomAction={...base};
    const kinds:ClassroomAction['kind'][]=['announcement','material','assignment','topic'];
    if(typeof parsed.kind==='string'&&kinds.includes(parsed.kind as ClassroomAction['kind']))out.kind=parsed.kind as ClassroomAction['kind'];
    if(typeof parsed.title==='string'&&parsed.title.trim().length>=4)out.title=parsed.title.trim().slice(0,140);
    if(typeof parsed.body==='string'&&parsed.body.trim().length>=10)out.body=parsed.body.trim().slice(0,2000);
    if(Array.isArray(parsed.links))out.links=parsed.links.filter((l):l is string=>typeof l==='string'&&/^https:\/\/[^\s,]+$/.test(l)).slice(0,5);
    if(typeof parsed.dueDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(parsed.dueDate))out.dueDate=parsed.dueDate;
    if(typeof parsed.points==='number'&&Number.isInteger(parsed.points)&&parsed.points>=0&&parsed.points<=100)out.points=parsed.points;
    if(typeof parsed.topic==='string'&&parsed.topic.trim())out.topic=parsed.topic.trim().slice(0,80);
    return out;
  }
  /** Draft a campus notice from the latest watched circular. Returns text only - the composer still asks for approval. */
  async brainNotice(actor:Actor,target?:{sourceId?:string;url?:string}){
    if(!this.brain)throw new Error('The brain is not available in this build.');
    const status=await this.brain.probe();if(!status.available)throw new Error(status.error??'Ollama is not reachable.');
    let itemTitle='',itemUrl='',itemDate: string|undefined,origin='';
    if(target?.sourceId){
      const src=this.store.get<WatchSource>('sources',target.sourceId);if(!src)throw new Error('Unknown watch source.');
      const item=target.url?src.items.find(i=>i.url===target.url):src.items[0];
      if(!item)throw new Error('That document is not in the watched list any more. Rescan the source.');
      itemTitle=item.title;itemUrl=item.url;itemDate=item.date;origin=`watched document on ${src.name}`;
    } else {
      const events=this.store.all<WatchEvent>('events').slice().sort((a,b)=>Date.parse(b.detectedAt)-Date.parse(a.detectedAt));
      const latest=events[0];if(!latest)throw new Error('No circulars have been watched yet. Scan a source first, or use Draft notice on any watched document.');
      itemTitle=latest.title;itemUrl=latest.url;itemDate=latest.date;origin='the latest detected circular';
    }
    const prompt=['You are Composer, the notice writer of an Indian university campus office.',
      'A circular from the official university website needs a campus notice.',
      'Circular title: '+itemTitle,'Link: '+itemUrl,itemDate?'Circular date: '+itemDate:'',
      'Write the campus notice students should see. Reply with ONLY one JSON object:',
      'title: the notice title, max 120 characters','body: 2 to 4 short sentences. Say what it is, who it affects, and what to do. Never invent deadlines, fees or rules that are not stated above.',
      'urgency: "critical" only for exam or fee emergencies, otherwise "normal"'].filter(Boolean).join('\n');
    const parsed=extractJson(await this.brain.chat(prompt));
    if(!parsed)throw new Error('The brain answer was not usable. Try again or write the notice yourself.');
    const title=typeof parsed.title==='string'?parsed.title.trim().slice(0,200):'';
    const body=typeof parsed.body==='string'?parsed.body.trim().slice(0,4000):'';
    if(title.length<4||body.length<10)throw new Error('The brain draft was too short. Try again or write the notice yourself.');
    const urgency:Notice['urgency']=parsed.urgency==='critical'?'critical':'normal';
    this.store.audit({...actor,agent:'Composer'},'notice.brain_drafted','composer','Ollama draft from '+origin+': '+itemTitle+' (approval still required).');
    return {title,body,urgency,source:itemTitle,url:itemUrl,engine:this.brain.model};
  }
  question(courseId:string,text:string,actor:Actor){const c=this.store.get<Course>('courses',courseId);if(!c)throw new Error('Unknown course.');const entry=Object.entries(c.faq).find(([k])=>text.toLowerCase().includes(k));if(entry&&!/grade|mark|extension|exception/i.test(text)){this.store.audit({agent:'Scribe',behalf:c.teacherId},'faq.answered',c.id,`Course knowledge: ${entry[0]}`);return {answer:entry[1],escalated:false};}const a=this.approveRequest('A student question needs you',text,'teacher','question',id('question'),{text},c.teacherId);return {answer:'Sent to the teacher for review. No answer has been sent to a student.',escalated:true,approvalId:a.id};}
  resolve(input:Audience){return resolveAudience(this.store.all('students'),input);}
  importStudents(input:unknown,actor:Actor){this.requireHuman(actor);if(actor.role!=='operator')throw new Error('Only the campus operator can import the directory.');const students=z.array(studentSchema).min(1).max(1000).parse(input);if(new Set(students.map(s=>s.id)).size!==students.length||new Set(students.map(s=>s.email)).size!==students.length)throw new Error('Student IDs and email addresses must be unique.');this.store.db.transaction(()=>{this.store.remove('students');for(const student of students)this.store.put('students',student);})();this.store.audit(actor,'directory.imported','directory',`${students.length} student records imported; pending recipient approvals may need re-creation.`);return {count:students.length};}
  async tick(){
    const actor:Actor={agent:'System',behalf:'operator'};
    for(const s of this.store.all<WatchSource>('sources'))if(s.enabled&&(!s.lastScan||Date.now()-Date.parse(s.lastScan)>=s.intervalMinutes*60000)){try{await this.scan(s.id,actor);}catch{/* surfaced in ASK-ME */}}
    let retryBudget=40;
    for(const r of this.store.all<Receipt>('receipts')){if(retryBudget<=0)break;if(r.status==='failed'&&r.retryAt&&Date.parse(r.retryAt)<=Date.now()){const n=this.store.get<Notice>('notices',r.noticeId);if(n){await this.deliverEmail(n,r.recipient,actor,r);retryBudget--;}}}
    for(const reminder of this.store.all<Reminder>('reminders'))if(reminder.status==='scheduled'&&Date.parse(reminder.at)<=Date.now()){const n=this.store.get<Notice>('notices',reminder.noticeId);if(!n)continue;const draft=this.createNotice({title:`Reminder · ${n.title}`,body:`T-${reminder.daysBefore} reminder\n\n${n.body}`,audience:n.audience,urgency:n.urgency,deadline:null,channels:n.channels},actor);reminder.status='ready';reminder.approvalId=draft.approvalId;this.store.put('reminders',reminder);}
  }
}
