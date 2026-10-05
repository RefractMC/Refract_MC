use super::*;
use serde_json::json;

struct Fixture(PathBuf);

impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("refract-import-plan-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Self(root)
    }

    fn json(&self, name: &str, value: &Value) {
        fs::write(self.0.join(name), serde_json::to_vec(value).unwrap()).unwrap();
    }

    fn inspect(&self, selected: Option<&str>) -> Result<Plan, String> {
        let staged = self.0.join("unpublished/minecraft");
        let result = inspect(&self.0, Path::new("pack.zip"), &staged, selected);
        assert!(!staged.exists(), "planning must not copy or publish files");
        result
    }

    fn error(&self, expected: &str) {
        let error = match self.inspect(Some("1.21.1")) {
            Ok(_) => panic!("invalid recognized metadata became an import plan"),
            Err(error) => error,
        };
        assert!(error.contains(expected), "{error}");
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

fn mrpack() -> Value {
    json!({ "formatVersion": 1, "game": "minecraft", "name": "Empty pack", "dependencies": { "minecraft": "1.20.1" }, "files": [] })
}

fn curseforge() -> Value {
    json!({ "manifestVersion": 1, "manifestType": "minecraftModpack", "minecraft": { "version": "1.7.10" }, "files": [] })
}

#[test]
fn corrupt_recognized_json_cannot_fall_back_even_with_explicit_version() {
    for marker in ["modrinth.index.json", "manifest.json", "instance.json"] {
        let fixture = Fixture::new();
        fs::write(fixture.0.join(marker), b"{").unwrap();
        fixture.error(marker);
        assert_eq!(fs::read(fixture.0.join(marker)).unwrap(), b"{");
    }
}

#[test]
fn conflicting_markers_and_incomplete_prism_exports_fail_before_publication() {
    let fixture = Fixture::new();
    fixture.json("modrinth.index.json", &mrpack());
    fixture.json("manifest.json", &curseforge());
    fixture.error("conflicting");
    fs::remove_file(fixture.0.join("modrinth.index.json")).unwrap();
    fs::remove_file(fixture.0.join("manifest.json")).unwrap();
    fs::write(fixture.0.join("instance.cfg"), "name=Incomplete").unwrap();
    fixture.error("mmc-pack.json");
}

#[test]
fn missing_mrpack_marker_is_not_a_plain_zip() {
    let fixture = Fixture::new();
    let result = inspect(
        &fixture.0,
        Path::new("pack.MRPACK"),
        &fixture.0.join("stage"),
        None,
    );
    assert!(matches!(result, Err(error) if error.contains("missing modrinth.index.json")));
}

#[test]
fn valid_empty_modrinth_and_historical_curseforge_packs_keep_declared_versions() {
    for (marker, value, expected) in [
        ("modrinth.index.json", mrpack(), "1.20.1"),
        ("manifest.json", curseforge(), "1.7.10"),
    ] {
        let fixture = Fixture::new();
        fixture.json(marker, &value);
        let plan = fixture.inspect(Some("1.21.1")).unwrap();
        assert_eq!(plan.minecraft.as_deref(), Some(expected));
        assert!(plan.loader.is_none());
    }
}

#[test]
fn missing_versions_and_malformed_required_file_lists_are_errors() {
    for files in [Value::Null, json!({}), json!("not-files"), json!([{}])] {
        let fixture = Fixture::new();
        let mut manifest = curseforge();
        manifest["files"] = files;
        fixture.json("manifest.json", &manifest);
        fixture.error("file");
    }
    for (marker, mut value, field) in [
        ("modrinth.index.json", mrpack(), "dependencies"),
        ("manifest.json", curseforge(), "minecraft"),
    ] {
        let fixture = Fixture::new();
        value[field] = json!({});
        fixture.json(marker, &value);
        fixture.error("version");
    }
}

#[test]
fn unsupported_formats_dependencies_and_ambiguous_loaders_are_rejected() {
    for change in [
        json!({ "formatVersion": 2 }),
        json!({ "game": "another-game" }),
        json!({ "dependencies": { "minecraft": "1.20.1", "unknown-loader": "1" } }),
        json!({ "dependencies": { "minecraft": "1.20.1", "fabric-loader": "0.16.0", "quilt-loader": "0.27.0" } }),
    ] {
        let fixture = Fixture::new();
        let mut value = mrpack();
        for (key, field) in change.as_object().unwrap() {
            value[key] = field.clone();
        }
        fixture.json("modrinth.index.json", &value);
        assert!(fixture.inspect(None).is_err());
    }
    let fixture = Fixture::new();
    let mut cf = curseforge();
    cf["minecraft"]["modLoaders"] = json!([{ "id": "forge-10.13.4.1614", "primary": true }, { "id": "fabric-0.16.0", "primary": true }]);
    fixture.json("manifest.json", &cf);
    fixture.error("ambiguous");
}

#[test]
fn curseforge_ids_and_override_paths_are_checked_before_network_work() {
    let fixture = Fixture::new();
    let mut cf = curseforge();
    cf["files"] = json!([{ "projectID": 1, "fileID": u64::MAX }]);
    fixture.json("manifest.json", &cf);
    fixture.error("identifiers");
    cf["files"] = json!([]);
    cf["overrides"] = json!("../outside");
    fixture.json("manifest.json", &cf);
    assert!(fixture.inspect(None).is_err());
    cf["overrides"] = json!(7);
    fixture.json("manifest.json", &cf);
    fixture.error("overrides");
}

#[test]
fn modrinth_files_require_usable_hash_size_and_environment_metadata() {
    let fixture = Fixture::new();
    let good = json!({ "path": "mods/a.jar", "downloads": ["https://cdn.modrinth.com/a.jar"], "hashes": { "sha1": "a".repeat(40), "sha512": "b".repeat(128) }, "fileSize": 10 });
    let mut pack = mrpack();
    pack["files"] = json!([good.clone()]);
    fixture.json("modrinth.index.json", &pack);
    assert!(fixture.inspect(None).is_ok());
    for (key, invalid) in [
        ("hashes", json!({})),
        ("fileSize", json!(-1)),
        ("env", json!({ "client": "sometimes" })),
    ] {
        let mut file = good.clone();
        file[key] = invalid;
        pack["files"] = json!([good.clone(), file]);
        fixture.json("modrinth.index.json", &pack);
        assert!(fixture.inspect(None).is_err());
    }
}

#[test]
fn refract_exports_preserve_legacy_optional_loader_versions() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("minecraft")).unwrap();
    fixture.json(
        "instance.json",
        &json!({ "name": "Old export", "minecraftVersion": "b1.7.3", "modLoader": "fabric" }),
    );
    let plan = fixture.inspect(None).unwrap();
    assert_eq!(plan.minecraft.as_deref(), Some("b1.7.3"));
    assert_eq!(plan.loader.as_deref(), Some("fabric"));
    assert!(plan.loader_version.is_none());
    fixture.json(
        "instance.json",
        &json!({ "minecraftVersion": "../../outside" }),
    );
    fixture.error("unsafe version");
}

