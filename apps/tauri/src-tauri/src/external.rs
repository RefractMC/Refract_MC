//! External launcher discovery/import, ported from `external-launchers.ts` and
//! `multimc-import.ts`.

use crate::instances;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalInstance {
    source: String,
    source_name: String,
    name: String,
    minecraft_version: String,
    mod_loader: Option<String>,
    mod_loader_version: Option<String>,
    instance_dir: String,
    game_dir: String,
}

fn appdata() -> PathBuf {
    std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("USERPROFILE")
                .map(|p| PathBuf::from(p).join("AppData").join("Roaming"))
        })
        .or_else(dirs::config_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn try_read_json(path: impl AsRef<Path>) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn try_read_text(path: impl AsRef<Path>) -> Option<String> {
    fs::read_to_string(path).ok()
}

fn basename(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "Instance".into())
}

fn parse_ini(text: &str) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        if line.starts_with('[') {
            continue;
        }
        out.insert(k.trim().to_string(), v.trim().to_string());
    }
    out
}

fn subdirs(dir: impl AsRef<Path>) -> Vec<PathBuf> {
    fs::read_dir(dir)
        .ok()
        .into_iter()
        .flat_map(|rd| rd.flatten())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect()
}

fn loader_name(raw: Option<&str>) -> Option<String> {
    match raw?.to_ascii_lowercase().as_str() {
        "forge" | "neoforge" | "fabric" | "quilt" => Some(raw.unwrap().to_ascii_lowercase()),
        _ => None,
    }
}

fn detect_mmc_loader(components: &[Value]) -> (Option<String>, Option<String>) {
    for c in components {
        let uid = c.get("uid").and_then(Value::as_str).unwrap_or_default();
        let version = c.get("version").and_then(Value::as_str).map(str::to_string);
        match uid {
            "net.minecraftforge" => return (Some("forge".into()), version),
            "net.neoforged.neoforge" => return (Some("neoforge".into()), version),
            "net.fabricmc.fabric-loader" => return (Some("fabric".into()), version),
            "org.quiltmc.quilt-loader" => return (Some("quilt".into()), version),
            _ => {}
        }
    }
    (None, None)
}

fn parse_mmc_instance(
    instance_dir: &Path,
    source: &str,
    source_name: &str,
) -> Option<ExternalInstance> {
    let cfg_path = instance_dir.join("instance.cfg");
    let pack_path = instance_dir.join("mmc-pack.json");
    if !cfg_path.exists() || !pack_path.exists() {
        return None;
    }

    let cfg = parse_ini(&try_read_text(cfg_path).unwrap_or_default());
    let pack = try_read_json(pack_path)?;
    let components = pack.get("components")?.as_array()?;
    let mc = components
        .iter()
        .find(|c| c.get("uid").and_then(Value::as_str) == Some("net.minecraft"))?
        .get("version")?
        .as_str()?
        .to_string();
    let (mod_loader, mod_loader_version) = detect_mmc_loader(components);
    let dot_mc = instance_dir.join(".minecraft");
    let game_dir = if dot_mc.exists() {
        dot_mc
    } else {
        instance_dir.join("minecraft")
    };

    Some(ExternalInstance {
        source: source.into(),
        source_name: source_name.into(),
        name: cfg
            .get("name")
            .cloned()
            .unwrap_or_else(|| basename(instance_dir)),
        minecraft_version: mc,
        mod_loader,
        mod_loader_version,
        instance_dir: instance_dir.to_string_lossy().to_string(),
        game_dir: game_dir.to_string_lossy().to_string(),
    })
}

fn scan_mmc(base_dir: PathBuf, source: &str, source_name: &str) -> Vec<ExternalInstance> {
    subdirs(base_dir)
        .into_iter()
        .filter_map(|p| parse_mmc_instance(&p, source, source_name))
        .collect()
}

fn scan_mmc_folder(root: &Path) -> Vec<ExternalInstance> {
    let mut out = Vec::new();
    for (base, source, source_name) in [
        (root.to_path_buf(), "multimc", "MultiMC / Prism"),
        (root.join("instances"), "multimc", "MultiMC / Prism"),
        (
            root.join("PrismLauncher").join("instances"),
            "prism",
            "Prism Launcher",
        ),
        (root.join("MultiMC").join("instances"), "multimc", "MultiMC"),
    ] {
        if let Some(ext) = parse_mmc_instance(&base, source, source_name) {
            out.push(ext);
        }
        out.extend(scan_mmc(base, source, source_name));
    }
    out
}

