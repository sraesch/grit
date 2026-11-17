//! User settings, stored as JSON in the app's config directory
//! (e.g. `~/.config/io.grit.app/settings.json` on Linux).

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Folder that holds cloned repositories; the Open dialog starts here.
    /// `None` means the home folder.
    pub repos_dir: Option<String>,
    /// Open repositories are fetched in the background this often; 0 turns it off.
    pub auto_fetch_minutes: u32,
}

/// Longest automatic fetch interval: once a day.
pub const MAX_AUTO_FETCH_MINUTES: u32 = 24 * 60;

impl Default for Settings {
    fn default() -> Self {
        Settings {
            repos_dir: None,
            auto_fetch_minutes: 10,
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
    home: Option<PathBuf>,
    current: Mutex<Settings>,
}

impl SettingsStore {
    /// Reads the settings file. A missing or unreadable file gives the defaults, so a broken
    /// file never keeps the app from starting; it is replaced on the next save.
    pub fn load(path: PathBuf, home: Option<PathBuf>) -> Self {
        let current = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or_default();
        SettingsStore {
            path,
            home,
            current: Mutex::new(current),
        }
    }

    pub fn get(&self) -> Settings {
        self.current.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Validates and normalizes `settings`, writes them to disk and returns what was stored.
    pub fn update(&self, settings: Settings) -> Result<Settings, String> {
        if settings.auto_fetch_minutes > MAX_AUTO_FETCH_MINUTES {
            return Err(format!(
                "Fetch automatically at most every {MAX_AUTO_FETCH_MINUTES} minutes (once a day)"
            ));
        }
        let settings = Settings {
            repos_dir: normalize_dir(settings.repos_dir.as_deref(), self.home.as_deref())?,
            auto_fetch_minutes: settings.auto_fetch_minutes,
        };
        write_atomically(
            &self.path,
            &serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?,
        )?;
        *self.current.lock().map_err(|e| e.to_string())? = settings.clone();
        Ok(settings)
    }
}

/// Empty means "not set"; `~` expands to the home folder; anything else must be an absolute
/// path to an existing folder.
fn normalize_dir(dir: Option<&str>, home: Option<&Path>) -> Result<Option<String>, String> {
    let Some(dir) = dir.map(str::trim).filter(|d| !d.is_empty()) else {
        return Ok(None);
    };
    let path = match (dir.strip_prefix('~'), home) {
        (Some(rest), Some(home)) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
            home.join(rest.trim_start_matches(['/', '\\']))
        }
        _ => PathBuf::from(dir),
    };
    if !path.is_absolute() {
        return Err(format!("Use a full path for the repositories folder, not \"{dir}\""));
    }
    if !path.is_dir() {
        return Err(format!("The folder {} does not exist", path.display()));
    }
    // Drop trailing separators and "." parts so the stored path is tidy.
    Ok(Some(
        path.components().collect::<PathBuf>().to_string_lossy().into_owned(),
    ))
}

/// Writes through a temporary file and a rename, so a crash never leaves half a file.
fn write_atomically(path: &Path, contents: &str) -> Result<(), String> {
    let dir = path.parent().ok_or("Invalid settings path")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, contents).map_err(|e| format!("Could not save settings: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("Could not save settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A throwaway directory in the system temp dir, removed on drop.
    struct TempDir(PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("grit-settings-{}-{name}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            TempDir(dir)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn repos(dir: &str) -> Settings {
        Settings {
            repos_dir: Some(dir.to_string()),
            ..Settings::default()
        }
    }

    #[test]
    fn defaults_without_a_file_and_persists_updates() {
        let tmp = TempDir::new("roundtrip");
        let path = tmp.0.join("config/settings.json");
        let store = SettingsStore::load(path.clone(), None);
        assert_eq!(store.get(), Settings::default());

        let repos_dir = tmp.0.join("repos");
        std::fs::create_dir(&repos_dir).unwrap();
        let saved = store.update(repos(&format!("{}/", repos_dir.display()))).unwrap();
        assert_eq!(saved.repos_dir.as_deref(), Some(repos_dir.to_str().unwrap()));
        assert_eq!(store.get(), saved);

        // A new store (next app start) reads what was saved.
        assert_eq!(SettingsStore::load(path.clone(), None).get(), saved);
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"reposDir\""));

        // Clearing the field goes back to the default.
        assert_eq!(store.update(repos("  ")).unwrap(), Settings::default());
        assert_eq!(SettingsStore::load(path, None).get(), Settings::default());
    }

    #[test]
    fn falls_back_to_defaults_for_a_broken_file() {
        let tmp = TempDir::new("broken");
        let path = tmp.0.join("settings.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert_eq!(SettingsStore::load(path.clone(), None).get(), Settings::default());

        // Unknown fields from other versions are ignored rather than failing the whole file.
        std::fs::write(&path, r#"{"reposDir": "/somewhere", "future": 1}"#).unwrap();
        assert_eq!(SettingsStore::load(path, None).get(), repos("/somewhere"));
    }

    #[test]
    fn validates_the_repositories_folder() {
        let tmp = TempDir::new("validate");
        let store = SettingsStore::load(tmp.0.join("settings.json"), Some(tmp.0.clone()));
        std::fs::create_dir(tmp.0.join("code")).unwrap();
        std::fs::write(tmp.0.join("file.txt"), "x").unwrap();

        assert!(store.update(repos("relative/path")).unwrap_err().contains("full path"));
        let missing = tmp.0.join("missing");
        assert!(
            store
                .update(repos(missing.to_str().unwrap()))
                .unwrap_err()
                .contains("does not exist")
        );
        let file = tmp.0.join("file.txt");
        assert!(
            store
                .update(repos(file.to_str().unwrap()))
                .unwrap_err()
                .contains("does not exist")
        );
        // A failed update keeps the previous settings.
        assert_eq!(store.get(), Settings::default());

        let expected = tmp.0.join("code");
        assert_eq!(
            store.update(repos("~/code")).unwrap().repos_dir.as_deref(),
            expected.to_str()
        );
        assert_eq!(store.update(repos("~")).unwrap().repos_dir.as_deref(), tmp.0.to_str());
    }

    #[test]
    fn stores_the_auto_fetch_interval() {
        let tmp = TempDir::new("auto-fetch");
        let path = tmp.0.join("settings.json");
        // Files from before the setting existed fetch every 10 minutes.
        std::fs::write(&path, r#"{"reposDir": null}"#).unwrap();
        let store = SettingsStore::load(path.clone(), None);
        assert_eq!(store.get().auto_fetch_minutes, 10);

        let off = Settings {
            auto_fetch_minutes: 0,
            ..Settings::default()
        };
        assert_eq!(store.update(off.clone()).unwrap(), off);
        assert_eq!(SettingsStore::load(path, None).get(), off);

        let too_long = Settings {
            auto_fetch_minutes: MAX_AUTO_FETCH_MINUTES + 1,
            ..Settings::default()
        };
        assert!(store.update(too_long).unwrap_err().contains("once a day"));
        assert_eq!(store.get(), off);
    }
}
