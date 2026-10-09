const fs=require('fs'),p=require('path'),D=__dirname,r=f=>fs.existsSync(p.join(D,f))?fs.readFileSync(p.join(D,f),'utf8'):'';
const parts=['av','cv','su','bb','cf'];
const intro=r('intro.html');
const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>ApexAgent · floating assistant · v2</title>
<style>${r('core.css')}\n${parts.map(x=>`/* ${x} */\n`+r('parts/'+x+'.css')).join('\n')}\n${r('lead.css')}</style></head><body>
${intro}${r('shell.html')}
<script>${r('core.js')}</script>
${parts.map(x=>`<script>/* ${x} */\n${r('parts/'+x+'.js')}</script>`).join('\n')}
<script>${r('main.js')}</script>
<script>${r('steps.js')}</script>
</body></html>`;
fs.writeFileSync(process.argv[2]||p.join(D,'out.html'),html);console.log('wrote',html.length,'bytes');