fn parse_modrinth_instance(instance_dir: &Path) -> Option<ExternalInstance> {
    let p = try_read_json(instance_dir.join("profile.json"))?;
    let meta = p.get("metadata").unwrap_or(&p);
    let mc = meta.get("game_version").and_then(Value::as_str)?;
    Some(ExternalInstance {
        source: "modrinth".into(),
        source_name: "Modrinth App".into(),
        name: meta
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| basename(instance_dir)),
        minecraft_version: mc.into(),
        mod_loader: loader_name(meta.get("loader").and_then(Value::as_str)),
        mod_loader_version: meta
            .get("loader_version")
            .and_then(Value::as_str)
            .map(str::to_string),
        instance_dir: instance_dir.to_string_lossy().to_string(),
        game_dir: instance_dir.to_string_lossy().to_string(),
    })
}

fn scan_modrinth_profiles(profiles_dir: PathBuf) -> Vec<ExternalInstance> {
    subdirs(profiles_dir)
        .into_iter()
        .filter_map(|instance_dir| parse_modrinth_instance(&instance_dir))
        .collect()
}

fn scan_modrinth(ad: &Path) -> Vec<ExternalInstance> {
    scan_modrinth_profiles(ad.join("com.modrinth.theseus").join("profiles"))
}

fn scan_modrinth_folder(root: &Path) -> Vec<ExternalInstance> {
    let mut out = Vec::new();
    if let Some(ext) = parse_modrinth_instance(root) {
        out.push(ext);
    }
    for base in [
        root.to_path_buf(),
        root.join("profiles"),
        root.join("com.modrinth.theseus").join("profiles"),
    ] {
        out.extend(scan_modrinth_profiles(base));
    }
    out
}

