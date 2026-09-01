//! Mojang metadata rule evaluation shared by installation and launch.

use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Architecture {
    X86,
    X86_64,
    Arm,
    Aarch64,
    Other(&'static str),
}

impl Architecture {
    fn current() -> Self {
        match std::env::consts::ARCH {
            "x86" => Self::X86,
            "x86_64" => Self::X86_64,
            "arm" => Self::Arm,
            "aarch64" => Self::Aarch64,
            other => Self::Other(other),
        }
    }

    /// Java-style `os.arch` value for the target platform.
    fn rule_name(self, os_name: &str) -> &'static str {
        match self {
            Self::X86 => "x86",
            Self::X86_64 if os_name == "osx" => "x86_64",
            Self::X86_64 => "amd64",
            Self::Arm => "arm",
            Self::Aarch64 => "aarch64",
            Self::Other(name) => name,
        }
    }

    /// Mojang's `${arch}` native-classifier placeholder means process bitness.
    fn classifier_bits(self) -> &'static str {
        match self {
            Self::X86 | Self::Arm => "32",
            Self::X86_64 | Self::Aarch64 => "64",
            Self::Other(_) if cfg!(target_pointer_width = "64") => "64",
            Self::Other(_) => "32",
        }
    }
}

struct RuleContext<'a> {
    os_name: &'a str,
    os_arch: &'a str,
    os_version: Option<&'a str>,
    classifier_bits: &'a str,
    features: &'a HashMap<String, bool>,
}

impl<'a> RuleContext<'a> {
    fn current(features: &'a HashMap<String, bool>) -> Self {
        let architecture = Architecture::current();
        let os_name = os_name();
        Self {
            os_name,
            os_arch: architecture.rule_name(os_name),
            os_version: os_version(),
            classifier_bits: architecture.classifier_bits(),
            features,
        }
    }
}

pub(crate) fn os_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

fn os_version() -> Option<&'static str> {
    static VERSION: OnceLock<Option<String>> = OnceLock::new();
    VERSION.get_or_init(detect_os_version).as_deref()
}

#[cfg(target_os = "windows")]
fn detect_os_version() -> Option<String> {
    use std::mem::size_of;
    use windows_sys::Wdk::System::SystemServices::RtlGetVersion;
    use windows_sys::Win32::System::SystemInformation::OSVERSIONINFOW;

    let mut info = OSVERSIONINFOW {
        dwOSVersionInfoSize: size_of::<OSVERSIONINFOW>() as u32,
        ..Default::default()
    };
    if unsafe { RtlGetVersion(&mut info) } == 0 {
        Some(format!("{}.{}", info.dwMajorVersion, info.dwMinorVersion))
    } else {
        None
    }
}

#[cfg(target_os = "macos")]
fn detect_os_version() -> Option<String> {
    command_output("sw_vers", &["-productVersion"])
}

#[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
fn detect_os_version() -> Option<String> {
    command_output("uname", &["-r"])
}

