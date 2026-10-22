const fs=require('node:fs');const path=require('node:path');
console.log('Node:',process.version);
console.log('Node 24+:',Number(process.versions.node.split('.')[0])>=24?'PASS':'NEEDED');
for(const file of ['server.cjs','web/index.html','launcher.cjs'])console.log(file+':',fs.existsSync(path.join(__dirname,file))?'PASS':'MISSING - extract the whole ZIP');
try{const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE example(id INTEGER)');db.close();console.log('Built-in SQLite: PASS');}catch(e){console.log('Built-in SQLite:',e.message);}
try{const probe=path.join(__dirname,'.write-check');fs.writeFileSync(probe,'ok');fs.unlinkSync(probe);console.log('Folder write access: PASS');}catch(e){console.log('Folder write access: FAILED - move this folder to Downloads or Desktop');}
console.log('\nNo Vite, npm install, C++ compiler, or Python is required. Email, Classroom and the local brain are optional and configured in .env (see START-HERE.md).');