#[test]
fn prism_exports_keep_exact_components_and_reject_unsupported_ones() {
    let fixture = Fixture::new();
    fs::write(
        fixture.0.join("instance.cfg"),
        "[General]\nname=Prism fixture\n",
    )
    .unwrap();
    fs::create_dir(fixture.0.join(".minecraft")).unwrap();
    let mut pack = json!({ "formatVersion": 1, "components": [{ "uid": "net.minecraft", "version": "1.21.1" }, { "uid": "org.lwjgl3", "version": "3.3.3" }, { "uid": "net.fabricmc.fabric-loader", "version": "0.16.0" }] });
    fixture.json("mmc-pack.json", &pack);
    let plan = fixture.inspect(None).unwrap();
    assert_eq!(plan.name.as_deref(), Some("Prism fixture"));
    assert_eq!(plan.loader_version.as_deref(), Some("0.16.0"));
    pack["components"][0]["version"] = Value::Null;
    fixture.json("mmc-pack.json", &pack);
    fixture.error("net.minecraft.version");
    pack["components"][0] = json!({ "uid": "custom.component", "version": "1" });
    fixture.json("mmc-pack.json", &pack);
    fixture.error("unsupported component");
}

#[test]
fn plain_archives_wait_for_an_explicit_version_without_guessing() {
    let fixture = Fixture::new();
    fs::create_dir(fixture.0.join("saves")).unwrap();
    fs::create_dir(fixture.0.join("mods")).unwrap();
    let plan = fixture.inspect(None).unwrap();
    assert!(plan.minecraft.is_none());
    assert_eq!(
        fixture
            .inspect(Some("1.7.10"))
            .unwrap()
            .minecraft
            .as_deref(),
        Some("1.7.10")
    );
    assert!(fixture.inspect(Some("../outside")).is_err());
    assert_eq!(
        serde_json::to_value(Outcome::NeedsVersion).unwrap(),
        json!({ "status": "needsVersion" })
    );
    assert_eq!(
        serde_json::to_value(Outcome::Installed {
            id: "fixture-id".into()
        })
        .unwrap(),
        json!({ "status": "installed", "id": "fixture-id" })
    );
}

#[test]
fn oversized_or_non_utf8_metadata_fails_without_a_fallback() {
    let fixture = Fixture::new();
    fs::write(fixture.0.join("manifest.json"), [0xff]).unwrap();
    fixture.error("UTF-8");
    fs::write(
        fixture.0.join("manifest.json"),
        vec![b' '; MAX_METADATA_BYTES as usize + 1],
    )
    .unwrap();
    fixture.error("size limit");
}
