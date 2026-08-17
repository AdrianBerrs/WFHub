mod inventory;
mod ocr;
mod theme;

use tauri::AppHandle;

use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader, BufWriter, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    process::{Command as SyncCommand, Stdio},
    str::FromStr,
    sync::{LazyLock, Mutex, OnceLock},
    thread,
    time::{Duration, Instant},
};

use image::DynamicImage;
use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewWindow,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use xcap::Window as CaptureWindow;

static EXITING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

const REWARD_FILE: &str = "/tmp/wfhub_reward.json";
const REWARD_HISTORY_FILE: &str = "reward_history.json";
const MAX_REWARD_HISTORY: usize = 100;
static CONFIG_LOG_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);

fn config_path() -> PathBuf {
    data_path("config.json")
}

fn read_config_file() -> serde_json::Value {
    fs::read_to_string(config_path())
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .unwrap_or_else(|| serde_json::Value::Object(serde_json::Map::new()))
}

fn read_log_path_from_config() -> PathBuf {
    let config = read_config_file();
    config["log_path"]
        .as_str()
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .unwrap_or_default()
}

pub fn get_log_path() -> PathBuf {
    if let Some(path) = CONFIG_LOG_PATH.lock().unwrap().clone() {
        return path;
    }
    let path = read_log_path_from_config();
    *CONFIG_LOG_PATH.lock().unwrap() = Some(path.clone());
    path
}

fn set_log_path(path: &str) {
    *CONFIG_LOG_PATH.lock().unwrap() = Some(PathBuf::from(path));
}


const WARFRAME_WINDOW_NAME: &str = "Warframe";
const BUILD_IMAGE_PATH: &str = "/tmp/wfhub_build_input.png";
const RIVEN_IMAGE_PATH: &str = "/tmp/wfhub_riven_input.png";
const MARKET_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const HUB_STATE_FILE: &str = "hub_state.json";
const VOID_TRADER_INVENTORY_CACHE_FILE: &str = "void_trader_last_inventory.json";
const DEFAULT_HUB_REFRESH_SECONDS: u64 = 60;
const MIN_HUB_REFRESH_SECONDS: u64 = 15;
const MAX_HUB_REFRESH_SECONDS: u64 = 600;
const MAX_SAVED_BUILDS: usize = 20;
const WFMARKET_AUTH_FILE: &str = "wfmarket_auth.json";
const WFMARKET_API_BASE: &str = "https://api.warframe.market/v1";

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
struct WfMarketAuth {
    jwt: String,
    username: String,
    csrf_token: String,
}

fn extract_csrf_from_jwt(jwt: &str) -> Option<String> {
    use base64::Engine;
    let parts: Vec<&str> = jwt.split('.').collect();
    if parts.len() != 3 { return None; }
    let payload = parts[1];
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let json: serde_json::Value = serde_json::from_slice(&decoded).ok()?;
    json.get("csrf_token")?.as_str().map(|s| s.to_string())
}

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
static MOD_RANKS_CACHE: OnceLock<String> = OnceLock::new();
static MISSION_REWARDS_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static CETUS_BOUNTY_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static SOLARIS_BOUNTY_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static ZARIMAN_BOUNTY_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static TRANSIENT_REWARDS_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static RELICS_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static ENEMY_LOCATIONS_CACHE: OnceLock<serde_json::Value> = OnceLock::new();
static PRIME_PARTS_CACHE: OnceLock<String> = OnceLock::new();
static DUCAT_VALUES_CACHE: OnceLock<String> = OnceLock::new();
static PRIME_VAULT_CACHE: OnceLock<String> = OnceLock::new();
static MOD_META_CACHE: OnceLock<String> = OnceLock::new();
static BARO_NAME_MAP_CACHE: OnceLock<HashMap<String, String>> = OnceLock::new();

#[derive(Deserialize, Serialize, Clone, Debug)]
struct RewardItem {
    name: String,
    platinum: f32,
    is_best: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct RewardPayload {
    #[serde(default)]
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
    #[serde(default)]
    attacker_reward: String,
    #[serde(default)]
    defender_reward: String,
    expires_at_ms: i64,
    #[serde(default)]
    completion_pct: f64,
    #[serde(default)]
    count: i64,
    #[serde(default)]
    required_runs: i64,
    #[serde(default)]
    completed: bool,
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
struct HubSortieMission {
    mission_type: String,
    node: String,
    modifier: String,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct HubSortie {
    boss: String,
    faction: String,
    expires_at_ms: i64,
    missions: Vec<HubSortieMission>,
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
    sortie: Option<HubSortie>,
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

#[derive(Serialize, Clone, Debug)]
struct WeeklyMission {
    mission_type: String,
    node: String,
    modifier: String,
}

#[derive(Serialize, Clone, Debug)]
struct WeeklyArchonHunt {
    boss: String,
    faction: String,
    expires_at_ms: i64,
    missions: Vec<WeeklyMission>,
}

#[derive(Serialize, Clone, Debug)]
struct WeeklyArchimedeaRisk {
    name: String,
    description: String,
    is_hard: bool,
}

#[derive(Serialize, Clone, Debug)]
struct WeeklyArchimedeaMission {
    mission_type: String,
    faction: String,
    deviation: String,
    #[serde(default)]
    deviation_description: String,
    risks: Vec<WeeklyArchimedeaRisk>,
}

#[derive(Serialize, Clone, Debug)]
struct WeeklyModifier {
    name: String,
    description: String,
}

#[derive(Serialize, Clone, Debug)]
struct WeeklyArchimedea {
    type_name: String,
    expires_at_ms: i64,
    missions: Vec<WeeklyArchimedeaMission>,
    personal_modifiers: Vec<WeeklyModifier>,
}

#[derive(Serialize, Clone, Debug)]
struct WeeklyCircuitChoices {
    category: String,
    choices: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
struct WeeklySteelPathReward {
    name: String,
    cost: i64,
}

#[derive(Serialize, Clone, Debug)]
struct WeeklySteelPath {
    current_reward: WeeklySteelPathReward,
    rotation: Vec<WeeklySteelPathReward>,
    evergreens: Vec<WeeklySteelPathReward>,
    expires_at_ms: i64,
}

#[derive(Serialize, Clone, Debug)]
struct WeeklyState {
    fetched_at_ms: i64,
    weekly_reset_ms: i64,
    archon_hunt: Option<WeeklyArchonHunt>,
    sortie: Option<WeeklyArchonHunt>,
    archimedeas: Vec<WeeklyArchimedea>,
    circuit_normal: Option<WeeklyCircuitChoices>,
    circuit_hard: Option<WeeklyCircuitChoices>,
    steel_path: Option<WeeklySteelPath>,
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
        use std::time::{SystemTime, UNIX_EPOCH};
        let secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let h = (secs / 3600) % 24;
        let m = (secs / 60) % 60;
        let s = secs % 60;
        let _ = writeln!(f, "[{h:02}:{m:02}:{s:02}] {msg}");
    }
}

struct OcrDaemon {
    _process: std::process::Child,
    writer: BufWriter<std::process::ChildStdin>,
    reader: BufReader<std::process::ChildStdout>,
}

static OCR_DAEMON: Mutex<Option<OcrDaemon>> = Mutex::new(None);

fn init_ocr_daemon(app: &tauri::AppHandle) {
    if OCR_DAEMON.lock().unwrap().is_some() {
        return;
    }
    let script_path = ocr_script_path(app);
    log_to_file(&format!("[ocr_daemon] iniciando: {}", script_path.display()));
    let mut child = match SyncCommand::new(python_binary(app))
        .arg(&script_path)
        .arg("--daemon")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            log_to_file(&format!("[ocr_daemon] falha ao spawnar: {e}"));
            return;
        }
    };

    let stdin = match child.stdin.take() {
        Some(s) => s,
        None => {
            log_to_file("[ocr_daemon] stdin indisponível");
            return;
        }
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            log_to_file("[ocr_daemon] stdout indisponível");
            return;
        }
    };
    if let Some(stderr) = child.stderr.take() {
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                log_to_file(&format!("[ocr_py] {line}"));
            }
        });
    }

    let mut reader = BufReader::new(stdout);
    let mut ready_line = String::new();
    match reader.read_line(&mut ready_line) {
        Ok(0) => {
            log_to_file("[ocr_daemon] processo encerrou antes de READY");
            return;
        }
        Err(e) => {
            log_to_file(&format!("[ocr_daemon] erro lendo READY: {e}"));
            return;
        }
        Ok(_) => {}
    }

    let signal = ready_line.trim();
    if signal != "READY" {
        log_to_file(&format!("[ocr_daemon] sinal inesperado: '{signal}'"));
        return;
    }

    log_to_file("[ocr_daemon] pronto");
    *OCR_DAEMON.lock().unwrap() = Some(OcrDaemon {
        _process: child,
        writer: BufWriter::new(stdin),
        reader,
    });
}

