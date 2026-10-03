use super::*;

#[test]
fn preview_content_is_immutable_one_use_bounded_and_expires() {
    let mut previews = VecDeque::new();
    let make_tail = || log_privacy::Tail {
        text: "reviewed fixture text".into(),
        truncated: false,
    };
    let preview = store_preview(&mut previews, make_tail()).unwrap();
    assert_eq!(
        take_preview(&mut previews, &preview.preview_id).unwrap(),
        preview.text
    );
    assert!(take_preview(&mut previews, &preview.preview_id).is_err());
    for _ in 0..MAX_PREVIEWS {
        store_preview(&mut previews, make_tail()).unwrap();
    }
    assert!(store_preview(&mut previews, make_tail()).is_err());
    let old_id = previews[0].id.clone();
    let expires = previews[0].created + PREVIEW_LIFETIME;
    assert!(take_preview_at(&mut previews, &old_id, expires).is_err());
    assert!(store_preview(&mut previews, make_tail()).is_ok());
}

#[test]
fn upload_response_only_allows_a_public_mclogs_link() {
    assert_eq!(
        valid_share_url("https://mclo.gs/abc123").unwrap(),
        "https://mclo.gs/abc123"
    );
    for url in [
        "http://mclo.gs/abc",
        "https://mclo.gs.evil.invalid/abc",
        "https://evil.invalid/abc",
        "https://user:secret@mclo.gs/abc",
        "https://mclo.gs:123/abc",
        "https://mclo.gs/abc?token=secret",
        "https://mclo.gs/abc#secret",
        "https://mclo.gs/path/abc",
        "https://mclo.gs/",
    ] {
        assert!(valid_share_url(url).is_err(), "{url}");
    }
}

#[test]
fn upload_sends_only_reviewed_sanitized_bytes_to_loopback_fixture() {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let worker = std::thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = Vec::new();
        let mut buffer = [0u8; 1024];
        loop {
            let size = stream.read(&mut buffer).unwrap();
            assert!(size > 0);
            bytes.extend_from_slice(&buffer[..size]);
            assert!(bytes.len() < 16 * 1024);
            if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&bytes[..end]);
                let length: usize = header
                    .lines()
                    .find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse().unwrap())
                    })
                    .unwrap();
                if bytes.len() >= end + 4 + length {
                    break;
                }
            }
        }
        let request = String::from_utf8(bytes).unwrap();
        assert!(!request.contains("fixture-private-secret"));
        assert!(request.contains("useful+diagnostic"));
        let body = r#"{"success":true,"url":"https://mclo.gs/fixture123"}"#;
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let _ = stream.shutdown(std::net::Shutdown::Write);
        while matches!(stream.read(&mut buffer), Ok(size) if size > 0) {}
    });
    let reviewed = log_privacy::Censor::default()
        .line("access_token=fixture-private-secret useful diagnostic");
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let url = tauri::async_runtime::block_on(upload(&client, &endpoint, &reviewed)).unwrap();
    assert_eq!(url, "https://mclo.gs/fixture123");
    worker.join().unwrap();
}
