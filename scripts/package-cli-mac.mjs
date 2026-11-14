import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickIdentity } from './package-mac.mjs';
import { checkSource, buildEnv } from './cli-release-source.mjs';

export function selectIdentity(output, env) {
  const identity=pickIdentity(output,env);
  if(identity==='-') throw new Error('A Developer ID Application identity is required for CLI authority enrollment.');
  return identity;
}
export function validateVersion(version) {
  if(!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version)) throw new Error('Invalid release version');
  return version;
}
export function releaseCommands(manifest) {
  return ['apex-cli','apex-daemon','apex-provenance'].map(name=>['cargo','build','--manifest-path',manifest,'--release','--locked','-p',name]);
}
export function manifestFor(version,files,sourceCommit) {
  validateVersion(version);
  if(!/^[a-f0-9]{40}$/.test(sourceCommit||'')) throw new Error('Invalid source commit');
  for(const file of files) {
    if(!/^[a-zA-Z0-9_.-]+$/.test(file.name) || file.name==='..') throw new Error('Invalid manifest file');
    if(!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('Invalid manifest hash');
  }
  return {formatVersion:1,product:'apex-cli',version,architecture:'arm64',sourceCommit,files};
}
function run(command,args,options={}) {
  const r=spawnSync(command,args,{stdio:'inherit',...options});
  if(r.error) throw r.error;
  if(r.status!==0) throw new Error(`${command} failed; release was not produced`);
  return r;
}
function main() {
  if(process.platform!=='darwin'||process.arch!=='arm64') throw new Error('First acceptance target is macOS Apple Silicon.');
  const repo=resolve(dirname(fileURLToPath(import.meta.url)),'..');
  const release=join(repo,'release');
  if(resolve(process.cwd())!==release) throw new Error(`Start CLI production packaging from ${release}`);
  // Refuses unless this folder is an unmodified export of a commit on main.
  const source=checkSource(repo);
  const version=validateVersion(source.version);
  console.log(`Building CLI ${version} from ${source.commit}`);
  const discovery=run('/usr/bin/security',['find-identity','-v','-p','codesigning'],{encoding:'utf8',stdio:'pipe'});
  const identity=selectIdentity(discovery.stdout,process.env);
  for(const [command,...args] of releaseCommands(join(repo,'Cargo.toml'))) run(command,args,{cwd:release,env:{...process.env,...buildEnv(source)}});
  const stage=mkdtempSync(join(release,'.apex-cli-'));
  try {
    const name=`Apex-CLI_${version}_arm64`;
    const product=join(stage,name); mkdirSync(product);
    const files=[];
    for(const binary of ['apex','apex-daemon','apex-provenance']) {
      const target=join(product,binary); copyFileSync(join(repo,'target/release',binary),target);
      const identifier=binary==='apex'?'dev.apexdeck.cli':`dev.apexdeck.${binary.slice(5)}`;
      run('/usr/bin/codesign',['--force','--sign',identity,'--identifier',identifier,'--options','runtime','--timestamp',target]);
      run('/usr/bin/codesign',['--verify','--strict','-R=anchor apple generic and certificate leaf[subject.OU] = "75N5HW62JH"',target]);
      files.push({name:binary,sha256:createHash('sha256').update(readFileSync(target)).digest('hex')});
    }
    copyFileSync(join(repo,'scripts/install-cli-provenance.sh'),join(product,'install-cli-provenance.sh'));
    writeFileSync(join(product,'manifest.json'),JSON.stringify(manifestFor(version,files,source.commit),null,2)+'\n');
    writeFileSync(join(product,'INSTALL.txt'),`Apex CLI ${version}, macOS Apple Silicon\n\nThis archive contains Developer ID signed binaries. It is not a notarized installer.\nInstall explicitly from this extracted directory:\n  sudo /bin/bash ./install-cli-provenance.sh "$PWD"\nThen launch in your normal user terminal:\n  apex\n\nThe installer preserves existing Deck authority keys, journal and exact pins, adding separate standalone pins. It restarts the authority service. Upgrades: an identical build is a no-op, a newer version or a rebuilt same-version payload replaces Standalone and swaps standalone pins, older is refused. Quit apex and run apex backend stop first; the installer refuses while the CLI or its backend is running and restores the previous install if anything fails. Flags: --no-path-link (skip /usr/local/bin/apex link), --uninstall (remove Standalone and standalone pins, keep data).\nProvider API-key setup is unfinished; use official provider subscription sign-in.\n`);
    const archive=join(release,`${name}.tar.gz`);
    run('/usr/bin/tar',['--no-xattrs','-czf',archive,'-C',stage,name],{env:{...process.env,COPYFILE_DISABLE:'1'}});
    const hash=createHash('sha256').update(readFileSync(archive)).digest('hex');
    writeFileSync(`${archive}.sha256`,`${hash}  ${name}.tar.gz\n`);
    console.log(`Signed CLI archive: ${archive}\nSHA256 ${hash}\nNotarization and installed acceptance remain required.`);
  } finally { rmSync(stage,{recursive:true,force:true}); }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { main(); } catch(error) { console.error(error.message); process.exitCode=1; }
}