fn atl_loader_name(raw: Option<&Value>) -> Option<String> {
    let s = match raw? {
        Value::String(s) => s.to_ascii_lowercase(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    match s.as_str() {
        "fabric" | "4" => Some("fabric".into()),
        "forge" | "1" => Some("forge".into()),
        "quilt" | "5" => Some("quilt".into()),
        "neoforge" | "6" => Some("neoforge".into()),
        _ => None,
    }
}

fn parse_atlauncher_instance(instance_dir: &Path) -> Option<ExternalInstance> {
    let p = try_read_json(instance_dir.join("instance.json"))?;
    let l = p.get("launcher").unwrap_or(&Value::Null);
    let mc = l
        .get("minecraftVersion")
        .or_else(|| p.get("minecraftVersion"))
        .and_then(Value::as_str)?;
    let loader = l.get("loaderVersion").unwrap_or(&Value::Null);
    Some(ExternalInstance {
        source: "atlauncher".into(),
        source_name: "ATLauncher".into(),
        name: l
            .get("name")
            .or_else(|| p.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| basename(instance_dir)),
        minecraft_version: mc.into(),
        mod_loader: atl_loader_name(loader.get("type")),
        mod_loader_version: loader
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
        instance_dir: instance_dir.to_string_lossy().to_string(),
        game_dir: instance_dir
            .join(".minecraft")
            .to_string_lossy()
            .to_string(),
    })
}

fn scan_atlauncher_instances(instances_dir: PathBuf) -> Vec<ExternalInstance> {
    subdirs(instances_dir)
        .into_iter()
        .filter_map(|instance_dir| parse_atlauncher_instance(&instance_dir))
        .collect()
}

fn scan_atlauncher(ad: &Path) -> Vec<ExternalInstance> {
    scan_atlauncher_instances(ad.join("ATLauncher").join("instances"))
}

fn scan_atlauncher_folder(root: &Path) -> Vec<ExternalInstance> {
    let mut out = Vec::new();
    if let Some(ext) = parse_atlauncher_instance(root) {
        out.push(ext);
    }
    for base in [
        root.to_path_buf(),
        root.join("instances"),
        root.join("ATLauncher").join("instances"),
    ] {
        out.extend(scan_atlauncher_instances(base));
    }
    out
}

fn cf_loader_name(type_id: Option<i64>, name: Option<&str>) -> Option<String> {
    match type_id {
        Some(1) => return Some("forge".into()),
        Some(4) => return Some("fabric".into()),
        Some(5) => return Some("quilt".into()),
        Some(6) => return Some("neoforge".into()),
        _ => {}
    }
    let l = name?.to_ascii_lowercase();
    if l.contains("neoforge") {
        Some("neoforge".into())
    } else if l.contains("forge") {
        Some("forge".into())
    } else if l.contains("fabric") {
        Some("fabric".into())
    } else if l.contains("quilt") {
        Some("quilt".into())
    } else {
        None
    }
}

fn cf_loader_version(name: Option<&str>) -> Option<String> {
    for part in name?.split('-') {
        if part.chars().next().is_some_and(|c| c.is_ascii_digit()) && part.contains('.') {
            return Some(part.to_string());
        }
    }
    None
}

fn parse_curseforge_instance(instance_dir: &Path) -> Option<ExternalInstance> {
    let p = try_read_json(instance_dir.join("minecraftinstance.json"))?;
    let mc = p.get("gameVersion").and_then(Value::as_str)?;
    let loader = p.get("baseModLoader").unwrap_or(&Value::Null);
    let loader_name = loader.get("name").and_then(Value::as_str);
    Some(ExternalInstance {
        source: "curseforge".into(),
        source_name: "CurseForge".into(),
        name: p
            .get("name")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| basename(instance_dir)),
        minecraft_version: mc.into(),
        mod_loader: cf_loader_name(loader.get("type").and_then(Value::as_i64), loader_name),
        mod_loader_version: cf_loader_version(loader_name),
        instance_dir: instance_dir.to_string_lossy().to_string(),
        game_dir: instance_dir.to_string_lossy().to_string(),
    })
}

fn scan_curseforge_instances(instances_dir: PathBuf) -> Vec<ExternalInstance> {
    subdirs(instances_dir)
        .into_iter()
        .filter_map(|instance_dir| parse_curseforge_instance(&instance_dir))
        .collect()
}

fn scan_curseforge() -> Vec<ExternalInstance> {
    let h = home();
    [
        h.join("curseforge").join("minecraft").join("Instances"),
        h.join("Documents")
            .join("curseforge")
            .join("minecraft")
            .join("Instances"),
        PathBuf::from(r"C:\curseforge\minecraft\Instances"),
    ]
    .into_iter()
    .flat_map(scan_curseforge_instances)
    .collect()
}

fn scan_curseforge_folder(root: &Path) -> Vec<ExternalInstance> {
    let mut out = Vec::new();
    if let Some(ext) = parse_curseforge_instance(root) {
        out.push(ext);
    }
    for base in [
        root.to_path_buf(),
        root.join("Instances"),
        root.join("curseforge").join("minecraft").join("Instances"),
        root.join("minecraft").join("Instances"),
    ] {
        out.extend(scan_curseforge_instances(base));
    }
    out
}

fn parse_gdlauncher_instance(instance_dir: &Path) -> Option<ExternalInstance> {
    let p = try_read_json(instance_dir.join("instance.json"))?;
    let cfg = p.get("config").unwrap_or(&p);
    let mc = cfg.get("version").and_then(Value::as_str)?;
    let loader = cfg.get("loader").unwrap_or(&Value::Null);
    Some(ExternalInstance {
        source: "gdlauncher".into(),
        source_name: "GDLauncher".into(),
        name: cfg
            .get("name")
            .or_else(|| p.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| basename(instance_dir)),
        minecraft_version: mc.into(),
        mod_loader: loader_name(loader.get("type").and_then(Value::as_str)),
        mod_loader_version: loader
            .get("version")
            .and_then(Value::as_str)
            .map(str::to_string),
        instance_dir: instance_dir.to_string_lossy().to_string(),
        game_dir: instance_dir
            .join(".minecraft")
            .to_string_lossy()
            .to_string(),
    })
}

fn scan_gdlauncher_instances(instances_dir: PathBuf) -> Vec<ExternalInstance> {
    subdirs(instances_dir)
        .into_iter()
        .filter_map(|instance_dir| parse_gdlauncher_instance(&instance_dir))
        .collect()
}

fn scan_gdlauncher(ad: &Path) -> Vec<ExternalInstance> {
    scan_gdlauncher_instances(ad.join("gdlauncher_carbon").join("instances"))
}

fn scan_gdlauncher_folder(root: &Path) -> Vec<ExternalInstance> {
    let mut out = Vec::new();
    if let Some(ext) = parse_gdlauncher_instance(root) {
        out.push(ext);
    }
    for base in [
        root.to_path_buf(),
        root.join("instances"),
        root.join("gdlauncher_carbon").join("instances"),
    ] {
        out.extend(scan_gdlauncher_instances(base));
    }
    out
}

fn dedupe_instances(instances: Vec<ExternalInstance>) -> Vec<ExternalInstance> {
    let mut seen = std::collections::HashSet::new();
    instances
        .into_iter()
        .filter(|ext| seen.insert(ext.instance_dir.clone()))
        .collect()
}

#[tauri::command]
pub fn scan_external_instances() -> Vec<ExternalInstance> {
    let ad = appdata();
    let mut out = Vec::new();
    out.extend(scan_mmc(
        ad.join("PrismLauncher").join("instances"),
        "prism",
        "Prism Launcher",
    ));
    out.extend(scan_mmc(
        ad.join("MultiMC").join("instances"),
        "multimc",
        "MultiMC",
    ));
    out.extend(scan_modrinth(&ad));
    out.extend(scan_atlauncher(&ad));
    out.extend(scan_curseforge());
    out.extend(scan_gdlauncher(&ad));
    dedupe_instances(out)
}

#[tauri::command]
pub fn scan_external_folder(folder: String) -> Vec<ExternalInstance> {
    let root = PathBuf::from(folder);
    if !root.is_dir() {
        return vec![];
    }
    let mut out = Vec::new();
    out.extend(scan_mmc_folder(&root));
    out.extend(scan_modrinth_folder(&root));
    out.extend(scan_atlauncher_folder(&root));
    out.extend(scan_curseforge_folder(&root));
    out.extend(scan_gdlauncher_folder(&root));
    dedupe_instances(out)
}

fn input_from_external(ext: &ExternalInstance, imported: bool) -> Value {
    let mut input = json!({
        "name": ext.name,
        "minecraftVersion": ext.minecraft_version,
        "memoryMb": 2048,
    });
    if let Some(loader) = &ext.mod_loader {
        input["modLoader"] = json!(loader);
    }
    if let Some(version) = &ext.mod_loader_version {
        input["modLoaderVersion"] = json!(version);
    }
    if imported {
        input["groupId"] = json!("Imported");
    } else {
        input["externalGameDir"] = json!(ext.game_dir);
        input["externalSource"] = json!(ext.source_name);
    }
    input
}

fn copy_dir_contents(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            let _ = copy_dir_contents(&from, &to);
        } else {
            let _ = fs::copy(&from, &to);
        }
    }
    Ok(())
}

