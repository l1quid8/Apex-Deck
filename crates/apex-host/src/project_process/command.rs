//! Opaque builders: project execution policy is applied after all arguments,
//! environment and working-directory changes, at the actual spawn boundary.
use std::{
    ffi::{OsStr, OsString},
    io,
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Output, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, Arc},
    time::{Duration, Instant},
};
use apex_adapters::{OwnedProcessChild, OwnedProcessRegistry};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub struct ProjectCommand {
    command: Option<Command>,
    data: PathBuf,
    folder: PathBuf,
    stdin: Option<Stdio>,
    stdout: Option<Stdio>,
    stderr: Option<Stdio>,
    input: Option<Vec<u8>>,
}

pub struct ProjectAsyncCommand(ProjectCommand);

pub struct BoundedOutput {
    pub output: Output,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

struct SpawnConfig {
    command: Command,
    data: PathBuf,
    folder: PathBuf,
    stdin: Stdio,
    stdout: Stdio,
    stderr: Stdio,
    input: Option<Vec<u8>>,
}

impl ProjectCommand {
    pub(super) fn new(command: Command, data: &Path, folder: &Path) -> Self {
        Self { command: Some(command), data: data.to_path_buf(), folder: folder.to_path_buf(), stdin: None, stdout: None, stderr: None, input: None }
    }
    fn config(&mut self) -> &mut Command { self.command.as_mut().expect("project command already executed") }
    pub fn arg(&mut self, arg: impl AsRef<OsStr>) -> &mut Self { self.config().arg(arg); self }
    pub fn args<I, S>(&mut self, args: I) -> &mut Self where I: IntoIterator<Item=S>, S: AsRef<OsStr> { self.config().args(args); self }
    pub fn env(&mut self, key: impl AsRef<OsStr>, value: impl AsRef<OsStr>) -> &mut Self { self.config().env(key,value); self }
    pub fn env_remove(&mut self, key: impl AsRef<OsStr>) -> &mut Self { self.config().env_remove(key); self }
    pub fn current_dir(&mut self, folder: impl AsRef<Path>) -> &mut Self { self.folder=folder.as_ref().to_path_buf(); self.config().current_dir(folder); self }
    pub fn stdin(&mut self, stdio: Stdio) -> &mut Self { self.stdin=Some(stdio); self }
    pub fn stdout(&mut self, stdio: Stdio) -> &mut Self { self.stdout=Some(stdio); self }
    pub fn stderr(&mut self, stdio: Stdio) -> &mut Self { self.stderr=Some(stdio); self }
    pub fn input(&mut self, bytes: &[u8]) -> &mut Self { self.input=Some(bytes.to_vec()); self }
    #[cfg(unix)]
    pub fn process_group(&mut self, group: i32) -> &mut Self { use std::os::unix::process::CommandExt; self.config().process_group(group); self }
    #[cfg(windows)]
    pub fn raw_arg(&mut self, arg: impl AsRef<OsStr>) -> &mut Self { use std::os::windows::process::CommandExt; self.config().raw_arg(arg); self }

    fn take(&mut self, output: bool) -> io::Result<SpawnConfig> {
        let mut command=self.command.take().ok_or_else(||io::Error::other("project command already executed"))?;
        // Use the final directory, after every builder setter. Linux always
        // jails; other platforms cannot launch a command constructed before taint.
        let folder=self.folder.canonicalize()?;
        super::check_project(&self.data,&folder).map_err(io::Error::other)?;
        command.current_dir(&folder);
        let input=self.input.take();
        let stdin=if input.is_some(){Stdio::piped()}else{self.stdin.take().unwrap_or_else(||if output {Stdio::null()}else{Stdio::inherit()})};
        Ok(SpawnConfig { command, data:self.data.clone(), folder,
            stdin,
            stdout:self.stdout.take().unwrap_or_else(||if output {Stdio::piped()} else {Stdio::inherit()}),
            stderr:self.stderr.take().unwrap_or_else(||if output {Stdio::piped()} else {Stdio::inherit()}), input })
    }

