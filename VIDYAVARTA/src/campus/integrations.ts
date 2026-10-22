import nodemailer from 'nodemailer';
import { randomBytes } from 'node:crypto';
import type { SecretBroker } from './secrets';
import type { ClassroomAction, Course, Notice } from './types';
export class Integrations {
  private states = new Map<string,{teacherId:string;expires:number;verifier:string}>();
  constructor(readonly broker:SecretBroker, readonly env:NodeJS.ProcessEnv=process.env) {}
  get classroomReady() { return Boolean(this.env.GOOGLE_CLIENT_ID && this.env.GOOGLE_CLIENT_SECRET && this.broker.available); }
  get smtpReady() { return Boolean(this.env.SMTP_HOST && this.env.SMTP_FROM && this.env.SMTP_ALLOWLIST); }
  get smtpMissing() { return (['SMTP_HOST','SMTP_FROM','SMTP_ALLOWLIST'] as const).filter(k=>!this.env[k]); }
  get classroomMissing(): string[] { const missing: string[] = (['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET'] as const).filter(k=>!this.env[k]); if(!this.broker.available)missing.push('CAMPUS_SECRET_KEY'); return missing; }
  private allowed(recipient:string) {
    const address=recipient.toLowerCase(); const domain=address.split('@')[1]??'';
    return (this.env.SMTP_ALLOWLIST??'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean).some(entry=>{
      if(entry.startsWith('@')||entry.startsWith('.')){const core=entry.slice(1);return domain===core||domain.endsWith('.'+core);}
      if(entry.includes('@'))return address===entry;
      return domain===entry||domain.endsWith('.'+entry);
    });
  }
  connected(teacherId:string) { try{return Boolean(this.broker.read(`google:${teacherId}`));}catch{return false;} }
  async oauthStart(teacherId:string) {
    if(!this.classroomReady)throw new Error('Configure GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and the secret broker first.');
    const state=randomBytes(24).toString('hex'),verifier=randomBytes(32).toString('base64url');
    this.states.set(state,{teacherId,expires:Date.now()+600_000,verifier});
    const {createHash}=await import('node:crypto');
    const p=new URLSearchParams({client_id:this.env.GOOGLE_CLIENT_ID!,redirect_uri:this.env.GOOGLE_REDIRECT_URI ?? 'http://127.0.0.1:4318/oauth/callback',response_type:'code',access_type:'offline',prompt:'consent',state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',scope:['classroom.courses.readonly','classroom.announcements','classroom.coursework.students','classroom.courseworkmaterials','classroom.topics','classroom.rosters.readonly'].map(s=>'https://www.googleapis.com/auth/'+s).join(' ')});
    return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  }
  async oauthCallback(state:string,code:string) {
    const pending=this.states.get(state);this.states.delete(state);
    if(!pending || pending.expires<Date.now())throw new Error('OAuth state invalid or expired. Reconnect from Integrations.');
    const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code,client_id:this.env.GOOGLE_CLIENT_ID!,client_secret:this.env.GOOGLE_CLIENT_SECRET!,redirect_uri:this.env.GOOGLE_REDIRECT_URI ?? 'http://127.0.0.1:4318/oauth/callback',grant_type:'authorization_code',code_verifier:pending.verifier}),signal:AbortSignal.timeout(15000)});
    if(!response.ok)throw new Error('Google rejected OAuth authorization. Check your test user and redirect URI.');
    const token=await response.json() as {refresh_token?:string};if(!token.refresh_token)throw new Error('No refresh token returned. Revoke and reconnect.');
    this.broker.write(`google:${pending.teacherId}`,token.refresh_token);
    return pending.teacherId;
  }
  async google(teacherId:string,path:string,method='GET',body?:unknown) {
    const refresh=this.broker.read(`google:${teacherId}`);if(!refresh)throw new Error('Teacher not connected. Complete Google OAuth in Integrations.');
    const tokenResponse=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:this.env.GOOGLE_CLIENT_ID!,client_secret:this.env.GOOGLE_CLIENT_SECRET!,refresh_token:refresh,grant_type:'refresh_token'}),signal:AbortSignal.timeout(15000)});
    if(!tokenResponse.ok)throw new Error('Google token expired or revoked. Reconnect the teacher account.');
    const {access_token}=await tokenResponse.json() as {access_token:string};
    for(let attempt=0;attempt<3;attempt++) {
      const res=await fetch(`https://classroom.googleapis.com/v1/${path}`,{method,headers:{Authorization:`Bearer ${access_token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
      if(res.ok)return await res.json() as Record<string,any>;
      // Retry explicit quota rejections only. Blind POST retries can duplicate coursework.
      if(res.status===429 && attempt<2){await new Promise(r=>setTimeout(r,500*2**attempt));continue;}
      if(res.status===404){
        const courseId=path.split('/')[1]?.replace('courses/','')??'';
        throw new Error(`Classroom HTTP 404: Google cannot see course "${courseId}" for the connected account. Most common cause: that ID came from the browser address bar, which now shows an ENCODED id (contains letters) instead of the numeric course ID. Fix: press "Fetch my real Google courses" in Integrations and pick the course from the list. Also check the connected account is a TEACHER in that course, and reconnect if you authorised a different account.`);
      }
      throw new Error(`Classroom HTTP ${res.status}. Verify course access, scopes, and account connection.`);
    }
    throw new Error('Classroom quota exhausted. Retry later.');
  }
  async post(course:Course,action:ClassroomAction) {
    if(!course.liveId)throw new Error('Map this course to a real Google Classroom course ID first.');
    const base=`courses/${encodeURIComponent(course.liveId)}`;
    const materials=action.links?.map(url=>({link:{url}}));
    if(action.kind==='topic')return this.google(course.teacherId,`${base}/topics`,'POST',{name:action.title});
    if(action.kind==='announcement')return this.google(course.teacherId,`${base}/announcements`,'POST',{text:`${action.title}\n\n${action.body}`,state:'PUBLISHED',...(materials?.length?{materials}:{})});
    let topicId:string|undefined;
    if(action.topic){const topics=await this.google(course.teacherId,`${base}/topics`);topicId=(topics.topic??[]).find((t:{name:string})=>t.name.toLowerCase()===action.topic!.toLowerCase())?.topicId;if(!topicId)throw new Error(`Topic "${action.topic}" not found. Create it first.`);}
    const body:Record<string,unknown>={title:action.title,description:action.body,state:'PUBLISHED',...(materials?.length?{materials}:{}),...(topicId?{topicId}:{})};
    if(action.kind==='assignment'){body.workType='ASSIGNMENT';body.maxPoints=action.points??100;if(action.dueDate){const d=new Date(action.dueDate);body.dueDate={year:d.getUTCFullYear(),month:d.getUTCMonth()+1,day:d.getUTCDate()};body.dueTime={hours:18,minutes:29};}}
    return this.google(course.teacherId,`${base}/${action.kind==='material'?'courseWorkMaterials':'courseWork'}`,'POST',body);
  }
  async sendEmail(notice:Notice,recipient:string) {
    if(!this.allowed(recipient))throw new Error('Recipient not in SMTP_ALLOWLIST. External delivery blocked.');
    if(!this.smtpReady)throw new Error('SMTP not configured.');
    const transport=nodemailer.createTransport({host:this.env.SMTP_HOST,port:Number(this.env.SMTP_PORT??587),secure:this.env.SMTP_PORT==='465',requireTLS:this.env.SMTP_REQUIRE_TLS!=='0',auth:this.env.SMTP_USER?{user:this.env.SMTP_USER,pass:this.env.SMTP_PASS}:undefined,connectionTimeout:10000,socketTimeout:15000});
    const cleanTitle=notice.title.replace(/[\r\n\t]+/g,' ').replace(/\s+/g,' ').trim().slice(0,180);
    const deadline=notice.deadline?`\n\nDeadline: ${notice.deadline}`:'';
    const info=await transport.sendMail({from:this.env.SMTP_FROM,to:recipient,subject:`[UNOFFICIAL STUDENT PROJECT] ${cleanTitle}`,text:`Unofficial student project - not issued by Silver Oak University.\n\n${notice.body}${deadline}\n\nYou receive this because the campus office published a notice to your segment. Reply to the department office, not to this address.`,html:emailHtml(notice,cleanTitle),messageId:`<${notice.id}.${Buffer.from(recipient).toString('hex')}@vidyavarta.invalid>`});
    if(!info.accepted.length)throw new Error('SMTP rejected recipient.');return info.messageId as string;
  }
}

const escapeHtml=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
function emailHtml(notice:Notice,cleanTitle:string){
  const paragraph=(text:string)=>`<p style=\"margin:0 0 14px\">${escapeHtml(text).replace(/\n/g,'<br>')}</p>`;
  return `<div style=\"font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#26221f\">
  <div style=\"background:#741f32;color:#fff4e0;padding:18px 22px;border-radius:8px 8px 0 0\"><strong style=\"font-size:16px\">VidyaVarta campus notice</strong><div style=\"font-size:11px;opacity:.85\">Unofficial student project - not issued by Silver Oak University</div></div>
  <div style=\"border:1px solid #e2d8c6;border-top:0;padding:22px;border-radius:0 0 8px 8px\">
    <h2 style=\"margin:0 0 12px;font-size:17px\">${escapeHtml(cleanTitle)}</h2>
    ${paragraph(notice.body)}
    ${notice.deadline?paragraph(`Deadline: ${notice.deadline}`):''}
    ${notice.urgency==='critical'?'<p style=\"color:#a13c3c;font-weight:bold;margin:0 0 14px\">Marked critical by the campus office.</p>':''}
    <hr style=\"border:0;border-top:1px solid #eee2d2;margin:18px 0\">
    <p style=\"margin:0;font-size:11px;color:#8a8381\">Sent to your segment by the campus office. Reply to the department office, not to this address.</p>
  </div>
</div>`;
}
