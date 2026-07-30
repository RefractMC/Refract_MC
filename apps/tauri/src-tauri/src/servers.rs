//! Instance server list (servers.dat NBT) + server status ping (TCP Server List
//! Ping). Port of the mc.servers / mc.pingServer IPC handlers.

use crate::instances;
use crate::paths;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::time::{Duration, Instant};

#[derive(Deserialize)]
struct ServersDat {
    servers: Option<Vec<ServerEntry>>,
}

#[derive(Deserialize)]
struct ServerEntry {
    name: Option<String>,
    ip: Option<String>,
    icon: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedServer {
    id: String,
    name: String,
    ip: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    minecraft_version: Option<String>,
    updated_at: i64,
}

#[derive(Default, Deserialize, Serialize)]
struct LinkedServerStore {
    #[serde(default = "store_version")]
    version: u32,
    #[serde(default)]
    instances: HashMap<String, Vec<LinkedServer>>,
}

fn store_version() -> u32 {
    1
}

fn linked_servers_path() -> PathBuf {
    paths::data_dir().join("linked-servers.json")
}

fn load_linked_store() -> LinkedServerStore {
    fs::read_to_string(linked_servers_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_else(|| LinkedServerStore {
            version: store_version(),
            ..LinkedServerStore::default()
        })
}

fn persist_linked_store(store: &LinkedServerStore) -> Result<(), String> {
    fs::create_dir_all(paths::data_dir()).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    fs::write(linked_servers_path(), text).map_err(|e| e.to_string())
}

fn linked_for_instance(instance_id: &str) -> Vec<LinkedServer> {
    // Linked records are kept outside Minecraft's NBT file.
    load_linked_store()
        .instances
        .remove(instance_id)
        .unwrap_or_default()
}

fn normalize_server_address(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty()
        || value.len() > 255
        || !value.is_ascii()
        || value.chars().any(char::is_whitespace)
        || value.contains("//")
        || value.contains(['/', '\\', '@', '?', '#'])
    {
        return Err("Enter a valid Minecraft server address.".into());
    }

    if let Some(bracketed) = value.strip_prefix('[') {
        let Some((host, suffix)) = bracketed.split_once(']') else {
            return Err("Enter a valid bracketed IPv6 server address.".into());
        };
        if host.parse::<std::net::Ipv6Addr>().is_err() {
            return Err("Enter a valid bracketed IPv6 server address.".into());
        }
        if suffix.is_empty() {
            return Ok(value.to_ascii_lowercase());
        }
        let Some(port) = suffix.strip_prefix(':') else {
            return Err("Enter a valid bracketed IPv6 server address.".into());
        };
        if port.parse::<u16>().ok().filter(|port| *port > 0).is_none() {
            return Err("Server ports must be between 1 and 65535.".into());
        }
        return Ok(value.to_ascii_lowercase());
    }

    if value.matches(':').count() > 1 {
        return Err("IPv6 addresses must be wrapped in brackets.".into());
    }
    if let Some((host, port)) = value.rsplit_once(':') {
        if host.is_empty() {
            return Err("Enter a valid Minecraft server address.".into());
        }
        if port.parse::<u16>().ok().filter(|port| *port > 0).is_none() {
            return Err("Server ports must be between 1 and 65535.".into());
        }
    }
    Ok(value.to_ascii_lowercase())
}

fn normalize_server_name(raw: &str) -> Result<String, String> {
    let value = raw.trim();
    if value.is_empty() || value.chars().count() > 80 || value.chars().any(char::is_control) {
        return Err("Server names must be between 1 and 80 characters.".into());
    }
    Ok(value.to_string())
}

fn normalize_minecraft_version(raw: Option<String>) -> Result<Option<String>, String> {
    let Some(raw) = raw else { return Ok(None) };
    let value = raw.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 32
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return Err("The invite contains an invalid Minecraft version.".into());
    }
    Ok(Some(value.to_string()))
}

/// Parse the instance's servers.dat (uncompressed NBT) into the saved server
fn merge_linked_servers(mut servers: Vec<Value>, linked_servers: Vec<LinkedServer>) -> Vec<Value> {
    let mut addresses: HashSet<String> = servers
        .iter()
        .filter_map(|server| server.get("ip").and_then(Value::as_str))
        .map(str::to_ascii_lowercase)
        .collect();
    for linked in linked_servers {
        let address = linked.ip.to_ascii_lowercase();
        if !addresses.insert(address) {
            if let Some(server) = servers.iter_mut().find(|server| {
                server
                    .get("ip")
                    .and_then(Value::as_str)
                    .is_some_and(|ip| ip.eq_ignore_ascii_case(&linked.ip))
            }) {
                server["linked"] = json!(true);
                server["linkId"] = json!(linked.id);
                server["minecraftVersion"] = json!(linked.minecraft_version);
                server["updatedAt"] = json!(linked.updated_at);
            }
            continue;
        }
        servers.push(json!({
            "name": linked.name,
            "ip": linked.ip,
            "linked": true,
            "linkId": linked.id,
            "minecraftVersion": linked.minecraft_version,
            "updatedAt": linked.updated_at,
        }));
    }
    servers
}

/// list. Returns `[{ name, ip, icon? }]`.
#[tauri::command]
pub fn mc_servers(instance_id: String) -> Vec<Value> {
    let path = instances::game_dir(&instance_id).join("servers.dat");
    let parsed = std::fs::read(&path)
        .ok()
        .and_then(|bytes| fastnbt::from_bytes::<ServersDat>(&bytes).ok());
    let servers: Vec<Value> = parsed
        .and_then(|value| value.servers)
        .unwrap_or_default()
        .into_iter()
        .map(|server| {
            let mut value = json!({
                "name": server.name.unwrap_or_default(),
                "ip": server.ip.unwrap_or_default(),
            });
            if let Some(icon) = server.icon {
                value["icon"] = json!(icon);
            }
            value
        })
        .collect();

    merge_linked_servers(servers, linked_for_instance(&instance_id))
}

#[tauri::command]
pub fn linked_servers(instance_id: String) -> Result<Vec<LinkedServer>, String> {
    if instances::get_instance_by_id(instance_id.clone()).is_none() {
        return Err(format!("Instance not found: {instance_id}"));
    }
    Ok(linked_for_instance(&instance_id))
}

#[tauri::command]
pub fn link_server(
    instance_id: String,
    id: Option<String>,
    name: String,
    ip: String,
    minecraft_version: Option<String>,
) -> Result<LinkedServer, String> {
    if instances::get_instance_by_id(instance_id.clone()).is_none() {
        return Err(format!("Instance not found: {instance_id}"));
    }
    let id = id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if id.is_empty()
        || id.len() > 96
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("The invite contains an invalid link ID.".into());
    }
    let server = LinkedServer {
        id,
        name: normalize_server_name(&name)?,
        ip: normalize_server_address(&ip)?,
        minecraft_version: normalize_minecraft_version(minecraft_version)?,
        updated_at: chrono::Utc::now().timestamp_millis(),
    };
    let mut store = load_linked_store();
    let servers = store.instances.entry(instance_id).or_default();
    servers.retain(|existing| existing.id != server.id && existing.ip != server.ip);
    servers.push(server.clone());
    persist_linked_store(&store)?;
    Ok(server)
}

