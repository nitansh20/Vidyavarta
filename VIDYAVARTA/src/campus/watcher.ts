import { load } from 'cheerio';
import { hash } from './store';
import type { WatchItem } from './types';
export const ALLOWED_HOSTS = new Set(['silveroakuni.ac.in','www.silveroakuni.ac.in','sapiou.silveroakuni.ac.in']);
export function validateSource(url: string) { const u = new URL(url); if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname) || u.username || u.password || (u.port && u.port !== '443')) throw new Error('Watch sources must be HTTPS pages on silveroakuni.ac.in.'); return u; }
export function parseCirculars(html: string, base: string): WatchItem[] {
  const $=load(html); const items = new Map<string,WatchItem>();
  $('a[href]').each((_, element) => {
    const a=$(element), href=a.attr('href') ?? ''; const title=a.text().replace(/\s+/g,' ').trim();
    let url: URL; try { url=new URL(href,base); } catch { return; }
    if (url.protocol !== 'https:' || !title || title.length<5) return;
    // Document links only: navigation/footer changes must not become circulars.
    if (!/\.(pdf|docx?)(\?|$)/i.test(url.href)) return;
    const row=a.closest('tr,li').text().replace(/\s+/g,' ').trim();
    const date=/(\d{1,2}[\/-]\d{1,2}[\/-]\d{4}|\d{4}-\d{2}-\d{2})/.exec(row)?.[1];
    const item={title,url:url.href,...(date?{date}:{})};
    items.set(item.url,{...item,hash:hash(item)});
  });
  return [...items.values()];
}
export function diffItems(before: WatchItem[], after: WatchItem[]) {
  const old=new Map(before.map(i => [i.url,i.hash]));
  return after.filter(i => old.get(i.url)!==i.hash).map(item => ({...item,change:old.has(item.url)?'changed' as const:'new' as const}));
}
export function classify(title: string) {
  const category = /fee|payment|enroll/i.test(title) ? 'fee' : /exam|quiz|assessment|timetable/i.test(title) ? 'exam' : /semester|academic|course|syllabus|practical/i.test(title) ? 'academic' : 'general';
  const urgency = /fee|deadline|last date|exam.?form|enroll|urgent|postpon|cancel/i.test(title) ? 'critical' : 'normal';
  return { category, urgency } as const;
}
export function parsePublicFeed(json: unknown): WatchItem[] {
  const response=json as { data?: {main_title?:string;pdf_link?:string;circular_date?:string;legacyCircularPage?:{url_route?:string}}[] };
  if(!Array.isArray(response.data))throw new Error('Public circular API schema changed.');
  return response.data.flatMap(row=>{
    const title=row.main_title?.trim(), path=row.pdf_link??row.legacyCircularPage?.url_route?.trim();
    if(!title||!path)return [];
    let url:URL;try{url=new URL(path,'https://silveroakuni.ac.in');}catch{return [];}
    if(url.protocol!=='https:'||!ALLOWED_HOSTS.has(url.hostname))return [];
    const item={title,url:url.href,...(row.circular_date?{date:row.circular_date.slice(0,10)}:{})};
    return [{...item,hash:hash(item)}];
  });
}
export async function fetchCirculars(url: string): Promise<WatchItem[]> {
  const source=validateSource(url);
  // Current SOU site renders circulars client-side from this public read-only endpoint.
  // Keep the registered source as the human-facing page, not a scraper browser.
  const circularType=source.pathname==='/circulars/academic'?'academic_calendar,regular':source.pathname==='/circulars/exam'?'exam_page':null;
  if(circularType){
    const all:WatchItem[]=[];
    for(let page=1;page<=20;page++){
      const params=new URLSearchParams({page:String(page),pageSize:'50',isHome:'0',circular_type:circularType});
      const response=await fetch('https://sapiou.silveroakuni.ac.in/v1/legacy-circulars?'+params,{signal:AbortSignal.timeout(15000),redirect:'error',headers:{Accept:'application/json','User-Agent':'VidyaVarta/1.5 (public circular monitor)'}});
      if(!response.ok)throw new Error('Public circular API returned HTTP '+response.status);
      const text=await response.text();if(text.length>3_000_000)throw new Error('Public feed exceeds size limit.');
      const json=JSON.parse(text);all.push(...parsePublicFeed(json));
      if(!json.meta?.pagination?.hasNextPage){if(!all.length)throw new Error('No circulars in public feed. Previous state retained.');return all;}
    }
    throw new Error('Public feed exceeded 20 pages; refusing an incomplete baseline.');
  }
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), redirect:'error', headers:{'User-Agent':'VidyaVarta/1.5 (public circular monitor)'} });
  if (!res.ok) throw new Error(`University website returned HTTP ${res.status}.`);
  if (Number(res.headers.get('content-length'))>3_000_000) throw new Error('Source exceeds 3 MB limit.');
  const reader=res.body?.getReader(); if (!reader) throw new Error('Empty response');
  let html=''; let size=0; const decoder=new TextDecoder();
  while (true) { const {done,value}=await reader.read(); if(done)break; size+=value.length; if(size>3_000_000){await reader.cancel();throw new Error('Source exceeds 3 MB limit.');} html+=decoder.decode(value,{stream:true}); }
  const items=parseCirculars(html,url);
  if (!items.length) throw new Error('No document links found. Source layout may have changed; previous state retained.');
  return items;
}

