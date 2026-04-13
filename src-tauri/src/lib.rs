mod forja;
mod inventory;
mod ocr;
mod theme;

use std::{
    collections::{HashMap, HashSet},
    fs,
    fs::File,
    io::{BufRead, BufReader, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    process::Command,
    str::FromStr,
    sync::{LazyLock, OnceLock},
    thread,
    time::{Duration, Instant},
};

use image::DynamicImage;
use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewWindow,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use xcap::Window as CaptureWindow;

const REWARD_FILE: &str = "/tmp/wfhub_reward.json";
const ITEM_SEARCH_FILE: &str = "/tmp/wfhub_item_search.json";
const ITEM_SCREEN_PATH: &str = "/tmp/wfhub_item_screen.png";
fn get_log_path() -> PathBuf {
    let config_path = project_root().join("data").join("config.json");
    if let Ok(content) = fs::read_to_string(&config_path) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(p) = v["log_path"].as_str() {
                if !p.is_empty() {
                    return PathBuf::from(p);
                }
            }
        }
    }
    PathBuf::new()
}
const WARFRAME_WINDOW_NAME: &str = "Warframe";
const BUILD_IMAGE_PATH: &str = "/tmp/wfhub_build_input.png";
const RIVEN_IMAGE_PATH: &str = "/tmp/wfhub_riven_input.png";
const MARKET_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const HUB_STATE_FILE: &str = "hub_state.json";
const DEFAULT_HUB_REFRESH_SECONDS: u64 = 60;
const MIN_HUB_REFRESH_SECONDS: u64 = 15;
const MAX_HUB_REFRESH_SECONDS: u64 = 600;
const MAX_SAVED_BUILDS: usize = 20;

static HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent(MARKET_USER_AGENT)
        .build()
        .expect("failed to build shared HTTP client")
});
static ITEMS_LIST_CACHE: OnceLock<String> = OnceLock::new();
static MODS_ALL_CACHE: OnceLock<String> = OnceLock::new();
static PRICES_CACHE: OnceLock<String> = OnceLock::new();
static ENEMY_MOD_TABLES_CACHE: OnceLock<String> = OnceLock::new();
static MOD_NAMES_CACHE: OnceLock<String> = OnceLock::new();
static ITEM_RARITIES_CACHE: OnceLock<String> = OnceLock::new();
static MOD_LOCATIONS_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static ENEMY_MOD_TABLES_JSON_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static MISSION_REWARDS_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static CETUS_BOUNTY_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static SOLARIS_BOUNTY_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static ZARIMAN_BOUNTY_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static TRANSIENT_REWARDS_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static RELICS_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static ENEMY_LOCATIONS_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static PRIME_PARTS_CACHE: OnceLock<String> = OnceLock::new();
static BARO_NAME_MAP_CACHE: OnceLock<HashMap<String, String>> = OnceLock::new();

#[derive(Deserialize, Serialize, Clone, Debug)]
struct RewardItem {
    name: String,
    platinum: f32,
    is_best: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct RewardPayload {
    timestamp: String,
    items: Vec<RewardItem>,
}

#[derive(Serialize)]
struct ShellCommandResult {
    success: bool,
    code: Option<i32>,
    stdout: String,
    stderr: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct HubCycle {
    key: String,
    label: String,
    state: String,
    expires_at_ms: i64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct HubAlert {
    id: String,
    title: String,
    tier: String,
    expires_at_ms: i64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct HubInvasion {
    id: String,
    location: String,
    attacker: String,
    defender: String,
    reward: String,
    expires_at_ms: i64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct HubNews {
    id: String,
    title: String,
    url: Option<String>,
    published_at_ms: i64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct HubActivity {
    title: String,
    description: String,
    expires_at_ms: i64,
    #[serde(default)]
    tier: Option<String>,
    #[serde(default)]
    boss: Option<String>,
    #[serde(default)]
    stages: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct HubVoidTrader {
    active: bool,
    location: String,
    starts_at_ms: i64,
    ends_at_ms: i64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct HubSnapshot {
    source: String,
    fetched_at_ms: i64,
    worlds: Vec<HubCycle>,
    alerts: Vec<HubAlert>,
    invasions: Vec<HubInvasion>,
    #[serde(default)]
    news: Vec<HubNews>,
    #[serde(default)]
    arbitration: Option<HubActivity>,
    #[serde(default)]
    archon_hunt: Option<HubActivity>,
    void_trader: HubVoidTrader,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct HubFetchResponse {
    stale: bool,
    message: Option<String>,
    refresh_seconds: u64,
    snapshot: HubSnapshot,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct HubArbitrationSlot {
    start_at_ms: i64,
    end_at_ms: i64,
    description: String,
    #[serde(default)]
    tier: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct HubArbitrationScheduleResponse {
    source: String,
    generated_at_ms: i64,
    days: u8,
    #[serde(default)]
    stale: bool,
    message: Option<String>,
    slots: Vec<HubArbitrationSlot>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct HubStateFile {
    refresh_seconds: u64,
    last_success_at_ms: Option<i64>,
    last_snapshot: Option<HubSnapshot>,
}

impl Default for HubStateFile {
    fn default() -> Self {
        Self {
            refresh_seconds: DEFAULT_HUB_REFRESH_SECONDS,
            last_success_at_ms: None,
            last_snapshot: None,
        }
    }
}

fn log_to_file(msg: &str) {
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/wfhub_debug.log")
    {
        let _ = writeln!(f, "{}", msg);
    }
}

fn toggle_main_window(window: &WebviewWindow) {
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn show_overlay(app: &tauri::AppHandle, payload: RewardPayload) {
    let overlay = match app.get_webview_window("overlay") {
        Some(w) => w,
        None => {
            eprintln!("[wfhub] ERROR: overlay window not found!");
            return;
        }
    };

    if let Ok(Some(monitor)) = overlay.primary_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let logical_width = size.width as f64 / scale;
        let x = logical_width - 450.0;
        let _ = overlay.set_position(tauri::LogicalPosition::new(x, 60.0));
    }

    let _ = overlay.emit("reward-detected", &payload);
    let _ = overlay.show();
    let _ = overlay.set_always_on_top(true);

    // Auto-hide after 15 seconds
    let overlay_clone = overlay.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(15));
        let _ = overlay_clone.emit("hide-overlay", ());
        let _ = overlay_clone.hide();
    });
}

fn reward_payload_from_file() -> Result<RewardPayload, String> {
    let contents = fs::read_to_string(REWARD_FILE)
        .map_err(|err| format!("failed to read {REWARD_FILE}: {err}"))?;
    serde_json::from_str::<RewardPayload>(&contents)
        .map_err(|err| format!("failed to parse reward JSON: {err}"))
}

fn command_result(output: std::process::Output) -> ShellCommandResult {
    ShellCommandResult {
        success: output.status.success(),
        code: output.status.code(),
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
    }
}

fn debug_artifacts_enabled() -> bool {
    matches!(std::env::var("WFHUB_DEBUG_FILES").as_deref(), Ok("1"))
}

fn save_debug_image(image: &DynamicImage, path: &str) {
    if debug_artifacts_enabled() {
        let _ = image.save(path);
    }
}

fn project_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")))
        .to_path_buf()
}

fn data_path(path: &str) -> PathBuf {
    project_root().join("data").join(path)
}

fn read_text_cached(path: &str, cache: &OnceLock<String>) -> Result<String, String> {
    if let Some(contents) = cache.get() {
        return Ok(contents.clone());
    }

    let contents = fs::read_to_string(data_path(path))
        .map_err(|err| format!("failed to read {path}: {err}"))?;
    let _ = cache.set(contents.clone());
    Ok(contents)
}

fn read_json_cached(
    path: &str,
    cache: &'static OnceLock<serde_json::Value>,
) -> Result<&'static serde_json::Value, String> {
    if let Some(value) = cache.get() {
        return Ok(value);
    }

    let contents = fs::read_to_string(data_path(path))
        .map_err(|err| format!("failed to read {path}: {err}"))?;
    let parsed = serde_json::from_str::<serde_json::Value>(&contents)
        .map_err(|err| format!("failed to parse {path}: {err}"))?;
    let _ = cache.set(parsed);
    Ok(cache.get().expect("JSON cache should be initialized"))
}

fn http_client() -> &'static reqwest::Client {
    &HTTP_CLIENT
}

fn to_riven_auction_stat_url_name(stat: &str) -> Option<&'static str> {
    match stat.trim() {
        "critical_chance" => Some("critical_chance"),
        "critical_damage" => Some("critical_damage"),
        "multishot" => Some("multishot"),
        "damage" => Some("base_damage_/_melee_damage"),
        "fire_rate" => Some("fire_rate_/_attack_speed"),
        "status_chance" => Some("status_chance"),
        "status_duration" => Some("status_duration"),
        "toxin" => Some("toxin_damage"),
        "heat" => Some("heat_damage"),
        "cold" => Some("cold_damage"),
        "electricity" => Some("electricity_damage"),
        "slash" => Some("slash_damage"),
        "impact" => Some("impact_damage"),
        "puncture" => Some("puncture_damage"),
        "reload_speed" => Some("reload_speed"),
        "punch_through" => Some("punch_through"),
        "magazine" => Some("magazine_capacity"),
        "max_ammo" => Some("ammo_maximum"),
        "zoom" => Some("zoom"),
        "recoil" => Some("recoil"),
        "projectile_speed" => Some("projectile_speed"),
        _ => None,
    }
}

fn ocr_script_path(app: &tauri::AppHandle) -> PathBuf {
    let dev_path = project_root().join("scripts/ocr/ocr_vision.py");
    if dev_path.exists() {
        return dev_path;
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled_path = resource_dir.join("scripts/ocr/ocr_vision.py");
        if bundled_path.exists() {
            return bundled_path;
        }
    }

    dev_path
}

fn build_ocr_script_path(app: &tauri::AppHandle) -> PathBuf {
    let dev_path = project_root().join("scripts/ocr/ocr_vision_build.py");
    if dev_path.exists() {
        return dev_path;
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled_path = resource_dir.join("scripts/ocr/ocr_vision_build.py");
        if bundled_path.exists() {
            return bundled_path;
        }
    }

    dev_path
}

fn riven_ocr_script_path(app: &tauri::AppHandle) -> PathBuf {
    let dev_path = project_root().join("scripts/ocr/ocr_vision_riven.py");
    if dev_path.exists() {
        return dev_path;
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled_path = resource_dir.join("scripts/ocr/ocr_vision_riven.py");
        if bundled_path.exists() {
            return bundled_path;
        }
    }
    dev_path
}

fn item_ocr_script_path(app: &tauri::AppHandle) -> PathBuf {
    let dev_path = project_root().join("scripts/ocr/ocr_item_name.py");
    if dev_path.exists() {
        return dev_path;
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled_path = resource_dir.join("scripts/ocr/ocr_item_name.py");
        if bundled_path.exists() {
            return bundled_path;
        }
    }

    dev_path
}

fn capture_item_from_warframe(app: &tauri::AppHandle) -> Result<String, String> {
    let window = warframe_window()?;
    let frame = window
        .capture_image()
        .map_err(|err| format!("failed to capture Warframe window: {err}"))?;
    let image = DynamicImage::ImageRgba8(frame);
    image
        .save(ITEM_SCREEN_PATH)
        .map_err(|err| format!("failed to save item screenshot: {err}"))?;

    let script = item_ocr_script_path(app);
    let output = Command::new("/usr/bin/python3")
        .arg(&script)
        .arg(ITEM_SCREEN_PATH)
        .output()
        .map_err(|err| format!("failed to run OCR script: {err}"))?;

    if !output.status.success() {
        return Err(format!(
            "OCR script failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    let json_str = fs::read_to_string(ITEM_SEARCH_FILE)
        .map_err(|err| format!("failed to read OCR result: {err}"))?;
    let val: serde_json::Value =
        serde_json::from_str(&json_str).map_err(|err| format!("failed to parse OCR result: {err}"))?;

    val["name"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "item name not found in OCR output".to_string())
}

fn warframe_window() -> Result<CaptureWindow, String> {
    let windows = CaptureWindow::all().map_err(|err| format!("failed to list windows: {err}"))?;
    windows
        .into_iter()
        .find(|window| window.title() == WARFRAME_WINDOW_NAME)
        .ok_or_else(|| format!("window \"{WARFRAME_WINDOW_NAME}\" not found"))
}

fn run_detection(app: &tauri::AppHandle) -> Result<Option<RewardPayload>, String> {
    log_to_file("[run_detection] capturando janela Warframe...");
    let window = warframe_window()?;
    let frame = window
        .capture_image()
        .map_err(|err| format!("failed to capture Warframe window: {err}"))?;
    let image = DynamicImage::ImageRgba8(frame);
    save_debug_image(&image, "/tmp/wfinfo_capture.png");

    let theme = ocr::detect_theme(&image);
    let parts = ocr::extract_parts(&image, theme);
    log_to_file(&format!("[run_detection] partes extraídas: {}", parts.len()));
    if parts.is_empty() {
        log_to_file("[run_detection] nenhuma parte, abortando OCR");
        return Ok(None);
    }

    let _ = fs::remove_file(REWARD_FILE);

    let script_path = ocr_script_path(app);
    log_to_file(&format!("[run_detection] chamando OCR: {}", script_path.display()));
    let output = Command::new("/usr/bin/python3")
        .arg(&script_path)
        .arg("/tmp/wfinfo_prefilter.png")
        .output()
        .map_err(|err| format!("failed to run {}: {err}", script_path.display()))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stdout.trim().is_empty() {
        log_to_file(&format!("[run_detection] OCR stdout:\n{}", stdout.trim()));
        eprintln!("[wfhub] OCR stdout:\n{}", stdout.trim());
    }
    if !stderr.trim().is_empty() {
        log_to_file(&format!("[run_detection] OCR stderr:\n{}", stderr.trim()));
        eprintln!("[wfhub] OCR stderr:\n{}", stderr.trim());
    }
    if !output.status.success() {
        let err = format!("OCR script exited with status {}", output.status);
        log_to_file(&format!("[run_detection] ERRO: {err}"));
        return Err(err);
    }

    if !Path::new(REWARD_FILE).exists() {
        log_to_file("[run_detection] reward JSON não gerado pelo OCR");
        return Ok(None);
    }

    let result = reward_payload_from_file().map(Some);
    if let Ok(Some(ref payload)) = result {
        log_to_file(&format!("[run_detection] payload OK: {} itens", payload.items.len()));
    }
    result
}

#[tauri::command]
async fn fetch_market_orders(item_slug: String) -> Result<String, String> {
    let url = format!("https://api.warframe.market/v1/items/{}/orders", item_slug);
    let response = http_client()
        .get(&url)
        .header("Accept", "application/json")
        .header("Origin", "https://warframe.market")
        .header("Referer", "https://warframe.market/")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    log_to_file(&format!(
        "[market] status: {}, body preview: {}",
        status,
        &text[..text.len().min(200)]
    ));
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, &text[..text.len().min(200)]));
    }
    Ok(text)
}

#[tauri::command]
async fn fetch_market_top(slug: String, rank: Option<u32>) -> Result<String, String> {
    let url = match rank {
        Some(r) => format!("https://api.warframe.market/v2/orders/item/{}/top?rank={}", slug, r),
        None    => format!("https://api.warframe.market/v2/orders/item/{}/top", slug),
    };
    let response = http_client()
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    response.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_item_info(slug: String) -> Result<String, String> {
    let url = format!("https://api.warframe.market/v2/item/{}", slug);
    let response = http_client()
        .get(&url)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    response.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_riven_auctions(
    weapon_url_name: String,
    positive_stats: Option<String>,
    negative_stats: Option<String>,
) -> Result<String, String> {
    let mut url = format!(
        "https://api.warframe.market/v1/auctions/search?type=riven&weapon_url_name={weapon_url_name}"
    );

    if let Some(positive) = positive_stats {
        let trimmed = positive.trim();
        if !trimmed.is_empty() {
            url.push_str("&positive_stats=");
            url.push_str(trimmed);
        }
    }

    if let Some(negative) = negative_stats {
        if let Some(mapped_negative) = to_riven_auction_stat_url_name(&negative) {
            url.push_str("&negative_stats=");
            url.push_str(mapped_negative);
        }
    }

    let response = http_client()
        .get(&url)
        .header("Accept", "application/json")
        .header("Origin", "https://warframe.market")
        .header("Referer", "https://warframe.market/")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, &text[..text.len().min(200)]));
    }

    Ok(text)
}

#[tauri::command]
fn read_items_list() -> Result<String, String> {
    read_text_cached("items_list.json", &ITEMS_LIST_CACHE)
}

#[tauri::command]
fn read_all_mods() -> Result<String, String> {
    read_text_cached("mods_all.json", &MODS_ALL_CACHE)
}

#[tauri::command]
fn read_prime_parts() -> Result<String, String> {
    read_text_cached("prime_parts.json", &PRIME_PARTS_CACHE)
}

#[tauri::command]
fn read_prices() -> Result<String, String> {
    read_text_cached("prices.json", &PRICES_CACHE)
}

#[tauri::command]
fn read_enemy_mod_tables() -> Result<String, String> {
    read_text_cached("enemyModTables.json", &ENEMY_MOD_TABLES_CACHE)
}

#[tauri::command]
fn read_builds() -> Result<String, String> {
    let path = project_root().join("data").join("builds.json");
    if !path.exists() {
        return Ok("[]".to_string());
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

fn maybe_store_build_screenshot(id: &str, image_path: Option<String>) -> Option<String> {
    let raw_path = image_path?;
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return None;
    }

    let source = PathBuf::from(trimmed);
    if !source.exists() {
        return None;
    }

    let extension = source
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .filter(|ext| matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "webp"))
        .unwrap_or_else(|| "png".to_string());

    let images_dir = project_root().join("data").join("build_images");
    if fs::create_dir_all(&images_dir).is_err() {
        return None;
    }

    let file_name = format!("{}.{}", id, extension);
    let destination = images_dir.join(&file_name);
    if fs::copy(&source, &destination).is_err() {
        return None;
    }

    Some(format!("build_images/{}", file_name))
}

fn build_screenshot_path_if_valid(screenshot_rel_path: &str) -> Option<PathBuf> {
    let rel_path = Path::new(screenshot_rel_path);
    if rel_path.is_absolute() {
        return None;
    }
    if rel_path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_)))
    {
        return None;
    }

