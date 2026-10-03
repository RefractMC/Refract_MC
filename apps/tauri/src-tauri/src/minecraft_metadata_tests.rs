use super::*;
use serde_json::json;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("refract-metadata-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn artifact() -> Value {
    json!({"url":"https://libraries.minecraft.net/example/test/1/test-1.jar",
        "path":"example/test/1/test-1.jar", "sha1":"a".repeat(40), "size":123})
}

fn library() -> Value {
    json!({"name":"example:test:1", "downloads":{"artifact":artifact()}})
}

fn version() -> Value {
    json!({"id":"1.21.8", "mainClass":"net.minecraft.client.main.Main",
        "downloads":{"client":artifact()}, "libraries":[library()],
        "assetIndex":{"id":"26", "url":"https://piston-meta.mojang.com/index.json",
            "sha1":"b".repeat(40), "size":456}, "javaVersion":{"majorVersion":21}})
}

fn plan(value: &Value, root: &Path) -> Result<MinecraftPlan, String> {
    minecraft(
        value,
        "1.21.8",
        &root.join("versions"),
        &root.join("libraries"),
        &root.join("assets"),
    )
}

#[test]
fn complete_plan_preserves_integrity_and_does_not_publish_files() {
    let f = Fixture::new();
    let p = plan(&version(), &f.0).unwrap();
    assert_eq!(p.client.size, Some(123));
    assert_eq!(p.libraries.artifacts.len(), 1);
    assert_eq!(p.index_id, "26");
    assert_eq!(p.java_major, 21);
    assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 0);
}

#[test]
fn missing_required_sections_and_invalid_java_fail() {
    let f = Fixture::new();
    for field in ["mainClass", "downloads", "libraries", "assetIndex"] {
        let mut v = version();
        v.as_object_mut().unwrap().remove(field);
        assert!(plan(&v, &f.0).is_err(), "{field}");
    }
    for major in [json!(0), json!(-1), json!("21"), json!(u64::MAX)] {
        let mut v = version();
        v["javaVersion"]["majorVersion"] = major;
        assert!(plan(&v, &f.0).is_err());
    }
}

#[test]
fn invalid_required_artifacts_cannot_disappear_from_plan() {
    let f = Fixture::new();
    for field in ["path", "url", "sha1", "size"] {
        let mut lib = library();
        lib["downloads"]["artifact"]
            .as_object_mut()
            .unwrap()
            .remove(field);
        assert!(libraries(&json!([lib]), &f.0).is_err(), "{field}");
    }
    for value in [
        json!(null),
        json!([]),
        json!({}),
        json!({"name":"example:test:1","downloads":{}}),
    ] {
        assert!(libraries(&json!([value]), &f.0).is_err());
    }
}

#[test]
fn artifact_paths_and_index_ids_reject_portable_traversal() {
    let f = Fixture::new();
    for path in [
        "../outside.jar",
        "a/../../outside.jar",
        "C:\\outside.jar",
        "/outside.jar",
        "a\\..\\outside.jar",
        "a/CON.jar",
    ] {
        let mut lib = library();
        lib["downloads"]["artifact"]["path"] = json!(path);
        assert!(libraries(&json!([lib]), &f.0).is_err(), "{path}");
    }
    for id in ["../index", "a/b", "a\\b", "CON", ""] {
        let mut v = version();
        v["assetIndex"]["id"] = json!(id);
        assert!(plan(&v, &f.0).is_err(), "{id}");
    }
}

#[test]
fn invalid_hashes_sizes_and_urls_fail_before_publication() {
    let f = Fixture::new();
    for hash in ["", "aa", &"g".repeat(40), &"é".repeat(20)] {
        let mut v = version();
        v["downloads"]["client"]["sha1"] = json!(hash);
        assert!(plan(&v, &f.0).is_err());
    }
    for bytes in [json!(-1), json!("123"), json!(1.5), json!(null)] {
        let mut v = version();
        v["downloads"]["client"]["size"] = bytes;
        assert!(plan(&v, &f.0).is_err());
    }
    for url in [
        "",
        "http://libraries.minecraft.net/test.jar",
        "https://example.com/test.jar",
        "https://user@libraries.minecraft.net/test.jar",
    ] {
        let mut v = version();
        v["downloads"]["client"]["url"] = json!(url);
        assert!(plan(&v, &f.0).is_err());
    }
    assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 0);
}

