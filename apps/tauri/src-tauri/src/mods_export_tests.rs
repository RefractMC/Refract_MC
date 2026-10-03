use super::*;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("refract-export-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("game/config/nested")).unwrap();
        fs::create_dir_all(root.join("game/mods")).unwrap();
        Self(root)
    }

    fn game(&self) -> PathBuf {
        self.0.join("game")
    }

    fn destination(&self) -> PathBuf {
        self.0.join("pack.mrpack")
    }

    fn write(&self, relative: &str, bytes: &[u8]) {
        fs::write(self.game().join(relative), bytes).unwrap();
    }

    fn assert_previous_export(&self) {
        assert_eq!(
            fs::read(self.destination()).unwrap(),
            b"previous complete archive"
        );
        assert!(fs::read_dir(&self.0).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".pack.mrpack.")
        }));
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn link_directory(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    {
        let mut command = std::process::Command::new("cmd");
        crate::procutil::hide_window(&mut command);
        let output = command
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture creation failed: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn a_file_added_during_archive_writing_prevents_incomplete_publication() {
    let fixture = Fixture::new();
    fixture.write("config/settings", b"selected content");
    fs::write(fixture.destination(), b"previous complete archive").unwrap();
    let inventory = export_inventory(&fixture.game()).unwrap();
    let error = write_export_archive(
        &fixture.game(),
        &fixture.destination(),
        &json!({}),
        &[],
        &inventory.overrides,
        |done, total| {
            assert_ne!(done, total);
            if done == 1 {
                fixture.write("config/new-settings", b"new selected content");
            }
        },
    )
    .unwrap_err();
    assert!(error.contains("changed during export"));
    fixture.assert_previous_export();
}

#[test]
fn invalid_provider_fields_cannot_create_a_downloadable_pack_entry() {
    let hash = "a".repeat(128);
    let valid = json!({"files": [{"hashes": {"sha512": hash, "sha1": "b".repeat(40)}, "size": 12, "url": "https://cdn.modrinth.com/pack.jar"}]});
    assert_eq!(export_provider_file(&valid, &hash).unwrap()["size"], 12);
    for (key, invalid) in [
        ("url", json!("https://untrusted.invalid/pack.jar")),
        (
            "url",
            json!(format!("https://cdn.modrinth.com/{}", "x".repeat(2048))),
        ),
        ("hashes", json!({"sha512": hash, "sha1": "not-a-sha1"})),
        ("size", json!(-1)),
    ] {
        let mut version = valid.clone();
        version["files"][0][key] = invalid;
        assert!(export_provider_file(&version, &hash).is_none());
    }
}

#[test]
fn complete_export_round_trips_nested_config_and_enabled_disabled_content() {
    let fixture = Fixture::new();
    fixture.write("mods/known.jar", b"known content");
    fixture.write("mods/disabled.jar.disabled", b"disabled content");
    fixture.write("config/nested/settings.json", br#"{"enabled":true}"#);
    let inventory = export_inventory(&fixture.game()).unwrap();
    assert_eq!(inventory.candidates.len(), 1);
    assert_eq!(inventory.overrides.len(), 2);
    let mut overrides = inventory.overrides;
    overrides.extend(inventory.candidates);
    let index = json!({"formatVersion": 1, "files": [], "dependencies": {"minecraft": "fixture"}});
    write_export_archive(
        &fixture.game(),
        &fixture.destination(),
        &index,
        &[],
        &overrides,
        |_, _| {},
    )
    .unwrap();
    let mut archive = zip::ZipArchive::new(fs::File::open(fixture.destination()).unwrap()).unwrap();
    assert_eq!(archive.len(), 4);
    for (name, expected) in [
        ("overrides/mods/known.jar", b"known content".as_slice()),
        (
            "overrides/mods/disabled.jar.disabled",
            b"disabled content".as_slice(),
        ),
        (
            "overrides/config/nested/settings.json",
            br#"{"enabled":true}"#.as_slice(),
        ),
    ] {
        let mut bytes = Vec::new();
        archive
            .by_name(name)
            .unwrap()
            .read_to_end(&mut bytes)
            .unwrap();
        assert_eq!(bytes, expected);
    }
    let decoded: Value =
        serde_json::from_reader(archive.by_name("modrinth.index.json").unwrap()).unwrap();
    assert_eq!(decoded, index);
}

#[test]
fn config_junction_cannot_include_an_outside_marker() {
    let fixture = Fixture::new();
    let outside = fixture.0.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("private-marker"), b"outside export scope").unwrap();
    let link = fixture.game().join("config").join("linked");
    link_directory(&outside, &link);
    assert!(export_inventory(&fixture.game()).is_err());
    assert_eq!(
        fs::read(outside.join("private-marker")).unwrap(),
        b"outside export scope"
    );
    #[cfg(windows)]
    fs::remove_dir(link).unwrap();
    #[cfg(unix)]
    fs::remove_file(link).unwrap();
}

#[test]
fn content_selection_excludes_download_staging_and_unrelated_entries() {
    let fixture = Fixture::new();
    fixture.write(
        "mods/.refract-update-backup-fixture.tmp",
        b"previous content",
    );
    fixture.write("mods/.known.jar.fixture.part", b"incomplete download");
    fixture.write("mods/unrelated.txt", b"outside selected content");
    fs::create_dir(fixture.game().join("mods").join("nested")).unwrap();
    fixture.write("mods/nested/unselected.jar", b"outside selected content");
    let inventory = export_inventory(&fixture.game()).unwrap();
    assert!(inventory.candidates.is_empty());
    assert!(inventory.overrides.is_empty());
}

#[test]
fn completion_progress_means_the_finished_archive_is_published() {
    let fixture = Fixture::new();
    fixture.write("config/settings", b"selected content");
    fs::write(fixture.destination(), b"previous complete archive").unwrap();
    let inventory = export_inventory(&fixture.game()).unwrap();
    let mut completed = false;
    write_export_archive(
        &fixture.game(),
        &fixture.destination(),
        &json!({}),
        &[],
        &inventory.overrides,
        |done, total| {
            if done == total {
                let archive =
                    zip::ZipArchive::new(fs::File::open(fixture.destination()).unwrap()).unwrap();
                assert_eq!(archive.len(), 2);
                completed = true;
            } else {
                assert_eq!(
                    fs::read(fixture.destination()).unwrap(),
                    b"previous complete archive"
                );
            }
        },
    )
    .unwrap();
    assert!(completed);
}

#[cfg(unix)]
#[test]
fn linked_content_file_is_rejected_instead_of_hashed_or_embedded() {
    let fixture = Fixture::new();
    let outside = fixture.0.join("private.jar");
    fs::write(&outside, b"outside export scope").unwrap();
    std::os::unix::fs::symlink(&outside, fixture.game().join("mods/linked.jar")).unwrap();
    assert!(export_inventory(&fixture.game()).is_err());
}

#[test]
fn override_lost_after_planning_preserves_the_previous_archive_and_cleans_staging() {
    let fixture = Fixture::new();
    fixture.write("config/settings", b"selected content");
    fs::write(fixture.destination(), b"previous complete archive").unwrap();
    let inventory = export_inventory(&fixture.game()).unwrap();
    let result = write_export_archive(
        &fixture.game(),
        &fixture.destination(),
        &json!({}),
        &[],
        &inventory.overrides,
        |done, _| {
            if done == 1 {
                fs::remove_file(fixture.game().join("config/settings")).unwrap();
            }
        },
    );
    assert!(result.is_err());
    fixture.assert_previous_export();
}

#[test]
fn same_size_override_change_is_detected_without_a_hash_cache() {
    let fixture = Fixture::new();
    fixture.write("config/settings", b"old bytes");
    fs::write(fixture.destination(), b"previous complete archive").unwrap();
    let inventory = export_inventory(&fixture.game()).unwrap();
    fixture.write("config/settings", b"new bytes");
    assert!(write_export_archive(
        &fixture.game(),
        &fixture.destination(),
        &json!({}),
        &[],
        &inventory.overrides,
        |_, _| {}
    )
    .is_err());
    fixture.assert_previous_export();
}

#[test]
fn provider_reference_does_not_hide_a_missing_or_changed_selected_file() {
    let fixture = Fixture::new();
    fixture.write("mods/known.jar", b"known content");
    fs::write(fixture.destination(), b"previous complete archive").unwrap();
    let inventory = export_inventory(&fixture.game()).unwrap();
    fs::remove_file(fixture.game().join("mods/known.jar")).unwrap();
    assert!(write_export_archive(
        &fixture.game(),
        &fixture.destination(),
        &json!({}),
        &inventory.candidates,
        &[],
        |_, _| {}
    )
    .is_err());
    fixture.assert_previous_export();
}

#[test]
fn a_selected_root_that_is_a_file_is_an_error_not_an_empty_folder() {
    let fixture = Fixture::new();
    fs::remove_dir_all(fixture.game().join("config")).unwrap();
    fixture.write("config", b"invalid config folder");
    assert!(export_inventory(&fixture.game()).is_err());
}

#[cfg(windows)]
#[test]
fn locked_destination_preserves_the_previous_archive_and_cleans_staging() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    fixture.write("config/settings", b"selected content");
    fs::write(fixture.destination(), b"previous complete archive").unwrap();
    let inventory = export_inventory(&fixture.game()).unwrap();
    let _held = fs::OpenOptions::new()
        .read(true)
        .share_mode(3)
        .open(fixture.destination())
        .unwrap();
    assert!(write_export_archive(
        &fixture.game(),
        &fixture.destination(),
        &json!({}),
        &[],
        &inventory.overrides,
        |done, total| assert_ne!(done, total),
    )
    .is_err());
    fixture.assert_previous_export();
}

#[cfg(windows)]
#[test]
fn locked_export_input_does_not_become_an_omitted_file() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    fixture.write("mods/locked.jar", b"required content");
    let _lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(fixture.game().join("mods/locked.jar"))
        .unwrap();
    assert!(export_inventory(&fixture.game()).is_err());
}

#[test]
fn cancelled_export_cannot_publish_a_partial_archive() {
    let instance = instances::TestInstance::new();
    let game = instance.directory.join("minecraft");
    fs::create_dir_all(game.join("config")).unwrap();
    fs::write(game.join("config/settings"), b"selected content").unwrap();
    let inventory = export_inventory(&game).unwrap();
    let destination = instance.directory.join("pack.mrpack");
    fs::write(&destination, b"previous complete archive").unwrap();
    let operation =
        crate::operations::Operation::begin(&instance.id, crate::operations::Kind::Snapshot)
            .unwrap();
    crate::operations::request_cancel(operation.id()).unwrap();
    let result = operation.sync_scope(|| {
        write_export_archive(
            &game,
            &destination,
            &json!({}),
            &[],
            &inventory.overrides,
            |_, _| {},
        )
    });
    assert!(result.is_err());
    assert_eq!(fs::read(destination).unwrap(), b"previous complete archive");
}