    Some(project_root().join("data").join(rel_path))
}

fn collect_screenshot_paths(builds: &[serde_json::Value]) -> Vec<PathBuf> {
    builds
        .iter()
        .filter_map(|build| build["screenshot_rel_path"].as_str())
        .filter_map(build_screenshot_path_if_valid)
        .collect()
}

#[tauri::command]
fn save_build(name: String, items: Vec<String>, image_path: Option<String>) -> Result<(), String> {
    let path = project_root().join("data").join("builds.json");
    let mut builds: Vec<serde_json::Value> = if path.exists() {
        let content = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or_default()
    } else {
        vec![]
    };
    let id = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string();
    let screenshot_rel_path = maybe_store_build_screenshot(&id, image_path);

    builds.push(serde_json::json!({
        "id": id,
        "name": name,
        "items": items,
        "screenshot_rel_path": screenshot_rel_path,
        "created_at": inventory::utc_iso_now_pub()
    }));

    let removed_screenshots = if builds.len() > MAX_SAVED_BUILDS {
        let to_remove = builds.len() - MAX_SAVED_BUILDS;
        let removed: Vec<serde_json::Value> = builds.drain(0..to_remove).collect();
        collect_screenshot_paths(&removed)
    } else {
        Vec::new()
    };

    let content = serde_json::to_string_pretty(&builds).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())?;

    for screenshot_path in removed_screenshots {
        let _ = fs::remove_file(screenshot_path);
    }

    Ok(())
}

#[tauri::command]
fn delete_build(id: String) -> Result<(), String> {
    let path = project_root().join("data").join("builds.json");
    if !path.exists() { return Ok(()); }
    let content = fs::read_to_string(&path).unwrap_or_default();
    let mut builds: Vec<serde_json::Value> = serde_json::from_str(&content).unwrap_or_default();

    let removed_builds: Vec<serde_json::Value> = builds
        .iter()
        .filter(|build| build["id"].as_str() == Some(&id))
        .cloned()
        .collect();
    let removed_screenshots = collect_screenshot_paths(&removed_builds);

    builds.retain(|b| b["id"].as_str() != Some(&id));
    let content = serde_json::to_string_pretty(&builds).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())?;

    for screenshot_path in removed_screenshots {
        let _ = fs::remove_file(screenshot_path);
    }

    Ok(())
}

fn build_screenshot_absolute_path(screenshot_rel_path: &str) -> Result<PathBuf, String> {
    let absolute = build_screenshot_path_if_valid(screenshot_rel_path)
        .ok_or_else(|| "caminho de screenshot invalido".to_string())?;
    if !absolute.exists() {
        return Err("screenshot nao encontrado".to_string());
    }

    Ok(absolute)
}

#[tauri::command]
fn resolve_build_screenshot_path(screenshot_rel_path: String) -> Result<String, String> {
    let absolute = build_screenshot_absolute_path(&screenshot_rel_path)?;

    Ok(absolute.to_string_lossy().to_string())
}

#[tauri::command]
fn read_build_screenshot_preview(screenshot_rel_path: String) -> Result<String, String> {
    let absolute = build_screenshot_absolute_path(&screenshot_rel_path)?;
    let bytes = fs::read(&absolute).map_err(|e| e.to_string())?;
    let extension = absolute
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .unwrap_or_default();
    let mime = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    };

    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime, encoded))
}

