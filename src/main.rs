mod backend;

const SOURCE_COMMIT: &str = match option_env!("AGENT_RIDER_SOURCE_COMMIT") {
    Some(value) => value,
    None => "unknown",
};

fn print_version() {
    println!("agrider {} ({SOURCE_COMMIT})", env!("CARGO_PKG_VERSION"));
}

fn usage() {
    eprintln!("Usage: agrider <serve|upgrade>\n       agrider --version");
}

#[tokio::main]
async fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("--version" | "-V") => print_version(),
        Some("serve") => {
            let config = backend::config::Config::load();
            let database = backend::database::Database::open(config.db_path.clone())
                .expect("open Agent Rider database");
            backend::server::serve(config, database)
                .await
                .expect("serve Agent Rider");
        }
        Some("upgrade") => {
            eprintln!("agrider upgrade is not available in this development build yet");
            std::process::exit(2);
        }
        _ => {
            usage();
            std::process::exit(2);
        }
    }
}
