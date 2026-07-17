mod backend;

#[tokio::main]
async fn main() {
    let config = backend::config::Config::load();
    let database = backend::database::Database::open(config.db_path.clone())
        .expect("open Agent Rider database");
    backend::server::serve(config, database)
        .await
        .expect("serve Agent Rider backend");
}
