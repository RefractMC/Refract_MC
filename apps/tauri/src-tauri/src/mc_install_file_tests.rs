use super::*;
use serde_json::json;
use sha1::{Digest, Sha1};
use std::path::PathBuf;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("refract-install-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn archive(&self, name: &str, contents: &[u8]) -> PathBuf {
        let path = self.0.join("natives.jar");
        let mut writer = zip::ZipWriter::new(File::create(&path).unwrap());
        writer
            .start_file(name, zip::write::SimpleFileOptions::default())
            .unwrap();
        writer.write_all(contents).unwrap();
        writer.finish().unwrap();
        path
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn no_cancel() -> downloader::CancelCheck {
    Arc::new(|| Ok(()))
}

#[test]
fn native_extraction_publishes_into_the_actual_game_root() {
    let f = Fixture::new();
    let jar = f.archive("nested/example.dll", b"native");
    let game = f.0.join("external-game");
    extract_natives(&jar, &game, &[], &no_cancel()).unwrap();
    assert_eq!(
        std::fs::read(game.join("natives/example.dll")).unwrap(),
        b"native"
    );
    assert!(!f.0.join("minecraft/natives").exists());
}

#[test]
fn native_exclusions_and_cancellation_preserve_previous_file() {
    let f = Fixture::new();
    let jar = f.archive("nested/example.dll", b"new");
    let game = f.0.join("game");
    std::fs::create_dir_all(game.join("natives")).unwrap();
    std::fs::write(game.join("natives/example.dll"), b"old").unwrap();
    extract_natives(&jar, &game, &["nested/".into()], &no_cancel()).unwrap();
    assert_eq!(
        std::fs::read(game.join("natives/example.dll")).unwrap(),
        b"old"
    );
    let cancelled: downloader::CancelCheck = Arc::new(|| Err("Cancelled fixture".into()));
    assert!(extract_natives(&jar, &game, &[], &cancelled).is_err());
    assert_eq!(
        std::fs::read(game.join("natives/example.dll")).unwrap(),
        b"old"
    );
}

#[test]
fn traversal_native_is_rejected_without_writing_outside_game() {
    let f = Fixture::new();
    let jar = f.archive("../outside.dll", b"bad");
    assert!(extract_natives(&jar, &f.0.join("game"), &[], &no_cancel()).is_err());
    assert!(!f.0.join("outside.dll").exists());
    assert!(!f.0.join("game/natives/outside.dll").exists());
}

fn copies(f: &Fixture, content: &[u8]) -> minecraft_metadata::AssetPlan {
    let hash = hex::encode(Sha1::digest(content));
    let v = json!({"virtual":true,"map_to_resources":true,"objects":{"sounds/test.ogg":{"hash":hash,"size":content.len()}}});
    let p = minecraft_metadata::assets(
        &v,
        "legacy",
        &f.0.join("assets"),
        &f.0.join("game"),
        downloader::Existing::SkipIfExists,
    )
    .unwrap();
    std::fs::create_dir_all(p.downloads[0].dest.parent().unwrap()).unwrap();
    std::fs::write(&p.downloads[0].dest, content).unwrap();
    p
}

#[test]
fn mapped_assets_are_materialized_from_verified_objects() {
    let f = Fixture::new();
    let p = copies(&f, b"sound");
    materialize_assets(&f.0.join("assets"), &p.copies, &no_cancel()).unwrap();
    for copy in &p.copies {
        assert_eq!(std::fs::read(&copy.destination).unwrap(), b"sound");
    }
}

#[test]
fn corrupt_mapped_asset_never_replaces_previous_file() {
    let f = Fixture::new();
    let p = copies(&f, b"sound");
    let target = &p.copies[0].destination;
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(target, b"previous").unwrap();
    std::fs::write(&p.downloads[0].dest, b"wrong").unwrap();
    assert!(materialize_assets(&f.0.join("assets"), &p.copies, &no_cancel()).is_err());
    assert_eq!(std::fs::read(target).unwrap(), b"previous");
    assert_eq!(
        std::fs::read_dir(target.parent().unwrap()).unwrap().count(),
        1
    );
}

#[test]
fn cancelled_asset_copy_keeps_previous_file_and_cleans_temporary_output() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let f = Fixture::new();
    let p = copies(&f, &vec![42; 256 * 1024]);
    let target = &p.copies[0].destination;
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(target, b"previous").unwrap();
    let count = AtomicUsize::new(0);
    let cancel: downloader::CancelCheck = Arc::new(move || {
        if count.fetch_add(1, Ordering::SeqCst) >= 2 {
            Err("Cancelled fixture".into())
        } else {
            Ok(())
        }
    });
    assert!(materialize_assets(&f.0.join("assets"), &p.copies, &cancel).is_err());
    assert_eq!(std::fs::read(target).unwrap(), b"previous");
    assert_eq!(
        std::fs::read_dir(target.parent().unwrap()).unwrap().count(),
        1
    );
}