fn call_ocr_daemon(image_path: &str, app: &tauri::AppHandle) -> Result<String, String> {
    let mut guard = OCR_DAEMON.lock().map_err(|e| e.to_string())?;

    if guard.is_none() {
        drop(guard);
        log_to_file("[ocr_daemon] não inicializado, reiniciando...");
        init_ocr_daemon(app);
        return Err("daemon não estava pronto, reiniciado".to_string());
    }

    let daemon = guard.as_mut().unwrap();
    let io_result = (|| -> std::io::Result<String> {
        writeln!(daemon.writer, "{}", image_path)?;
        daemon.writer.flush()?;
        let mut line = String::new();
        daemon.reader.read_line(&mut line)?;
        Ok(line)
    })();

    match io_result {
        Ok(line) if !line.trim().is_empty() => Ok(line),
        Ok(_) => {
            // daemon encerrou stdin sem responder
            *guard = None;
            drop(guard);
            log_to_file("[ocr_daemon] sem resposta, reiniciando...");
            init_ocr_daemon(app);
            Err("daemon reiniciado após resposta vazia".to_string())
        }
        Err(e) => {
            *guard = None;
            drop(guard);
            log_to_file(&format!("[ocr_daemon] erro de IO: {e}, reiniciando..."));
            init_ocr_daemon(app);
            Err(format!("daemon reiniciado após erro: {e}"))
        }
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

/// Eleva o overlay acima de jogos em borderless/fullscreen no macOS.
/// - NSPopUpMenuWindowLevel (101): acima de qualquer janela de app
/// - NSWindowCollectionBehaviorCanJoinAllSpaces (1): aparece no Space do jogo em fullscreen nativo
/// DEVE ser chamado via run_on_main_thread (AppKit requer main thread).
#[cfg(target_os = "macos")]
fn set_overlay_window_level(window: &WebviewWindow) {
    use objc::{msg_send, sel, sel_impl, runtime::Object};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    let Ok(handle) = window.window_handle() else { return };
    let RawWindowHandle::AppKit(h) = handle.as_ref() else { return };
    unsafe {
        let ns_view = h.ns_view.as_ptr() as *mut Object;
        let ns_window: *mut Object = msg_send![ns_view, window];
        if ns_window.is_null() { return; }
        // NSScreenSaverWindowLevel = 1000, acima de qualquer janela de app
        let _: () = msg_send![ns_window, setLevel: 1000i64];
        // Preserva comportamentos existentes e adiciona CanJoinAllSpaces (bit 0)
        let current: u64 = msg_send![ns_window, collectionBehavior];
        let _: () = msg_send![ns_window, setCollectionBehavior: current | 1u64];
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

    // Usa o monitor mais largo (onde o jogo provavelmente está rodando)
    let target_monitor = overlay
        .available_monitors()
        .ok()
        .and_then(|monitors| monitors.into_iter().max_by_key(|m| m.size().width));

    if let Some(monitor) = target_monitor {
        let scale = monitor.scale_factor();
        let phys_size = monitor.size();
        let phys_pos = monitor.position();
        let logical_width = phys_size.width as f64 / scale;
        let logical_height = phys_size.height as f64 / scale;
        let logical_x = phys_pos.x as f64 / scale;
        let logical_y = phys_pos.y as f64 / scale;
        let overlay_w = 964.0_f64;
        let overlay_h = 310.0_f64;
        let x = logical_x + (logical_width - overlay_w) / 2.0;
        let y = logical_y + logical_height - overlay_h - 40.0;
        let _ = overlay.set_position(tauri::LogicalPosition::new(x, y));
        let _ = overlay.set_size(tauri::LogicalSize::new(overlay_w, overlay_h));
    } else {
        let _ = overlay.set_size(tauri::LogicalSize::new(964.0, 310.0));
    }

    let _ = overlay.emit("reward-detected", &payload);
    let _ = overlay.show();
    // Não chama set_always_on_top aqui — ele usa NSRunLoop e pode sobrescrever
    // o setLevel:1000 do ObjC que roda via GCD (run_on_main_thread)
    #[cfg(target_os = "macos")]
    {
        let overlay_main = overlay.clone();
        let _ = overlay.run_on_main_thread(move || {
            set_overlay_window_level(&overlay_main);
        });
    }

    // Auto-hide after 15 seconds
    let overlay_clone = overlay.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(15));
        let _ = overlay_clone.emit("hide-overlay", ());
        let _ = overlay_clone.hide();
    });
}

fn show_trade_overlay(app: &tauri::AppHandle, payload: TradeSuccessPayload) {
    let overlay = match app.get_webview_window("overlay") {
        Some(w) => w,
        None => {
            eprintln!("[wfhub] ERROR: overlay window not found!");
            return;
        }
    };

    let target_monitor = overlay
        .available_monitors()
        .ok()
        .and_then(|monitors| monitors.into_iter().max_by_key(|m| m.size().width));

    if let Some(monitor) = target_monitor {
        let scale = monitor.scale_factor();
        let phys_size = monitor.size();
        let phys_pos = monitor.position();
        let logical_width = phys_size.width as f64 / scale;
        let logical_height = phys_size.height as f64 / scale;
        let logical_x = phys_pos.x as f64 / scale;
        let logical_y = phys_pos.y as f64 / scale;
        let overlay_w = 480.0_f64;
        let overlay_h = 200.0_f64;
        let x = logical_x + logical_width - overlay_w - 20.0;
        let y = logical_y + logical_height - overlay_h - 60.0;
        let _ = overlay.set_position(tauri::LogicalPosition::new(x, y));
        let _ = overlay.set_size(tauri::LogicalSize::new(overlay_w, overlay_h));
    } else {
        let _ = overlay.set_size(tauri::LogicalSize::new(480.0, 200.0));
    }

    let _ = overlay.emit("trade-success", &payload);
    let _ = overlay.show();
    #[cfg(target_os = "macos")]
    {
        let overlay_main = overlay.clone();
        let _ = overlay.run_on_main_thread(move || {
            set_overlay_window_level(&overlay_main);
        });
    }
}

