use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::AppHandle;
use tauri::Manager;

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct SavedGroup {
    pub name: String,
    pub directory: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct AppSettings {
    pub saved_groups: Vec<SavedGroup>,
    pub theme: String, // "light" or "dark"
}

fn get_settings_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|p| p.join("settings.json"))
}

pub fn load_settings(app: &AppHandle) -> AppSettings {
    if let Some(path) = get_settings_path(app) {
        if path.exists() {
            if let Ok(content) = fs::read_to_string(path) {
                if let Ok(settings) = serde_json::from_str(&content) {
                    return settings;
                }
            }
        }
    }
    AppSettings::default()
}

pub fn save_settings(app: &AppHandle, settings: &AppSettings) -> Result<(), String> {
    if let Some(path) = get_settings_path(app) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let content = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
        fs::write(path, content).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("Could not determine settings path".to_string())
    }
}
