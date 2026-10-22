import { build } from 'esbuild';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync, mkdirSync, cpSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=resolve(process.env.VIDYAVARTA_PACKAGE_DIR??join(root,'portable-build'));
// Refuse to overwrite an arbitrary user directory. Packages contain this marker.
try{const marker=JSON.parse(readFileSync(join(output,'package.json'),'utf8'));if(marker.name!=='vidyavarta-ready')throw new Error('Refusing to overwrite a non-package directory.');}catch(e){if(e.code!=='ENOENT')throw e;}
mkdirSync(output,{recursive:true});
const result=await build({entryPoints:[join(root,'src/campus/portable/server.ts')],outfile:join(output,'server.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',minify:false,legalComments:'eof',metafile:true,alias:{'better-sqlite3':join(root,'src/campus/portable/sqlite.ts')},logLevel:'info'});
const external=Object.values(result.metafile.outputs).flatMap(out=>out.imports.filter(i=>i.external).map(i=>i.path));
const {builtinModules}=await import('node:module');
const nonBuiltin=external.filter(x=>!x.startsWith('node:')&&!builtinModules.includes(x));
if(nonBuiltin.length)throw new Error('Runtime still needs third-party modules: '+nonBuiltin.join(', '));
rmSync(join(output,'web'),{recursive:true,force:true});cpSync(join(root,'dist-web'),join(output,'web'),{recursive:true});
for(const name of ['launcher.cjs','START-VIDYAVARTA.cmd','CHECK-SETUP.cmd','check.cjs','hint.cjs']){
  let text=readFileSync(join(root,'tools/portable',name),'utf8');if(name.endsWith('.cmd'))text=text.replace(/\r?\n/g,'\r\n');writeFileSync(join(output,name),text);
}
const pkg={name:'vidyavarta-ready',version:'1.0.0',private:true,description:'Zero-install VidyaVarta (live product); no npm install needed - double-click START-VIDYAVARTA.cmd',engines:{node:'>=24'},scripts:{start:'node launcher.cjs',check:'node check.cjs','dev:live':'node hint.cjs',dev:'node hint.cjs'}};
writeFileSync(join(output,'package.json'),JSON.stringify(pkg,null,2)+'\n');
writeFileSync(join(output,'package-lock.json'),JSON.stringify({name:pkg.name,version:pkg.version,lockfileVersion:3,requires:true,packages:{'':{name:pkg.name,version:pkg.version,engines:pkg.engines}}},null,2)+'\n');
writeFileSync(join(output,'.gitignore'),'data/\nstartup-error.log\n.env\n');
cpSync(join(root,'tools/portable/START-HERE.md'),join(output,'START-HERE.md'));
cpSync(join(root,'tools/portable/READ-ME-FIRST.txt'),join(output,'READ-ME-FIRST.txt'));
cpSync(join(root,'START-LIVE.txt'),join(output,'START-LIVE.txt'));
cpSync(join(root,'LIVE-SETUP.txt'),join(output,'LIVE-SETUP.txt'));
cpSync(join(root,'README.md'),join(output,'PROJECT-INFO.md'));
mkdirSync(join(output,'licenses'),{recursive:true});cpSync(join(root,'LICENSE'),join(output,'licenses','UPSTREAM-LICENSE.txt'));
cpSync(join(root,'LICENSE-ASSETS.md'),join(output,'licenses','ASSET-ATTRIBUTION.md'));
cpSync(join(root,'src/renderer/src/campus/fonts/LICENSE-DM-Sans.txt'),join(output,'licenses','FONT-DM-SANS.txt'));
cpSync(join(root,'src/renderer/src/campus/fonts/LICENSE-Manrope.txt'),join(output,'licenses','FONT-MANROPE.txt'));
const libraries=new Set(Object.keys(JSON.parse(readFileSync(join(root,'package.json'),'utf8')).dependencies));
for(const input of Object.keys(result.metafile.inputs)){
  const tail=input.split('node_modules/').pop();if(tail===input)continue;const parts=tail.split('/');libraries.add(parts[0].startsWith('@')?parts.slice(0,2).join('/'):parts[0]);
}
let notices='VIDYAVARTA THIRD-PARTY NOTICES\n\nThe following library notices cover bundled backend and frontend dependencies. Some source-only libraries are listed for completeness.\n';
for(const library of [...libraries].sort()){
  const path=join(root,'node_modules',library);let pkg;try{pkg=JSON.parse(readFileSync(join(path,'package.json'),'utf8'));}catch{continue;}
  notices+='\n\n===== '+library+' '+pkg.version+' ('+String(pkg.license??'see package license')+') =====\n';
  for(const name of ['LICENSE','LICENSE.md','LICENSE.txt','license','license.md','LICENSE-MIT','COPYING']){try{notices+=readFileSync(join(path,name),'utf8')+'\n';break;}catch{}}
}
writeFileSync(join(output,'licenses','THIRD-PARTY-NOTICES.txt'),notices);
writeFileSync(join(output,'PACKAGE-CHECK.json'),JSON.stringify({buildNode:process.version,target:'Node.js 24+',nativeAddons:0,externalThirdPartyImports:nonBuiltin,requiredNpmInstall:false,mode:'live',configuration:'via .env next to launcher.cjs'},null,2));
console.log('READY PACKAGE:',output,'\nExternal third-party modules:',nonBuiltin.length,'\nNo native addons or development server required.');
