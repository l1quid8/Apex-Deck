use apex_cli::{
    args::{self, Launch},
    runtime,
};
#[tokio::main]
async fn main() {
    apex_cli::authority::harden_process();
    let result = async {
        match args::parse(std::env::args().skip(1))? {
            Launch::Help => print!("{}", args::HELP),
            Launch::Version => println!("{}", args::version_line()),
            Launch::Backend { args, stop } => apex_cli::backend::lifecycle(&args,stop).await?,
            Launch::Interactive(args) => {
                apex_cli::authority::assert_trusted_startup()?;
                apex_cli::backend::ensure(&args).await?;
                runtime::run(args).await?;
            }
        }
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = result {
        eprintln!("apex: {}", apex_cli::input::clean(&error));
        std::process::exit(1);
    }
}