    pub fn output(&mut self) -> io::Result<Output> { self.run_sync(true,None,usize::MAX,usize::MAX,||None).map(|r|r.output) }
    pub fn status(&mut self) -> io::Result<ExitStatus> { self.run_sync(false,None,0,0,||None).map(|r|r.output.status) }
    pub fn output_bounded(&mut self, timeout: Duration, stdout_cap:usize, stderr_cap:usize) -> io::Result<BoundedOutput> {
        self.run_sync(true,Some(timeout),stdout_cap,stderr_cap,||None)
    }
    pub fn output_with_monitor(&mut self, stopped: impl FnMut()->Option<String>) -> io::Result<Output> {
        self.run_sync(true,None,usize::MAX,usize::MAX,stopped).map(|r|r.output)
    }
    fn run_sync(&mut self, output:bool, timeout:Option<Duration>, out_cap:usize, err_cap:usize, mut stopped:impl FnMut()->Option<String>) -> io::Result<BoundedOutput> {
        let config=self.take(output)?;
        let cancel=Arc::new(AtomicBool::new(false)); let worker_cancel=cancel.clone();
        let (sent,received)=std::sync::mpsc::sync_channel(1);
        // A persistent thread for this execution owns bubblewrap's parent and
        // reactor until the child tree and proxy are stopped. No nested runtime.
        std::thread::Builder::new().name("apex-project-process".into()).spawn(move || {
            let result=tokio::runtime::Builder::new_current_thread().enable_all().build()
                .and_then(|runtime|runtime.block_on(collect(config,timeout,out_cap,err_cap,worker_cancel)));
            let _=sent.send(result);
        })?;
        let mut reason=None;
        loop {
            if reason.is_none() { if let Some(message)=stopped() { reason=Some((message,Instant::now())); cancel.store(true,Ordering::SeqCst); } }
            match received.recv_timeout(Duration::from_millis(20)) {
                Ok(result)=>return if let Some((message,_))=reason {Err(io::Error::new(io::ErrorKind::Interrupted,message))} else {result},
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected)=>return Err(io::Error::other("project executor stopped without a result")),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)=> {
                    if reason.as_ref().is_some_and(|(_,at)|at.elapsed()>Duration::from_secs(10)) { return Err(io::Error::other("project process cleanup did not finish after cancellation")); }
                }
            }
        }
    }
}

impl ProjectAsyncCommand {
    pub(super) fn new(command: ProjectCommand) -> Self {Self(command)}
    pub fn arg(&mut self, arg:impl AsRef<OsStr>)->&mut Self {self.0.arg(arg);self}
    pub fn args<I,S>(&mut self,args:I)->&mut Self where I:IntoIterator<Item=S>,S:AsRef<OsStr>{self.0.args(args);self}
    pub fn env(&mut self,key:impl AsRef<OsStr>,value:impl AsRef<OsStr>)->&mut Self{self.0.env(key,value);self}
    pub fn env_remove(&mut self,key:impl AsRef<OsStr>)->&mut Self{self.0.env_remove(key);self}
    pub fn current_dir(&mut self,folder:impl AsRef<Path>)->&mut Self{self.0.current_dir(folder);self}
    pub fn stdin(&mut self,stdio:Stdio)->&mut Self{self.0.stdin(stdio);self}
    pub fn stdout(&mut self,stdio:Stdio)->&mut Self{self.0.stdout(stdio);self}
    pub fn stderr(&mut self,stdio:Stdio)->&mut Self{self.0.stderr(stdio);self}
    // All project children are owned and killed when dropped.
    pub fn input(&mut self,bytes:&[u8])->&mut Self{self.0.input(bytes);self}
    pub fn kill_on_drop(&mut self,_enabled:bool)->&mut Self{self}
    #[cfg(unix)]
    pub fn process_group(&mut self,group:i32)->&mut Self{self.0.process_group(group);self}
    #[cfg(windows)]
    pub fn raw_arg(&mut self,arg:impl AsRef<OsStr>)->&mut Self{self.0.raw_arg(arg);self}
    pub async fn prepare(&self)->io::Result<()> { prepare(&self.0.data).await.map_err(io::Error::other) }
    pub fn spawn(&mut self)->io::Result<ProjectChild>{self.spawn_owned(&OwnedProcessRegistry::default())}
    pub fn spawn_owned(&mut self,registry:&OwnedProcessRegistry)->io::Result<ProjectChild>{spawn(self.0.take(false)?,registry)}
    pub async fn output(&mut self)->io::Result<Output>{collect(self.0.take(true)?,None,usize::MAX,usize::MAX,Arc::new(AtomicBool::new(false))).await.map(|r|r.output)}
}