fn native_library() -> Value {
    json!({"name":"org.lwjgl.lwjgl:lwjgl-platform:2.9.0",
        "natives":{"windows":"natives-windows","linux":"natives-linux","osx":"natives-osx"},
        "downloads":{"classifiers":{"natives-windows":artifact(),"natives-linux":artifact(),"natives-osx":artifact()}},
        "extract":{"exclude":["META-INF/"]}})
}

#[test]
fn legitimate_native_only_library_has_native_task_and_no_classpath_jar() {
    let f = Fixture::new();
    let lib = native_library();
    let p = libraries(&json!([lib.clone()]), &f.0).unwrap();
    assert!(p.artifacts.is_empty());
    assert_eq!(p.natives.len(), 1);
    assert_eq!(p.natives[0].excludes, ["META-INF/"]);
    assert!(library_artifact_path(&lib, &f.0).unwrap().is_none());
}

#[test]
fn malformed_selected_native_and_exclusions_fail() {
    let f = Fixture::new();
    let classifier = rules::native_classifier(&native_library()).unwrap();
    let mut lib = native_library();
    lib["downloads"]["classifiers"]
        .as_object_mut()
        .unwrap()
        .remove(&classifier);
    assert!(libraries(&json!([lib]), &f.0).is_err());
    for exclude in [json!("META-INF/"), json!([null])] {
        let mut lib = native_library();
        lib["extract"]["exclude"] = exclude;
        assert!(libraries(&json!([lib]), &f.0).is_err());
    }
    let mut lib = native_library();
    lib["natives"] = json!({"windows":null});
    assert!(libraries(&json!([lib]), &f.0).is_err());
}

#[test]
fn explicit_legacy_maven_libraries_and_classifiers_remain_supported() {
    let f = Fixture::new();
    let p = libraries(&json!([{"name":"example:test:1"}]), &f.0).unwrap();
    assert_eq!(p.artifacts.len(), 1);
    assert_eq!(
        p.artifacts[0].url,
        "https://libraries.minecraft.net/example/test/1/test-1.jar"
    );
    assert!(p.artifacts[0].hash.is_none());
    let mut lib = native_library();
    lib.as_object_mut().unwrap().remove("downloads");
    let p = libraries(&json!([lib]), &f.0).unwrap();
    assert!(p.artifacts.is_empty());
    assert_eq!(p.natives.len(), 1);
    assert!(p.natives[0].task.url.contains("-natives-"));
    assert_eq!(
        maven_path("example:test:1@zip", None).unwrap(),
        "example/test/1/test-1.zip"
    );
    assert_eq!(
        maven_path("example:test:1:client@zip", None).unwrap(),
        "example/test/1/test-1-client.zip"
    );
}

#[test]
fn malformed_legacy_coordinates_do_not_gain_a_fallback() {
    let f = Fixture::new();
    for name in [
        "example",
        "example:test:",
        "example:test:../1",
        "example:test:1:bad:extra",
        "example:test:1@",
        ".:test:1",
        "example:test:1@jar@zip",
    ] {
        assert!(libraries(&json!([{"name":name}]), &f.0).is_err(), "{name}");
    }
    assert!(libraries(&json!([{"name":"example:test:1","url":null}]), &f.0).is_err());
}

#[test]
fn excluded_platform_records_are_optional_but_malformed_rules_are_errors() {
    let f = Fixture::new();
    let p = libraries(&json!([{"rules":[{"action":"disallow"}]}]), &f.0).unwrap();
    assert!(p.artifacts.is_empty());
    for rule in [
        json!({"action":"unknown"}),
        json!({"action":"allow","os":{"version":"["}}),
        json!({"action":"allow","features":{"demo":"true"}}),
    ] {
        let mut lib = library();
        lib["rules"] = json!([rule]);
        assert!(libraries(&json!([lib]), &f.0).is_err());
    }
}

#[test]
fn duplicate_downloads_deduplicate_but_conflicting_destinations_fail() {
    let f = Fixture::new();
    let lib = library();
    assert_eq!(
        libraries(&json!([lib.clone(), lib.clone()]), &f.0)
            .unwrap()
            .artifacts
            .len(),
        1
    );
    let mut other = lib.clone();
    other["downloads"]["artifact"]["size"] = json!(124);
    assert!(libraries(&json!([lib.clone(), other]), &f.0).is_err());
    let mut other = lib.clone();
    other["downloads"]["artifact"]["path"] = json!("example/Test/1/test-1.jar");
    assert!(libraries(&json!([lib, other]), &f.0).is_err());
}

fn asset_index() -> Value {
    json!({"objects":{"sounds/test.ogg":{"hash":"a".repeat(40),"size":123}}})
}

