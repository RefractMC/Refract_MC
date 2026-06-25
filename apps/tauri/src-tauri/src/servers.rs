//! Instance server list (servers.dat NBT) + server status ping (TCP Server List
//! Ping). Port of the mc.servers / mc.pingServer IPC handlers.

use crate::instances;
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
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

/// Parse the instance's servers.dat (uncompressed NBT) into the saved server
/// list. Returns `[{ name, ip, icon? }]`.
#[tauri::command]
pub fn mc_servers(instance_id: String) -> Vec<Value> {
    let path = instances::game_dir(&instance_id).join("servers.dat");
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return vec![],
    };
    let parsed: ServersDat = match fastnbt::from_bytes(&bytes) {
        Ok(p) => p,
        Err(_) => return vec![],
    };
    parsed
        .servers
        .unwrap_or_default()
        .into_iter()
        .map(|s| {
            let mut o =
                json!({ "name": s.name.unwrap_or_default(), "ip": s.ip.unwrap_or_default() });
            if let Some(icon) = s.icon {
                o["icon"] = json!(icon);
            }
            o
        })
        .collect()
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
