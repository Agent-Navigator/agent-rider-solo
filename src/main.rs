mod backend;

fn main() {
    let config = backend::config::Config::load();
    let _database = backend::database::Database::open(config.db_path.clone())
        .expect("open Agent Rider database");
    println!(
        "agent-rider-store core initialized for {}",
        config.db_path.display()
    );
}