#[tauri::command]
pub fn unlink_server(instance_id: String, id: String) -> Result<(), String> {
    let mut store = load_linked_store();
    if let Some(servers) = store.instances.get_mut(&instance_id) {
        servers.retain(|server| server.id != id);
        if servers.is_empty() {
            store.instances.remove(&instance_id);
        }
    }
    persist_linked_store(&store)
}

// ── Server List Ping (TCP) ───────────────────────────────────────────────────

fn write_varint(buf: &mut Vec<u8>, value: i32) {
    let mut v = value as u32;
    loop {
        let mut byte = (v & 0x7F) as u8;
        v >>= 7;
        if v != 0 {
            byte |= 0x80;
        }
        buf.push(byte);
        if v == 0 {
            break;
        }
    }
}

fn read_varint<R: Read>(r: &mut R) -> std::io::Result<i32> {
    let mut num: u32 = 0;
    let mut shift = 0;
    loop {
        let mut b = [0u8; 1];
        r.read_exact(&mut b)?;
        num |= ((b[0] & 0x7F) as u32) << shift;
        if b[0] & 0x80 == 0 {
            break;
        }
        shift += 7;
        if shift >= 35 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "varint too long",
            ));
        }
    }
    Ok(num as i32)
}

fn write_string(buf: &mut Vec<u8>, s: &str) {
    write_varint(buf, s.len() as i32);
    buf.extend_from_slice(s.as_bytes());
}

