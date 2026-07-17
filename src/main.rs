mod backend;

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("agent-rider-store {}", env!("CARGO_PKG_VERSION"));
        return;
    }
    let config = backend::config::Config::load();
    let database = backend::database::Database::open(config.db_path.clone())
        .expect("open Agent Rider database");
    backend::server::serve(config, database)
        .await
        .expect("serve Agent Rider backend");
}
