use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("refract-reset-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        Self(root)
    }
    fn data(&self) -> PathBuf {
        self.0.join("data")
    }
    fn populate(&self) {
        let data = self.data();
        for name in DIRECTORIES {
            fs::create_dir_all(data.join(name)).unwrap();
            fs::write(data.join(name).join("owned.txt"), "remove").unwrap();
        }
        for name in DOCUMENTS {
            persistence::write_json(&data.join(name), &json!([])).unwrap();
        }
        for (folder, value) in [
            ("Managed", json!({"id":"managed"})),
            (
                "Linked",
                json!({"id":"linked", "externalGameDir": self.0.join("external-game")}),
            ),
        ] {
            let dir = data.join("instances").join(folder);
            persistence::write_json(&dir.join("instance.json"), &value).unwrap();
            fs::write(dir.join("owned.txt"), "instance").unwrap();
        }
        for name in ["custom-instance", "external-game"] {
            fs::create_dir_all(self.0.join(name)).unwrap();
            fs::write(self.0.join(name).join("keep.txt"), "external").unwrap();
        }
        persistence::write_json(
            &data.join("instance-registry.json"),
            &json!([
                {"id":"custom", "path":self.0.join("custom-instance")}
            ]),
        )
        .unwrap();
        persistence::write_json(
            &data.join("config.json"),
            &json!({
                "accounts": [{"uuid":"offline", "username":"Test"}],
                "activeAccountId":"offline", "analyticsEnabled":false,
                "analyticsNoticeShown":true, "onboardingDone":true,
                "curseforgeApiKey":"synthetic-private-key"
            }),
        )
        .unwrap();
        fs::write(data.join("unrelated.txt"), "keep").unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn options(delete_accounts: bool, unlink_external_instances: bool) -> ResetOptions {
    ResetOptions {
        delete_accounts,
        unlink_external_instances,
    }
}

#[test]
fn preserves_external_data_registrations_accounts_and_analytics_choice_by_default() {
    let fixture = Fixture::new();
    fixture.populate();
    let root = fixture.data();
    let result = execute(&root, options(false, false), || panic!("do not open vault")).unwrap();
    assert_eq!(result.retained_instances, 2);
    assert!(!result.accounts_removed);
    assert_eq!(
        serde_json::to_value(&result).unwrap(),
        json!({"retainedInstances":2, "accountsRemoved":false})
    );
    assert!(!root.join("instances/Managed").exists());
    assert!(root.join("instances/Linked/instance.json").exists());
    assert!(fixture.0.join("custom-instance/keep.txt").exists());
    assert!(fixture.0.join("external-game/keep.txt").exists());
    assert!(root.join("unrelated.txt").exists());
    for name in DIRECTORIES {
        assert!(!root.join(name).exists());
    }
    for name in DOCUMENTS {
        assert!(!root.join(name).exists());
        assert!(!root.join(format!("{name}.bak")).exists());
    }
    let config = read_config(&root).unwrap();
    assert_eq!(config["accounts"][0]["uuid"], "offline");
    assert_eq!(config["analyticsEnabled"], false);
    assert_eq!(config["onboardingDone"], false);
    assert!(config.get("curseforgeApiKey").is_none());
    let backup: Value =
        serde_json::from_slice(&fs::read(root.join("config.json.bak")).unwrap()).unwrap();
    assert_eq!(config, backup);
}

#[test]
fn explicit_unlink_never_deletes_external_files_and_vault_failure_is_retryable() {
    let fixture = Fixture::new();
    fixture.populate();
    let root = fixture.data();
    let error = execute(&root, options(true, true), || {
        Err("mock keyring unavailable".into())
    })
    .err()
    .unwrap();
    assert_eq!(error, "mock keyring unavailable");
    assert_eq!(
        read_config(&root).unwrap()["accounts"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(fixture.0.join("external-game/keep.txt").exists());
    assert!(fixture.0.join("custom-instance/keep.txt").exists());
    let result = execute(&root, options(true, true), || Ok(())).unwrap();
    assert!(result.accounts_removed);
    assert_eq!(result.retained_instances, 0);
    assert_eq!(read_config(&root).unwrap()["accounts"], json!([]));
    // Recovery after a later damaged primary must not resurrect erased accounts
    // or a previous custom API key from the pre-reset backup.
    fs::write(root.join("config.json"), b"{damaged after reset").unwrap();
    let recovered = read_config(&root).unwrap();
    assert_eq!(recovered["accounts"], json!([]));
    assert!(recovered.get("curseforgeApiKey").is_none());
    let registry: Vec<Value> =
        persistence::read_json(&root.join("instance-registry.json"), Vec::new).unwrap();
    assert!(registry.is_empty());
    assert!(fixture.0.join("custom-instance/keep.txt").exists());
}

#[test]
fn overlapping_external_path_or_invalid_metadata_fails_before_deletion() {
    let fixture = Fixture::new();
    fixture.populate();
    let root = fixture.data();
    let instance = root.join("instances/Linked/instance.json");
    persistence::write_json(
        &instance,
        &json!({"id":"linked", "externalGameDir":root.join("cache")}),
    )
    .unwrap();
    assert!(execute(&root, options(true, true), || panic!("no deletion")).is_err());
    assert!(root.join("themes/owned.txt").exists());
    persistence::write_json(&instance, &json!({"id":"linked"})).unwrap();
    fs::create_dir(root.join("instances/Unknown")).unwrap();
    assert!(execute(&root, options(true, true), || panic!("no deletion")).is_err());
    assert!(root.join("themes/owned.txt").exists());
}

#[cfg(windows)]
#[test]
fn locked_file_reports_partial_failure_and_keeps_registration_and_account_metadata() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    fixture.populate();
    let root = fixture.data();
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(root.join("themes/owned.txt"))
        .unwrap();
    let error = execute(&root, options(true, false), || {
        panic!("preserve vault on file failure")
    })
    .err()
    .unwrap();
    assert!(error.contains("Reset is incomplete"), "{error}");
    assert_eq!(read_config(&root).unwrap()["onboardingDone"], true);
    assert!(root.join("instance-registry.json").exists());
    drop(locked);
    execute(&root, options(true, false), || Ok(())).unwrap();
}

#[cfg(windows)]
#[test]
fn locked_instance_payload_keeps_identity_for_retry() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    fixture.populate();
    let root = fixture.data();
    let instance = root.join("instances/Managed");
    let locked = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(instance.join("owned.txt"))
        .unwrap();
    assert!(execute(&root, options(false, false), || panic!("keep vault")).is_err());
    assert!(instance.join("instance.json").is_file());
    drop(locked);
    execute(&root, options(false, false), || panic!("keep vault")).unwrap();
    assert!(!instance.exists());
}

#[test]
fn active_work_rejects_production_reset_before_any_user_data_access() {
    // Keep this lease alive through the assertion. The destructive body is
    // unreachable, even while other tests are running on the shared process.
    let lease = maintenance::shared().unwrap();
    let result = tauri::async_runtime::block_on(launcher_delete_all(options(true, true)));
    assert!(result.err().unwrap().contains("Stop running games"));
    drop(lease);
}

#[test]
fn reset_requires_explicit_choices_and_protects_custom_linked_game_roots() {
    assert!(serde_json::from_value::<ResetOptions>(json!({})).is_err());
    assert!(serde_json::from_value::<ResetOptions>(
        json!({"deleteAccounts":true, "unlinkExternalInstances":false, "deleteExternalFiles":true})
    )
    .is_err());
    let fixture = Fixture::new();
    fixture.populate();
    let root = fixture.data();
    persistence::write_json(
        &fixture.0.join("custom-instance/instance.json"),
        &json!({"id":"custom", "externalGameDir":root.join("assets")}),
    )
    .unwrap();
    assert!(execute(&root, options(true, true), || panic!("no deletion")).is_err());
    assert!(root.join("themes/owned.txt").exists());
}

#[test]
fn corrupt_external_metadata_and_nested_links_are_preserved_before_any_deletion() {
    let fixture = Fixture::new();
    fixture.populate();
    let root = fixture.data();
    let custom = fixture.0.join("custom-instance/instance.json");
    fs::write(&custom, b"{broken").unwrap();
    fs::write(custom.with_extension("json.bak"), b"{\"id\":\"custom\"}").unwrap();
    assert!(execute(&root, options(true, true), || panic!("no deletion")).is_err());
    assert_eq!(fs::read(&custom).unwrap(), b"{broken");
    fs::write(&custom, b"{\"id\":\"custom\"}").unwrap();
    let target = fixture.0.join("external-game");
    let link = root.join("instances").join("Managed").join("linked-world");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&target, &link).unwrap();
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("cmd");
        crate::procutil::hide_window(&mut command);
        let output = command
            .args(["/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    assert!(execute(&root, options(true, true), || panic!("no deletion")).is_err());
    assert_eq!(fs::read(target.join("keep.txt")).unwrap(), b"external");
    assert!(root.join("themes/owned.txt").exists());
}
