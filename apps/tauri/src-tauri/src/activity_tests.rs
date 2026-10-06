use super::*;
use std::fs;
use std::path::PathBuf;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("refract-activity-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> PathBuf {
        self.0.join("activity.json")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn concurrent_activity_records_are_all_committed() {
    let fixture = Fixture::new();
    let workers: Vec<_> = (0..24)
        .map(|index| {
            let path = fixture.path();
            std::thread::spawn(move || add_at(&path, format!("entry-{index}")).unwrap())
        })
        .collect();
    let committed: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().unwrap())
        .collect();
    let stored: Vec<ActivityEntry> = persistence::read_json(&fixture.path(), Vec::new).unwrap();
    assert_eq!(stored.len(), committed.len());
    for entry in committed {
        assert!(stored
            .iter()
            .any(|record| record.id == entry.id && record.label == entry.label));
    }
}

#[test]
fn recent_activity_limit_and_order_are_preserved() {
    let fixture = Fixture::new();
    for index in 0..60 {
        add_at(&fixture.path(), index.to_string()).unwrap();
    }
    let stored: Vec<ActivityEntry> = persistence::read_json(&fixture.path(), Vec::new).unwrap();
    assert_eq!(stored.len(), 50);
    assert_eq!(stored[0].label, "59");
    assert_eq!(stored[49].label, "10");
}

#[test]
fn malformed_activity_recovers_backup_without_resetting_history() {
    let fixture = Fixture::new();
    add_at(&fixture.path(), "keep".into()).unwrap();
    fs::write(fixture.path(), br#"[{"id":"broken","ts":"wrong type"}]"#).unwrap();
    let stored: Vec<ActivityEntry> = persistence::read_json(&fixture.path(), Vec::new).unwrap();
    assert_eq!(stored[0].label, "keep");
    assert!(fs::read_dir(&fixture.0)
        .unwrap()
        .map(Result::unwrap)
        .any(|entry| entry.file_name().to_string_lossy().contains(".corrupt-")));
}

#[test]
fn failed_activity_writes_return_an_error_and_preserve_history() {
    let fixture = Fixture::new();
    fs::write(fixture.path(), b"{").unwrap();
    assert!(add_at(&fixture.path(), "new".into()).is_err());
    assert_eq!(fs::read(fixture.path()).unwrap(), b"{");
    fs::remove_file(fixture.path()).unwrap();
    add_at(&fixture.path(), "keep".into()).unwrap();
    let original = fs::read(fixture.path()).unwrap();
    let backup = fixture.0.join("activity.json.bak");
    fs::remove_file(&backup).unwrap();
    fs::create_dir(&backup).unwrap();
    assert!(add_at(&fixture.path(), "new".into()).is_err());
    assert_eq!(fs::read(fixture.path()).unwrap(), original);
}