fn copy_game_dirs(src_game_dir: &Path, dest_game_dir: &Path) {
    for dir in [
        "mods",
        "resourcepacks",
        "shaderpacks",
        "config",
        "saves",
        "datapacks",
    ] {
        let src = src_game_dir.join(dir);
        if !src.exists() {
            continue;
        }
        let _ = copy_dir_contents(&src, &dest_game_dir.join(dir));
    }
}

#[tauri::command]
pub fn link_external_instance(ext: ExternalInstance) -> Result<Value, String> {
    instances::create_instance(input_from_external(&ext, false))
}

#[tauri::command]
pub fn import_external_instance(ext: ExternalInstance) -> Result<Value, String> {
    let instance = instances::create_instance(input_from_external(&ext, true))?;
    let id = instance
        .get("id")
        .and_then(Value::as_str)
        .ok_or("created instance has no id")?;
    let dest = instances::resolve_instance_dir(id).join("minecraft");
    copy_game_dirs(Path::new(&ext.game_dir), &dest);
    Ok(instance)
}

#[tauri::command]
pub fn import_multimc_instance(instance_folder: String) -> Result<Value, String> {
    let folder = PathBuf::from(instance_folder);
    let ext = parse_mmc_instance(&folder, "multimc", "MultiMC / Prism").ok_or_else(|| {
        "Not a valid MultiMC/Prism instance folder (missing instance.cfg or mmc-pack.json)"
            .to_string()
    })?;
    import_external_instance(ext)
}
