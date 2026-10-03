use super::*;

#[test]
fn filters_fixture_credentials_identifiers_and_home_paths_without_losing_diagnostics() {
    let mut censor = Censor::default();
    censor.add("fake-bare-access-token", "<ACCESS TOKEN>");
    censor.add("FixturePlayer", "<ACCOUNT>");
    censor.add("12345678-1234-4321-9876-012345678901", "<ACCOUNT>");
    remember_secret("fake-bare-refresh-token");
    for input in [
        "access_token=fake-access-value useful error",
        "--accessToken fake-access-value useful error",
        r#"refresh_token: "fake-refresh-value" useful error"#,
        r#"{"refresh_token":"fake-refresh-value"}"#,
        r#"{"message":"refresh_token=\"fake-escaped-value\" useful error","level":"error"}"#,
        "new refresh token: \"fake-refresh-value\" useful error",
        "Authorization: Bearer fake-auth-value useful error",
        "(Session ID is fake-session-value) useful error",
        "device_code = fake-device-value useful error",
        "fake-bare-access-token fake-bare-refresh-token useful error",
        "C:\\Users\\FixturePerson\\Games\\mod.jar useful error",
        "D:/Users/FixturePerson/Games/mod.jar useful error",
        "/home/FixturePerson/Games/mod.jar useful error",
        "/Users/FixturePerson/Games/mod.jar useful error",
        "FixturePlayer 12345678-1234-4321-9876-012345678901 useful error",
        "username=PrivatePlayer uuid=private-identifier useful error",
        "https://private-user:private-password@server.invalid useful error",
    ] {
        let output = censor.line(input);
        for secret in [
            "fake-",
            "FixturePerson",
            "FixturePlayer",
            "12345678-1234",
            "PrivatePlayer",
            "private-identifier",
            "private-password",
        ] {
            assert!(!output.contains(secret), "{input:?} -> {output:?}");
        }
        if input.contains("useful error") {
            assert!(output.contains("useful error"), "{output}");
        }
    }
    assert_eq!(
        censor.line("java.lang.OutOfMemoryError: Java heap space"),
        "java.lang.OutOfMemoryError: Java heap space"
    );
    assert!(censor
        .line("e4mc: world.example.e4mc.link")
        .contains("world.example.e4mc.link"));
}

#[test]
fn streaming_drops_whole_long_lines_and_keeps_invalid_utf8_and_following_output() {
    let mut input = vec![b'x'; MAX_LINE_BYTES * 4];
    input.extend_from_slice(b"fake-secret\nvalid \xff diagnostic\n");
    let mut lines = Vec::new();
    read_lines(input.as_slice(), |line| lines.push(line)).unwrap();
    assert_eq!(lines[0], OMITTED_LINE);
    assert!(lines[1].contains("diagnostic"));
    assert_eq!(lines.len(), 2);
    assert!(lines.iter().all(|line| line.len() <= MAX_LINE_BYTES));
}

#[test]
fn tail_seeks_before_allocation_and_never_emits_a_cut_secret() {
    let path = std::env::temp_dir().join(format!("refract-tail-{}.log", uuid::Uuid::new_v4()));
    let mut file = std::fs::File::create(&path).unwrap();
    file.set_len(64 * 1024 * 1024).unwrap();
    file.seek(SeekFrom::End(0)).unwrap();
    use std::io::Write;
    file.write_all(b"fake-secret-partial\nuseful diagnostic\n")
        .unwrap();
    drop(file);
    let result = tail(&path, 128, 10, &Censor::default()).unwrap();
    assert!(result.truncated);
    assert_eq!(result.text, "useful diagnostic");
    assert!(result.text.len() <= 128);
    std::fs::remove_file(&path).unwrap();
}

#[test]
fn flood_budget_limits_events_and_reports_omission() {
    let mut budget = OutputBudget::new();
    let mut accepted = 0;
    for _ in 0..10000 {
        accepted += usize::from(budget.accept("line".into()).is_some());
    }
    assert_eq!(accepted, 100);
    assert!(budget.finish().is_some());
    budget.start = Instant::now() - Duration::from_secs(2);
    assert!(budget
        .accept("after flood".into())
        .unwrap()
        .contains("omitted"));
    assert!(budget.finish().is_none());
}

#[test]
fn structured_logs_remain_valid_and_redact_nested_credential_fields() {
    let input = serde_json::json!({"level": "error", "message": "useful error", "extra": {"refreshToken": "fixture-secret", "username": "PrivatePerson"}}).to_string();
    let output = Censor::default().line(&input);
    let parsed: serde_json::Value = serde_json::from_str(&output).unwrap();
    assert_eq!(parsed["level"], "error");
    assert_eq!(parsed["message"], "useful error");
    assert!(!output.contains("fixture-secret"));
    assert!(!output.contains("PrivatePerson"));
}

#[test]
fn process_output_boundary_censors_before_delivery_and_reports_reader_failure() {
    struct FailingReader {
        read: bool,
    }
    impl Read for FailingReader {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.read {
                return Err(std::io::Error::other("fake-sensitive-system-detail"));
            }
            self.read = true;
            let bytes = b"access_token=fake-process-secret useful diagnostic\n";
            buffer[..bytes.len()].copy_from_slice(bytes);
            Ok(bytes.len())
        }
    }
    let mut delivered = Vec::new();
    filtered_output(FailingReader { read: false }, &Censor::default(), |line| {
        delivered.push(line)
    });
    let output = delivered.join("\n");
    assert!(output.contains("useful diagnostic"));
    assert!(output.contains("could not read"));
    assert!(!output.contains("fake-process-secret"));
    assert!(!output.contains("fake-sensitive-system-detail"));
}