fn append_reward_history(payload: &RewardPayload) {
    let path = data_path(REWARD_HISTORY_FILE);
    let mut history: Vec<RewardPayload> = path
        .exists()
        .then(|| fs::read_to_string(&path).ok())
        .flatten()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    history.insert(0, payload.clone());
    history.truncate(MAX_REWARD_HISTORY);
    if let Ok(json) = serde_json::to_string(&history) {
        let _ = fs::write(&path, json);
    }
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

// Resolved once at startup: the repo's data/ in dev, the writable app-data
// directory in a bundled app (seeded from the bundled resources).
static DATA_DIR: Mutex<Option<PathBuf>> = Mutex::new(None);

pub fn set_data_dir(path: PathBuf) {
    *DATA_DIR.lock().unwrap() = Some(path);
}

pub fn data_dir() -> PathBuf {
    if let Some(path) = DATA_DIR.lock().unwrap().clone() {
        return path;
    }
    project_root().join("data")
}

pub fn data_path(path: &str) -> PathBuf {
    data_dir().join(path)
}

// Resolve a project-relative file (e.g. a script) to a path that works both in
// dev (repo) and in a bundled app (resources directory).
pub fn resource_path(app: &tauri::AppHandle, relative: &str) -> PathBuf {
    let dev_path = project_root().join(relative);
    if dev_path.exists() {
        return dev_path;
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled_path = resource_dir.join(relative);
        if bundled_path.exists() {
            return bundled_path;
        }
    }

    dev_path
}

// Resolve the Python interpreter: prefer the bundled CPython (repo python/ in
// dev, resources python/ in a bundle) so pyobjc/numpy/Pillow are always
// available without a manual install; fall back to the system /usr/bin/python3.
pub fn python_binary(app: &tauri::AppHandle) -> PathBuf {
    let dev_path = project_root().join("python/bin/python3");
    if dev_path.exists() {
        return dev_path;
    }

    if let Ok(resource_dir) = app.path().resource_dir() {
        let bundled_path = resource_dir.join("python/bin/python3");
        if bundled_path.exists() {
            return bundled_path;
        }
    }

    PathBuf::from("/usr/bin/python3")
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
    resource_path(app, "scripts/ocr/ocr_vision.py")
}

fn build_ocr_script_path(app: &tauri::AppHandle) -> PathBuf {
    resource_path(app, "scripts/ocr/ocr_vision_build.py")
}

fn riven_ocr_script_path(app: &tauri::AppHandle) -> PathBuf {
    resource_path(app, "scripts/ocr/ocr_vision_riven.py")
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
    let _parts = ocr::extract_parts(&image, theme);
    log_to_file(&format!("[run_detection] partes extraídas: {}", _parts.len()));

    log_to_file("[run_detection] chamando daemon OCR...");
    let json_line = match call_ocr_daemon("/tmp/wfinfo_prefilter.png", app) {
        Ok(line) => line,
        Err(e) => {
            log_to_file(&format!("[run_detection] daemon indisponível: {e}"));
            return Ok(None);
        }
    };

    let payload: RewardPayload = match serde_json::from_str(json_line.trim()) {
        Ok(p) => p,
        Err(e) => {
            log_to_file(&format!("[run_detection] erro ao parsear JSON do daemon: {e}\nJSON: {json_line}"));
            return Ok(None);
        }
    };

    if payload.items.is_empty() {
        log_to_file("[run_detection] daemon retornou 0 itens");
        return Ok(None);
    }

    log_to_file(&format!("[run_detection] payload OK: {} itens", payload.items.len()));
    Ok(Some(payload))
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
fn read_mod_ranks() -> Result<String, String> {
    read_text_cached("mod_ranks.json", &MOD_RANKS_CACHE)
}

#[tauri::command]
fn read_items_prices() -> Result<String, String> {
    fs::read_to_string(data_path("items_prices.json")).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_item_price(name: String, buy: Option<f64>, sell: Option<f64>) -> Result<(), String> {
    let path = data_path("items_prices.json");
    let mut map: std::collections::HashMap<String, serde_json::Value> =
        serde_json::from_str(&fs::read_to_string(&path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;

    let now = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();

    let entry = map.entry(name.clone()).or_insert_with(|| serde_json::json!({
        "avg": null, "buy": null, "sell": null, "ducats": null
    }));

    if let Some(obj) = entry.as_object_mut() {
        if let Some(b) = buy {
            obj.insert("buy".into(), serde_json::json!(b));
        }
        if let Some(s) = sell {
            obj.insert("sell".into(), serde_json::json!(s));
        }
        obj.insert("updated_at".into(), serde_json::json!(now));
    }

    let tmp_path = std::path::PathBuf::from("/tmp/.items_prices.json.tmp");
    let content = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
    fs::write(&tmp_path, &content).map_err(|e| e.to_string())?;
    fs::rename(&tmp_path, &path).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn read_mod_images() -> Result<String, String> {
    fs::read_to_string(data_path("mod_images.json")).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_arcane_images() -> Result<String, String> {
    fs::read_to_string(data_path("arcane_images.json")).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_prime_parts() -> Result<String, String> {
    read_text_cached("prime_parts.json", &PRIME_PARTS_CACHE)
}

#[tauri::command]
fn read_circuit_images() -> Result<String, String> {
    fs::read_to_string(data_path("circuit_images.json")).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_ducat_values() -> Result<String, String> {
    read_text_cached("ducat_values.json", &DUCAT_VALUES_CACHE)
}

#[tauri::command]
fn read_prime_vault() -> Result<String, String> {
    read_text_cached("prime_vault.json", &PRIME_VAULT_CACHE)
}

#[tauri::command]
fn read_mod_meta() -> Result<String, String> {
    read_text_cached("mod_meta.json", &MOD_META_CACHE)
}

#[tauri::command]
fn read_prices() -> Result<String, String> {
    read_text_cached("prices.json", &PRICES_CACHE)
}

#[tauri::command]
fn read_reward_history() -> Result<String, String> {
    let path = data_path(REWARD_HISTORY_FILE);
    if !path.exists() {
        return Ok("[]".to_string());
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_enemy_mod_tables() -> Result<String, String> {
    read_text_cached("enemyModTables.json", &ENEMY_MOD_TABLES_CACHE)
}

#[tauri::command]
fn read_builds() -> Result<String, String> {
    let path = data_path("builds.json");
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

    let images_dir = data_path("build_images");
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

    Some(data_path(rel_path.to_string_lossy().as_ref()))
}

fn collect_screenshot_paths(builds: &[serde_json::Value]) -> Vec<PathBuf> {
    builds
        .iter()
        .filter_map(|build| build["screenshot_rel_path"].as_str())
        .filter_map(build_screenshot_path_if_valid)
        .collect()
}

#[tauri::command]
fn test_overlay(app: tauri::AppHandle) {
    let payload = RewardPayload {
        timestamp: "test".to_string(),
        items: vec![
            RewardItem { name: "Ash Prime Neuroptics".to_string(), platinum: 45.0, is_best: true },
            RewardItem { name: "Volt Prime Chassis".to_string(), platinum: 12.0, is_best: false },
            RewardItem { name: "Forma Blueprint".to_string(), platinum: 2.0, is_best: false },
            RewardItem { name: "Orokin Cell".to_string(), platinum: 5.0, is_best: false },
        ],
    };
    show_overlay(&app, payload);
}

#[tauri::command]
fn test_trade_overlay(app: tauri::AppHandle) {
    let payload = TradeSuccessPayload {
        items: vec!["Baruuk Prime Neuroptics Blueprint".to_string()],
        buyer: "Bizuaxd".to_string(),
        platinum: 25,
    };
    show_trade_overlay(&app, payload);
}

#[tauri::command]
fn test_trade_overlay_set(app: tauri::AppHandle) {
    let payload = TradeSuccessPayload {
        items: vec![
            "Baruuk Prime Neuroptics Blueprint".to_string(),
            "Baruuk Prime Chassis Blueprint".to_string(),
            "Baruuk Prime Systems Blueprint".to_string(),
            "Baruuk Prime Blueprint".to_string(),
        ],
        buyer: "Bizuaxd".to_string(),
        platinum: 70,
    };
    show_trade_overlay(&app, payload);
}

#[tauri::command]
fn hide_overlay_window(app: tauri::AppHandle) {
    if let Some(overlay) = app.get_webview_window("overlay") {
        let _ = overlay.hide();
    }
}

#[tauri::command]
fn save_build(
    name: String,
    items: Vec<String>,
    image_path: Option<String>,
    related_entity: Option<String>,
    related_entity_kind: Option<String>,
) -> Result<(), String> {
    let path = data_path("builds.json");
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
        "related_entity": related_entity,
        "related_entity_kind": related_entity_kind,
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
    let path = data_path("builds.json");
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

#[derive(Clone, Serialize)]
struct ShellProgressPayload {
    action: String,
    line: String,
    done: bool,
}

#[tauri::command]
async fn run_shell_action(app: AppHandle, action: String) -> Result<ShellCommandResult, String> {
    let script = match action.as_str() {
        "run_update_script" => resource_path(&app, "update.sh"),
        "update_prices" => resource_path(&app, "update_prices.sh"),
        _ => return Err(format!("ação desconhecida: {action}")),
    };
    if !script.exists() {
        return Err(format!("Script não encontrado em {}", script.display()));
    }

    let mut cmd = tokio::process::Command::new(
        if action == "update_prices" { "sh" } else { script.to_str().unwrap_or("") }
    );
    cmd.current_dir(data_dir());
    cmd.env("WFHUB_DATA_DIR", data_dir());
    cmd.env("WFHUB_PYTHON", python_binary(&app));
    if action == "update_prices" {
        cmd.arg(script.to_string_lossy().as_ref());
    }

    let mut child = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e: std::io::Error| format!("falha ao executar: {e}"))?;

    let stdout = child.stdout.take()
        .ok_or_else(|| "stdout not available".to_string())?;
    let stderr = child.stderr.take()
        .ok_or_else(|| "stderr not available".to_string())?;

    use tokio::io::AsyncBufReadExt;

    let mut out_lines = Vec::new();
    let mut out_reader = tokio::io::BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        let n = out_reader.read_line(&mut line).await
            .map_err(|e: std::io::Error| e.to_string())?;
        if n == 0 { break; }
        let trimmed = line.trim_end().to_string();
        out_lines.push(trimmed.clone());
        let _ = app.emit("shell-progress", ShellProgressPayload {
            action: action.clone(),
            line: trimmed,
            done: false,
        });
    }

    let mut err_lines = Vec::new();
    let mut err_reader = tokio::io::BufReader::new(stderr);
    let mut line = String::new();
    loop {
        line.clear();
        let n = err_reader.read_line(&mut line).await
            .map_err(|e: std::io::Error| e.to_string())?;
        if n == 0 { break; }
        err_lines.push(line.trim_end().to_string());
    }

    let status = child.wait().await.map_err(|e: std::io::Error| e.to_string())?;
    let _ = app.emit("shell-progress", ShellProgressPayload {
        action,
        line: String::new(),
        done: true,
    });

    let stdout = out_lines.join("\n");
    let stderr = err_lines.join("\n");

    Ok(ShellCommandResult {
        success: status.success(),
        code: status.code(),
        stdout: stdout.trim().to_string(),
        stderr: stderr.trim().to_string(),
    })
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

fn wfmarket_auth_path() -> PathBuf {
    data_path(WFMARKET_AUTH_FILE)
}

fn read_wfmarket_auth_file() -> WfMarketAuth {
    let path = wfmarket_auth_path();
    if !path.exists() {
        return WfMarketAuth::default();
    }
    serde_json::from_str(&fs::read_to_string(path).unwrap_or_default()).unwrap_or_default()
}

fn write_wfmarket_auth_file(auth: &WfMarketAuth) -> Result<(), String> {
    let json = serde_json::to_string_pretty(auth).map_err(|e| e.to_string())?;
    fs::write(wfmarket_auth_path(), json).map_err(|e| e.to_string())
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

fn wfstat_side_reward(side: &serde_json::Value) -> String {
    let items = side.pointer("/reward/countedItems")
        .and_then(|v| v.as_array());
    if let Some(items) = items {
        let parts: Vec<String> = items.iter().filter_map(|item| {
            let name = item.get("type").and_then(|v| v.as_str())?;
            let count = item.get("count").and_then(|v| v.as_i64()).unwrap_or(1);
            Some(if count > 1 { format!("{count}x {name}") } else { name.to_string() })
        }).collect();
        if !parts.is_empty() {
            return parts.join(", ");
        }
    }
    let credits = side.pointer("/reward/credits").and_then(|v| v.as_i64()).unwrap_or(0);
    if credits > 0 { return format!("{credits} Credits"); }
    "Battle Pay".to_string()
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

fn humanize_sortie_boss(raw: &str) -> String {
    let stripped = raw.replace("SORTIE_BOSS_", "");
    match stripped.as_str() {
        "ALAD_V" => return "Alad V".to_string(),
        "LECH_KRIL" | "LIEUTENANT_LECH_KRIL" => return "Lech Kril".to_string(),
        "TYL_REGOR" => return "Tyl Regor".to_string(),
        "GENERAL_SARGAS_RUK" => return "Sargas Ruk".to_string(),
        "KELA_DE_THAYM" => return "Kela De Thaym".to_string(),
        "AMBULAS" => return "Ambulas".to_string(),
        "VOR" => return "Vor".to_string(),
        "NEF" | "NEF_ANYO" => return "Nef Anyo".to_string(),
        "CORRUPTED_VOR" => return "Corrupted Vor".to_string(),
        "THE_SERGEANT" => return "The Sergeant".to_string(),
        "COUNCILOR_VAY_HEK" => return "Vay Hek".to_string(),
        "RAPTOR" => return "Raptor".to_string(),
        "JORDAS_GOLEM" | "JORDAS" => return "Jordas Golem".to_string(),
        "PHORID" => return "Phorid".to_string(),
        "HYENA" | "HYENA_PACK" => return "Hyena Pack".to_string(),
        _ => {}
    }
    stripped
        .split('_')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().to_string() + &chars.as_str().to_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn faction_from_tileset(tileset: &str) -> Option<&'static str> {
    let t = tileset.to_lowercase();
    if t.contains("corpus") { return Some("Corpus"); }
    if t.contains("grineer") { return Some("Grineer"); }
    if t.contains("infest") { return Some("Infested"); }
    if t.contains("orokin") { return Some("Corrupted"); }
    None
}

fn faction_from_boss(boss_raw: &str) -> Option<&'static str> {
    let stripped = boss_raw.replace("SORTIE_BOSS_", "");
    match stripped.as_str() {
        "NEF" | "NEF_ANYO" | "ALAD_V" | "THE_SERGEANT" | "AMBULAS" | "RAPTOR" | "HYENA" | "HYENA_PACK" => Some("Corpus"),
        "LECH_KRIL" | "LIEUTENANT_LECH_KRIL" | "TYL_REGOR" | "GENERAL_SARGAS_RUK" | "KELA_DE_THAYM" | "COUNCILOR_VAY_HEK" | "VOR" => Some("Grineer"),
        "JORDAS_GOLEM" | "JORDAS" | "PHORID" => Some("Infested"),
        "CORRUPTED_VOR" => Some("Corrupted"),
        _ => None,
    }
}

fn humanize_sortie_modifier(raw: &str) -> String {
    let stripped = raw.replace("SORTIE_MODIFIER_", "");
    match stripped.as_str() {
        "EXIMUS_STRONGHOLD" | "EXIMUS" => return "Eximus Stronghold".to_string(),
        "SNIPER_ONLY" => return "Sniper Only".to_string(),
        "SHOTGUN_ONLY" => return "Shotgun Only".to_string(),
        "ASSAULT_RIFLE_ONLY" => return "Rifle Only".to_string(),
        "ENERGY_REDUCTION" | "LOW_ENERGY" => return "Energy Reduction".to_string(),
        "SHIELD_DISABLE" => return "Shields Disabled".to_string(),
        "MELEE_ONLY" => return "Melee Only".to_string(),
        "PISTOL_ONLY" => return "Pistol Only".to_string(),
        "BOW_ONLY" => return "Bow Only".to_string(),
        "ARMOR_REDUCTION" => return "Armor Reduction".to_string(),
        "HAZARD_RADIATION" => return "Radiation Hazard".to_string(),
        "HAZARD_COLD" => return "Cryogenic Leakage".to_string(),
        "HAZARD_FIRE" => return "Fire Fissures".to_string(),
        "HAZARD_MAGNETIC" => return "Magnetic Anomaly".to_string(),
        "HAZARD_ELECTRICITY" => return "Electrical Hazard".to_string(),
        "HAZARD_TOXIN" => return "Toxic Gas".to_string(),
        "LOW_GRAVITY" => return "Low Gravity".to_string(),
        _ => {}
    }
    stripped
        .split('_')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(c) => c.to_uppercase().to_string() + &chars.as_str().to_lowercase(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn parse_sortie_from_worldstate(
    worldstate: &serde_json::Value,
    now_ms: i64,
    export_regions: Option<&serde_json::Value>,
    dict: Option<&serde_json::Value>,
) -> Option<HubSortie> {
    let entry = worldstate
        .get("Sorties")
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|item| {
                    let end = item.get("Expiry").and_then(mongo_date_to_ms).unwrap_or(0);
                    now_ms < end
                })
                .or_else(|| arr.last())
        })?;

    let expires_at_ms = entry
        .get("Expiry")
        .and_then(mongo_date_to_ms)
        .unwrap_or(now_ms + 86_400_000);
    let boss_raw = entry.get("Boss").and_then(|v| v.as_str()).unwrap_or("");
    let boss = humanize_sortie_boss(boss_raw);

    let mission_array = entry
        .get("Variants")
        .and_then(|v| v.as_array())
        .or_else(|| entry.get("Missions").and_then(|v| v.as_array()));

    // Derive faction from Faction field, first variant's tileset, or boss name
    let faction = entry
        .get("Faction")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| humanize_faction(s))
        .or_else(|| {
            mission_array
                .and_then(|arr| arr.first())
                .and_then(|m| m.get("tileset"))
                .and_then(|v| v.as_str())
                .and_then(faction_from_tileset)
                .map(|s| s.to_string())
        })
        .or_else(|| faction_from_boss(boss_raw).map(|s| s.to_string()))
        .unwrap_or_else(|| "Unknown".to_string());

    let missions = mission_array
        .map(|missions| {
            missions
                .iter()
                .map(|mission| {
                    let mission_type = mission
                        .get("missionType")
                        .and_then(|v| v.as_str())
                        .map(humanize_mission_type)
                        .unwrap_or_else(|| "Mission".to_string());
                    let node = mission
                        .get("node")
                        .and_then(|v| v.as_str())
                        .map(|node| resolve_node_label(node, export_regions, dict))
                        .unwrap_or_else(|| "Unknown".to_string());
                    let modifier = mission
                        .get("modifierType")
                        .and_then(|v| v.as_str())
                        .map(humanize_sortie_modifier)
                        .unwrap_or_else(|| "—".to_string());
                    HubSortieMission { mission_type, node, modifier }
                })
                .collect()
        })
        .unwrap_or_default();

    Some(HubSortie { boss, faction, expires_at_ms, missions })
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
        .get("https://oracle.browse.wf/worldState.min.json")
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

    // Fetch completion data from warframestat (oracle.browse.wf não tem esses campos)
    let wfstat_invasions: HashMap<String, serde_json::Value> = {
        let arr: Vec<serde_json::Value> = match client
            .get("https://api.warframestat.us/pc/invasions")
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(resp) => resp.json::<Vec<serde_json::Value>>().await.unwrap_or_default(),
            Err(_) => vec![],
        };
        arr.into_iter()
            .filter_map(|item| {
                let id = item.get("id")?.as_str()?.to_string();
                Some((id, item))
            })
            .collect()
    };

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
                    id: id.clone(),
                    location: maybe_tenno_invasion
                        .and_then(|entry| entry.get("location"))
                        .and_then(|v| v.as_str())
                        .map(|v| v.to_string())
                        .or_else(|| item.get("node").and_then(|v| v.as_str()).map(humanize_node))
                        .unwrap_or_else(|| "Nodo desconhecido".to_string()),
                    attacker,
                    defender,
                    reward,
                    attacker_reward: wfstat_invasions.get(&id)
                        .and_then(|w| w.get("attacker"))
                        .map(wfstat_side_reward).unwrap_or_default(),
                    defender_reward: wfstat_invasions.get(&id)
                        .and_then(|w| w.get("defender"))
                        .map(wfstat_side_reward).unwrap_or_default(),
                    expires_at_ms: invasion_expiry,
                    completion_pct: wfstat_invasions.get(&id)
                        .and_then(|w| w.get("completion")).and_then(|v| v.as_f64()).unwrap_or(0.0),
                    count: wfstat_invasions.get(&id)
                        .and_then(|w| w.get("count")).and_then(|v| v.as_i64()).unwrap_or(0),
                    required_runs: wfstat_invasions.get(&id)
                        .and_then(|w| w.get("requiredRuns")).and_then(|v| v.as_i64()).unwrap_or(0),
                    completed: wfstat_invasions.get(&id)
                        .and_then(|w| w.get("completed")).and_then(|v| v.as_bool()).unwrap_or(false),
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

    let sortie = parse_sortie_from_worldstate(
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
        sortie,
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
                        attacker_reward: String::new(),
                        defender_reward: String::new(),
                        expires_at_ms: item
                            .get("start")
                            .and_then(|v| v.as_i64())
                            .map(|start| (start + 86_400) * 1000)
                            .unwrap_or(now + 3_600_000),
                        completion_pct: 0.0,
                        count: 0,
                        required_runs: 0,
                        completed: false,
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
    let sortie = None;

    Ok(HubSnapshot {
        source: "tenno.tools".to_string(),
        fetched_at_ms: now,
        worlds,
        alerts,
        invasions,
        news,
        arbitration,
        sortie,
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

fn next_weekly_reset_ms(now: i64) -> i64 {
    use chrono::Datelike;
    // Warframe weekly reset: Monday 00:00 UTC
    let dt = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now).unwrap_or_default();
    let mut days_until_monday = (7 - dt.weekday().num_days_from_monday()) % 7;
    // Se hoje é segunda, o reset de hoje já passou → próximo reset é a próxima segunda
    if days_until_monday == 0 {
        days_until_monday = 7;
    }
    let next = dt
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .unwrap_or_default()
        .checked_add_days(chrono::Days::new(days_until_monday as u64))
        .unwrap_or_default();
    next.and_utc().timestamp_millis()
}

fn parse_iso_ms(raw: Option<&str>) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw?).ok().map(|dt| dt.timestamp_millis())
}

fn archimedea_type_name(raw: &str) -> &str {
    let cleaned: String = raw.chars().filter(|c| !c.is_whitespace() && *c != '_').collect();
    if cleaned.contains("HEX") {
        "Temporal Archimedea"
    } else {
        "Deep Archimedea"
    }
}

async fn fetch_weekly_state_internal() -> Result<WeeklyState, String> {
    let now = now_ms();
    let client = http_client();

    let payload: serde_json::Value = client
        .get("https://api.warframestat.us/pc/")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("warframestat request failed: {e}"))?
        .json()
        .await
        .map_err(|e| format!("warframestat parse failed: {e}"))?;

    let archon_hunt = payload.get("archonHunt").and_then(|v| {
        if v.is_null() { return None; }
        let expires = parse_iso_ms(v.get("expiry").and_then(|x| x.as_str()));
        let missions = v.get("missions").and_then(|x| x.as_array()).map(|arr| {
            arr.iter().map(|m| WeeklyMission {
                mission_type: m.get("type").and_then(|x| x.as_str()).unwrap_or("Missao").to_string(),
                node: m.get("node").and_then(|x| x.as_str()).unwrap_or("Nodo").to_string(),
                modifier: String::new(),
            }).collect::<Vec<_>>()
        }).unwrap_or_default();
        Some(WeeklyArchonHunt {
            boss: v.get("boss").and_then(|x| x.as_str()).unwrap_or("Archon").to_string(),
            faction: v.get("faction").and_then(|x| x.as_str()).unwrap_or("Narmer").to_string(),
            expires_at_ms: expires.unwrap_or(now + 7 * 86_400_000),
            missions,
        })
    });

    let sortie = payload.get("sortie").and_then(|v| {
        if v.is_null() { return None; }
        let expires = parse_iso_ms(v.get("expiry").and_then(|x| x.as_str()));
        let missions = v.get("variants").or_else(|| v.get("missions")).and_then(|x| x.as_array()).map(|arr| {
            arr.iter().map(|m| WeeklyMission {
                mission_type: m.get("missionType").or_else(|| m.get("type")).and_then(|x| x.as_str()).unwrap_or("Missao").to_string(),
                node: m.get("node").and_then(|x| x.as_str()).unwrap_or("Nodo").to_string(),
                modifier: m.get("modifier").or_else(|| m.get("modifierType")).and_then(|x| x.as_str()).unwrap_or("").to_string(),
            }).collect::<Vec<_>>()
        }).unwrap_or_default();
        Some(WeeklyArchonHunt {
            boss: v.get("boss").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            faction: v.get("faction").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            expires_at_ms: expires.unwrap_or(now + 86_400_000),
            missions,
        })
    });

    let archimedeas = payload.get("archimedeas").and_then(|v| v.as_array()).map(|arr| {
        arr.iter().map(|a| {
            let raw_type = a.get("type").and_then(|x| x.as_str()).unwrap_or("");
            let expires = parse_iso_ms(a.get("expiry").and_then(|x| x.as_str()));
            let missions = a.get("missions").and_then(|x| x.as_array()).map(|ms| {
                ms.iter().map(|m| WeeklyArchimedeaMission {
                    mission_type: m.get("missionType").and_then(|x| x.as_str()).unwrap_or("Missao").to_string(),
                    faction: m.get("faction").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    deviation: m.get("deviation").and_then(|d| d.get("name")).and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    deviation_description: m.get("deviation").and_then(|d| d.get("description")).and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    risks: m.get("risks").and_then(|x| x.as_array()).map(|rs| {
                        rs.iter().map(|r| WeeklyArchimedeaRisk {
                            name: r.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            description: r.get("description").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            is_hard: r.get("isHard").and_then(|x| x.as_bool()).unwrap_or(false),
                        }).collect::<Vec<_>>()
                    }).unwrap_or_default(),
                }).collect::<Vec<_>>()
            }).unwrap_or_default();
            let modifiers = a.get("personalModifiers").and_then(|x| x.as_array()).map(|ms| {
                ms.iter().map(|m| WeeklyModifier {
                    name: m.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    description: m.get("description").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                }).collect::<Vec<_>>()
            }).unwrap_or_default();
            WeeklyArchimedea {
                type_name: archimedea_type_name(raw_type).to_string(),
                expires_at_ms: expires.unwrap_or(now + 7 * 86_400_000),
                missions,
                personal_modifiers: modifiers,
            }
        }).collect::<Vec<_>>()
    }).unwrap_or_default();

    let mut circuit_normal = None;
    let mut circuit_hard = None;
    if let Some(choices) = payload.get("duviriCycle").and_then(|v| v.get("choices")).and_then(|v| v.as_array()) {
        for entry in choices {
            let category = entry.get("category").and_then(|x| x.as_str()).unwrap_or("");
            let choice_list = entry.get("choices").and_then(|x| x.as_array()).map(|cs| {
                cs.iter().filter_map(|c| c.as_str().map(|s| s.to_string())).collect::<Vec<_>>()
            }).unwrap_or_default();
            let struct_choice = WeeklyCircuitChoices {
                category: category.to_string(),
                choices: choice_list,
            };
            if category == "hard" {
                circuit_hard = Some(struct_choice);
            } else {
                circuit_normal = Some(struct_choice);
            }
        }
    }

    let steel_path = payload.get("steelPath").and_then(|v| {
        if v.is_null() { return None; }
        let reward = |field: &str| -> Vec<WeeklySteelPathReward> {
            v.get(field).and_then(|x| x.as_array()).map(|arr| {
                arr.iter().map(|r| WeeklySteelPathReward {
                    name: r.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                    cost: r.get("cost").and_then(|x| x.as_i64()).unwrap_or(0),
                }).collect::<Vec<_>>()
            }).unwrap_or_default()
        };
        let current = v.get("currentReward").map(|r| WeeklySteelPathReward {
            name: r.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            cost: r.get("cost").and_then(|x| x.as_i64()).unwrap_or(0),
        });
        let expires = parse_iso_ms(v.get("expiry").and_then(|x| x.as_str()));
        Some(WeeklySteelPath {
            current_reward: current.unwrap_or(WeeklySteelPathReward { name: String::new(), cost: 0 }),
            rotation: reward("rotation"),
            evergreens: reward("evergreens"),
            expires_at_ms: expires.unwrap_or(now + 7 * 86_400_000),
        })
    });

    // Weekly reset = maior expiry das atividades semanais (Archon/Archimedea),
    // todos reiniciam na mesma hora (segunda 00:00 UTC). Fallback: cálculo local.
    let mut weekly_reset_ms = next_weekly_reset_ms(now);
    let mut expiries: Vec<i64> = Vec::new();
    if let Some(ah) = &archon_hunt {
        expiries.push(ah.expires_at_ms);
    }
    for a in &archimedeas {
        expiries.push(a.expires_at_ms);
    }
    if let Some(sp) = &steel_path {
        expiries.push(sp.expires_at_ms);
    }
    if let Some(&max_exp) = expiries.iter().max() {
        if max_exp > now {
            weekly_reset_ms = max_exp;
        }
    }

    Ok(WeeklyState {
        fetched_at_ms: now,
        weekly_reset_ms,
        archon_hunt,
        sortie,
        archimedeas,
        circuit_normal,
        circuit_hard,
        steel_path,
    })
}

#[tauri::command]
async fn fetch_weekly_state() -> Result<String, String> {
    let state = fetch_weekly_state_internal().await?;
    serde_json::to_string(&state).map_err(|e| e.to_string())
}

#[derive(Deserialize, Serialize, Clone, Debug)]
struct HubVoidTraderInventoryItem {
    name: String,
    ducats: i64,
    credits: i64,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
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

fn void_trader_inventory_cache_path() -> PathBuf {
    data_path(VOID_TRADER_INVENTORY_CACHE_FILE)
}

fn read_void_trader_inventory_cache() -> Option<HubVoidTraderInventoryResponse> {
    let path = void_trader_inventory_cache_path();
    let raw = fs::read_to_string(path).ok()?;
    let cached: HubVoidTraderInventoryResponse = serde_json::from_str(&raw).ok()?;
    if cached.items.is_empty() {
        return None;
    }
    Some(cached)
}

fn write_void_trader_inventory_cache(resp: &HubVoidTraderInventoryResponse) -> Result<(), String> {
    if resp.items.is_empty() {
        return Ok(());
    }
    let json = serde_json::to_string_pretty(resp).map_err(|e| e.to_string())?;
    fs::write(void_trader_inventory_cache_path(), json).map_err(|e| e.to_string())
}

fn fill_void_trader_inventory_from_cache(
    mut resp: HubVoidTraderInventoryResponse,
    message: &str,
) -> HubVoidTraderInventoryResponse {
    if !resp.items.is_empty() {
        let _ = write_void_trader_inventory_cache(&resp);
        return resp;
    }

    if let Some(cached) = read_void_trader_inventory_cache() {
        resp.items = cached.items;
        resp.stale = true;
        resp.message = Some(message.to_string());
    }

    resp
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
            .get("https://oracle.browse.wf/worldState.min.json")
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
        Ok(resp) => {
            let resp = fill_void_trader_inventory_from_cache(
                resp,
                "No catalog in the current worldstate. Showing the last saved Baro catalog.",
            );
            return serde_json::to_string(&resp).map_err(|e| e.to_string());
        }
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
                    message: Some(primary_err.clone()),
                    items,
                })
            }
            .await;

            let resp = match fallback_result {
                Ok(resp) => fill_void_trader_inventory_from_cache(
                    resp,
                    "Fallback source did not include a catalog. Showing the last saved Baro catalog.",
                ),
                Err(fallback_err) => {
                    if let Some(mut cached) = read_void_trader_inventory_cache() {
                        cached.source = "local cache".to_string();
                        cached.active = false;
                        cached.stale = true;
                        cached.message = Some(format!(
                            "Live Void Trader sources unavailable. browse.wf: {primary_err}; tenno.tools: {fallback_err}"
                        ));
                        cached
                    } else {
                        return Err(format!(
                            "browse.wf failed: {primary_err}; tenno.tools failed: {fallback_err}"
                        ));
                    }
                }
            };
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
fn read_config() -> Result<String, String> {
    serde_json::to_string(&read_config_file()).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_log_path(path: String) -> Result<String, String> {
    let trimmed = path.trim().to_string();
    let mut config = read_config_file();
    config["log_path"] = serde_json::Value::String(trimmed.clone());
    let json = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(config_path(), json).map_err(|e| e.to_string())?;
    set_log_path(&trimmed);
    log_to_file(&format!("[config] log_path salvo: {}", trimmed));
    serde_json::to_string(&config).map_err(|e| e.to_string())
}

fn expand_ee_log_under(app_bundle: &Path) -> Option<PathBuf> {
    let users = app_bundle.join("Contents/SharedSupport/prefix/drive_c/users");
    for entry in fs::read_dir(&users).ok()?.flatten() {
        let candidate = entry.path().join("AppData/Local/Warframe/EE.log");
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn detect_ee_log_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();

    let direct_candidates = [
        PathBuf::from(&home).join("Library/Application Support/Warframe/EE.log"),
        PathBuf::from(&home).join("Library/Application Support/Steam/steamapps/common/Warframe/EE.log"),
        PathBuf::from(&home).join("Library/Application Support/Steam/SteamApps/common/Warframe/EE.log"),
    ];

    for candidate in direct_candidates {
        if candidate.exists() {
            return Some(candidate);
        }
    }

    let mut app_roots = vec![PathBuf::from("/Applications"), PathBuf::from(&home).join("Applications")];
    if let Ok(entries) = fs::read_dir("/Volumes") {
        for entry in entries.flatten() {
            app_roots.push(entry.path());
        }
    }

    for root in app_roots {
        let Ok(entries) = fs::read_dir(&root) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().map(|ext| ext == "app").unwrap_or(false) {
                if let Some(found) = expand_ee_log_under(&path) {
                    return Some(found);
                }
            }
        }
    }

    None
}

#[tauri::command]
fn detect_log_path() -> Result<Option<String>, String> {
    Ok(detect_ee_log_path().map(|p| p.to_string_lossy().to_string()))
}

// Copy bundled datasets into the writable data dir on first run (skips files
// that already exist so user updates are preserved).
fn seed_data_from_bundle(app: &tauri::AppHandle, target: &Path) {
    let Ok(resource_dir) = app.path().resource_dir() else {
        return;
    };
    let src = resource_dir.join("data");
    if !src.exists() {
        return;
    }
    if fs::create_dir_all(target).is_err() {
        return;
    }
    let Ok(entries) = fs::read_dir(&src) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name() else {
            continue;
        };
        let dest = target.join(name);
        if !dest.exists() {
            let _ = fs::copy(&path, &dest);
        }
    }
}

fn first_run_setup(app: tauri::AppHandle) {    if !data_path("prices.json").exists() {
        log_to_file("[setup] datasets ausentes, executando update.sh");
        let script = resource_path(&app, "update.sh");
        let _ = SyncCommand::new(&script)
            .current_dir(data_dir())
            .env("WFHUB_DATA_DIR", data_dir())
            .env("WFHUB_PYTHON", python_binary(&app))
            .output();
        log_to_file("[setup] update.sh concluído");
    }

    if get_log_path().as_os_str().is_empty() {
        if let Some(found) = detect_ee_log_path() {
            log_to_file(&format!("[setup] EE.log auto-detectado: {}", found.display()));
            let _ = save_log_path(found.to_string_lossy().to_string());
        }
    }
}

// ── WF Market Auth & Orders ──────────────────────────────────────────────────

#[tauri::command]
fn wfmarket_read_auth() -> Result<String, String> {
    serde_json::to_string(&read_wfmarket_auth_file()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn wfmarket_save_jwt(jwt: String) -> Result<String, String> {
    let jwt = jwt.trim().to_string();
    if jwt.is_empty() {
        return Err("JWT não pode ser vazio".to_string());
    }
    // Valida estrutura básica (3 partes separadas por '.')
    if jwt.split('.').count() != 3 {
        return Err("JWT inválido: formato incorreto".to_string());
    }

    let csrf_token = extract_csrf_from_jwt(&jwt).unwrap_or_default();

    // Tenta buscar ingame_name via v1 /profile, fallback para v2 /profile/me
    let username = async {
        let try_parse = |text: String| -> Option<String> {
            let json: serde_json::Value = serde_json::from_str(&text).ok()?;
            json.pointer("/payload/profile/ingame_name")
                .or_else(|| json.pointer("/payload/user/ingame_name"))
                .or_else(|| json.pointer("/data/ingame_name"))
                .or_else(|| json.pointer("/data/username"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        };

        if let Ok(resp) = http_client()
            .get(format!("{WFMARKET_API_BASE}/profile"))
            .header("Accept", "application/json")
            .header("Authorization", format!("JWT {jwt}"))
            .header("Platform", "pc")
            .header("Language", "en")
            .send()
            .await
        {
            let text = resp.text().await.unwrap_or_default();
            eprintln!("[wfmarket] v1/profile response: {}", &text[..text.len().min(400)]);
            if let Some(name) = try_parse(text) {
                return name;
            }
        }

        if let Ok(resp) = http_client()
            .get("https://api.warframe.market/v2/profile/me")
            .header("Accept", "application/json")
            .header("Authorization", format!("Bearer {jwt}"))
            .header("Platform", "pc")
            .header("Language", "en")
            .send()
            .await
        {
            let text = resp.text().await.unwrap_or_default();
            eprintln!("[wfmarket] v2/profile/me response: {}", &text[..text.len().min(400)]);
            if let Some(name) = try_parse(text) {
                return name;
            }
        }

        "Connected".to_string()
    }.await;

    let auth = WfMarketAuth { jwt, username, csrf_token };
    write_wfmarket_auth_file(&auth)?;
    serde_json::to_string(&auth).map_err(|e| e.to_string())
}

#[tauri::command]
fn wfmarket_logout() -> Result<(), String> {
    let path = wfmarket_auth_path();
    if path.exists() {
        fs::remove_file(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

async fn set_wfmarket_status_inner(status: &str) -> Result<(), String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let auth = read_wfmarket_auth_file();
    if auth.jwt.is_empty() {
        return Err("Not logged in to warframe.market".to_string());
    }

    let key = tokio_tungstenite::tungstenite::handshake::client::generate_key();
    let request = http::Request::builder()
        .uri("wss://ws.warframe.market/socket")
        .header("Host", "ws.warframe.market")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", key)
        .header("Sec-WebSocket-Protocol", "wfm")
        .body(())
        .map_err(|e| e.to_string())?;

    let (mut ws, _) = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio_tungstenite::connect_async(request),
    )
    .await
    .map_err(|_| "WebSocket connection timed out".to_string())?
    .map_err(|e| format!("WebSocket connect failed: {e}"))?;

    let timeout_dur = std::time::Duration::from_secs(8);

    let auth_msg = serde_json::json!({
        "route": "@wfm|cmd/auth/signIn",
        "id": "1",
        "payload": { "token": auth.jwt }
    })
    .to_string();
    ws.send(Message::Text(auth_msg)).await.map_err(|e| e.to_string())?;

    let auth_result = tokio::time::timeout(timeout_dur, async {
        while let Some(msg) = ws.next().await {
            let msg = msg.map_err(|e| e.to_string())?;
            if let Message::Text(txt) = msg {
                let v: serde_json::Value = serde_json::from_str(&txt).unwrap_or_default();
                let route = v["route"].as_str().unwrap_or("");
                log_to_file(&format!("[wfmarket_ws] rx: {route}"));
                if route == "@wfm|cmd/auth/signIn:ok" {
                    return Ok(());
                }
                if route.ends_with(":error") {
                    return Err(format!("Auth error: {}", v["payload"]));
                }
            }
        }
        Err("WebSocket closed before auth response".to_string())
    })
    .await
    .map_err(|_| "Auth response timed out".to_string())?;

    auth_result?;

    let status_msg = serde_json::json!({
        "route": "@wfm|cmd/status/set",
        "id": "2",
        "payload": { "status": status, "duration": 21600 }
    })
    .to_string();
    ws.send(Message::Text(status_msg)).await.map_err(|e| e.to_string())?;

    let status_result = tokio::time::timeout(timeout_dur, async {
        while let Some(msg) = ws.next().await {
            let msg = msg.map_err(|e| e.to_string())?;
            if let Message::Text(txt) = msg {
                let v: serde_json::Value = serde_json::from_str(&txt).unwrap_or_default();
                let route = v["route"].as_str().unwrap_or("");
                log_to_file(&format!("[wfmarket_ws] rx: {route}"));
                if route == "@wfm|cmd/status/set:ok" {
                    return Ok(());
                }
                if route.ends_with(":error") {
                    return Err(format!("Status error: {}", v["payload"]));
                }
            }
        }
        Err("WebSocket closed before status response".to_string())
    })
    .await
    .map_err(|_| "Status response timed out".to_string())?;

    ws.close(None).await.ok();
    log_to_file(&format!("[wfmarket_ws] status set to {status} ok"));
    status_result
}

#[tauri::command]
async fn wfmarket_set_status(status: String) -> Result<(), String> {
    let valid = ["ingame", "online", "invisible"];
    if !valid.contains(&status.as_str()) {
        return Err(format!("Invalid status: {status}"));
    }
    set_wfmarket_status_inner(&status).await
}

#[tauri::command]
async fn wfmarket_create_sell_order(
    item_slug: String,
    platinum: u32,
    quantity: u32,
    rank: Option<u32>,
) -> Result<String, String> {
    let auth = read_wfmarket_auth_file();
    if auth.jwt.is_empty() {
        return Err("Not logged in to warframe.market".to_string());
    }

    // Usa v2 para resolver item_id (mais confiável que v1 para todos os tipos de item)
    let item_resp = http_client()
        .get(format!("https://api.warframe.market/v2/item/{item_slug}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let item_text = item_resp.text().await.map_err(|e| e.to_string())?;
    log_to_file(&format!("[wfmarket_create] v2 item response: {}", &item_text[..item_text.len().min(400)]));
    let item_json: serde_json::Value =
        serde_json::from_str(&item_text).map_err(|e| format!("failed to parse item info: {e}"))?;

    let item_id = item_json
        .pointer("/data/id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| format!("item_id not found. response: {}", &item_text[..item_text.len().min(200)]))?
        .to_string();

    let bulk_tradable = item_json
        .pointer("/data/bulkTradable")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    // v2 body: camelCase fields
    let mut order_body = serde_json::json!({
        "type": "sell",
        "itemId": item_id,
        "platinum": platinum,
        "quantity": quantity,
        "visible": true,
    });
    if bulk_tradable {
        order_body["perTrade"] = serde_json::json!(1);
    }
    if let Some(r) = rank {
        order_body["rank"] = serde_json::json!(r);
    }

    let resp = http_client()
        .post("https://api.warframe.market/v2/order")
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", auth.jwt))
        .header("Platform", "pc")
        .header("Language", "en")
        .json(&order_body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let order_status = resp.status();
    let order_text = resp.text().await.map_err(|e| e.to_string())?;
    log_to_file(&format!("[wfmarket_create] POST /v2/order → {} | {}", order_status, &order_text[..order_text.len().min(400)]));

    if !order_status.is_success() {
        return Err(format!("HTTP {}: {}", order_status, &order_text[..order_text.len().min(300)]));
    }
    Ok(order_text)
}

#[tauri::command]
async fn wfmarket_get_orders() -> Result<String, String> {
    let auth = read_wfmarket_auth_file();
    if auth.jwt.is_empty() {
        return Err("Not logged in to warframe.market".to_string());
    }
    let resp = http_client()
        .get("https://api.warframe.market/v2/orders/my")
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {}", auth.jwt))
        .header("Platform", "pc")
        .header("Language", "en")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, &text[..text.len().min(300)]));
    }

    let mut json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    // Enrich each order with item slug+name via GET /v2/item/{itemId}
    if let Some(orders) = json.get_mut("data").and_then(|d| d.as_array_mut()) {
        for order in orders.iter_mut() {
            let item_id = match order.get("itemId").and_then(|v| v.as_str()) {
                Some(id) => id.to_string(),
                None => continue,
            };
            if let Ok(item_resp) = http_client()
                .get(format!("https://api.warframe.market/v2/item/{item_id}"))
                .header("Accept", "application/json")
                .send()
                .await
            {
                if let Ok(item_text) = item_resp.text().await {
                    if let Ok(item_json) = serde_json::from_str::<serde_json::Value>(&item_text) {
                        let name = item_json.pointer("/data/i18n/en/name")
                            .and_then(|v| v.as_str())
                            .unwrap_or("Unknown")
                            .to_string();
                        let slug = item_json.pointer("/data/slug")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        order["item"] = serde_json::json!({ "id": item_id, "slug": slug, "name": name });
                    }
                }
            }
        }
    }

    serde_json::to_string(&json).map_err(|e| e.to_string())
}

#[tauri::command]
async fn wfmarket_update_order(
    id: String,
    platinum: u32,
    quantity: u32,
    visible: bool,
    rank: Option<u32>,
) -> Result<String, String> {
    let auth = read_wfmarket_auth_file();
    if auth.jwt.is_empty() {
        return Err("Not logged in to warframe.market".to_string());
    }
    let mut body = serde_json::json!({
        "platinum": platinum,
        "quantity": quantity,
        "visible": visible,
    });
    if let Some(r) = rank {
        body["rank"] = serde_json::json!(r);
    }
    let resp = http_client()
        .patch(format!("https://api.warframe.market/v2/order/{id}"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", auth.jwt))
        .header("Platform", "pc")
        .header("Language", "en")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, &text[..text.len().min(300)]));
    }
    Ok(text)
}

#[tauri::command]
async fn wfmarket_close_order(id: String, quantity: u32) -> Result<String, String> {
    let auth = read_wfmarket_auth_file();
    if auth.jwt.is_empty() {
        return Err("Not logged in to warframe.market".to_string());
    }
    let resp = http_client()
        .post(format!("https://api.warframe.market/v2/order/{id}/close"))
        .header("Accept", "application/json")
        .header("Content-Type", "application/json")
        .header("Authorization", format!("Bearer {}", auth.jwt))
        .header("Platform", "pc")
        .header("Language", "en")
        .json(&serde_json::json!({ "quantity": quantity }))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, &text[..text.len().min(300)]));
    }
    Ok(text)
}

#[tauri::command]
async fn wfmarket_delete_order(id: String) -> Result<String, String> {
    let auth = read_wfmarket_auth_file();
    if auth.jwt.is_empty() {
        return Err("Not logged in to warframe.market".to_string());
    }
    let resp = http_client()
        .delete(format!("https://api.warframe.market/v2/order/{id}"))
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {}", auth.jwt))
        .header("Platform", "pc")
        .header("Language", "en")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, &text[..text.len().min(300)]));
    }
    Ok(text)
}

async fn resolve_item_name(item_id: &str) -> Option<(String, String)> {
    let resp = http_client()
        .get(format!("https://api.warframe.market/v2/item/{item_id}"))
        .header("Accept", "application/json")
        .send()
        .await
        .ok()?;

    let text = resp.text().await.ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;

    let name = json.pointer("/data/i18n/en/name")
        .or_else(|| json.pointer("/data/item_name"))
        .or_else(|| json.pointer("/item/item_name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let slug = json.pointer("/data/slug")
        .or_else(|| json.pointer("/data/url_name"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    match (name, slug) {
        (Some(n), Some(s)) => Some((n, s)),
        (Some(n), None) => Some((n.clone(), n.to_lowercase().replace(' ', "_"))),
        (None, Some(s)) => Some((s.replace('_', " "), s)),
        (None, None) => None,
    }
}

#[tauri::command]
async fn wfmarket_confirm_trade(item_name: String) -> Result<String, String> {
    let auth = read_wfmarket_auth_file();
    if auth.jwt.is_empty() {
        return Err("Not logged in to warframe.market".to_string());
    }

    let resp = http_client()
        .get("https://api.warframe.market/v2/orders/my")
        .header("Accept", "application/json")
        .header("Authorization", format!("Bearer {}", auth.jwt))
        .header("Platform", "pc")
        .header("Language", "en")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, &text[..text.len().min(300)]));
    }

    let orders: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("Invalid JSON: {e}"))?;

    let orders_list: Vec<&serde_json::Value> = orders
        .get("data")
        .and_then(|d| d.as_array())
        .ok_or("No orders list found")?
        .iter()
        .collect();

    let item_lower = item_name.to_lowercase();
    let item_slug = item_lower.replace(' ', "_");

    log_to_file(&format!("[wfmarket] {} ordens, buscando '{}'", orders_list.len(), item_name));

    let mut matching_order: Option<(String, u32)> = None;
    let mut best_score: usize = 0;

    for order in &orders_list {
        let order_type = order.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let visible = order.get("visible").and_then(|v| v.as_bool()).unwrap_or(false);
        if order_type != "sell" || !visible { continue; }

        let item_id = match order.get("itemId").and_then(|v| v.as_str()) {
            Some(id) => id,
            None => continue,
        };

        let (item_name_resolved, item_slug_resolved) = match resolve_item_name(item_id).await {
            Some(result) => result,
            None => {
                log_to_file(&format!("[wfmarket] resolve falhou itemId={}", item_id));
                continue;
            }
        };

        let c_lower = item_name_resolved.to_lowercase();
        let c_slug = item_slug_resolved.to_lowercase();

        let score = if c_lower == item_lower || c_slug == item_slug {
            100
        } else if c_lower.contains(&item_lower) || item_lower.contains(&c_lower)
               || c_slug.contains(&item_slug) || item_slug.contains(&c_slug)
        {
            item_lower.len().min(c_lower.len()).max(1)
        } else {
            0
        };

        if score > best_score {
            if let Some(id) = order.get("id").and_then(|v| v.as_str()) {
                if let Some(quantity) = order.get("quantity").and_then(|v| v.as_u64()) {
                    matching_order = Some((id.to_string(), quantity as u32));
                    best_score = score;
                    log_to_file(&format!(
                        "[wfmarket] match: '{}' (slug={}) score={} id={}",
                        item_name_resolved, item_slug_resolved, score, id
                    ));
                }
            }
        }
    }

    let (order_id, quantity) = matching_order
        .ok_or_else(|| format!("Nenhuma ordem ativa para '{}'", item_name))?;

    log_to_file(&format!("[wfmarket] fechando {} (qty={})", order_id, quantity));
    wfmarket_close_order(order_id, quantity).await
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

    let mod_locations = read_json_cached("modLocations.json", &MOD_LOCATIONS_CACHE)?;
    if let Some(locs) = mod_locations["modLocations"].as_array() {
        for entry in locs {
            let mod_name = entry["modName"].as_str().unwrap_or("");
            if let Some(enemies) = entry["enemies"].as_array() {
                for enemy in enemies {
                    upsert_rarity(
                        &mut rarities,
                        mod_name,
                        enemy["rarity"].as_str().unwrap_or(""),
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
    let output = SyncCommand::new(python_binary(&app))
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
    let output = SyncCommand::new(python_binary(&app))
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


fn open_ee_log_at_end(log_path: &std::path::Path) -> Option<BufReader<fs::File>> {
    let file = fs::File::open(log_path).ok()?;
    let mut reader = BufReader::new(file);
    reader.seek(SeekFrom::End(0)).ok()?;
    Some(reader)
}

#[derive(Serialize, Clone)]
struct TradeSuccessPayload {
    items: Vec<String>,
    buyer: String,
    platinum: u32,
}

fn parse_trade_from_buffer(buf: &[String]) -> Option<TradeSuccessPayload> {
    let mut items = Vec::new();
    let mut buyer = String::new();
    let mut platinum = 0u32;
    let mut in_trade = false;
    let mut after_offering = false;

    for line_raw in buf {
        let line = line_raw.trim();
        if line.contains("Dialog.lua: Dialog::CreateOkCancel(description=Are you sure you want to accept this trade") {
            in_trade = true;
            after_offering = line.contains("You are offering:");
            continue;
        }
        if !in_trade { continue; }

        if line.starts_with("and will receive from") {
            // Extract buyer between "from " and " the following:"
            let rest = line.strip_prefix("and will receive from")?.trim();
            if let Some(end) = rest.find(" the following:") {
                buyer = rest[..end]
                    .trim_end_matches(|c: char| c.is_control() || c == '\u{200d}')
                    .to_string();
            }
            continue;
        }

        if line.starts_with("Platinum x ") {
            let rest = line.strip_prefix("Platinum x ")?;
            let amount_str = rest.split(',').next()?.trim();
            platinum = amount_str.parse().unwrap_or(0);
            break;
        }

        if line.starts_with('\"') && line.contains(',') && line.contains("title=") {
            break;
        }

        if !line.is_empty() && !line.starts_with("title=") {
            items.push(line.to_string());
        }
    }

    if items.is_empty() || buyer.is_empty() || platinum == 0 {
        return None;
    }

    Some(TradeSuccessPayload { items, buyer, platinum })
}

static LINE_RING: LazyLock<Mutex<Vec<String>>> = LazyLock::new(|| Mutex::new(Vec::new()));
const RING_CAPACITY: usize = 200;

fn push_ring(line: String) {
    let mut ring = LINE_RING.lock().unwrap();
    ring.push(line);
    if ring.len() > RING_CAPACITY {
        ring.remove(0);
    }
}

fn find_recent_trade_context() -> Option<TradeSuccessPayload> {
    let ring = LINE_RING.lock().unwrap();
    // Walk backwards to find the trade dialog
    let start = ring.len().saturating_sub(150);
    for i in (start..ring.len()).rev() {
        if ring[i].contains("Dialog.lua: Dialog::CreateOkCancel(description=Are you sure you want to accept this trade") {
            if let Some(payload) = parse_trade_from_buffer(&ring[i..]) {
                return Some(payload);
            }
        }
    }
    None
}

fn monitor_ee_log(app: tauri::AppHandle) {
    let cooldown = Duration::from_secs(10);
    let mut last_trigger = Instant::now() - cooldown;

    loop {
        let log_path = get_log_path();
        if log_path.as_os_str().is_empty() {
            log_to_file("[ee_log] log_path não configurado, aguardando configuração");
            thread::sleep(Duration::from_secs(2));
            continue;
        }

        // Wait until the file exists (game might not be open yet)
        let mut reader = match open_ee_log_at_end(&log_path) {
            Some(r) => r,
            None => {
                thread::sleep(Duration::from_secs(2));
                continue;
            }
        };
        log_to_file(&format!("[ee_log] monitorando EE.log: {}", log_path.display()));

        let mut reader_pos: u64 = reader.seek(SeekFrom::Current(0)).unwrap_or(0);

        'monitor: loop {
            thread::sleep(Duration::from_millis(200));

            // Re-read the configured path so changes apply without a restart.
            if get_log_path() != log_path {
                log_to_file("[ee_log] log_path alterado, reiniciando monitor");
                break 'monitor;
            }

            // Detect if the file was truncated or replaced (Warframe restart)
            let file_len = fs::metadata(&log_path).ok().map(|m| m.len()).unwrap_or(u64::MAX);
            if file_len < reader_pos {
                log_to_file("[ee_log] EE.log foi recriado (Warframe reiniciado), reabrindo");
                break 'monitor;
            }

            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => break,
                    Ok(_) => {
                        reader_pos = reader.seek(SeekFrom::Current(0)).unwrap_or(reader_pos);
                        push_ring(line.clone());

                        let trimmed = line.trim().to_string();

                        // Trigger only on real prime reward screens.
                        let is_reward_trigger = trimmed.contains("VoidProjections: OpenVoidProjectionRewardScreen");
                        let is_trade_success = trimmed == "The trade was successful!"
                            || trimmed.ends_with("The trade was successful!")
                            || trimmed.contains("The trade was successful!");

                        if is_reward_trigger && last_trigger.elapsed() >= cooldown {
                            last_trigger = Instant::now();
                            log_to_file(&format!("[ee_log] trigger: {}", trimmed));
                            thread::sleep(Duration::from_millis(3500));
                            match run_detection(&app) {
                                Ok(Some(payload)) => {
                                    log_to_file(&format!("[ee_log] {} itens detectados", payload.items.len()));
                                    append_reward_history(&payload);
                                    show_overlay(&app, payload);
                                }
                                Ok(None) => {
                                    log_to_file("[ee_log] OCR sem partes detectadas");
                                }
                                Err(e) => {
                                    log_to_file(&format!("[ee_log] erro: {e}"));
                                }
                            }
                            reader.seek(SeekFrom::End(0)).ok();
                            reader_pos = reader.seek(SeekFrom::Current(0)).unwrap_or(reader_pos);
                            break;
                        }

                        if is_trade_success {
                            log_to_file("[ee_log] trade bem-sucedido detectado");
                            if let Some(payload) = find_recent_trade_context() {
                                log_to_file(&format!(
                                    "[ee_log] trade: {} itens, comprador={}, plat={}",
                                    payload.items.len(), payload.buyer, payload.platinum
                                ));
                                show_trade_overlay(&app, payload);
                            } else {
                                log_to_file("[ee_log] trade: nao foi possivel extrair contexto do log");
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let toggle_shortcut_id = Shortcut::from_str("CmdOrCtrl+Shift+W")
        .expect("failed to parse toggle shortcut")
        .id();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            fetch_market_orders,
            fetch_market_top,
            fetch_item_info,
            fetch_riven_auctions,
            read_items_list,
            read_all_mods,
            read_mod_ranks,
            read_items_prices,
            save_item_price,
            read_mod_images,
            read_arcane_images,
            read_mod_names,
            read_item_rarities,
            save_temp_image,
            analyze_build_image,
            search_farm_data,
            inventory::start_inventory_scan,
            inventory::stop_inventory_scan,
            inventory::save_inventory_result,
            inventory::read_inventory,
            inventory::save_prime_parts,
            inventory::debug_inventory_ocr,
            read_prime_parts,
            read_prime_vault,
            read_mod_meta,
            read_ducat_values,
            read_prices,
            read_enemy_mod_tables,
            read_builds,
            save_build,
            delete_build,
            resolve_build_screenshot_path,
            read_build_screenshot_preview,
            read_hub_state,
            save_hub_settings,
            read_config,
            save_log_path,
            detect_log_path,
            fetch_hub_worldstate,
            fetch_hub_void_trader_inventory,
            fetch_hub_arbitrations_next_days,
            run_shell_action,
            analyze_riven_image,
            read_riven_weapon_rules,
            read_reward_history,
            wfmarket_read_auth,
            wfmarket_save_jwt,
            wfmarket_logout,
            wfmarket_set_status,
            wfmarket_create_sell_order,
            wfmarket_get_orders,
            wfmarket_update_order,
            wfmarket_close_order,
            wfmarket_confirm_trade,
            wfmarket_delete_order,
            test_overlay,
            test_trade_overlay,
            test_trade_overlay_set,
            hide_overlay_window,
            fetch_weekly_state,
            read_circuit_images
        ])
        .manage(inventory::InventoryState::default())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    if event.state() == ShortcutState::Pressed
                        && shortcut.id() == toggle_shortcut_id
                    {
                        if let Some(window) = app.get_webview_window("main") {
                            toggle_main_window(&window);
                        }
                    }
                })
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let app_handle = app.handle().clone();

            // --- Resolve the writable data dir (repo data/ in dev, app-data in bundle) ---
            let dev_data = project_root().join("data");
            if dev_data.exists() {
                set_data_dir(dev_data);
            } else if let Ok(app_data) = app.path().app_data_dir() {
                let data_dir = app_data.join("data");
                seed_data_from_bundle(app.handle(), &data_dir);
                set_data_dir(data_dir);
            }

            // --- Tray icon ---
            let icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit WFHub", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&quit_item])?;
            TrayIconBuilder::new()
                .icon(icon)
                .icon_as_template(true)
                .tooltip("WFHub")
                .menu(&tray_menu)
                .on_menu_event(move |_app, event| {
                    if event.id() == "quit" {
                        if EXITING.swap(true, std::sync::atomic::Ordering::SeqCst) {
                            return;
                        }
                        tauri::async_runtime::spawn(async {
                            let _ = tokio::time::timeout(
                                std::time::Duration::from_secs(5),
                                set_wfmarket_status_inner("invisible"),
                            )
                            .await;
                            std::process::exit(0);
                        });
                    }
                })
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

            // --- OCR daemon (pré-aquece Python + Vision Framework) ---
            let app_for_daemon = app.handle().clone();
            thread::spawn(move || init_ocr_daemon(&app_for_daemon));

            // --- EE.log monitor ---
            let app_handle_log = app.handle().clone();
            thread::spawn(move || monitor_ee_log(app_handle_log));

            // --- First-run setup: populate datasets + auto-detect EE.log ---
            let app_for_setup = app.handle().clone();
            thread::spawn(move || first_run_setup(app_for_setup));

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

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building WFHub")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if EXITING.swap(true, std::sync::atomic::Ordering::SeqCst) {
                    return;
                }
                api.prevent_exit();
                tauri::async_runtime::spawn(async {
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(5),
                        set_wfmarket_status_inner("invisible"),
                    )
                    .await;
                    std::process::exit(0);
                });
            }
        });
}
