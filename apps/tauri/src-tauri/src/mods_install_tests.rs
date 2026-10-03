use super::*;

struct Fixture {
    instance: instances::TestInstance,
    kind: &'static str,
    root: &'static str,
}

impl Fixture {
    fn new(kind: &'static str, disabled: bool) -> Self {
        let instance = instances::TestInstance::new();
        let root = subdir_for(kind);
        let fixture = Self {
            instance,
            kind,
            root,
        };
        fs::create_dir_all(fixture.game().join(root)).unwrap();
        fs::write(
            fixture.game().join(root).join(if disabled {
                "old.zip.disabled"
            } else {
                "old.zip"
            }),
            b"working previous pack",
        )
        .unwrap();
        instances::mutate_instance(&fixture.instance.id, |value| {
            value["mods"] = json!([fixture.record("old.zip", "old-version")]);
            Ok(())
        })
        .unwrap();
        fixture
    }

    fn game(&self) -> PathBuf {
        game_dir(&self.instance.id).unwrap()
    }

    fn storage(&self) -> PathBuf {
        self.instance.directory.join("fixture-snapshots")
    }

    fn record(&self, name: &str, version: &str) -> Value {
        json!({"projectId": "project", "contentType": self.kind, "fileName": name, "versionId": version})
    }

    fn metadata(&self) -> Value {
        instances::get_instance_by_id(self.instance.id.clone())
            .unwrap()
            .unwrap()
    }

    fn plan(&self, name: &str) -> ContentInstallPlan {
        ContentInstallPlan::new(
            &self.instance.id,
            name,
            self.kind,
            Some(self.record(name, "new-version")),
        )
        .unwrap()
    }

    fn stage(&self) -> ContentInstallStage {
        let stage = ContentInstallStage::new(&self.instance.id).unwrap();
        fs::write(&stage.path, b"verified replacement pack").unwrap();
        stage
    }

    fn snapshot(&self) -> crate::snapshots::SnapshotHandle {
        crate::snapshots::create_content_change_at(&self.storage(), &self.instance.id, self.root)
            .unwrap()
    }

    fn publish(&self, name: &str) -> Result<String, String> {
        publish_content_install(
            self.plan(name),
            self.stage(),
            "https://cdn.modrinth.com/new.zip",
            Some(hex::encode(Sha512::digest(b"verified replacement pack"))),
            None,
            || Ok(self.snapshot()),
        )
    }

    fn assert_no_staging(&self) {
        assert!(fs::read_dir(&self.instance.directory)
            .unwrap()
            .all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".refract-content-")
            }));
    }
}

#[test]
fn failed_download_preserves_every_pack_type_and_its_metadata() {
    for kind in ["resourcepack", "shader", "datapack"] {
        let fixture = Fixture::new(kind, false);
        let before = fixture.metadata();
        let error = tauri::async_runtime::block_on(install_content_file(
            fixture.instance.id.clone(),
            "https://untrusted.invalid/new.zip".into(),
            "old.zip".into(),
            kind.into(),
            Some(fixture.record("old.zip", "new-version")),
            None,
            None,
        ))
        .unwrap_err();
        assert!(error.contains("untrusted host"));
        assert_eq!(
            fs::read(fixture.game().join(fixture.root).join("old.zip")).unwrap(),
            b"working previous pack"
        );
        assert_eq!(fixture.metadata(), before);
        assert!(!fixture.storage().exists());
        fixture.assert_no_staging();
    }
}

#[test]
fn same_name_enabled_replacement_updates_bytes_and_metadata() {
    for kind in ["resourcepack", "shader", "datapack"] {
        let fixture = Fixture::new(kind, false);
        fixture.publish("old.zip").unwrap();
        assert_eq!(
            fs::read(fixture.game().join(fixture.root).join("old.zip")).unwrap(),
            b"verified replacement pack"
        );
        assert_eq!(fixture.metadata()["mods"][0]["versionId"], "new-version");
        assert_eq!(fixture.metadata()["mods"][0]["fileName"], "old.zip");
        fixture.assert_no_staging();
    }
}

