import {build} from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const root=fs.mkdtempSync('/tmp/deck-widget-ui-');
await build({configFile:false,define:{'process.env.NODE_ENV':'"production"'},plugins:[react()],build:{outDir:path.join(root,'assets'),lib:{entry:path.resolve('tests/fixtures/generated-widget-ui.tsx'),formats:['es'],fileName:()=> 'widget.js',cssFileName:'widget'},minify:false,emptyOutDir:true},logLevel:'error'});
fs.writeFileSync(path.join(root,'index.html'),'<html><head><link rel="stylesheet" href="assets/widget.css"></head><body style="margin:0;background:#fafafa;color:#222"><div id="root"></div><script type="module" src="assets/widget.js"></script></body></html>');
for(const phase of ['initial','restart']){
 const child=spawn(process.execPath,['node_modules/electron/cli.js','desktop/generated-ui/security-widget-ui.mjs','--fixture-dir',root,'--phase',phase],{stdio:['ignore','pipe','pipe']});
 const log=fs.createWriteStream(path.join(root,`${phase}.log`));child.stdout.pipe(log);child.stderr.pipe(log);
 const timer=setTimeout(()=>child.kill('SIGTERM'),60000);
 const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject)});clearTimeout(timer);log.end();
 const evidence=JSON.parse(fs.readFileSync(path.join(root,`${phase}.json`),'utf8'));
 console.log(JSON.stringify({code,root,phase,passed:evidence.passed,checks:evidence.checks,error:evidence.error}));
 if(code!==0||!evidence.passed){process.exitCode=1;break;}
}