/// Keeps proxy routing attached to the owned child instead of a command builder.
pub struct ProjectChild { child:OwnedProcessChild, proxy:Option<tokio::task::JoinHandle<()>> }
impl std::ops::Deref for ProjectChild {type Target=OwnedProcessChild;fn deref(&self)->&Self::Target{&self.child}}
impl std::ops::DerefMut for ProjectChild {fn deref_mut(&mut self)->&mut Self::Target{&mut self.child}}
impl ProjectChild {
    pub async fn wait_with_output(self)->io::Result<Output>{collect_child(self,None,None,usize::MAX,usize::MAX,Arc::new(AtomicBool::new(false))).await.map(|out|out.output)}
    pub async fn terminate_tree(&mut self)->Result<(),String>{
        self.child.terminate_tree().await?;
        if let Some(proxy)=self.proxy.take(){proxy.abort();let _=proxy.await;}
        Ok(())
    }
}
impl Drop for ProjectChild {fn drop(&mut self){if let Some(proxy)=self.proxy.take(){proxy.abort();}}}

fn spawn(mut config:SpawnConfig,registry:&OwnedProcessRegistry)->io::Result<ProjectChild>{
    tokio::runtime::Handle::try_current().map_err(|_|io::Error::other("project execution requires a running process reactor"))?;
    super::check_project(&config.data,&config.folder).map_err(io::Error::other)?;
    #[cfg(target_os="linux")]
    {return spawn_jailed(config,registry);}
    #[cfg(not(target_os="linux"))]
    {
        config.command.stdin(config.stdin).stdout(config.stdout).stderr(config.stderr);
        let mut command=tokio::process::Command::from(config.command);command.kill_on_drop(true);
        Ok(ProjectChild{child:registry.spawn(&mut command)?,proxy:None})
    }
}

