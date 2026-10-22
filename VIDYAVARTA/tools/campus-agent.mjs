#!/usr/bin/env node
// A narrow bridge client for existing CLI sessions. Cannot resolve human approvals.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const [method='GET',path='/api/health',json]=process.argv.slice(2);
if(!['GET','POST'].includes(method)||!path.startsWith('/api/'))throw new Error('Usage: npm run campus:api -- GET /api/health');
const sessionPath=resolve(process.env.CAMPUS_DATA_DIR??'.campus-live','bridge-session.json');
const {url,token}=JSON.parse(await readFile(sessionPath,'utf8'));
const response=await fetch(url+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','X-Agent-Id':process.env.CAMPUS_AGENT??'Michael','X-Campus-Role':process.env.CAMPUS_ROLE??'operator','X-Teacher-Id':process.env.CAMPUS_TEACHER??'faculty-01'},...(method==='POST'?{body:json??'{}'}:{})});
console.log(JSON.stringify(await response.json(),null,2));if(!response.ok)process.exitCode=1;
