use super::*;
use std::io::Write;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("refract-java-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn runtime(&self, name: &str, major: u32) -> Install {
        let home = self.0.join(name);
        fs::create_dir_all(home.join("bin")).unwrap();
        fs::write(home.join("bin").join(JAVA_BIN), b"previous runtime").unwrap();
        Install {
            version: major,
            path: home.to_string_lossy().into_owned(),
            vendor: "Fixture".into(),
            architecture: Some(adoptium_arch().into()),
            custom: None,
        }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn java_probe_child() {
    let Ok(mode) = std::env::var("REFRACT_JAVA_PROBE_TEST") else {
        return;
    };
    match mode.as_str() {
        "valid" => eprintln!("java.version = 21.0.12\njava.vendor = Fixture\nos.arch = amd64"),
        "failed" => {
            eprintln!("java.version = 21\nos.arch = amd64");
            std::process::exit(1);
        }
        "oversized" => {
            let mut output = std::io::stdout().lock();
            for _ in 0..100 {
                output.write_all(&[b'x'; 8192]).unwrap();
            }
        }
        "hung" => std::thread::sleep(Duration::from_secs(30)),
        _ => panic!("Unknown probe fixture"),
    }
}

fn probe_fixture(mode: &str) -> Command {
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "java::provision_tests::java_probe_child",
            "--nocapture",
        ])
        .env("REFRACT_JAVA_PROBE_TEST", mode);
    command
}

#[test]
fn probe_requires_success_and_bounds_output_and_execution() {
    tauri::async_runtime::block_on(async {
        let text = probe_command(probe_fixture("valid"), Duration::from_secs(5))
            .await
            .unwrap();
        let java = parse_probe(Path::new("runtime/bin/java"), &text).unwrap();
        assert_eq!(java.version, 21);
        assert_eq!(java.architecture.as_deref(), Some("x64"));
        assert_eq!(java.vendor, "Fixture");
        assert!(
            probe_command(probe_fixture("failed"), Duration::from_secs(5))
                .await
                .unwrap_err()
                .contains("unsuccessfully")
        );
        assert!(
            probe_command(probe_fixture("oversized"), Duration::from_secs(5))
                .await
                .unwrap_err()
                .contains("too much output")
        );
        let started = Instant::now();
        assert!(
            probe_command(probe_fixture("hung"), Duration::from_millis(400))
                .await
                .unwrap_err()
                .contains("timed out")
        );
        assert!(started.elapsed() < Duration::from_secs(4));
        assert!(probe_checked(Path::new("missing-java-executable"))
            .await
            .is_err());
    });
    assert!(parse_probe(Path::new("runtime/bin/java"), "not.java.version = 21").is_err());
    assert_eq!(architecture("arm64"), Some("aarch64"));
    assert_eq!(architecture("i686"), Some("x86"));
}

#[test]
fn package_and_runtime_validation_rejects_missing_integrity_or_wrong_platform() {
    let fixture = Fixture::new();
    let mut install = fixture.runtime("runtime", 21);
    assert!(validate_runtime(&install, 21).is_ok());
    assert!(validate_runtime(&install, 17).is_err());
    install.architecture = Some("x86".into());
    assert!(validate_runtime(&install, 21).is_err());
    install.architecture = None;
    assert!(validate_runtime(&install, 21).is_err());
    let valid = json!([{
        "version": { "major": 21 },
        "binary": {
            "architecture": adoptium_arch(), "os": adoptium_os(), "image_type": "jre",
            "package": { "link": "https://github.com/adoptium/runtime.zip", "name": "runtime.zip",
                "size": 10, "checksum": "a".repeat(64) }
        }
    }]);
    assert!(runtime_package(&valid, 21).is_ok());
    assert!(runtime_package(&valid, 17).is_err());
    assert!(runtime_package(&json!([]), 21).is_err());
    for (key, value) in [
        ("name", json!("../runtime.zip")),
        ("checksum", json!(null)),
        ("size", json!(0)),
        ("link", json!("http://github.com/runtime.zip")),
    ] {
        let mut invalid = valid.clone();
        invalid[0]["binary"]["package"][key] = value;
        assert!(
            runtime_package(&invalid, 21).is_err(),
            "accepted invalid {key}"
        );
    }
    let mut invalid = valid.clone();
    invalid[0]["binary"]["architecture"] = json!("x86");
    assert!(runtime_package(&invalid, 21).is_err());
}

