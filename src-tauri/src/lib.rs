mod resx;
mod settings;

use std::path::Path;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use walkdir::WalkDir;
use serde::{Deserialize, Serialize};
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, Manager};
use settings::AppSettings;

struct WatcherState {
    watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
struct ResxFile {
    path: String,
    lang: String, // "default" or "en-US"
}

#[derive(Serialize)]
struct ResxGroup {
    name: String,
    directory: String,
    files: Vec<ResxFile>,
}

#[derive(Serialize)]
struct RowData {
    key: String,
    values: HashMap<String, String>, // Lang -> Value
}

#[tauri::command]
fn scan_directory(path: &str) -> Vec<ResxGroup> {
    let mut groups: HashMap<String, ResxGroup> = HashMap::new();

    for entry in WalkDir::new(path).into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("resx") {
            let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            let parent = path.parent().unwrap_or(Path::new("")).to_string_lossy().to_string();
            
            // Heuristic: Split by dot. Last part is lang if short, else default.
            let parts: Vec<&str> = file_stem.split('.').collect();
            let (group_name, lang) = if parts.len() > 1 {
                 let potential_lang = parts.last().unwrap();
                 // Valid lang codes are usually 2-3 chars or 5 chars (en, en-US)
                 // Some are longer "zh-Hans", "az-Latn-AZ"
                 if potential_lang.len() <= 10 && potential_lang.chars().next().unwrap_or(' ').is_ascii_alphabetic() {
                     (parts[..parts.len()-1].join("."), potential_lang.to_string())
                 } else {
                     (file_stem.to_string(), "default".to_string())
                 }
            } else {
                (file_stem.to_string(), "default".to_string())
            };

            let group_key = format!("{}::{}", parent, group_name);

            groups.entry(group_key.clone()).or_insert(ResxGroup {
                name: group_name,
                directory: parent.clone(),
                files: Vec::new(),
            }).files.push(ResxFile {
                path: path.to_string_lossy().to_string(),
                lang,
            });
        }
    }
    
    // Sort files in groups: default first, then alphabetical
    for group in groups.values_mut() {
        group.files.sort_by(|a, b| {
            if a.lang == "default" { std::cmp::Ordering::Less }
            else if b.lang == "default" { std::cmp::Ordering::Greater }
            else { a.lang.cmp(&b.lang) }
        });
    }

    let mut result: Vec<ResxGroup> = groups.into_values().collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));
    result
}

#[tauri::command]
fn load_group(files: Vec<ResxFile>) -> Result<Vec<RowData>, String> {
    let mut key_map: HashMap<String, HashMap<String, String>> = HashMap::new();
    let mut all_keys: HashSet<String> = HashSet::new();

    for file in files {
        // We ignore errors for individual files to show partial data, or we could fail.
        // Let's log error and continue.
        if let Ok(parsed) = resx::parse_resx(Path::new(&file.path)) {
            for (k, v) in parsed {
                all_keys.insert(k.clone());
                key_map.entry(k).or_default().insert(file.lang.clone(), v);
            }
        }
    }

    let mut rows = Vec::new();
    for key in all_keys {
        let values = key_map.remove(&key).unwrap_or_default();
        rows.push(RowData { key, values });
    }
    
    rows.sort_by(|a, b| a.key.cmp(&b.key));
    Ok(rows)
}

#[tauri::command]
fn update_resource(path: &str, key: &str, value: &str) -> Result<(), String> {
    resx::update_resx_key(Path::new(path), key, value).map_err(|e| e.to_string())
}

#[tauri::command]
fn add_key(path: &str, key: &str) -> Result<(), String> {
    // Adds key with empty value
    resx::add_resx_key(Path::new(path), key, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_key(path: &str, key: &str) -> Result<usize, String> {
    resx::remove_resx_key(Path::new(path), key).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct BatchInsertItem {
    key: String,
    value: String,
    index: usize,
}

#[tauri::command]
fn insert_key(path: &str, key: &str, value: &str, index: usize) -> Result<(), String> {
    resx::insert_resx_key(Path::new(path), key, value, index).map_err(|e| e.to_string())
}

#[tauri::command]
fn batch_insert_keys(path: &str, items: Vec<BatchInsertItem>) -> Result<(), String> {
    let items: Vec<resx::ResxInsert> = items.into_iter().map(|i| resx::ResxInsert {
        key: i.key,
        value: i.value,
        index: i.index,
    }).collect();
    resx::insert_resx_keys(Path::new(path), items).map_err(|e| e.to_string())
}

#[tauri::command]
fn batch_remove_keys(path: &str, keys: Vec<String>) -> Result<HashMap<String, usize>, String> {
    let key_set: HashSet<String> = keys.into_iter().collect();
    resx::remove_resx_keys(Path::new(path), &key_set).map_err(|e| e.to_string())
}

#[tauri::command]
fn batch_update_resources(path: &str, updates: HashMap<String, String>) -> Result<(), String> {
    resx::update_resx_keys(Path::new(path), &updates).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_key(path: &str, old_key: &str, new_key: &str) -> Result<(), String> {
    resx::rename_resx_key(Path::new(path), old_key, new_key).map_err(|e| e.to_string())
}

#[tauri::command]
fn watch_group(app: AppHandle, directory: String) -> Result<(), String> {
    let state = app.state::<WatcherState>();
    let mut watcher_guard = state.watcher.lock().map_err(|e| e.to_string())?;

    let app_handle = app.clone();
    let mut watcher = RecommendedWatcher::new(move |res: Result<notify::Event, notify::Error>| {
        match res {
           Ok(event) => {
               let is_resx = event.paths.iter().any(|p| p.extension().and_then(|s| s.to_str()) == Some("resx"));
               if is_resx {
                   let _ = app_handle.emit("resx-changed", ());
               }
           },
           Err(e) => println!("watch error: {:?}", e),
        }
    }, Config::default()).map_err(|e| e.to_string())?;

    watcher.watch(Path::new(&directory), RecursiveMode::NonRecursive).map_err(|e| e.to_string())?;
    
    *watcher_guard = Some(watcher);
    Ok(())
}

#[tauri::command]
fn get_app_settings(app: AppHandle) -> AppSettings {
    settings::load_settings(&app)
}

#[tauri::command]
fn save_app_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    settings::save_settings(&app, &settings)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(WatcherState { watcher: Mutex::new(None) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan_directory,
            load_group,
            update_resource,
            add_key,
            insert_key,
            batch_insert_keys,
            remove_key,
            batch_remove_keys,
            batch_update_resources,
            rename_key,
            watch_group,
            get_app_settings,
            save_app_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running EasyResX");
}