#[cfg(windows)]
#[test]
fn denied_same_name_replacement_preserves_the_previous_pack_and_record() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new("resourcepack", false);
    let before = fixture.metadata();
    let path = fixture.game().join(fixture.root).join("old.zip");
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&path)
        .unwrap();
    let snapshot = std::cell::RefCell::new(None);
    let error = publish_content_install(
        fixture.plan("old.zip"),
        fixture.stage(),
        "https://cdn.modrinth.com/new.zip",
        None,
        None,
        || {
            let handle = fixture.snapshot();
            *snapshot.borrow_mut() = Some(handle.clone());
            Ok(handle)
        },
    )
    .unwrap_err();
    assert!(error.contains("Recover the instance"));
    assert_eq!(fs::read(&path).unwrap(), b"working previous pack");
    assert_eq!(fixture.metadata(), before);
    drop(held);
    snapshot.borrow().as_ref().unwrap().rollback().unwrap();
    assert_eq!(fs::read(path).unwrap(), b"working previous pack");
    assert_eq!(fixture.metadata(), before);
    fixture.assert_no_staging();
}

#[test]
fn verified_replacement_changes_files_and_metadata_together() {
    for kind in ["resourcepack", "shader", "datapack"] {
        let fixture = Fixture::new(kind, false);
        assert_eq!(fixture.publish("new.zip").unwrap(), "new.zip");
        let directory = fixture.game().join(fixture.root);
        assert_eq!(
            fs::read(directory.join("new.zip")).unwrap(),
            b"verified replacement pack"
        );
        assert!(!directory.join("old.zip").exists());
        let metadata = fixture.metadata();
        assert_eq!(metadata["mods"].as_array().unwrap().len(), 1);
        assert_eq!(metadata["mods"][0]["versionId"], "new-version");
        assert_eq!(metadata["mods"][0]["fileName"], "new.zip");
        assert_eq!(metadata["mods"][0]["contentType"], kind);
        assert_eq!(metadata["mods"][0]["fileSize"], 25);
        let journal: Value = serde_json::from_slice(
            &fs::read(
                fixture
                    .storage()
                    .join(&fixture.instance.id)
                    .join("transaction.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(journal["phase"], "committed");
        fixture.assert_no_staging();
    }
}

#[test]
fn replacement_preserves_disabled_state_with_the_same_or_new_name() {
    for name in ["old.zip", "new.zip"] {
        let fixture = Fixture::new("resourcepack", true);
        fixture.publish(name).unwrap();
        let directory = fixture.game().join(fixture.root);
        assert_eq!(
            fs::read(directory.join(format!("{name}.disabled"))).unwrap(),
            b"verified replacement pack"
        );
        assert!(!directory.join(name).exists());
        assert_eq!(fixture.metadata()["mods"][0]["fileName"], name);
        fixture.assert_no_staging();
    }
}

#[test]
fn cancellation_after_snapshot_restores_the_old_pack_and_metadata() {
    let fixture = Fixture::new("resourcepack", false);
    let before = fixture.metadata();
    let plan = fixture.plan("new.zip");
    let stage = fixture.stage();
    let operation = crate::operations::Operation::begin(
        &fixture.instance.id,
        crate::operations::Kind::Mutation,
    )
    .unwrap();
    let error = operation
        .sync_scope(|| {
            publish_content_install(
                plan,
                stage,
                "https://cdn.modrinth.com/new.zip",
                None,
                None,
                || {
                    let snapshot = fixture.snapshot();
                    crate::operations::request_cancel(operation.id()).unwrap();
                    Ok(snapshot)
                },
            )
        })
        .unwrap_err();
    assert!(error.to_lowercase().contains("cancel"));
    assert_eq!(fixture.metadata(), before);
    assert_eq!(
        fs::read(fixture.game().join(fixture.root).join("old.zip")).unwrap(),
        b"working previous pack"
    );
    assert!(!fixture.game().join(fixture.root).join("new.zip").exists());
    fixture.assert_no_staging();
}

#[test]
fn unrelated_destination_is_never_replaced() {
    let fixture = Fixture::new("resourcepack", false);
    let target = fixture.game().join(fixture.root).join("new.zip");
    fs::write(&target, b"another installed pack").unwrap();
    assert!(ContentInstallPlan::new(
        &fixture.instance.id,
        "new.zip",
        fixture.kind,
        Some(fixture.record("new.zip", "new-version"))
    )
    .is_err());
    assert_eq!(fs::read(target).unwrap(), b"another installed pack");
}

#[test]
fn shared_content_records_cannot_replace_another_projects_file() {
    let fixture = Fixture::new("resourcepack", false);
    instances::mutate_instance(&fixture.instance.id, |value| {
        value["mods"].as_array_mut().unwrap().push(json!({
            "projectId": "different-project", "contentType": "resourcepack", "fileName": "old.zip"
        }));
        Ok(())
    })
    .unwrap();
    assert!(ContentInstallPlan::new(
        &fixture.instance.id,
        "new.zip",
        fixture.kind,
        Some(fixture.record("new.zip", "new-version"))
    )
    .is_err());
    assert_eq!(
        fs::read(fixture.game().join(fixture.root).join("old.zip")).unwrap(),
        b"working previous pack"
    );
}

#[test]
fn failed_snapshot_cannot_change_the_installed_pack() {
    let fixture = Fixture::new("resourcepack", false);
    let before = fixture.metadata();
    let error = publish_content_install(
        fixture.plan("new.zip"),
        fixture.stage(),
        "https://cdn.modrinth.com/new.zip",
        None,
        None,
        || Err("Snapshot storage is full".into()),
    )
    .unwrap_err();
    assert_eq!(error, "Snapshot storage is full");
    assert_eq!(
        fs::read(fixture.game().join(fixture.root).join("old.zip")).unwrap(),
        b"working previous pack"
    );
    assert!(!fixture.game().join(fixture.root).join("new.zip").exists());
    assert_eq!(fixture.metadata(), before);
    fixture.assert_no_staging();
}

#[test]
fn changed_staging_rolls_back_and_retains_a_recoverable_snapshot() {
    let fixture = Fixture::new("resourcepack", false);
    let before = fixture.metadata();
    let error = publish_content_install(
        fixture.plan("new.zip"),
        fixture.stage(),
        "https://cdn.modrinth.com/new.zip",
        Some(hex::encode(Sha512::digest(b"different expected bytes"))),
        None,
        || Ok(fixture.snapshot()),
    )
    .unwrap_err();
    assert!(error.contains("changed before publication"));
    assert_eq!(
        fs::read(fixture.game().join(fixture.root).join("old.zip")).unwrap(),
        b"working previous pack"
    );
    assert!(!fixture.game().join(fixture.root).join("new.zip").exists());
    assert_eq!(fixture.metadata(), before);
    let journal: Value = serde_json::from_slice(
        &fs::read(
            fixture
                .storage()
                .join(&fixture.instance.id)
                .join("transaction.json"),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(journal["phase"], "rolled_back");
    fixture.assert_no_staging();
}

#[cfg(windows)]
#[test]
fn denied_metadata_publication_preserves_records_and_can_recover_after_unlock() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new("resourcepack", false);
    let before = fixture.metadata();
    let snapshot = std::cell::RefCell::new(None);
    let lock = std::cell::RefCell::new(None);
    let error = publish_content_install(
        fixture.plan("new.zip"),
        fixture.stage(),
        "https://cdn.modrinth.com/new.zip",
        None,
        None,
        || {
            let handle = fixture.snapshot();
            *lock.borrow_mut() = Some(
                fs::OpenOptions::new()
                    .read(true)
                    .share_mode(3)
                    .open(fixture.instance.directory.join("instance.json"))
                    .unwrap(),
            );
            *snapshot.borrow_mut() = Some(handle.clone());
            Ok(handle)
        },
    )
    .unwrap_err();
    assert!(error.contains("Recover the instance"));
    assert_eq!(fixture.metadata(), before);
    lock.borrow_mut().take();
    snapshot.borrow().as_ref().unwrap().rollback().unwrap();
    assert_eq!(fixture.metadata(), before);
    assert_eq!(
        fs::read(fixture.game().join(fixture.root).join("old.zip")).unwrap(),
        b"working previous pack"
    );
    assert!(!fixture.game().join(fixture.root).join("new.zip").exists());
    fixture.assert_no_staging();
}

#[test]
fn uninstall_removes_enabled_and_disabled_mods_and_keeps_other_content_records() {
    for disabled in [false, true] {
        let fixture = Fixture::new("mod", disabled);
        instances::mutate_instance(&fixture.instance.id, |value| {
            value["mods"].as_array_mut().unwrap().push(json!({
                "projectId": "project", "contentType": "resourcepack", "fileName": "other.zip"
            }));
            Ok(())
        })
        .unwrap();
        uninstall_mod_with_snapshot(fixture.instance.id.clone(), "project".into(), || {
            Ok(fixture.snapshot())
        })
        .unwrap();
        let directory = fixture.game().join("mods");
        assert!(!directory.join("old.zip").exists());
        assert!(!directory.join("old.zip.disabled").exists());
        let metadata = fixture.metadata();
        assert_eq!(metadata["mods"].as_array().unwrap().len(), 1);
        assert_eq!(metadata["mods"][0]["contentType"], "resourcepack");
    }
}

#[test]
fn uninstall_reconciles_a_missing_file_without_removing_other_records() {
    let fixture = Fixture::new("mod", false);
    fs::remove_file(fixture.game().join("mods").join("old.zip")).unwrap();
    uninstall_mod_with_snapshot(fixture.instance.id.clone(), "project".into(), || {
        Ok(fixture.snapshot())
    })
    .unwrap();
    assert!(fixture.metadata()["mods"].as_array().unwrap().is_empty());
    // Already absent projects have an explicit idempotent result and need no snapshot.
    uninstall_mod_with_snapshot(fixture.instance.id.clone(), "project".into(), || {
        panic!("unnecessary snapshot")
    })
    .unwrap();
}

#[test]
fn ambiguous_mod_records_cannot_delete_shared_files() {
    let fixture = Fixture::new("mod", false);
    instances::mutate_instance(&fixture.instance.id, |value| {
        value["mods"].as_array_mut().unwrap().push(json!({
            "projectId": "different-project", "contentType": "mod", "fileName": "old.zip"
        }));
        Ok(())
    })
    .unwrap();
    let before = fixture.metadata();
    assert!(
        uninstall_mod_with_snapshot(fixture.instance.id.clone(), "project".into(), || panic!(
            "unsafe snapshot"
        ))
        .is_err()
    );
    assert_eq!(fixture.metadata(), before);
    assert_eq!(
        fs::read(fixture.game().join("mods").join("old.zip")).unwrap(),
        b"working previous pack"
    );
}

#[cfg(windows)]
#[test]
fn locked_mod_retains_its_record_and_can_be_uninstalled_after_recovery() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new("mod", true);
    let path = fixture.game().join("mods").join("old.zip.disabled");
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(&path)
        .unwrap();
    let before = fixture.metadata();
    let snapshot = std::cell::RefCell::new(None);
    let error = uninstall_mod_with_snapshot(fixture.instance.id.clone(), "project".into(), || {
        let handle = fixture.snapshot();
        *snapshot.borrow_mut() = Some(handle.clone());
        Ok(handle)
    })
    .unwrap_err();
    assert!(error.contains("Could not remove the installed mod"));
    assert_eq!(fixture.metadata(), before);
    assert_eq!(fs::read(&path).unwrap(), b"working previous pack");
    drop(held);
    snapshot.borrow().as_ref().unwrap().rollback().unwrap();
    uninstall_mod_with_snapshot(fixture.instance.id.clone(), "project".into(), || {
        Ok(fixture.snapshot())
    })
    .unwrap();
    assert!(!path.exists());
    assert!(fixture.metadata()["mods"].as_array().unwrap().is_empty());
}

#[test]
fn portable_content_names_reject_device_names_and_alternate_streams() {
    for name in [
        "NUL.zip",
        "pack.zip:stream",
        "pack.zip.",
        "pack.zip ",
        "COM1.zip",
    ] {
        assert!(safe_content_name(name).is_err(), "accepted {name}");
    }
}
