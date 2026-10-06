use super::*;
use serde_json::json;
use std::fs;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("refract-friends-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> PathBuf {
        self.0.join("friends.json")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn friend(index: u128) -> Friend {
    Friend {
        uuid: uuid::Uuid::from_u128(index).to_string(),
        username: format!("Player_{index}"),
        added_at: index as u64,
        note: None,
    }
}

#[test]
fn legacy_aliases_and_unknown_fields_survive_note_changes() {
    let fixture = Fixture::new();
    let id = "0123456789abcdef0123456789abcdef";
    let original = json!([{
        "uuid": id, "playerName": " LegacyPlayer ", "added_at": 42,
        "note": " old ", "future": {"keep": true}
    }]);
    fs::write(fixture.path(), serde_json::to_vec(&original).unwrap()).unwrap();
    let before = list_at(&fixture.path()).unwrap();
    assert_eq!(before[0].username, "LegacyPlayer");
    assert_eq!(before[0].added_at, 42);
    update_note_at(&fixture.path(), &hyphenate_uuid(id).unwrap(), " new ").unwrap();
    let stored: Value = serde_json::from_slice(&fs::read(fixture.path()).unwrap()).unwrap();
    assert_eq!(stored[0]["future"], original[0]["future"]);
    assert_eq!(stored[0]["playerName"], original[0]["playerName"]);
    assert_eq!(
        list_at(&fixture.path()).unwrap()[0].note.as_deref(),
        Some("new")
    );
    update_note_at(&fixture.path(), id, " ").unwrap();
    assert!(list_at(&fixture.path()).unwrap()[0].note.is_none());
    assert!(add_at(
        &fixture.path(),
        Friend {
            uuid: hyphenate_uuid(id).unwrap(),
            ..friend(2)
        }
    )
    .is_err());
    remove_at(&fixture.path(), &hyphenate_uuid(id).unwrap()).unwrap();
    assert!(list_at(&fixture.path()).unwrap().is_empty());
}

#[test]
fn concurrent_additions_and_note_changes_preserve_all_records() {
    let fixture = Fixture::new();
    let workers: Vec<_> = (1..=16)
        .map(|index| {
            let path = fixture.path();
            std::thread::spawn(move || {
                let record = add_at(&path, friend(index)).unwrap();
                update_note_at(&path, &record.uuid, &format!("note-{index}")).unwrap();
            })
        })
        .collect();
    for worker in workers {
        worker.join().unwrap();
    }
    let records = list_at(&fixture.path()).unwrap();
    assert_eq!(records.len(), 16);
    for index in 1..=16 {
        let record = records
            .iter()
            .find(|record| record.uuid == friend(index).uuid)
            .unwrap();
        assert_eq!(record.note, Some(format!("note-{index}")));
    }
}

#[test]
fn concurrent_duplicate_additions_have_one_winner() {
    let fixture = Fixture::new();
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let path = fixture.path();
            std::thread::spawn(move || add_at(&path, friend(1)))
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .filter(Result::is_ok)
            .count(),
        1
    );
    assert_eq!(list_at(&fixture.path()).unwrap().len(), 1);
}

#[test]
fn invalid_records_recover_as_a_whole_and_preserve_corrupt_bytes() {
    let fixture = Fixture::new();
    add_at(&fixture.path(), friend(1)).unwrap();
    let corrupt = br#"[{"uuid":"keep","username":"Player"},{"username":"missing UUID"}]"#;
    fs::write(fixture.path(), corrupt).unwrap();
    assert_eq!(list_at(&fixture.path()).unwrap()[0].uuid, friend(1).uuid);
    let preserved = fs::read_dir(&fixture.0)
        .unwrap()
        .map(Result::unwrap)
        .find(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
        .unwrap();
    assert_eq!(fs::read(preserved.path()).unwrap(), corrupt);
}

#[test]
fn unrecoverable_or_unreadable_storage_is_never_replaced_by_an_empty_list() {
    let fixture = Fixture::new();
    for bytes in [
        br#"{"unexpected":[]}"#.as_slice(),
        br#"[{"uuid":"x","note":23}]"#,
        b"{",
    ] {
        fs::write(fixture.path(), bytes).unwrap();
        assert!(list_at(&fixture.path()).is_err());
        assert!(add_at(&fixture.path(), friend(1)).is_err());
        assert!(remove_at(&fixture.path(), "x").is_err());
        assert!(update_note_at(&fixture.path(), "x", "new").is_err());
        assert_eq!(fs::read(fixture.path()).unwrap(), bytes);
    }
    fs::remove_file(fixture.path()).unwrap();
    fs::create_dir(fixture.path()).unwrap();
    assert!(list_at(&fixture.path()).is_err());
    assert!(add_at(&fixture.path(), friend(1)).is_err());
}

#[test]
fn failed_save_and_missing_friend_do_not_report_success_or_change_records() {
    let fixture = Fixture::new();
    add_at(&fixture.path(), friend(1)).unwrap();
    assert!(update_note_at(&fixture.path(), &friend(2).uuid, "new").is_err());
    let original = fs::read(fixture.path()).unwrap();
    let backup = fixture.0.join("friends.json.bak");
    fs::remove_file(&backup).unwrap();
    fs::create_dir(&backup).unwrap();
    assert!(update_note_at(&fixture.path(), &friend(1).uuid, "new").is_err());
    assert!(add_at(&fixture.path(), friend(2)).is_err());
    assert!(remove_at(&fixture.path(), &friend(1).uuid).is_err());
    assert_eq!(fs::read(fixture.path()).unwrap(), original);
}