#[test]
fn publication_preserves_previous_runtime_and_custom_entries() {
    let fixture = Fixture::new();
    let previous = fixture.runtime("jre-21", 21);
    let mut custom = fixture.runtime("user-chosen", 21);
    custom.custom = Some(true);
    let registry = fixture.0.join("managed.json");
    persistence::write_json(&registry, &vec![previous.clone(), custom.clone()]).unwrap();
    let staging = StagingRuntime::create(&fixture.0).unwrap();
    let extracted = staging.path.join("runtime");
    fs::create_dir_all(extracted.join("Contents/Home/bin")).unwrap();
    fs::write(
        extracted.join("Contents/Home/bin").join(JAVA_BIN),
        b"replacement runtime",
    )
    .unwrap();
    let mut candidate = previous.clone();
    candidate.path = extracted
        .join("Contents/Home")
        .to_string_lossy()
        .into_owned();
    let installed = publish_runtime(&fixture.0, &extracted, candidate).unwrap();
    drop(staging);
    assert_eq!(
        fs::read(exe_in_home(&installed.path)).unwrap(),
        b"replacement runtime"
    );
    assert_eq!(
        fs::read(exe_in_home(&previous.path)).unwrap(),
        b"previous runtime"
    );
    let entries: Vec<Install> = persistence::read_json(&registry, Vec::new).unwrap();
    assert!(entries.iter().any(|item| item.path == installed.path));
    assert!(entries
        .iter()
        .any(|item| item.path == custom.path && item.custom == Some(true)));
    assert!(!entries.iter().any(|item| item.path == previous.path));
    let backup: Vec<Install> =
        serde_json::from_slice(&fs::read(fixture.0.join("managed.json.bak")).unwrap()).unwrap();
    assert!(backup.iter().any(|item| item.path == previous.path));
}

#[test]
fn failed_registration_keeps_previous_pointer_and_runtime() {
    let fixture = Fixture::new();
    let previous = fixture.runtime("jre-21", 21);
    let registry = fixture.0.join("managed.json");
    // Fail after generation publication, before registry publication.
    fs::write(
        &registry,
        serde_json::to_vec(&vec![previous.clone()]).unwrap(),
    )
    .unwrap();
    fs::create_dir(fixture.0.join("managed.json.bak")).unwrap();
    let staging = StagingRuntime::create(&fixture.0).unwrap();
    let mut candidate = fixture.runtime("candidate", 21);
    let extracted = staging.path.join("runtime");
    fs::rename(&candidate.path, &extracted).unwrap();
    candidate.path = extracted.to_string_lossy().into_owned();
    assert!(publish_runtime(&fixture.0, &extracted, candidate).is_err());
    drop(staging);
    let entries: Vec<Install> = serde_json::from_slice(&fs::read(&registry).unwrap()).unwrap();
    assert_eq!(entries[0].path, previous.path);
    assert_eq!(
        fs::read(exe_in_home(&previous.path)).unwrap(),
        b"previous runtime"
    );
    let retained: Vec<_> = fs::read_dir(&fixture.0)
        .unwrap()
        .flatten()
        .filter(|item| is_generation(&item.file_name().to_string_lossy(), 21))
        .collect();
    assert_eq!(retained.len(), 1);
    check_generation(&retained[0].path(), 21).unwrap();
}

#[test]
fn removal_waits_for_all_leases_and_preserves_custom_runtimes() {
    let fixture = Fixture::new();
    let previous = fixture.runtime("jre-21", 21);
    let mut custom = fixture.runtime("user-chosen", 21);
    custom.custom = Some(true);
    let registry = fixture.0.join("managed.json");
    persistence::write_json(&registry, &vec![previous.clone(), custom.clone()]).unwrap();
    let first = RuntimeLease::acquire(&exe_in_home(&previous.path)).unwrap();
    let second = RuntimeLease::acquire(&exe_in_home(&previous.path)).unwrap();
    assert!(delete_runtime(&fixture.0, 21)
        .unwrap_err()
        .contains("in use"));
    drop(first);
    assert!(delete_runtime(&fixture.0, 21).is_err());
    drop(second);
    delete_runtime(&fixture.0, 21).unwrap();
    assert!(!Path::new(&previous.path).exists());
    assert!(Path::new(&custom.path).exists());
    let remaining: Vec<Install> = persistence::read_json(&registry, Vec::new).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].path, custom.path);
    assert!(RuntimeLease::acquire(&exe_in_home(&previous.path)).is_err());
}

#[test]
fn removal_rejects_unowned_or_traversing_records_before_any_deletion() {
    let fixture = Fixture::new();
    let previous = fixture.runtime("jre-21", 21);
    let mut unknown = fixture.runtime("keep-me", 21);
    let registry = fixture.0.join("managed.json");
    for path in [
        unknown.path.clone(),
        fixture
            .0
            .join("jre-21/../keep-me")
            .to_string_lossy()
            .into_owned(),
    ] {
        unknown.path = path;
        persistence::write_json(&registry, &vec![previous.clone(), unknown.clone()]).unwrap();
        assert!(delete_runtime(&fixture.0, 21).is_err());
        assert!(Path::new(&previous.path).exists());
        assert!(fixture.0.join("keep-me").exists());
    }
}

#[cfg(unix)]
#[test]
fn an_executable_alias_leases_the_actual_runtime() {
    let fixture = Fixture::new();
    let runtime = fixture.runtime("jre-21", 21);
    persistence::write_json(&fixture.0.join("managed.json"), &vec![runtime.clone()]).unwrap();
    let alias = fixture.0.join("alias/bin");
    fs::create_dir_all(&alias).unwrap();
    std::os::unix::fs::symlink(exe_in_home(&runtime.path), alias.join(JAVA_BIN)).unwrap();
    let lease = RuntimeLease::acquire(alias.join(JAVA_BIN).to_str().unwrap()).unwrap();
    assert!(delete_runtime(&fixture.0, 21)
        .unwrap_err()
        .contains("in use"));
    drop(lease);
    delete_runtime(&fixture.0, 21).unwrap();
}