#[tauri::command]
fn run_shell_action(action: String) -> Result<ShellCommandResult, String> {
    match action.as_str() {
        "run_update_script" => {
            let script = project_root().join("update.sh");
            if !script.exists() {
                return Err(format!("update.sh não encontrado em {}", script.display()));
            }

            let output = Command::new(&script)
                .current_dir(project_root())
                .output()
                .map_err(|e| format!("falha ao executar update.sh: {e}"))?;
            Ok(command_result(output))
        }
        "update_prices" => {
            let script = project_root().join("update_prices.sh");
            if !script.exists() {
                return Err(format!("update_prices.sh não encontrado em {}", script.display()));
            }
            let output = Command::new("sh")
                .arg(&script)
                .current_dir(project_root())
                .output()
                .map_err(|e| format!("falha ao executar update_prices.sh: {e}"))?;
            Ok(command_result(output))
        }
        _ => Err(format!("ação desconhecida: {action}")),
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn clamp_refresh_seconds(value: u64) -> u64 {
    value.clamp(MIN_HUB_REFRESH_SECONDS, MAX_HUB_REFRESH_SECONDS)
}

fn hub_state_path() -> PathBuf {
    data_path(HUB_STATE_FILE)
}

fn read_hub_state_file() -> HubStateFile {
    let path = hub_state_path();
    if !path.exists() {
        return HubStateFile::default();
    }
    let content = fs::read_to_string(path).unwrap_or_default();
    let mut state: HubStateFile = serde_json::from_str(&content).unwrap_or_default();
    state.refresh_seconds = clamp_refresh_seconds(state.refresh_seconds);
    state
}

fn write_hub_state_file(state: &HubStateFile) -> Result<(), String> {
    let mut normalized = state.clone();
    normalized.refresh_seconds = clamp_refresh_seconds(normalized.refresh_seconds);
    let json = serde_json::to_string_pretty(&normalized).map_err(|e| e.to_string())?;
    fs::write(hub_state_path(), json).map_err(|e| e.to_string())
}

fn mongo_date_to_ms(value: &serde_json::Value) -> Option<i64> {
    if let Some(raw) = value
        .get("$date")
        .and_then(|v| v.get("$numberLong"))
        .and_then(|v| v.as_str())
    {
        return raw.parse::<i64>().ok();
    }
    value.as_i64()
}

fn epoch_seconds_to_ms(value: i64) -> i64 {
    if value >= 1_000_000_000_000 {
        value
    } else {
        value.saturating_mul(1000)
    }
}

fn next_daily_reset_ms(now_ms: i64) -> i64 {
    let day_ms = 86_400_000_i64;
    ((now_ms.div_euclid(day_ms)) + 1) * day_ms
}

fn daily_reset_cycle(now_ms: i64) -> HubCycle {
    HubCycle {
        key: "daily-reset".to_string(),
        label: "Daily Reset".to_string(),
        state: "Standing".to_string(),
        expires_at_ms: next_daily_reset_ms(now_ms),
    }
}

fn clean_redtext_title(raw: &str) -> String {
    let line = raw.trim().replace("\r", "").replace("\n", " ");
    if let Some((_, tail)) = line.rsplit_once("WALLOPS :") {
        return tail.trim().to_string();
    }
    line
}

fn resolve_dict_value(dict: Option<&serde_json::Value>, key: &str) -> String {
    dict.and_then(|d| d.get(key))
        .and_then(|v| v.as_str())
        .unwrap_or(key)
        .to_string()
}

fn resolve_node_label(
    node_id: &str,
    export_regions: Option<&serde_json::Value>,
    dict: Option<&serde_json::Value>,
) -> String {
    let Some(regions) = export_regions else {
        return humanize_node(node_id);
    };

    let Some(region) = regions.get(node_id) else {
        return humanize_node(node_id);
    };

    let region_name = region
        .get("name")
        .and_then(|v| v.as_str())
        .map(|key| resolve_dict_value(dict, key))
        .unwrap_or_else(|| humanize_node(node_id));
    let system_name = region
        .get("systemName")
        .and_then(|v| v.as_str())
        .map(|key| resolve_dict_value(dict, key))
        .unwrap_or_default();

    if system_name.is_empty() {
        region_name
    } else {
        format!("{region_name}, {system_name}")
    }
}

fn sentence_case(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let lower = trimmed.to_lowercase();
    let mut chars = lower.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    }
}

fn resolve_arbitration_description(
    node_id: &str,
    export_regions: Option<&serde_json::Value>,
    dict: Option<&serde_json::Value>,
) -> String {
    let location = resolve_node_label(node_id, export_regions, dict);
    let Some(regions) = export_regions else {
        return location;
    };
    let Some(region) = regions.get(node_id) else {
        return location;
    };

    let mission = region
        .get("missionName")
        .and_then(|v| v.as_str())
        .map(|key| resolve_dict_value(dict, key))
        .unwrap_or_else(|| "Mission".to_string());
    let mission = sentence_case(&mission);
    let faction = region
        .get("faction")
        .and_then(|v| v.as_str())
        .map(humanize_faction)
        .unwrap_or_else(|| "Unknown".to_string());

    format!("{mission} - {faction} - {location}")
}

fn archon_name_from_boss(raw: Option<&str>) -> String {
    match raw.unwrap_or_default() {
        "SORTIE_BOSS_BOREAL" => "Boreal".to_string(),
        "SORTIE_BOSS_NIRA" => "Nira".to_string(),
        "SORTIE_BOSS_AMAR" => "Amar".to_string(),
        other if !other.is_empty() => other.replace("SORTIE_BOSS_", ""),
        _ => "Archon".to_string(),
    }
}

fn arbitration_tier_for_node(node_id: &str) -> Option<&'static str> {
    match node_id {
        "SolNode106" | "SolNode147" | "SolNode149" | "ClanNode22" => Some("S TIER"),
        "SolNode25" | "SolNode224" | "SolNode195" | "SolNode42" | "ClanNode24" | "ClanNode6" => Some("A TIER"),
        "SolNode707" | "SolNode125" | "ClanNode4" | "SolNode412" | "SolNode719" | "SolNode22" | "SolNode211" | "ClanNode8" | "SolNode72" | "SolNode212" | "SolNode46" | "SolNode450" => Some("B TIER"),
        "SolNode130" | "ClanNode15" | "SolNode408" | "SolNode402" | "SolNode26" | "SolNode18" | "SolNode305" | "SolNode185" | "SolNode43" | "SolNode64" | "SolNode122" | "SolNode167" | "SolNode164" | "ClanNode18" => Some("C TIER"),
        "SolNode85" | "ClanNode2" | "SolNode172" | "ClanNode0" | "SolNode17" | "SettlementNode11" | "SolNode23" => Some("D TIER"),
        _ => None,
    }
}

fn parse_arbitration_from_arbys(
    arbys_text: &str,
    now_ms: i64,
    export_regions: Option<&serde_json::Value>,
    dict: Option<&serde_json::Value>,
) -> Option<HubActivity> {
    let now_sec = now_ms / 1000;
    let mut current: Option<(i64, String)> = None;
    for line in arbys_text.lines() {
        let mut parts = line.trim().split(',');
        let start = parts.next()?.parse::<i64>().ok()?;
        let node = parts.next()?.trim().to_string();
        if start <= now_sec {
            current = Some((start, node));
        } else {
            break;
        }
    }
    let (start, node) = current?;
    let tier = arbitration_tier_for_node(&node)
        .unwrap_or("F TIER")
        .to_string();
    Some(HubActivity {
        title: "Arbitration".to_string(),
        description: resolve_arbitration_description(&node, export_regions, dict),
        expires_at_ms: (start + 3600) * 1000,
        tier: Some(tier),
        boss: None,
        stages: vec![],
    })
}

fn parse_arbitration_schedule_from_arbys(
    arbys_text: &str,
    now_ms: i64,
    days: u8,
    export_regions: Option<&serde_json::Value>,
    dict: Option<&serde_json::Value>,
) -> Vec<HubArbitrationSlot> {
    let now_sec = now_ms / 1000;
    let horizon_sec = now_sec + i64::from(days) * 86_400;
    let mut slots: Vec<HubArbitrationSlot> = Vec::new();

    for line in arbys_text.lines() {
        let mut parts = line.trim().split(',');
        let Some(start_raw) = parts.next() else {
            continue;
        };
        let Some(node_raw) = parts.next() else {
            continue;
        };
        let Ok(start) = start_raw.parse::<i64>() else {
            continue;
        };
        if start < now_sec || start >= horizon_sec {
            continue;
        }

        let node = node_raw.trim();
        let tier = arbitration_tier_for_node(node)
            .unwrap_or("F TIER")
            .to_string();
        slots.push(HubArbitrationSlot {
            start_at_ms: start * 1000,
            end_at_ms: (start + 3600) * 1000,
            description: resolve_arbitration_description(node, export_regions, dict),
            tier: Some(tier),
        });
    }

    slots.sort_by_key(|slot| slot.start_at_ms);
    slots
}