#[cfg(not(target_os = "windows"))]
fn command_output(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn regex_matches(pattern: &str, value: &str) -> bool {
    Regex::new(pattern).is_ok_and(|regex| regex.is_match(value))
}

fn rule_matches(rule: &Value, context: &RuleContext<'_>) -> bool {
    if let Some(os) = rule.get("os").filter(|value| !value.is_null()) {
        let Some(os) = os.as_object() else {
            return false;
        };
        if let Some(name) = os.get("name").filter(|value| !value.is_null()) {
            if name.as_str() != Some(context.os_name) {
                return false;
            }
        }
        if let Some(arch) = os.get("arch").filter(|value| !value.is_null()) {
            let Some(pattern) = arch.as_str() else {
                return false;
            };
            if !regex_matches(pattern, context.os_arch) {
                return false;
            }
        }
        if let Some(version) = os.get("version").filter(|value| !value.is_null()) {
            let (Some(pattern), Some(actual)) = (version.as_str(), context.os_version) else {
                return false;
            };
            if !regex_matches(pattern, actual) {
                return false;
            }
        }
    }

    if let Some(features) = rule.get("features").filter(|value| !value.is_null()) {
        let Some(features) = features.as_object() else {
            return false;
        };
        for (name, expected) in features {
            let Some(expected) = expected.as_bool() else {
                return false;
            };
            if context.features.get(name).copied().unwrap_or(false) != expected {
                return false;
            }
        }
    }

    true
}

fn allows_with_context(rules: &[Value], context: &RuleContext<'_>) -> bool {
    if rules.is_empty() {
        return true;
    }
    let mut allowed = false;
    for rule in rules {
        if rule_matches(rule, context) {
            allowed = rule.get("action").and_then(Value::as_str) == Some("allow");
        }
    }
    allowed
}

/// Mojang semantics: no rules means allowed; otherwise the last matching rule wins.
pub(crate) fn allows(rules: &[Value], features: &HashMap<String, bool>) -> bool {
    allows_with_context(rules, &RuleContext::current(features))
}

pub(crate) fn library_allowed(library: &Value) -> bool {
    let Some(rules) = library.get("rules").and_then(Value::as_array) else {
        return true;
    };
    allows(rules, &HashMap::new())
}

pub(crate) fn native_classifier(library: &Value) -> Option<String> {
    let features = HashMap::new();
    let context = RuleContext::current(&features);
    native_classifier_with_context(library, &context)
}

fn native_classifier_with_context(library: &Value, context: &RuleContext<'_>) -> Option<String> {
    let template = library.get("natives")?.get(context.os_name)?.as_str()?;
    Some(template.replace("${arch}", context.classifier_bits))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn context<'a>(
        os_name: &'a str,
        os_arch: &'a str,
        os_version: &'a str,
        classifier_bits: &'a str,
        features: &'a HashMap<String, bool>,
    ) -> RuleContext<'a> {
        RuleContext {
            os_name,
            os_arch,
            os_version: Some(os_version),
            classifier_bits,
            features,
        }
    }

    #[test]
    fn evaluates_name_architecture_version_and_order() {
        let features = HashMap::new();
        let windows_x64 = context("windows", "amd64", "10.0.26100", "64", &features);
        let rules = json!([
            { "action": "allow", "os": { "name": "windows", "arch": "^amd64$", "version": "^10\\." } },
            { "action": "disallow", "os": { "arch": "^x86$" } }
        ]);
        assert!(allows_with_context(rules.as_array().unwrap(), &windows_x64));

        let windows_x86 = context("windows", "x86", "10.0.19045", "32", &features);
        assert!(!allows_with_context(
            rules.as_array().unwrap(),
            &windows_x86
        ));

        let override_rules = json!([
            { "action": "disallow", "os": { "name": "windows" } },
            { "action": "allow", "os": { "name": "windows" } }
        ]);
        assert!(allows_with_context(
            override_rules.as_array().unwrap(),
            &windows_x64
        ));
    }

    #[test]
    fn evaluates_launcher_features_and_rejects_invalid_regex() {
        let features = HashMap::from([
            ("has_custom_resolution".to_string(), true),
            ("is_quick_play_multiplayer".to_string(), true),
        ]);
        let linux_arm64 = context("linux", "aarch64", "6.8.0", "64", &features);
        let matching = json!([{
            "action": "allow",
            "os": { "name": "linux", "arch": "^aarch64$" },
            "features": { "has_custom_resolution": true, "is_demo_user": false }
        }]);
        assert!(allows_with_context(
            matching.as_array().unwrap(),
            &linux_arm64
        ));

        let invalid = json!([{ "action": "allow", "os": { "arch": "[" } }]);
        assert!(!allows_with_context(
            invalid.as_array().unwrap(),
            &linux_arm64
        ));
    }

    #[test]
    fn resolves_x64_and_arm64_native_classifiers() {
        let features = HashMap::new();
        let x64 = context("windows", "amd64", "10.0.26100", "64", &features);
        let templated = json!({ "natives": { "windows": "natives-windows-${arch}" } });
        assert_eq!(
            native_classifier_with_context(&templated, &x64).as_deref(),
            Some("natives-windows-64")
        );

        let arm64 = context("windows", "aarch64", "10.0.26100", "64", &features);
        let explicit = json!({ "natives": { "windows": "natives-windows-arm64" } });
        assert_eq!(
            native_classifier_with_context(&explicit, &arm64).as_deref(),
            Some("natives-windows-arm64")
        );
    }
}