#[test]
fn malformed_required_assets_cannot_be_silently_omitted() {
    let f = Fixture::new();
    for v in [
        json!({}),
        json!({"objects":[]}),
        json!({"objects":{"test":{}}}),
        json!({"objects":{"test":{"hash":"aa","size":1}}}),
        json!({"objects":{"test":{"hash":"g".repeat(40),"size":1}}}),
        json!({"objects":{"test":{"hash":"a".repeat(40),"size":-1}}}),
    ] {
        assert!(assets(
            &v,
            "26",
            &f.0,
            &f.0.join("game"),
            downloader::Existing::SkipIfExists
        )
        .is_err());
    }
    assert!(assets(
        &json!({"objects":{}}),
        "26",
        &f.0,
        &f.0.join("game"),
        downloader::Existing::SkipIfExists
    )
    .unwrap()
    .downloads
    .is_empty());
}

#[test]
fn legacy_asset_layouts_are_checked_and_revalidate_cache() {
    let f = Fixture::new();
    let mut v = asset_index();
    v["virtual"] = json!(true);
    v["map_to_resources"] = json!(true);
    let p = assets(
        &v,
        "legacy",
        &f.0,
        &f.0.join("game"),
        downloader::Existing::SkipIfExists,
    )
    .unwrap();
    assert_eq!(p.downloads.len(), 1);
    assert_eq!(p.copies.len(), 2);
    assert!(p.downloads[0].existing == downloader::Existing::ReuseIfValid);
    assert!(p.copies[0]
        .destination
        .ends_with("virtual/legacy/sounds/test.ogg"));
    assert!(p.copies[1]
        .destination
        .ends_with("game/resources/sounds/test.ogg"));
}

#[test]
fn asset_names_flags_and_conflicting_hash_sizes_are_rejected() {
    let f = Fixture::new();
    for name in ["../outside", "C:\\outside", "sounds/CON.ogg"] {
        let v = json!({"objects":{name:{"hash":"a".repeat(40),"size":1}},"virtual":true});
        assert!(assets(
            &v,
            "legacy",
            &f.0,
            &f.0.join("game"),
            downloader::Existing::SkipIfExists
        )
        .is_err());
    }
    let mut v = asset_index();
    v["virtual"] = json!("true");
    assert!(assets(
        &v,
        "legacy",
        &f.0,
        &f.0.join("game"),
        downloader::Existing::SkipIfExists
    )
    .is_err());
    let v = json!({"objects":{"a":{"hash":"a".repeat(40),"size":1},"b":{"hash":"a".repeat(40),"size":2}}});
    assert!(assets(
        &v,
        "legacy",
        &f.0,
        &f.0.join("game"),
        downloader::Existing::SkipIfExists
    )
    .is_err());
}

#[test]
#[ignore = "reads public Mojang metadata; does not install or launch Minecraft"]
fn official_modern_and_legacy_metadata_build_complete_plans() {
    let f = Fixture::new();
    tauri::async_runtime::block_on(async {
        for (id, url) in [
            ("1.21.8", "https://piston-meta.mojang.com/v1/packages/403dee3925f64c7138b72a5302130829cb588784/1.21.8.json"),
            ("1.7.2", "https://piston-meta.mojang.com/v1/packages/c2e8ecbf355760a74c93d7210767fa043d53f27c/1.7.2.json"),
            ("b1.7.3", "https://piston-meta.mojang.com/v1/packages/44f6969326bd45aa00dcd3c4ca3a7c05ebb24c04/b1.7.3.json"),
        ] {
            let value = downloader::get_json(url, net::MINECRAFT_HOSTS, None).await.unwrap();
            let p = minecraft(&value, id, &f.0.join("versions"), &f.0.join("libraries"), &f.0.join("assets")).unwrap();
            assert!(!p.libraries.artifacts.is_empty());
            let (index, bytes) = downloader::get_verified_json(&p.index, None, MAX_INDEX_BYTES as usize).await.unwrap();
            assert_eq!(Some(bytes.len() as u64), p.index.size);
            let assets = assets(&index, &p.index_id, &f.0.join("assets"), &f.0.join("game"), downloader::Existing::ReuseIfValid).unwrap();
            assert!(!assets.downloads.is_empty());
            if id != "1.21.8" { assert!(!p.libraries.natives.is_empty()); assert!(!assets.copies.is_empty()); }
        }
    });
    assert_eq!(std::fs::read_dir(&f.0).unwrap().count(), 0);
}