#[test]
fn provisioning_ownership_is_shared_and_released_on_cancellation() {
    tauri::async_runtime::block_on(async {
        let lock = provision_lock(21).unwrap();
        let second = provision_lock(21).unwrap();
        let guard = lock.lock().await;
        let (started, waiting) = tokio::sync::oneshot::channel();
        let waiter = tauri::async_runtime::spawn(async move {
            started.send(()).unwrap();
            let _guard = second.lock().await;
        });
        waiting.await.unwrap();
        assert!(lock.try_lock().is_err());
        assert!(provision_lock(17).unwrap().try_lock().is_ok());
        waiter.abort();
        assert!(waiter.await.is_err());
        assert!(lock.try_lock().is_err());
        drop(guard);
        assert!(lock.try_lock().is_ok());
    });
}

fn zip_fixture(path: &Path, name: &str, bytes: &[u8]) {
    let mut zip = zip::ZipWriter::new(File::create(path).unwrap());
    zip.start_file(name, zip::write::SimpleFileOptions::default())
        .unwrap();
    zip.write_all(bytes).unwrap();
    zip.finish().unwrap();
}

#[test]
fn extraction_and_stage_cleanup_preserve_existing_runtime_on_failure() {
    let fixture = Fixture::new();
    let previous = fixture.runtime("jre-21", 21);
    let other = StagingRuntime::create(&fixture.0).unwrap();
    for name in [
        "../escaped",
        "nested/../../escaped",
        "C:/escaped",
        "bin/NUL.exe",
    ] {
        let staging = StagingRuntime::create(&fixture.0).unwrap();
        let archive = staging.path.join("bad.zip");
        let extracted = staging.path.join("extracted");
        fs::create_dir(&extracted).unwrap();
        zip_fixture(&archive, name, b"bad");
        assert!(unzip_to(&archive, &extracted).is_err(), "accepted {name}");
        let path = staging.path.clone();
        drop(staging);
        assert!(!path.exists());
        assert!(!fixture.0.join("escaped").exists());
        assert_eq!(
            fs::read(exe_in_home(&previous.path)).unwrap(),
            b"previous runtime"
        );
        assert!(other.path.exists());
    }
    let archive = other.path.join("broken.tar.gz");
    fs::write(&archive, b"not an archive").unwrap();
    assert!(untar_gz_to(&archive, &other.path.join("runtime")).is_err());
    assert_eq!(
        fs::read(exe_in_home(&previous.path)).unwrap(),
        b"previous runtime"
    );
}

#[test]
#[ignore = "Downloads and executes an Adoptium JRE in a disposable directory"]
fn adoptium_runtime_smoke() {
    tauri::async_runtime::block_on(async {
        let fixture = Fixture::new();
        let previous = fixture.runtime("jre-21", 21);
        persistence::write_json(&fixture.0.join("managed.json"), &vec![previous.clone()]).unwrap();
        let url = format!("https://api.adoptium.net/v3/assets/latest/21/hotspot?os={}&architecture={}&image_type=jre", adoptium_os(), adoptium_arch());
        let package = runtime_package(
            &downloader::get_json(&url, net::JAVA_HOSTS, None)
                .await
                .unwrap(),
            21,
        )
        .unwrap();
        let staging = StagingRuntime::create(&fixture.0).unwrap();
        let archive = staging.path.join("runtime.archive");
        downloader::fetch(
            &downloader::Task::new(package.url, archive.clone(), net::JAVA_HOSTS)
                .hash(Some(downloader::OwnedHash::Sha256(package.checksum)))
                .size(Some(package.size)),
        )
        .await
        .unwrap();
        let extracted = staging.path.join("runtime");
        fs::create_dir(&extracted).unwrap();
        if package.zip {
            unzip_to(&archive, &extracted).unwrap();
        } else {
            untar_gz_to(&archive, &extracted).unwrap();
        }
        let probed = probe_checked(&find_exe_in_tree(&extracted).unwrap())
            .await
            .unwrap();
        validate_runtime(&probed, 21).unwrap();
        let installed = publish_runtime(&fixture.0, &extracted, probed).unwrap();
        drop(staging);
        let lease = RuntimeLease::acquire(&exe_in_home(&installed.path)).unwrap();
        let published = probe_checked(Path::new(&lease.executable)).await.unwrap();
        validate_runtime(&published, 21).unwrap();
        assert_eq!(
            fs::read(exe_in_home(&previous.path)).unwrap(),
            b"previous runtime"
        );
        assert!(delete_runtime(&fixture.0, 21)
            .unwrap_err()
            .contains("in use"));
        drop(lease);
        delete_runtime(&fixture.0, 21).unwrap();
        assert!(!Path::new(&installed.path).exists());
    });
}
