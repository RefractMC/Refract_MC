use super::*;

struct Fixture(instances::TestInstance);

impl Fixture {
    fn new() -> Self {
        let fixture = Self(instances::TestInstance::new());
        fs::create_dir_all(fixture.game().join("mods")).unwrap();
        for (name, bytes) in [
            ("a.jar", b"enabled mod".as_slice()),
            ("b.jar.disabled", b"disabled mod".as_slice()),
            ("notes.txt", b"unrelated file".as_slice()),
        ] {
            fs::write(fixture.game().join("mods").join(name), bytes).unwrap();
        }
        fixture
    }

    fn game(&self) -> PathBuf {
        game_dir(&self.0.id).unwrap()
    }
    fn storage(&self) -> PathBuf {
        self.0.directory.join("fixture-snapshots")
    }
    fn snapshot(&self) -> crate::snapshots::SnapshotHandle {
        crate::snapshots::create_content_change_at(&self.storage(), &self.0.id, "mods").unwrap()
    }
    fn profile(&self, names: &[&str]) -> String {
        let profile = mods_profiles_save_owned(
            self.0.id.clone(),
            "Fixture profile".into(),
            names.iter().map(|name| (*name).to_string()).collect(),
        )
        .unwrap();
        profile["id"].as_str().unwrap().to_string()
    }
    fn assert_original(&self) {
        let root = self.game().join("mods");
        assert_eq!(fs::read(root.join("a.jar")).unwrap(), b"enabled mod");
        assert_eq!(
            fs::read(root.join("b.jar.disabled")).unwrap(),
            b"disabled mod"
        );
        assert_eq!(fs::read(root.join("notes.txt")).unwrap(), b"unrelated file");
        assert!(!root.join("a.jar.disabled").exists());
        assert!(!root.join("b.jar").exists());
    }
}

#[test]
fn profile_success_enables_and_disables_the_complete_selected_set() {
    let fixture = Fixture::new();
    let id = fixture.profile(&["b.jar"]);
    mods_profiles_apply_with_snapshot(fixture.0.id.clone(), id, || Ok(fixture.snapshot())).unwrap();
    let root = fixture.game().join("mods");
    assert_eq!(
        fs::read(root.join("a.jar.disabled")).unwrap(),
        b"enabled mod"
    );
    assert_eq!(fs::read(root.join("b.jar")).unwrap(), b"disabled mod");
    assert!(!root.join("a.jar").exists());
    assert!(!root.join("b.jar.disabled").exists());
    assert_eq!(fs::read(root.join("notes.txt")).unwrap(), b"unrelated file");
}

#[test]
fn failed_profile_after_one_rename_rolls_back_every_selected_file() {
    let fixture = Fixture::new();
    let id = fixture.profile(&["b.jar"]);
    let error = mods_profiles_apply_with_snapshot(fixture.0.id.clone(), id, || {
        let snapshot = fixture.snapshot();
        fs::write(
            fixture.game().join("mods").join("b.jar"),
            b"conflicting destination",
        )
        .unwrap();
        Ok(snapshot)
    })
    .unwrap_err();
    assert!(error.contains("destination already exists"));
    fixture.assert_original();
}

#[cfg(windows)]
#[test]
fn denied_profile_rename_reports_failure_and_can_recover_after_unlock() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let id = fixture.profile(&["b.jar"]);
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(fixture.game().join("mods").join("b.jar.disabled"))
        .unwrap();
    let snapshot = std::cell::RefCell::new(None);
    let error = mods_profiles_apply_with_snapshot(fixture.0.id.clone(), id, || {
        let handle = fixture.snapshot();
        *snapshot.borrow_mut() = Some(handle.clone());
        Ok(handle)
    })
    .unwrap_err();
    assert!(error.contains("Could not change the mod's enabled state"));
    assert!(error.contains("Recover the instance"));
    drop(held);
    snapshot.borrow().as_ref().unwrap().rollback().unwrap();
    fixture.assert_original();
}

#[test]
fn missing_profile_mod_and_conflicting_files_fail_before_mutation() {
    let fixture = Fixture::new();
    let id = fixture.profile(&["missing.jar"]);
    assert!(
        mods_profiles_apply_with_snapshot(fixture.0.id.clone(), id, || panic!("unsafe snapshot"))
            .unwrap_err()
            .contains("not installed")
    );
    fixture.assert_original();
    let id = fixture.profile(&["b.jar"]);
    fs::write(
        fixture.game().join("mods").join("b.jar"),
        b"ambiguous second copy",
    )
    .unwrap();
    assert!(
        mods_profiles_apply_with_snapshot(fixture.0.id.clone(), id, || panic!("unsafe snapshot"))
            .unwrap_err()
            .contains("conflicting")
    );
    assert!(fixture.game().join("mods").join("a.jar").is_file());
}

#[test]
fn malformed_profile_storage_is_reported_and_preserved_on_save() {
    let fixture = Fixture::new();
    let path = profiles_path(&fixture.0.id).unwrap();
    let corrupt = br#"{"profiles":"invalid list","futureField":true}"#;
    fs::write(&path, corrupt).unwrap();
    assert!(read_profiles(&fixture.0.id).is_err());
    assert!(mods_profiles_save_owned(fixture.0.id.clone(), "New profile".into(), vec![]).is_err());
    assert_eq!(fs::read(path).unwrap(), corrupt);
    fixture.assert_original();
}

#[test]
fn profile_storage_recovers_backup_and_preserves_unknown_fields() {
    let fixture = Fixture::new();
    let path = profiles_path(&fixture.0.id).unwrap();
    persistence::write_json(
        &path,
        &json!({"profiles": [], "futureField": {"keep": true}}),
    )
    .unwrap();
    let id = fixture.profile(&["a.jar"]);
    mods_profiles_rename_owned(fixture.0.id.clone(), id, "Renamed profile".into()).unwrap();
    let store: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(store["futureField"]["keep"], true);
    fs::write(&path, b"{truncated").unwrap();
    assert_eq!(read_profiles(&fixture.0.id).unwrap().len(), 1);
    assert!(fs::read_dir(&fixture.0.directory)
        .unwrap()
        .any(|entry| entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("mod-profiles.json.corrupt-")));
}

#[test]
fn cancellation_cannot_leave_a_partly_applied_profile() {
    let fixture = Fixture::new();
    let id = fixture.profile(&["b.jar"]);
    let operation =
        crate::operations::Operation::begin(&fixture.0.id, crate::operations::Kind::Mutation)
            .unwrap();
    let error = operation
        .sync_scope(|| {
            mods_profiles_apply_with_snapshot(fixture.0.id.clone(), id, || {
                let snapshot = fixture.snapshot();
                crate::operations::request_cancel(operation.id()).unwrap();
                Ok(snapshot)
            })
        })
        .unwrap_err();
    assert!(error.to_lowercase().contains("cancel"));
    fixture.assert_original();
}

#[test]
fn invalid_profile_names_and_duplicate_enabled_paths_cannot_replace_storage() {
    let fixture = Fixture::new();
    fixture.profile(&["a.jar"]);
    let path = profiles_path(&fixture.0.id).unwrap();
    let before = fs::read(&path).unwrap();
    for names in [
        vec!["../outside.jar"],
        vec!["a.jar", "A.jar"],
        vec!["NUL.jar"],
    ] {
        assert!(mods_profiles_save_owned(
            fixture.0.id.clone(),
            "Invalid profile".into(),
            names.into_iter().map(str::to_string).collect()
        )
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
    }
}