fn packet(id: i32, body: &[u8]) -> Vec<u8> {
    let mut inner = Vec::new();
    write_varint(&mut inner, id);
    inner.extend_from_slice(body);
    let mut out = Vec::new();
    write_varint(&mut out, inner.len() as i32);
    out.extend_from_slice(&inner);
    out
}

fn ping(host: &str, port: u16) -> std::io::Result<(i64, i64, u128)> {
    let addr = (host, port).to_socket_addrs()?.next().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "could not resolve host")
    })?;
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_secs(5))?;
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;

    // Handshake (next state = 1 status) + status request.
    let mut hs = Vec::new();
    write_varint(&mut hs, -1); // protocol version (unknown)
    write_string(&mut hs, host);
    hs.extend_from_slice(&port.to_be_bytes());
    write_varint(&mut hs, 1);

    let start = Instant::now();
    stream.write_all(&packet(0x00, &hs))?;
    stream.write_all(&packet(0x00, &[]))?; // status request

    let _len = read_varint(&mut stream)?;
    let _id = read_varint(&mut stream)?;
    let json_len = read_varint(&mut stream)? as usize;
    if json_len == 0 || json_len > 4 * 1024 * 1024 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bad status length",
        ));
    }
    let mut buf = vec![0u8; json_len];
    stream.read_exact(&mut buf)?;
    let latency = start.elapsed().as_millis();

    let v: Value = serde_json::from_slice(&buf)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let online = v["players"]["online"].as_i64().unwrap_or(0);
    let max = v["players"]["max"].as_i64().unwrap_or(0);
    Ok((online, max, latency))
}

/// Ping a server's status (players online/max + latency). Null on failure.
#[tauri::command]
pub async fn ping_server(ip: String) -> Option<Value> {
    // host[:port] — default port 25565. (No SRV resolution.)
    let (host, port) = match ip.rfind(':') {
        Some(i) => match ip[i + 1..].parse::<u16>() {
            Ok(port) => (ip[..i].to_string(), port),
            Err(_) => (ip.clone(), 25565u16),
        },
        _ => (ip.clone(), 25565u16),
    };
    tauri::async_runtime::spawn_blocking(move || {
        ping(&host, port).ok().map(|(online, max, latency_ms)| json!({ "online": online, "max": max, "latencyMs": latency_ms as u64 }))
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_minecraft_server_addresses() {
        assert_eq!(
            normalize_server_address("Play.Example.COM").unwrap(),
            "play.example.com"
        );
        assert_eq!(
            normalize_server_address("localhost:25565").unwrap(),
            "localhost:25565"
        );
        assert_eq!(
            normalize_server_address("[::1]:25565").unwrap(),
            "[::1]:25565"
        );
    }

    #[test]
    fn merges_linked_metadata_into_an_existing_saved_server() {
        let linked = LinkedServer {
            id: "server-link".into(),
            name: "Linked name".into(),
            ip: "play.example.com".into(),
            minecraft_version: Some("1.21.1".into()),
            updated_at: 42,
        };
        let merged = merge_linked_servers(
            vec![json!({ "name": "Saved name", "ip": "Play.Example.COM" })],
            vec![linked],
        );

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0]["name"], "Saved name");
        assert_eq!(merged[0]["linked"], true);
        assert_eq!(merged[0]["linkId"], "server-link");
        assert_eq!(merged[0]["minecraftVersion"], "1.21.1");
    }

    #[test]
    fn rejects_urls_and_unsafe_addresses() {
        for address in [
            "https://example.com",
            "user@example.com",
            "example.com/path",
            "example.com:0",
            "example.com:70000",
            "2001:db8::1",
            "[::1]:0",
            "[::1]:70000",
            "[not-ipv6]:25565",
        ] {
            assert!(
                normalize_server_address(address).is_err(),
                "accepted {address}"
            );
        }
    }
}