fn parse_archon_from_worldstate(
    worldstate: &serde_json::Value,
    now_ms: i64,
    export_regions: Option<&serde_json::Value>,
    dict: Option<&serde_json::Value>,
) -> Option<HubActivity> {
    let entry = worldstate
        .get("LiteSorties")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter().find(|item| {
                let start = item.get("Activation").and_then(mongo_date_to_ms).unwrap_or(0);
                let end = item.get("Expiry").and_then(mongo_date_to_ms).unwrap_or(0);
                now_ms >= start && now_ms < end
            }).or_else(|| arr.first())
        })?;

    let stages = entry
        .get("Missions")
        .and_then(|v| v.as_array())
        .map(|missions| {
            missions
                .iter()
                .take(3)
                .map(|mission| {
                    let mtype = mission
                        .get("missionType")
                        .and_then(|v| v.as_str())
                        .map(humanize_mission_type)
                        .unwrap_or_else(|| "Missao".to_string());
                    let node = mission
                        .get("node")
                        .and_then(|v| v.as_str())
                        .map(|node| resolve_node_label(node, export_regions, dict))
                        .unwrap_or_else(|| "Nodo".to_string());
                    format!("{mtype} - {node}")
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let boss = archon_name_from_boss(entry.get("Boss").and_then(|v| v.as_str()));
    let description = if stages.is_empty() {
        boss.clone()
    } else {
        format!("{} - {}", boss, stages.join(" | "))
    };

    Some(HubActivity {
        title: "Archon Hunt".to_string(),
        description,
        expires_at_ms: entry
            .get("Expiry")
            .and_then(mongo_date_to_ms)
            .unwrap_or(now_ms + 86_400_000),
        tier: None,
        boss: Some(boss),
        stages,
    })
}

fn parse_arbitration_from_tenno(payload: &serde_json::Value, now_ms: i64) -> Option<HubActivity> {
    let entry = payload
        .get("arbitrations")
        .and_then(|v| v.get("data"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())?;
    let location = entry
        .get("location")
        .and_then(|v| v.as_str())
        .or_else(|| entry.get("node").and_then(|v| v.as_str()))
        .unwrap_or("Local desconhecido")
        .to_string();
    let mission = entry
        .get("missionType")
        .and_then(|v| v.as_str())
        .map(|v| humanize_mission_type(v))
        .unwrap_or_else(|| "Missao".to_string());
    let expires_at_ms = entry
        .get("end")
        .and_then(|v| v.as_i64())
        .map(epoch_seconds_to_ms)
        .unwrap_or(now_ms + 3_600_000);
    Some(HubActivity {
        title: "Arbitration".to_string(),
        description: format!("{} - {}", sentence_case(&mission), location),
        expires_at_ms,
        tier: None,
        boss: None,
        stages: vec![],
    })
}

fn cycle_from_bounty(now: i64, bounty_expiry_ms: i64, key: &str, label: &str, night: &str, day: &str) -> HubCycle {
    let night_start = bounty_expiry_ms - 3_000_000;
    let is_night = now >= night_start;
    HubCycle {
        key: key.to_string(),
        label: label.to_string(),
        state: if is_night { night } else { day }.to_string(),
        expires_at_ms: if is_night { bounty_expiry_ms } else { night_start },
    }
}

fn fortuna_cycle(now: i64) -> HubCycle {
    let epoch = 1_541_837_628_000_i64;
    let cycle_len = 1_600_000_i64;
    let cold_start_offset = 400_000_i64;
    let cycle = (now - epoch).div_euclid(cycle_len);
    let cycle_start = epoch + cycle * cycle_len;
    let cycle_cold_start = cycle_start + cold_start_offset;
    let cycle_end = cycle_start + cycle_len;
    let is_cold = now >= cycle_cold_start;
    HubCycle {
        key: "fortuna".to_string(),
        label: "Fortuna".to_string(),
        state: if is_cold { "Cold" } else { "Warm" }.to_string(),
        expires_at_ms: if is_cold { cycle_end } else { cycle_cold_start },
    }
}

fn duviri_cycle(now: i64) -> HubCycle {
    let mood_len = 7_200_000_i64;
    let mood_names = ["Sorrow", "Fear", "Joy", "Anger", "Envy"];
    let mood_index = (now.div_euclid(mood_len)) as usize;
    let mood_end = (mood_index as i64 + 1) * mood_len;
    HubCycle {
        key: "duviri".to_string(),
        label: "Duviri".to_string(),
        state: mood_names[mood_index % mood_names.len()].to_string(),
        expires_at_ms: mood_end,
    }
}

fn normalize_resource_name(resource: &str) -> String {
    let base = resource.rsplit('/').next().unwrap_or(resource);
    let mut out = String::with_capacity(base.len() + 8);
    for (idx, ch) in base.chars().enumerate() {
        if idx > 0 && ch.is_uppercase() {
            out.push(' ');
        }
        out.push(ch);
    }
    out.replace('_', " ")
}

fn format_reward_with_count(name: &str, count: Option<i64>) -> String {
    match count {
        Some(c) if c > 1 => format!("{c}x {name}"),
        _ => name.to_string(),
    }
}

fn parse_reward_items(items: &[serde_json::Value]) -> Option<String> {
    let parts = items
        .iter()
        .filter_map(|item| {
            let name = item.get("name").and_then(|v| v.as_str())?;
            let count = item.get("count").and_then(|v| v.as_i64());
            Some(format_reward_with_count(name, count))
        })
        .collect::<Vec<_>>();
    if parts.is_empty() {
        None
    } else {
        Some(parts.join(", "))
    }
}

fn tenno_invasion_rewards(entry: &serde_json::Value) -> Option<String> {
    let attacker = entry
        .get("rewardsAttacker")
        .and_then(|v| v.get("items"))
        .and_then(|v| v.as_array())
        .and_then(|items| parse_reward_items(items));
    let defender = entry
        .get("rewardsDefender")
        .and_then(|v| v.get("items"))
        .and_then(|v| v.as_array())
        .and_then(|items| parse_reward_items(items));

    match (attacker, defender) {
        (Some(a), Some(d)) if a != d => Some(format!("{a} / {d}")),
        (Some(a), Some(_)) => Some(a),
        (Some(a), None) => Some(a),
        (None, Some(d)) => Some(d),
        (None, None) => None,
    }
}

fn browse_invasion_reward(item: &serde_json::Value) -> Option<String> {
    let reward = item
        .get("allyPay")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())?;
    let name = reward
        .get("ItemType")
        .and_then(|v| v.as_str())
        .map(normalize_resource_name)?;
    let count = reward.get("ItemCount").and_then(|v| v.as_i64());
    Some(format_reward_with_count(&name, count))
}

fn humanize_faction(raw: &str) -> String {
    match raw {
        "FC_GRINEER" | "Grineer" => "Grineer".to_string(),
        "FC_CORPUS" | "Corpus" => "Corpus".to_string(),
        "FC_INFESTATION" | "Infested" => "Infested".to_string(),
        "FC_TENNO" | "Tenno" => "Tenno".to_string(),
        _ => raw.replace("FC_", "").replace('_', " "),
    }
}

fn humanize_node(raw: &str) -> String {
    if let Some(node_num) = raw.strip_prefix("SolNode") {
        return format!("Nodo {node_num}");
    }
    raw.replace('_', " ").replace('/', " / ")
}

fn humanize_mission_type(raw: &str) -> String {
    let value = raw.replace("MT_", "").replace('_', " ").to_lowercase();
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => "Missao".to_string(),
    }
}

async fn fetch_tenno_worldstate_json() -> Result<serde_json::Value, String> {
    http_client()
        .get("https://api.tenno.tools/worldstate/pc")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("tenno.tools worldstate request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("tenno.tools worldstate parse failed: {e}"))
}

fn zariman_cycle(expiry_ms: i64, faction: Option<&str>) -> HubCycle {
    let state = match faction {
        Some("FC_GRINEER") => "Grineer",
        Some("FC_CORPUS") => "Corpus",
        _ => "Rotation",
    };
    HubCycle {
        key: "zariman".to_string(),
        label: "Zariman".to_string(),
        state: state.to_string(),
        expires_at_ms: expiry_ms,
    }
}

async fn fetch_hub_from_browse() -> Result<HubSnapshot, String> {
    let now = now_ms();
    let client = http_client();

    let worldstate: serde_json::Value = client
        .get("https://oracle.browse.wf/worldState.json")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("browse worldState request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("browse worldState parse failed: {e}"))?;

    let bounty_cycle: serde_json::Value = client
        .get("https://oracle.browse.wf/bounty-cycle")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("browse bounty-cycle request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("browse bounty-cycle parse failed: {e}"))?;

    let invasions_payload: serde_json::Value = client
        .get("https://oracle.browse.wf/invasions")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("browse invasions request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("browse invasions parse failed: {e}"))?;

    let redtext_payload: serde_json::Value = client
        .get("https://oracle.browse.wf/redtext.json")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("browse redtext request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("browse redtext parse failed: {e}"))?;

    let export_regions_payload: Option<serde_json::Value> =
        match client
            .get("https://browse.wf/warframe-public-export-plus/ExportRegions.json")
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(res) => res.json::<serde_json::Value>().await.ok(),
            Err(_) => None,
        };

    let dict_payload: Option<serde_json::Value> =
        match client
            .get("https://browse.wf/warframe-public-export-plus/dict.en.json")
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(res) => res.json::<serde_json::Value>().await.ok(),
            Err(_) => None,
        };

    let arbys_text = match client.get("https://browse.wf/arbys.txt").send().await {
        Ok(res) => res.text().await.ok(),
        Err(_) => None,
    };

    let tenno_payload = fetch_tenno_worldstate_json().await.ok();
    let tenno_alerts_by_id: HashMap<String, &serde_json::Value> = tenno_payload
        .as_ref()
        .and_then(|payload| payload.get("alerts"))
        .and_then(|v| v.get("data"))
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(|v| v.as_str()).map(|id| (id.to_string(), item)))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();
    let tenno_invasions_by_id: HashMap<String, &serde_json::Value> = tenno_payload
        .as_ref()
        .and_then(|payload| payload.get("invasions"))
        .and_then(|v| v.get("data"))
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(|v| v.as_str()).map(|id| (id.to_string(), item)))
                .collect::<HashMap<_, _>>()
        })
        .unwrap_or_default();

    let bounty_expiry = bounty_cycle
        .get("expiry")
        .and_then(|v| v.as_i64())
        .unwrap_or(now + 3_000_000);
    let zariman_faction = bounty_cycle.get("zarimanFaction").and_then(|v| v.as_str());

    let worlds = vec![
        cycle_from_bounty(now, bounty_expiry, "cetus", "Cetus", "Night", "Day"),
        fortuna_cycle(now),
        cycle_from_bounty(now, bounty_expiry, "cambion", "Cambion Drift", "Vome", "Fass"),
        duviri_cycle(now),
        zariman_cycle(bounty_expiry, zariman_faction),
        daily_reset_cycle(now),
    ];

    let alerts = worldstate
        .get("Alerts")
        .and_then(|v| v.as_array())
        .map(|alerts| {
            alerts
                .iter()
                .take(12)
                .map(|alert| {
                    let id = alert
                        .get("_id")
                        .and_then(|v| v.get("$oid"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("alert")
                        .to_string();
                    let mission = alert
                        .get("MissionInfo")
                        .and_then(|v| v.get("missionType"))
                        .and_then(|v| v.as_str())
                        .map(humanize_mission_type)
                        .unwrap_or_else(|| "Missao".to_string());
                    let location = alert
                        .get("MissionInfo")
                        .and_then(|v| v.get("location"))
                        .and_then(|v| v.as_str())
                        .map(humanize_node)
                        .unwrap_or_else(|| "Nodo desconhecido".to_string());
                    let maybe_tenno_alert = tenno_alerts_by_id.get(&id);
                    let title = maybe_tenno_alert
                        .and_then(|entry| entry.get("mission"))
                        .and_then(|mission_info| mission_info.get("node"))
                        .and_then(|v| v.as_str())
                        .map(|node| format!("{} @ {}", mission, node))
                        .unwrap_or_else(|| format!("{} @ {}", mission, location));
                    HubAlert {
                        id,
                        title,
                        tier: "Alert".to_string(),
                        expires_at_ms: alert
                            .get("Expiry")
                            .and_then(mongo_date_to_ms)
                            .unwrap_or(now + 3_600_000),
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let invasion_expiry = invasions_payload
        .get("expiry")
        .and_then(|v| v.as_i64())
        .map(epoch_seconds_to_ms)
        .unwrap_or(now + 3_600_000);
    let invasions = invasions_payload
        .get("invasions")
        .and_then(|v| v.as_array())
        .map(|items| {
            let mut rewards_by_id: HashMap<String, Vec<String>> = HashMap::new();
            let mut factions_by_id: HashMap<String, Vec<String>> = HashMap::new();

            for item in items {
                if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                    if let Some(reward) = browse_invasion_reward(item) {
                        let entry = rewards_by_id.entry(id.to_string()).or_default();
                        if !entry.contains(&reward) {
                            entry.push(reward);
                        }
                    }
                    if let Some(faction) = item.get("ally").and_then(|v| v.as_str()) {
                        let faction_name = humanize_faction(faction);
                        let entry = factions_by_id.entry(id.to_string()).or_default();
                        if !entry.contains(&faction_name) {
                            entry.push(faction_name);
                        }
                    }
                }
            }

            let mut seen_ids: HashSet<String> = HashSet::new();
            let mut merged: Vec<HubInvasion> = Vec::new();

            for item in items {
                let id = item
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or("invasion")
                    .to_string();
                if !seen_ids.insert(id.clone()) {
                    continue;
                }

                let maybe_tenno_invasion = tenno_invasions_by_id.get(&id);
                let reward = maybe_tenno_invasion
                    .and_then(|entry| tenno_invasion_rewards(entry))
                    .or_else(|| rewards_by_id.get(&id).map(|parts| parts.join(" / ")))
                    .unwrap_or_else(|| "Reward unknown".to_string());

                let fallback_factions = factions_by_id.get(&id).cloned().unwrap_or_default();
                let attacker = maybe_tenno_invasion
                    .and_then(|entry| entry.get("factionAttacker"))
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string())
                    .or_else(|| fallback_factions.first().cloned())
                    .unwrap_or_else(|| "Unknown".to_string());
                let defender = maybe_tenno_invasion
                    .and_then(|entry| entry.get("factionDefender"))
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string())
                    .or_else(|| fallback_factions.get(1).cloned())
                    .unwrap_or_else(|| "Opposition".to_string());

                merged.push(HubInvasion {
                    id,
                    location: maybe_tenno_invasion
                        .and_then(|entry| entry.get("location"))
                        .and_then(|v| v.as_str())
                        .map(|v| v.to_string())
                        .or_else(|| item.get("node").and_then(|v| v.as_str()).map(humanize_node))
                        .unwrap_or_else(|| "Nodo desconhecido".to_string()),
                    attacker,
                    defender,
                    reward,
                    expires_at_ms: invasion_expiry,
                });

                if merged.len() >= 12 {
                    break;
                }
            }

            merged
        })
        .unwrap_or_default();

    let news = redtext_payload
        .as_array()
        .map(|entries| {
            entries
                .iter()
                .rev()
                .take(12)
                .filter_map(|entry| {
                    let raw_title = entry.get("data").and_then(|v| v.as_str())?;
                    let published_at_ms = entry
                        .get("time")
                        .and_then(|v| v.as_i64())
                        .map(epoch_seconds_to_ms)
                        .unwrap_or(now);
                    Some(HubNews {
                        id: format!("redtext-{published_at_ms}"),
                        title: clean_redtext_title(raw_title),
                        url: Some("https://browse.wf/live".to_string()),
                        published_at_ms,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let arbitration = arbys_text
        .as_deref()
        .and_then(|txt| {
            parse_arbitration_from_arbys(
                txt,
                now,
                export_regions_payload.as_ref(),
                dict_payload.as_ref(),
            )
        })
        .or_else(|| tenno_payload.as_ref().and_then(|payload| parse_arbitration_from_tenno(payload, now)));

    let archon_hunt = parse_archon_from_worldstate(
        &worldstate,
        now,
        export_regions_payload.as_ref(),
        dict_payload.as_ref(),
    );

    let void_trader = worldstate
        .get("VoidTraders")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .map(|baro| {
            let starts_at_ms = baro.get("Activation").and_then(mongo_date_to_ms).unwrap_or(now + 86_400_000);
            let ends_at_ms = baro.get("Expiry").and_then(mongo_date_to_ms).unwrap_or(starts_at_ms + 172_800_000);
            HubVoidTrader {
                active: now >= starts_at_ms && now < ends_at_ms,
                location: tenno_payload
                    .as_ref()
                    .and_then(|payload| payload.get("voidtraders"))
                    .and_then(|v| v.get("data"))
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.first())
                    .and_then(|entry| entry.get("location"))
                    .and_then(|v| v.as_str())
                    .map(|v| v.to_string())
                    .or_else(|| baro.get("Node").and_then(|v| v.as_str()).map(humanize_node))
                    .unwrap_or_else(|| "Relay desconhecido".to_string()),
                starts_at_ms,
                ends_at_ms,
            }
        })
        .unwrap_or(HubVoidTrader {
            active: false,
            location: "Unknown relay".to_string(),
            starts_at_ms: now + 86_400_000,
            ends_at_ms: now + 172_800_000,
        });

    Ok(HubSnapshot {
        source: "browse.wf".to_string(),
        fetched_at_ms: now,
        worlds,
        alerts,
        invasions,
        news,
        arbitration,
        archon_hunt,
        void_trader,
    })
}

async fn fetch_hub_from_tenno_tools() -> Result<HubSnapshot, String> {
    let now = now_ms();
    let payload = fetch_tenno_worldstate_json().await?;

    let bounties_expiry = payload
        .get("bounties")
        .and_then(|v| v.get("time"))
        .and_then(|v| v.as_i64())
        .map(|secs| secs * 1000)
        .unwrap_or(now + 3_000_000);

    let worlds = vec![
        cycle_from_bounty(now, bounties_expiry, "cetus", "Cetus", "Night", "Day"),
        fortuna_cycle(now),
        cycle_from_bounty(now, bounties_expiry, "cambion", "Cambion Drift", "Vome", "Fass"),
        duviri_cycle(now),
        zariman_cycle(bounties_expiry, None),
        daily_reset_cycle(now),
    ];

    let alerts = payload
        .get("alerts")
        .and_then(|v| v.get("data"))
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .take(12)
                .map(|item| HubAlert {
                    id: item.get("id").and_then(|v| v.as_str()).unwrap_or("alert").to_string(),
                    title: item
                        .get("mission")
                        .and_then(|mission| {
                            let node = mission.get("node").and_then(|x| x.as_str());
                            let mtype = mission.get("type").and_then(|x| x.as_str());
                            match (mtype, node) {
                                (Some(t), Some(n)) => Some(format!("{} @ {}", humanize_mission_type(t), n)),
                                (None, Some(n)) => Some(format!("Alerta @ {n}")),
                                _ => None,
                            }
                        })
                        .unwrap_or_else(|| "Alerta".to_string()),
                    tier: "Alert".to_string(),
                    expires_at_ms: item
                        .get("end")
                        .and_then(|v| v.as_i64())
                        .map(|secs| secs * 1000)
                        .unwrap_or(now + 3_600_000),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let invasions = payload
        .get("invasions")
        .and_then(|v| v.get("data"))
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .take(12)
                .map(|item| {
                    let reward = tenno_invasion_rewards(item)
                        .unwrap_or_else(|| "Reward unknown".to_string());
                    HubInvasion {
                        id: item.get("id").and_then(|v| v.as_str()).unwrap_or("invasion").to_string(),
                        location: item.get("location").and_then(|v| v.as_str()).unwrap_or("Unknown node").to_string(),
                        attacker: item.get("factionAttacker").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string(),
                        defender: item.get("factionDefender").and_then(|v| v.as_str()).unwrap_or("Unknown").to_string(),
                        reward,
                        expires_at_ms: item
                            .get("start")
                            .and_then(|v| v.as_i64())
                            .map(|start| (start + 86_400) * 1000)
                            .unwrap_or(now + 3_600_000),
                    }
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let void_trader = payload
        .get("voidtraders")
        .and_then(|v| v.get("data"))
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .map(|baro| {
            let starts_at_ms = baro.get("start").and_then(|v| v.as_i64()).unwrap_or((now / 1000) + 86_400) * 1000;
            let ends_at_ms = baro.get("end").and_then(|v| v.as_i64()).unwrap_or((now / 1000) + 172_800) * 1000;
            HubVoidTrader {
                active: baro.get("active").and_then(|v| v.as_bool()).unwrap_or(false),
                location: baro.get("location").and_then(|v| v.as_str()).unwrap_or("Unknown relay").to_string(),
                starts_at_ms,
                ends_at_ms,
            }
        })
        .unwrap_or(HubVoidTrader {
            active: false,
            location: "Unknown relay".to_string(),
            starts_at_ms: now + 86_400_000,
            ends_at_ms: now + 172_800_000,
        });

    let news = payload
        .get("news")
        .and_then(|v| v.get("data"))
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .take(12)
                .map(|item| HubNews {
                    id: item.get("id").and_then(|v| v.as_str()).unwrap_or("news").to_string(),
                    title: item
                        .get("text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("News")
                        .trim()
                        .to_string(),
                    url: item.get("link").and_then(|v| v.as_str()).map(|v| v.to_string()),
                    published_at_ms: item
                        .get("start")
                        .and_then(|v| v.as_i64())
                        .map(epoch_seconds_to_ms)
                        .unwrap_or(now),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let arbitration = parse_arbitration_from_tenno(&payload, now);

    let archon_hunt = None;

    Ok(HubSnapshot {
        source: "tenno.tools".to_string(),
        fetched_at_ms: now,
        worlds,
        alerts,
        invasions,
        news,
        arbitration,
        archon_hunt,
        void_trader,
    })
}

async fn fetch_arbitrations_next_days_from_browse(now_ms: i64, days: u8) -> Result<Vec<HubArbitrationSlot>, String> {
    let client = http_client();

    let export_regions_payload: Option<serde_json::Value> =
        match client
            .get("https://browse.wf/warframe-public-export-plus/ExportRegions.json")
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(res) => res.json::<serde_json::Value>().await.ok(),
            Err(_) => None,
        };

    let dict_payload: Option<serde_json::Value> =
        match client
            .get("https://browse.wf/warframe-public-export-plus/dict.en.json")
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(res) => res.json::<serde_json::Value>().await.ok(),
            Err(_) => None,
        };

    let arbys_text = client
        .get("https://browse.wf/arbys.txt")
        .header("Accept", "text/plain")
        .send()
        .await
        .map_err(|e| format!("browse arbys request failed: {e}"))?
        .text()
        .await
        .map_err(|e| format!("browse arbys parse failed: {e}"))?;

    Ok(parse_arbitration_schedule_from_arbys(
        &arbys_text,
        now_ms,
        days,
        export_regions_payload.as_ref(),
        dict_payload.as_ref(),
    ))
}

#[derive(Serialize)]
struct HubVoidTraderInventoryItem {
    name: String,
    ducats: i64,
    credits: i64,
}

#[derive(Serialize)]
struct HubVoidTraderInventoryResponse {
    source: String,
    generated_at_ms: i64,
    active: bool,
    location: String,
    starts_at_ms: i64,
    ends_at_ms: i64,
    stale: bool,
    message: Option<String>,
    items: Vec<HubVoidTraderInventoryItem>,
}

#[tauri::command]
async fn fetch_hub_void_trader_inventory() -> Result<String, String> {
    let now = now_ms();
    let client = http_client();

    // Build (once per session) a short-code → display-name map using the two-step lookup:
    //   1. Export JSON maps canonical path → lang_key  (entry["name"] field)
    //   2. dict.en.json maps lang_key → English display name
    // ExportRelics has no "name" field — names are constructed from era+category fields.
    // A small hardcoded map covers items that still fall through.
    async fn get_or_build_name_map(client: &reqwest::Client) -> &'static HashMap<String, String> {
        if let Some(cached) = BARO_NAME_MAP_CACHE.get() {
            return cached;
        }

        // Hardcoded fallbacks for items not resolvable via Export JSONs
        let hardcoded: &[(&str, &str)] = &[
            ("MummyQuestKeyBlueprint", "Sands of Inaros Blueprint"),
        ];

        // Helper: load a JSON file from data/ first; fall back to HTTP download.
        // Returns serde_json::Value::Null on failure.
        async fn load_export(client: &reqwest::Client, filename: &str, url: &str) -> serde_json::Value {
            let local_path = data_path(filename);
            if let Ok(contents) = fs::read_to_string(&local_path) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&contents) {
                    return v;
                }
            }
            // Local file missing or corrupt — fall back to HTTP so the feature still
            // works before update.sh has been run for the first time.
            async {
                let res = client
                    .get(url)
                    .header("Accept", "application/json")
                    .send()
                    .await
                    .ok()?;
                res.json::<serde_json::Value>().await.ok()
            }
            .await
            .unwrap_or(serde_json::Value::Null)
        }

        // Step 1: dict.en.json → HashMap<lang_key, display_name>
        let lang_dict: HashMap<String, String> = {
            let val = load_export(
                &client,
                "dict.en.json",
                "https://browse.wf/warframe-public-export-plus/dict.en.json",
            ).await;
            val.as_object()
                .map(|obj| {
                    obj.iter()
                        .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.trim().to_string())))
                        .collect::<HashMap<_, _>>()
                })
                .unwrap_or_default()
        };

        // Step 2: standard Export JSONs (each entry has a "name" lang_key field)
        let export_files: &[(&str, &str)] = &[
            ("ExportUpgrades.json",     "https://browse.wf/warframe-public-export-plus/ExportUpgrades.json"),
            ("ExportWeapons.json",      "https://browse.wf/warframe-public-export-plus/ExportWeapons.json"),
            ("ExportFlavour.json",      "https://browse.wf/warframe-public-export-plus/ExportFlavour.json"),
            ("ExportResources.json",    "https://browse.wf/warframe-public-export-plus/ExportResources.json"),
            ("ExportCustoms.json",      "https://browse.wf/warframe-public-export-plus/ExportCustoms.json"),
            ("ExportBoosterPacks.json", "https://browse.wf/warframe-public-export-plus/ExportBoosterPacks.json"),
            ("ExportBundles.json",      "https://browse.wf/warframe-public-export-plus/ExportBundles.json"),
        ];

        let mut map: HashMap<String, String> = HashMap::new();

        for (filename, url) in export_files {
            let export = load_export(&client, filename, url).await;
            if let Some(obj) = export.as_object() {
                for (canonical_path, item_data) in obj {
                    let short_code = match canonical_path.rsplit('/').next() {
                        Some(s) if !s.is_empty() => s,
                        _ => continue,
                    };
                    if map.contains_key(short_code) {
                        continue;
                    }
                    let lang_key = match item_data.get("name").and_then(|v| v.as_str()) {
                        Some(k) => k,
                        None => continue,
                    };
                    if let Some(display_name) = lang_dict.get(lang_key) {
                        map.insert(short_code.to_string(), display_name.clone());
                    }
                }
            }
        }

        // Step 3: ExportRelics — no "name" field; construct from era + category
        // e.g. era="Axi", category="M5" → "Axi M5 Relic"
        let relics_export = load_export(
            &client,
            "ExportRelics.json",
            "https://browse.wf/warframe-public-export-plus/ExportRelics.json",
        ).await;
        if let Some(obj) = relics_export.as_object() {
            for (canonical_path, item_data) in obj {
                let short_code = match canonical_path.rsplit('/').next() {
                    Some(s) if !s.is_empty() => s,
                    _ => continue,
                };
                if map.contains_key(short_code) {
                    continue;
                }
                let era = item_data.get("era").and_then(|v: &serde_json::Value| v.as_str()).unwrap_or("");
                let category = item_data.get("category").and_then(|v: &serde_json::Value| v.as_str()).unwrap_or("");
                if !era.is_empty() && !category.is_empty() {
                    map.insert(short_code.to_string(), format!("{era} {category} Relic"));
                }
            }
        }

        // Step 4: hardcoded fallbacks for items still unresolved
        for (code, name) in hardcoded {
            map.entry(code.to_string()).or_insert_with(|| name.to_string());
        }

        // Store in the global cache and return a reference to it
        BARO_NAME_MAP_CACHE.get_or_init(|| map)
    }

    // --- Primary: browse.wf worldstate (live data) + cached name map ---
    let browse_result: Result<HubVoidTraderInventoryResponse, String> = async {
        let worldstate: serde_json::Value = client
            .get("https://oracle.browse.wf/worldState.json")
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("worldState request failed: {e}"))?
            .json()
            .await
            .map_err(|e| format!("worldState parse failed: {e}"))?;

        let name_map = get_or_build_name_map(&client).await;

        let trader = worldstate
            .get("VoidTraders")
            .and_then(|v| v.as_array())
            .and_then(|arr| arr.first())
            .ok_or_else(|| "No VoidTrader in worldstate".to_string())?;

        let starts_at_ms = trader.get("Activation").and_then(mongo_date_to_ms).unwrap_or(now + 86_400_000);
        let ends_at_ms = trader.get("Expiry").and_then(mongo_date_to_ms).unwrap_or(starts_at_ms + 172_800_000);
        let active = now >= starts_at_ms && now < ends_at_ms;

        let location = trader
            .get("Node")
            .and_then(|v| v.as_str())
            .map(humanize_node)
            .unwrap_or_else(|| "Unknown relay".to_string());

        // Always extract items — even if inactive, keep last-cycle data for reference.
        let items: Vec<HubVoidTraderInventoryItem> = trader
            .get("Manifest")
            .and_then(|v| v.as_array())
            .map(|manifest| {
                manifest
                    .iter()
                    .filter_map(|entry| {
                        let item_type = entry.get("ItemType").and_then(|v| v.as_str())?;
                        let ducats = entry.get("PrimePrice").and_then(|v| v.as_i64()).unwrap_or(0);
                        let credits = entry.get("RegularPrice").and_then(|v| v.as_i64()).unwrap_or(0);
                        // The ItemType may be a short code or a full path; try short code lookup first.
                        let short_code = item_type.rsplit('/').next().unwrap_or(item_type);
                        let name = name_map
                            .get(short_code)
                            .cloned()
                            .unwrap_or_else(|| short_code.replace('_', " "));
                        Some(HubVoidTraderInventoryItem { name, ducats, credits })
                    })
                    .collect()
            })
            .unwrap_or_default();

        Ok(HubVoidTraderInventoryResponse {
            source: "browse.wf".to_string(),
            generated_at_ms: now,
            active,
            location,
            starts_at_ms,
            ends_at_ms,
            stale: false,
            message: None,
            items,
        })
    }
    .await;

    match browse_result {
        Ok(resp) => return serde_json::to_string(&resp).map_err(|e| e.to_string()),
        Err(primary_err) => {
            // --- Fallback: tenno.tools ---
            let fallback_result: Result<HubVoidTraderInventoryResponse, String> = async {
                let payload = fetch_tenno_worldstate_json().await?;

                let trader = payload
                    .get("voidtraders")
                    .and_then(|v| v.get("data"))
                    .and_then(|v| v.as_array())
                    .and_then(|arr| arr.first())
                    .ok_or_else(|| "No VoidTrader in tenno.tools payload".to_string())?;

                let starts_at_ms = trader
                    .get("start")
                    .and_then(|v| v.as_i64())
                    .unwrap_or((now / 1000) + 86_400)
                    * 1000;
                let ends_at_ms = trader
                    .get("end")
                    .and_then(|v| v.as_i64())
                    .unwrap_or((now / 1000) + 172_800)
                    * 1000;
                let active = trader.get("active").and_then(|v| v.as_bool()).unwrap_or(false);
                let location = trader
                    .get("location")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Unknown relay")
                    .to_string();

                let items: Vec<HubVoidTraderInventoryItem> = trader
                    .get("inventory")
                    .and_then(|v| v.as_array())
                    .map(|inv| {
                        inv.iter()
                            .filter_map(|entry| {
                                let name = entry.get("item").and_then(|v| v.as_str())?.trim().to_string();
                                if name.is_empty() { return None; }
                                let ducats = entry.get("ducats").and_then(|v| v.as_i64()).unwrap_or(0);
                                let credits = entry.get("credits").and_then(|v| v.as_i64()).unwrap_or(0);
                                Some(HubVoidTraderInventoryItem { name, ducats, credits })
                            })
                            .collect()
                    })
                    .unwrap_or_default();

                Ok(HubVoidTraderInventoryResponse {
                    source: "tenno.tools (fallback)".to_string(),
                    generated_at_ms: now,
                    active,
                    location,
                    starts_at_ms,
                    ends_at_ms,
                    stale: true,
                    message: Some(primary_err),
                    items,
                })
            }
            .await;

            let resp = fallback_result?;
            serde_json::to_string(&resp).map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
fn read_hub_state() -> Result<String, String> {
    let state = read_hub_state_file();
    serde_json::to_string(&state).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_hub_settings(refresh_seconds: u64) -> Result<String, String> {
    let mut state = read_hub_state_file();
    state.refresh_seconds = clamp_refresh_seconds(refresh_seconds);
    write_hub_state_file(&state)?;
    serde_json::to_string(&state).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_hub_worldstate() -> Result<String, String> {
    let mut state = read_hub_state_file();
    let refresh_seconds = state.refresh_seconds;

    let snapshot = match fetch_hub_from_browse().await {
        Ok(snapshot) => Ok(snapshot),
        Err(primary_err) => fetch_hub_from_tenno_tools()
            .await
            .map_err(|fallback_err| format!("primary failed: {primary_err}; fallback failed: {fallback_err}")),
    };

    match snapshot {
        Ok(snapshot) => {
            state.last_success_at_ms = Some(now_ms());
            state.last_snapshot = Some(snapshot.clone());
            write_hub_state_file(&state)?;
            let response = HubFetchResponse {
                stale: false,
                message: None,
                refresh_seconds,
                snapshot,
            };
            serde_json::to_string(&response).map_err(|e| e.to_string())
        }
        Err(fetch_error) => {
            if let Some(snapshot) = state.last_snapshot {
                let response = HubFetchResponse {
                    stale: true,
                    message: Some(fetch_error),
                    refresh_seconds,
                    snapshot,
                };
                serde_json::to_string(&response).map_err(|e| e.to_string())
            } else {
                Err(fetch_error)
            }
        }
    }
}

#[tauri::command]
async fn fetch_hub_arbitrations_next_days(days: Option<u8>) -> Result<String, String> {
    let now = now_ms();
    let requested_days = days.unwrap_or(7).clamp(1, 14);

    match fetch_arbitrations_next_days_from_browse(now, requested_days).await {
        Ok(slots) => {
            let response = HubArbitrationScheduleResponse {
                source: "browse.wf".to_string(),
                generated_at_ms: now,
                days: requested_days,
                stale: false,
                message: None,
                slots,
            };
            serde_json::to_string(&response).map_err(|e| e.to_string())
        }
        Err(primary_err) => {
            let fallback_slot = fetch_tenno_worldstate_json()
                .await
                .ok()
                .and_then(|payload| parse_arbitration_from_tenno(&payload, now))
                .map(|activity| HubArbitrationSlot {
                    start_at_ms: activity.expires_at_ms - 3_600_000,
                    end_at_ms: activity.expires_at_ms,
                    description: activity.description,
                    tier: activity.tier,
                });

            let slots = if let Some(slot) = fallback_slot {
                vec![slot]
            } else {
                let state = read_hub_state_file();
                state
                    .last_snapshot
                    .and_then(|snapshot| snapshot.arbitration)
                    .map(|activity| HubArbitrationSlot {
                        start_at_ms: activity.expires_at_ms - 3_600_000,
                        end_at_ms: activity.expires_at_ms,
                        description: activity.description,
                        tier: activity.tier,
                    })
                    .into_iter()
                    .collect::<Vec<_>>()
            };

            let response = HubArbitrationScheduleResponse {
                source: if slots.is_empty() {
                    "browse.wf".to_string()
                } else {
                    "fallback".to_string()
                },
                generated_at_ms: now,
                days: requested_days,
                stale: true,
                message: Some(primary_err),
                slots,
            };
            serde_json::to_string(&response).map_err(|e| e.to_string())
        }
    }
}

#[tauri::command]
fn read_mod_names() -> Result<String, String> {
    if let Some(names) = MOD_NAMES_CACHE.get() {
        return Ok(names.clone());
    }

    let data = read_json_cached("modLocations.json", &MOD_LOCATIONS_CACHE)?;
    let mut names: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    if let Some(locs) = data["modLocations"].as_array() {
        for loc in locs {
            if let Some(name) = loc["modName"].as_str() {
                let clean = name.trim();
                if !clean.is_empty() && seen.insert(clean.to_lowercase()) {
                    names.push(clean.to_string());
                }
            }
        }
    }

    let serialized = serde_json::to_string(&names).map_err(|e| e.to_string())?;
    let _ = MOD_NAMES_CACHE.set(serialized.clone());
    Ok(serialized)
}


fn rarity_rank(rarity: &str) -> u8 {
    match rarity {
        "Common" => 1,
        "Uncommon" => 2,
        "Rare" => 3,
        "Legendary" => 4,
        _ => 0,
    }
}

fn upsert_rarity(map: &mut std::collections::HashMap<String, String>, item_name: &str, rarity: &str) {
    let clean_name = item_name.trim();
    let clean_rarity = rarity.trim();
    if clean_name.is_empty() || clean_rarity.is_empty() {
        return;
    }

    let key = clean_name.to_lowercase();
    let should_replace = match map.get(&key) {
        Some(existing) => rarity_rank(clean_rarity) > rarity_rank(existing),
        None => true,
    };

    if should_replace {
        map.insert(key, clean_rarity.to_string());
    }
}

#[tauri::command]
fn read_item_rarities() -> Result<String, String> {
    if let Some(serialized) = ITEM_RARITIES_CACHE.get() {
        return Ok(serialized.clone());
    }

    let mut rarities: std::collections::HashMap<String, String> = std::collections::HashMap::new();

    let enemy_mod_tables = read_json_cached("enemyModTables.json", &ENEMY_MOD_TABLES_JSON_CACHE)?;
    if let Some(tables) = enemy_mod_tables["enemyModTables"].as_array() {
        for table in tables {
            if let Some(mods) = table["mods"].as_array() {
                for item in mods {
                    upsert_rarity(
                        &mut rarities,
                        item["modName"].as_str().unwrap_or(""),
                        item["rarity"].as_str().unwrap_or(""),
                    );
                }
            }
        }
    }

    let mission_rewards = read_json_cached("missionRewards.json", &MISSION_REWARDS_CACHE)?;
    if let Some(planets) = mission_rewards["missionRewards"].as_object() {
        for nodes in planets.values() {
            if let Some(nodes) = nodes.as_object() {
                for info in nodes.values() {
                    if let Some(rotations) = info["rewards"].as_object() {
                        for rewards in rotations.values() {
                            if let Some(rewards) = rewards.as_array() {
                                for reward in rewards {
                                    upsert_rarity(
                                        &mut rarities,
                                        reward["itemName"].as_str().unwrap_or(""),
                                        reward["rarity"].as_str().unwrap_or(""),
                                    );
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    for (key, cache) in [
        ("cetusBountyRewards", &CETUS_BOUNTY_CACHE),
        ("solarisBountyRewards", &SOLARIS_BOUNTY_CACHE),
        ("zarimanRewards", &ZARIMAN_BOUNTY_CACHE),
    ] {
        let data = read_json_cached(&format!("{key}.json"), cache)?;
        if let Some(bounties) = data[key].as_array() {
            for bounty in bounties {
                if let Some(rotations) = bounty["rewards"].as_object() {
                    for rewards in rotations.values() {
                        if let Some(rewards) = rewards.as_array() {
                            for reward in rewards {
                                upsert_rarity(
                                    &mut rarities,
                                    reward["itemName"].as_str().unwrap_or(""),
                                    reward["rarity"].as_str().unwrap_or(""),
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    let transient_rewards = read_json_cached("transientRewards.json", &TRANSIENT_REWARDS_CACHE)?;
    if let Some(groups) = transient_rewards["transientRewards"].as_array() {
        for group in groups {
            if let Some(rewards) = group["rewards"].as_array() {
                for reward in rewards {
                    upsert_rarity(
                        &mut rarities,
                        reward["itemName"].as_str().unwrap_or(""),
                        reward["rarity"].as_str().unwrap_or(""),
                    );
                }
            }
        }
    }

    let relics = read_json_cached("relics.json", &RELICS_CACHE)?;
    if let Some(entries) = relics["relics"].as_array() {
        for relic in entries {
            if let Some(rewards) = relic["rewards"].as_array() {
                for reward in rewards {
                    upsert_rarity(
                        &mut rarities,
                        reward["itemName"].as_str().unwrap_or(""),
                        reward["rarity"].as_str().unwrap_or(""),
                    );
                }
            }
        }
    }

    let serialized = serde_json::to_string(&rarities).map_err(|e| e.to_string())?;
    let _ = ITEM_RARITIES_CACHE.set(serialized.clone());
    Ok(serialized)
}

#[tauri::command]
fn save_temp_image(base64_data: String, path: String) -> Result<(), String> {
    use base64::Engine;

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| e.to_string())?;
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[tauri::command]
fn analyze_riven_image(app: tauri::AppHandle, image_path: String) -> Result<String, String> {
    if image_path != RIVEN_IMAGE_PATH {
        fs::copy(&image_path, RIVEN_IMAGE_PATH)
            .map_err(|e| format!("failed to copy riven image to {RIVEN_IMAGE_PATH}: {e}"))?;
    }
    let script_path = riven_ocr_script_path(&app);
    let output = Command::new("/usr/bin/python3")
        .arg(&script_path)
        .arg(RIVEN_IMAGE_PATH)
        .output()
        .map_err(|e| format!("failed to run {}: {e}", script_path.display()))?;
    let stdout = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        log_to_file(&format!("[riven-ocr] stderr:\n{}", stderr.trim()));
    }
    if !output.status.success() {
        return Err(format!(
            "riven OCR exited with status {}: {}",
            output.status,
            stderr.trim()
        ));
    }
    Ok(stdout.trim().to_string())
}

#[tauri::command]
fn read_riven_weapon_rules() -> Result<String, String> {
    let path = data_path("rivenWeaponRules.json");
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn analyze_build_image(app: tauri::AppHandle, image_path: String) -> Result<String, String> {
    if image_path != BUILD_IMAGE_PATH {
        fs::copy(&image_path, BUILD_IMAGE_PATH)
            .map_err(|e| format!("failed to copy build image to {BUILD_IMAGE_PATH}: {e}"))?;
    }

    let script_path = build_ocr_script_path(&app);
    let output = Command::new("/usr/bin/python3")
        .arg(&script_path)
        .arg(BUILD_IMAGE_PATH)
        .output()
        .map_err(|e| format!("failed to run {}: {e}", script_path.display()))?;

    let stdout = String::from_utf8(output.stdout).map_err(|e| e.to_string())?;
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        log_to_file(&format!("[build-ocr] stderr:\n{}", stderr.trim()));
    }
    if !output.status.success() {
        return Err(format!(
            "build OCR exited with status {}: {}",
            output.status,
            stderr.trim()
        ));
    }

    Ok(stdout.trim().to_string())
}

#[tauri::command]
fn capture_item_name(app: tauri::AppHandle) -> Result<String, String> {
    capture_item_from_warframe(&app)
}

#[tauri::command]
fn search_farm_data(query: String) -> Result<String, String> {
    let query_lower = query.to_lowercase();
    let mut results: Vec<serde_json::Value> = Vec::new();

    let mod_locations = read_json_cached("modLocations.json", &MOD_LOCATIONS_CACHE)?;
    let enemy_locs_ok = read_json_cached("enemyLocations.json", &ENEMY_LOCATIONS_CACHE).ok();
    if let Some(locs) = mod_locations["modLocations"].as_array() {
        for loc in locs {
            let name = loc["modName"].as_str().unwrap_or("");
            if name.to_lowercase().contains(&query_lower) {
                if let Some(enemies) = loc["enemies"].as_array() {
                    for enemy in enemies {
                        let drop_table_chance = enemy["enemyModDropChance"].as_f64().unwrap_or(100.0);
                        let item_chance = enemy["chance"].as_f64().unwrap_or(0.0);
                        let real_chance = drop_table_chance * item_chance / 100.0;
                        let enemy_name = enemy["enemyName"].as_str().unwrap_or("");
                        let enemy_key = enemy_name.to_lowercase();
                        let (planets, tilesets, mission_nodes) =
                            if let Some(locs_data) = &enemy_locs_ok {
                                let entry = &locs_data[&enemy_key];
                                let p: Vec<&str> = entry["planets"]
                                    .as_array()
                                    .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                                    .unwrap_or_default();
                                let t: Vec<&str> = entry["tilesets"]
                                    .as_array()
                                    .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                                    .unwrap_or_default();
                                let mn = entry["mission_nodes"]
                                    .as_array()
                                    .cloned()
                                    .unwrap_or_default();
                                (p, t, mn)
                            } else {
                                (vec![], vec![], vec![])
                            };
                        results.push(serde_json::json!({
                            "source": "enemy",
                            "itemName": name,
                            "location": enemy_name,
                            "chance": real_chance,
                            "itemChance": item_chance,
                            "dropTableChance": drop_table_chance,
                            "rarity": enemy["rarity"].as_str().unwrap_or(""),
                            "extra": "",
                            "planets": planets,
                            "tilesets": tilesets,
                            "missionNodes": mission_nodes,
                        }));
                    }
                }
            }
        }
    }

    let mission_rewards = read_json_cached("missionRewards.json", &MISSION_REWARDS_CACHE)?;
    if let Some(planets) = mission_rewards["missionRewards"].as_object() {
        for (planet, nodes) in planets {
            if let Some(nodes) = nodes.as_object() {
                for (node, info) in nodes {
                    let game_mode = info["gameMode"].as_str().unwrap_or("");
                    if let Some(rotations) = info["rewards"].as_object() {
                        for (rotation, rewards) in rotations {
                            if let Some(rewards) = rewards.as_array() {
                                for reward in rewards {
                                    let item = reward["itemName"].as_str().unwrap_or("");
                                    if item.to_lowercase().contains(&query_lower) {
                                        results.push(serde_json::json!({
                                            "source": "mission",
                                            "itemName": item,
                                            "location": format!("{} — {} ({})", planet, node, game_mode),
                                            "chance": reward["chance"].as_f64().unwrap_or(0.0),
                                            "rarity": reward["rarity"].as_str().unwrap_or(""),
                                            "extra": format!("Rotation {}", rotation)
                                        }));
                                    }
                                }
                            }
                        }
                    } else if let Some(rewards) = info["rewards"].as_array() {
                        for reward in rewards {
                            let item = reward["itemName"].as_str().unwrap_or("");
                            if item.to_lowercase().contains(&query_lower) {
                                results.push(serde_json::json!({
                                    "source": "mission",
                                    "itemName": item,
                                    "location": format!("{} — {} ({})", planet, node, game_mode),
                                    "chance": reward["chance"].as_f64().unwrap_or(0.0),
                                    "rarity": reward["rarity"].as_str().unwrap_or(""),
                                    "extra": ""
                                }));
                            }
                        }
                    }
                }
            }
        }
    }

    let bounty_files = [
        ("cetusBountyRewards", "Cetus Bounty", &CETUS_BOUNTY_CACHE),
        ("solarisBountyRewards", "Fortuna Bounty", &SOLARIS_BOUNTY_CACHE),
        ("zarimanRewards", "Zariman Bounty", &ZARIMAN_BOUNTY_CACHE),
    ];
    for (key, label, cache) in &bounty_files {
        let data = read_json_cached(&format!("{key}.json"), cache)?;
        if let Some(bounties) = data[*key].as_array() {
            for bounty in bounties {
                let level = bounty["bountyLevel"].as_str().unwrap_or("");
                if let Some(rotations) = bounty["rewards"].as_object() {
                    for (rotation, rewards) in rotations {
                        if let Some(rewards) = rewards.as_array() {
                            for reward in rewards {
                                let item = reward["itemName"].as_str().unwrap_or("");
                                if item.to_lowercase().contains(&query_lower) {
                                    results.push(serde_json::json!({
                                        "source": "bounty",
                                        "itemName": item,
                                        "location": format!("{} — {}", label, level),
                                        "chance": reward["chance"].as_f64().unwrap_or(0.0),
                                        "rarity": reward["rarity"].as_str().unwrap_or(""),
                                        "extra": format!(
                                            "Rotation {} / {}",
                                            rotation,
                                            reward["stage"].as_str().unwrap_or("")
                                        )
                                    }));
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let transient_rewards = read_json_cached("transientRewards.json", &TRANSIENT_REWARDS_CACHE)?;
    if let Some(rewards) = transient_rewards["transientRewards"].as_array() {
        for group in rewards {
            let objective = group["objectiveName"].as_str().unwrap_or("");
            if let Some(items) = group["rewards"].as_array() {
                for item in items {
                    let name = item["itemName"].as_str().unwrap_or("");
                    if name.to_lowercase().contains(&query_lower) {
                        results.push(serde_json::json!({
                            "source": "special",
                            "itemName": name,
                            "location": objective,
                            "chance": item["chance"].as_f64().unwrap_or(0.0),
                            "rarity": item["rarity"].as_str().unwrap_or(""),
                            "extra": format!("Rotation {}", item["rotation"].as_str().unwrap_or(""))
                        }));
                    }
                }
            }
        }
    }

    let relics = read_json_cached("relics.json", &RELICS_CACHE)?;
    if let Some(relics) = relics["relics"].as_array() {
        for relic in relics {
            if relic["state"].as_str().unwrap_or("") != "Intact" {
                continue;
            }
            if let Some(rewards) = relic["rewards"].as_array() {
                for reward in rewards {
                    let item = reward["itemName"].as_str().unwrap_or("");
                    if item.to_lowercase().contains(&query_lower) {
                        let tier = relic["tier"].as_str().unwrap_or("");
                        let name = relic["relicName"].as_str().unwrap_or("");
                        results.push(serde_json::json!({
                            "source": "relic",
                            "itemName": item,
                            "location": format!("{} {} Relic", tier, name),
                            "chance": reward["chance"].as_f64().unwrap_or(0.0),
                            "rarity": reward["rarity"].as_str().unwrap_or(""),
                            "extra": ""
                        }));
                    }
                }
            }
        }
    }

    results.sort_by(|a, b| {
        let chance_a = a["chance"].as_f64().unwrap_or(0.0);
        let chance_b = b["chance"].as_f64().unwrap_or(0.0);
        chance_b
            .partial_cmp(&chance_a)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    serde_json::to_string(&results).map_err(|e| e.to_string())
}

fn is_reward_trigger(line: &str) -> bool {
    line.contains("Pause countdown done")
        || line.contains("Got rewards")
        || line.contains("Created /Lotus/Interface/ProjectionRewardChoice.swf")
}

fn start_reward_monitor(app: tauri::AppHandle) {
    thread::spawn(move || {
        log_to_file("[startup] start_reward_monitor iniciado");
        let log_path = get_log_path();
        let mut position: Option<u64> = None;
        let mut last_trigger = Instant::now()
            .checked_sub(Duration::from_secs(60))
            .unwrap_or_else(Instant::now);

        loop {
            thread::sleep(Duration::from_millis(200));

            let Ok(metadata) = fs::metadata(&log_path) else {
                position = None;
                continue;
            };
            let current_len = metadata.len();
            let current_position = position.get_or_insert(current_len);

            if current_len < *current_position {
                *current_position = current_len;
                continue;
            }

            if current_len == *current_position {
                continue;
            }

            let mut file = match File::open(&log_path) {
                Ok(file) => file,
                Err(err) => {
                    eprintln!("[wfhub] Failed to open {}: {err}", log_path.display());
                    continue;
                }
            };

            if let Err(err) = file.seek(SeekFrom::Start(*current_position)) {
                eprintln!(
                    "[wfhub] Failed to seek {} to {}: {err}",
                    log_path.display(),
                    current_position
                );
                continue;
            }
            *current_position = current_len;

            if last_trigger.elapsed() < Duration::from_secs(10) {
                eprintln!("[wfhub] cooldown ativo: {:.1}s restantes",
                    10.0 - last_trigger.elapsed().as_secs_f32());
                continue;
            }

            let mut reward_screen_detected = false;
            let reader = BufReader::new(file);
            for line in reader.lines() {
                match line {
                    Ok(line) if is_reward_trigger(&line) => {
                        reward_screen_detected = true;
                    }
                    Ok(_) => {}
                    Err(err) => {
                        eprintln!("[wfhub] Failed to read EE.log line: {err}");
                    }
                }
            }

            if !reward_screen_detected {
                continue;
            }

            let elapsed = last_trigger.elapsed().as_secs_f32();
            eprintln!("[wfhub] trigger detectado, last_trigger elapsed: {elapsed:.1}s");
            log_to_file(&format!("[monitor] trigger detectado, elapsed: {elapsed:.1}s"));
            last_trigger = Instant::now();
            thread::sleep(Duration::from_millis(1500));

            match run_detection(&app) {
                Ok(Some(payload)) => {
                    log_to_file(&format!("[monitor] show_overlay: {} itens", payload.items.len()));
                    show_overlay(&app, payload);
                }
                Ok(None) => {
                    log_to_file("[monitor] OCR sem partes, overlay não exibido");
                    eprintln!("[wfhub] OCR preprocessing produced no parts");
                }
                Err(err) => {
                    log_to_file(&format!("[monitor] detection failed: {err}"));
                    eprintln!("[wfhub] Detection failed: {err}");
                }
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let toggle_shortcut_id = Shortcut::from_str("CmdOrCtrl+Shift+W")
        .expect("failed to parse toggle shortcut")
        .id();
    let item_search_shortcut_id = Shortcut::from_str("CmdOrCtrl+Shift+3")
        .expect("failed to parse item search shortcut")
        .id();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            fetch_market_orders,
            fetch_market_top,
            fetch_item_info,
            fetch_riven_auctions,
            read_items_list,
            read_all_mods,
            read_mod_names,
            read_item_rarities,
            save_temp_image,
            analyze_build_image,
            capture_item_name,
            search_farm_data,
            forja::start_forja,
            forja::stop_forja,
            inventory::start_inventory_scan,
            inventory::stop_inventory_scan,
            inventory::save_inventory_result,
            inventory::read_inventory,
            inventory::save_prime_parts,
            read_prime_parts,
            read_prices,
            read_enemy_mod_tables,
            read_builds,
            save_build,
            delete_build,
            resolve_build_screenshot_path,
            read_build_screenshot_preview,
            read_hub_state,
            save_hub_settings,
            fetch_hub_worldstate,
            fetch_hub_void_trader_inventory,
            fetch_hub_arbitrations_next_days,
            run_shell_action,
            analyze_riven_image,
            read_riven_weapon_rules
        ])
        .manage(forja::ForjaState::default())
        .manage(inventory::InventoryState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        if shortcut.id() == toggle_shortcut_id {
                            if let Some(window) = app.get_webview_window("main") {
                                toggle_main_window(&window);
                            }
                        } else if shortcut.id() == item_search_shortcut_id {
                            let app_clone = app.clone();
                            thread::spawn(move || {
                                if let Some(win) = app_clone.get_webview_window("main") {
                                    let _ = win.show();
                                    let _ = win.set_focus();
                                }
                                match capture_item_from_warframe(&app_clone) {
                                    Ok(name) => {
                                        log_to_file(&format!("[item-search] OCR name: {name}"));
                                        if let Some(win) = app_clone.get_webview_window("main") {
                                            let _ = win.emit(
                                                "item-search-requested",
                                                serde_json::json!({ "name": name }),
                                            );
                                        }
                                    }
                                    Err(err) => {
                                        log_to_file(&format!("[item-search] OCR failed: {err}"));
                                        eprintln!("[wfhub] item OCR failed: {err}");
                                    }
                                }
                            });
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let app_handle = app.handle().clone();

            // --- Tray icon ---
            let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;
            TrayIconBuilder::new()
                .icon(icon)
                .tooltip("WFHub")
                .on_tray_icon_event(move |_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            toggle_main_window(&window);
                        }
                    }
                })
                .build(app)?;

            // --- Close-requested: esconde em vez de fechar ---
            if let Some(main_window) = app.get_webview_window("main") {
                let win = main_window.clone();
                main_window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win.hide();
                    }
                });
            }

            // --- Global hotkeys ---
            app.handle().global_shortcut().register("CmdOrCtrl+Shift+W")?;
            app.handle().global_shortcut().register("CmdOrCtrl+Shift+3")?;

            start_reward_monitor(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running WFHub");
}