// Compiled on Unix, including macOS, so the complete Linux launch path receives
// type checking during host development. Only Linux calls it in production.
#[cfg(unix)]
fn spawn_jailed(config:SpawnConfig,registry:&OwnedProcessRegistry)->io::Result<ProjectChild>{
    use apex_adapters::linux_jail;
    let path=config.command.get_envs().find(|(k,_)|*k==OsStr::new("PATH")).and_then(|(_,v)|v.map(OsString::from)).unwrap_or_else(||std::env::var_os("PATH").unwrap_or_default());
    let bwrap=linux_jail::find_bwrap(path.to_str()).ok_or_else(||io::Error::other("Automatic project operation refused: bubblewrap is unavailable"))?;
    match linux_jail::recorded_probe_state() {
        Some(linux_jail::JailState::Works)=>{},
        Some(linux_jail::JailState::Fails(reason))=>return Err(io::Error::other(reason)),
        None=>return Err(io::Error::other("Automatic project operation refused: the Linux jail has not passed its boot probe")),
    }
    let home=std::env::var_os("HOME").map(PathBuf::from).ok_or_else(||io::Error::other("project jail requires a home folder"))?;
    let args:Vec<String>=config.command.get_args().map(|arg|arg.to_str().map(str::to_owned).ok_or_else(||io::Error::other("project jail arguments must be valid UTF-8"))).collect::<Result<_,_>>()?;
    static NEXT:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
    let id=format!("{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed));
    let mut spec=linux_jail::build_spec(Path::new(config.command.get_program()),&args,&config.folder,apex_core::Access::Edits,None,&home,&config.data,"project-operations",&id,&path,&[],&[]).map_err(|error|io::Error::other(error.to_string()))?;
    spec.init=init_path()?;
    spec.provider_env=config.command.get_envs().filter_map(|(key,value)|Some((key.to_str()?.to_owned(),value?.to_os_string()))).collect();
    let mut jailed=linux_jail::launch::jailed_command(&spec,&bwrap).map_err(|error|io::Error::other(error.to_string()))?;
    jailed.command.stdin(config.stdin).stdout(config.stdout).stderr(config.stderr).kill_on_drop(true);
    let (child,control)=jailed.spawn(registry)?;
    let purposes=Arc::new(linux_jail::DaemonPurposes::new(Arc::new(linux_jail::proxy::Internet::default())));
    let proxy=tokio::spawn(linux_jail::channel::serve(control,purposes));
    Ok(ProjectChild{child,proxy:Some(proxy)})
}

async fn drain(mut pipe:impl tokio::io::AsyncRead+Unpin,cap:usize)->io::Result<(Vec<u8>,bool)>{
    let mut out=Vec::new();let mut truncated=false;let mut buf=[0u8;8192];
    loop{let n=pipe.read(&mut buf).await?;if n==0{break;}let keep=n.min(cap.saturating_sub(out.len()));out.extend_from_slice(&buf[..keep]);truncated|=keep<n;}
    Ok((out,truncated))
}
async fn collect(config:SpawnConfig,timeout:Option<Duration>,out_cap:usize,err_cap:usize,cancel:Arc<AtomicBool>)->io::Result<BoundedOutput>{
    let input=config.input.clone();
    #[cfg(target_os="linux")]
    prepare(&config.data).await.map_err(io::Error::other)?;
    #[cfg(target_os="linux")]
    let registry={let dir=config.data.join("project-processes");std::fs::create_dir_all(&dir)?;OwnedProcessRegistry::new(Some(dir))};
    #[cfg(not(target_os="linux"))]
    let registry=OwnedProcessRegistry::default();
    let child=spawn(config,&registry)?;
    collect_child(child,input,timeout,out_cap,err_cap,cancel).await
}
async fn collect_child(mut child:ProjectChild,input:Option<Vec<u8>>,timeout:Option<Duration>,out_cap:usize,err_cap:usize,cancel:Arc<AtomicBool>)->io::Result<BoundedOutput>{
    let stdout=child.stdout.take();let stderr=child.stderr.take();let stdin=child.stdin.take();
    let mut readers=tokio::spawn(async move{
        let out=async{match stdout{Some(p)=>drain(p,out_cap).await,None=>Ok((Vec::new(),false))}};
        let err=async{match stderr{Some(p)=>drain(p,err_cap).await,None=>Ok((Vec::new(),false))}};
        let write=async{if let(Some(mut pipe),Some(input))=(stdin,input){pipe.write_all(&input).await?;pipe.shutdown().await?;}Ok::<_,io::Error>(())};
        let(out,err,write)=tokio::join!(out,err,write);write?;Ok::<_,io::Error>((out?,err?))
    });
    let cancelled=async{loop{if cancel.load(Ordering::SeqCst){break;}tokio::time::sleep(Duration::from_millis(20)).await;}};
    let deadline=async{match timeout{Some(timeout)=>tokio::time::sleep(timeout).await,None=>std::future::pending().await}};
    let status=tokio::select!{status=child.wait()=>status,_=cancelled=>Err(io::Error::new(io::ErrorKind::Interrupted,"project command cancelled")),_=deadline=>Err(io::Error::new(io::ErrorKind::TimedOut,"project command timed out"))};
    let cleanup=child.terminate_tree().await.map_err(io::Error::other);
    let _=child.wait().await;
    cleanup?;
    let output=match tokio::time::timeout(Duration::from_secs(2),&mut readers).await {
        Ok(result)=>result.map_err(io::Error::other)??,
        Err(_)=>{readers.abort();let _=readers.await;return Err(io::Error::other("project output pipes did not close after cleanup"));}
    };
    Ok(BoundedOutput{output:Output{status:status?,stdout:output.0.0,stderr:output.1.0},stdout_truncated:output.0.1,stderr_truncated:output.1.1})
}

#[cfg(target_os="linux")]
async fn ensure_probe(data:&Path)->io::Result<()>{
    use apex_adapters::linux_jail;
    if linux_jail::recorded_probe_state().is_none(){
        static PROBE:tokio::sync::OnceCell<linux_jail::JailState>=tokio::sync::OnceCell::const_new();
        let state=PROBE.get_or_init(||async{
            let env=linux_jail::probe::ProbeEnv{init:init_path().unwrap_or_default(),home:std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default(),data:data.to_path_buf()};
            linux_jail::probe::run_installed(&env).await
        }).await.clone();
        linux_jail::record_probe_state(state);
    }
    match linux_jail::recorded_probe_state(){Some(linux_jail::JailState::Works)=>Ok(()),Some(linux_jail::JailState::Fails(reason))=>Err(io::Error::other(reason)),None=>Err(io::Error::other("Linux jail boot probe is unavailable"))}
}

#[cfg(unix)]
fn init_path()->io::Result<PathBuf>{
    #[cfg(feature="test-support")]
    if let Some(path)=std::env::var_os("APEX_JAIL_INIT"){return Ok(PathBuf::from(path));}
    std::env::current_exe()
}

pub async fn prepare(data:&Path)->Result<(),String>{
    #[cfg(target_os="linux")]
    ensure_probe(data).await.map_err(|e|e.to_string())?;
    #[cfg(not(target_os="linux"))]
    let _=data;
    Ok(())
}
