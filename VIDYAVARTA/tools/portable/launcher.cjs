'use strict';
// Intentionally dependency-free: this is the user's entry point, not Vite.
const fs=require('node:fs');
const path=require('node:path');
process.chdir(__dirname);
const major=Number(process.versions.node.split('.')[0]);
if(major<24){
  console.error('\nThis package needs Node.js 24 or newer. Detected: '+process.version+'\nKeep/install Node.js 24, reopen the terminal, and try again.\nNo npm install is required.\n');
  process.exitCode=1;
}else if(!fs.existsSync(path.join(__dirname,'server.cjs'))||!fs.existsSync(path.join(__dirname,'web','index.html'))){
  console.error('\nSome application files are missing. Right-click the ZIP -> Extract All.\nThen launch START-VIDYAVARTA.cmd from the extracted folder.\nDo not run it from inside the ZIP viewer.\n');process.exitCode=1;
}else{
  process.on('uncaughtException',error=>{
    const text=new Date().toISOString()+'\n'+(error.stack||error.message)+'\n';
    try{fs.appendFileSync(path.join(__dirname,'startup-error.log'),text);}catch{}
    console.error('\nStartup error: '+error.message+'\nSee startup-error.log in this folder.\n');process.exit(1);
  });
  require('./server.cjs');
}
