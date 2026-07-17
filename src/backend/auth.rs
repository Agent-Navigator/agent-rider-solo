use super::database::Database;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use chrono::Utc;
use hmac::{Hmac, Mac};
use pbkdf2::pbkdf2_hmac;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;

const PASSWORD_KEY: &str = "page_password";
const SECRET_KEY: &str = "page_password_session_secret";
const ITERATIONS: u32 = 210_000;
const SESSION_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordRecord {
    pub salt: String,
    pub hash: String,
    pub iterations: u32,
    pub digest: String,
    pub version: String,
    pub updated_at: String,
}

fn random(bytes: usize) -> String {
    let mut value = vec![0; bytes];
    rand::rng().fill_bytes(&mut value);
    URL_SAFE_NO_PAD.encode(value)
}
fn hash(password: &str, salt: &str, iterations: u32) -> String {
    let mut out = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), salt.as_bytes(), iterations, &mut out);
    URL_SAFE_NO_PAD.encode(out)
}

pub async fn record(db: &Database) -> Option<PasswordRecord> {
    db.get_kv(PASSWORD_KEY)
        .await
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_str(&v).ok())
}
pub fn verify(password: &str, record: &PasswordRecord) -> bool {
    hash(password, &record.salt, record.iterations) == record.hash
}
pub async fn set(db: &Database, password: &str) -> Result<PasswordRecord, String> {
    let salt = random(16);
    let record = PasswordRecord {
        salt: salt.clone(),
        hash: hash(password, &salt, ITERATIONS),
        iterations: ITERATIONS,
        digest: "sha256".into(),
        version: random(12),
        updated_at: Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    db.set_kv(PASSWORD_KEY, serde_json::to_string(&record).unwrap())
        .await?;
    Ok(record)
}
async fn secret(db: &Database) -> Result<String, String> {
    if let Some(v) = db.get_kv(SECRET_KEY).await? {
        return Ok(v);
    }
    let value = random(32);
    db.set_kv(SECRET_KEY, value.clone()).await?;
    Ok(value)
}
pub async fn cookie(db: &Database, record: &PasswordRecord) -> Result<String, String> {
    let expires = Utc::now().timestamp_millis() + SESSION_MS;
    let mut mac = Hmac::<Sha256>::new_from_slice(secret(db).await?.as_bytes()).unwrap();
    mac.update(format!("{}.{}", record.version, expires).as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!(
        "agent_rider_auth={}.{}.{}; Path=/; Max-Age={}; HttpOnly; SameSite=Strict",
        record.version,
        expires,
        signature,
        SESSION_MS / 1000
    ))
}
pub async fn authorized(db: &Database, cookie_header: Option<&str>) -> bool {
    let Some(record) = record(db).await else {
        return true;
    };
    let token = cookie_header
        .unwrap_or("")
        .split(';')
        .map(str::trim)
        .find_map(|v| v.strip_prefix("agent_rider_auth="));
    let Some(token) = token else { return false };
    let parts: Vec<_> = token.split('.').collect();
    if parts.len() != 3 || parts[0] != record.version {
        return false;
    }
    let Ok(expires) = parts[1].parse::<i64>() else {
        return false;
    };
    if expires < Utc::now().timestamp_millis() {
        return false;
    }
    let Ok(key) = secret(db).await else {
        return false;
    };
    let mut mac = Hmac::<Sha256>::new_from_slice(key.as_bytes()).unwrap();
    mac.update(format!("{}.{}", parts[0], expires).as_bytes());
    mac.verify_slice(&URL_SAFE_NO_PAD.decode(parts[2]).unwrap_or_default())
        .is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matches_known_pbkdf2_record() {
        let record = PasswordRecord {
            salt: "c2FsdA".into(),
            hash: hash("password", "c2FsdA", ITERATIONS),
            iterations: ITERATIONS,
            digest: "sha256".into(),
            version: "v".into(),
            updated_at: "".into(),
        };
        assert!(verify("password", &record));
        assert!(!verify("wrong", &record));
    }
}
