use std::{
    collections::HashSet,
    fs,
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use image::{DynamicImage, imageops::FilterType};
use tauri::{AppHandle, Emitter, Manager, State};
use xcap::Window as CaptureWindow;

const VALID_SCAN_TYPES: [&str; 3] = ["mods", "arcanes", "prime_parts"];

use crate::{data_path, log_to_file, resource_path, save_debug_image};

// ─── Managed state ────────────────────────────────────────────────────────────

pub struct InventoryState {
    pub running: Arc<AtomicBool>,
    pub items: Arc<Mutex<HashSet<String>>>,
    pub scan_type: Arc<Mutex<String>>,
}

impl Default for InventoryState {
    fn default() -> Self {
        Self {
            running: Arc::new(AtomicBool::new(false)),
            items: Arc::new(Mutex::new(HashSet::new())),
            scan_type: Arc::new(Mutex::new(String::new())),
        }
    }
}

// ─── Progress event payload ───────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
struct ProgressPayload {
    count: usize,
    phase: &'static str, // "capturing" | "processing" | "done"
}

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn start_inventory_scan(
    state: State<'_, InventoryState>,
    app: AppHandle,
    scan_type: String,
) -> Result<(), String> {
    if state.running.load(Ordering::SeqCst) {
        return Err("Scan already running".into());
    }
    if !VALID_SCAN_TYPES.contains(&scan_type.as_str()) {
        return Err(format!("Invalid scan_type: {scan_type}"));
    }

    state.running.store(true, Ordering::SeqCst);
    {
        let mut items = state.items.lock().map_err(|e| e.to_string())?;
        items.clear();
        *state.scan_type.lock().map_err(|e| e.to_string())? = scan_type.clone();
    }

    // Clean up leftover frame files from previous runs
    let mut i = 0;
    loop {
        let p = std::path::PathBuf::from(format!("/tmp/wfhub_inv_{i}.png"));
        if p.exists() { let _ = fs::remove_file(&p); i += 1; } else { break; }
    }

    let running   = Arc::clone(&state.running);
    let items_arc = Arc::clone(&state.items);

    thread::spawn(move || {
        let scroll_script = resource_path(&app, "scripts/automation/inventory_scroll.py");
        let ocr_script    = resource_path(&app, "scripts/automation/inventory_ocr.py");

        // Focus Warframe once before loop
        focus_wine();
        thread::sleep(Duration::from_millis(400));

        // ── Phase 1: fast capture loop ────────────────────────────────────────
        log_to_file(&format!("[inventory] fase 1: capturando ({scan_type})"));
        let mut frame_idx: usize = 0;
        let mut prev_pixels: Option<Vec<u8>> = None;
        let mut still_frames: u32 = 0;
        const STILL_THRESHOLD: u32 = 3;
        const DIFF_THRESHOLD:  f64 = 4.0;
        const CROP_TOP_PCT:    f64 = 0.20;
        const CROP_BOT_PCT:    f64 = 0.80;

        loop {
            if !running.load(Ordering::SeqCst) {
                break;
            }

            let frame = CaptureWindow::all()
                .ok()
                .and_then(|ws| ws.into_iter().find(|w| w.title() == "Warframe"))
                .and_then(|w| w.capture_image().ok());

            let Some(frame) = frame else {
                log_to_file("[inventory] janela Warframe não encontrada");
                thread::sleep(Duration::from_millis(200));
                continue;
            };

            let image = DynamicImage::ImageRgba8(frame)
                .resize(1920, 1080, FilterType::Triangle);
            let pixels = image.to_rgb8().into_raw();

            if let Some(ref prev) = prev_pixels {
                let h = 1080usize;
                let w = 1920usize;
                let row_start = (h as f64 * CROP_TOP_PCT) as usize;
                let row_end   = (h as f64 * CROP_BOT_PCT) as usize;
                let stride    = w * 3;
                let step      = 16;

                let mut total_diff = 0.0f64;
                let mut count      = 0usize;
                for row in (row_start..row_end).step_by(step) {
                    let base = row * stride;
                    for col in (0..w).step_by(step) {
                        let idx = base + col * 3;
                        if idx + 2 < prev.len() && idx + 2 < pixels.len() {
                            for c in 0..3 {
                                total_diff += (prev[idx + c] as i32 - pixels[idx + c] as i32)
                                    .unsigned_abs() as f64;
                            }
                            count += 1;
                        }
                    }
                }
                let mean_diff = if count > 0 { total_diff / (count * 3) as f64 } else { 0.0 };

                if mean_diff < DIFF_THRESHOLD {
                    still_frames += 1;
                    log_to_file(&format!("[inventory] frame estático {still_frames}/{STILL_THRESHOLD} (diff={mean_diff:.2})"));
                    if still_frames >= STILL_THRESHOLD {
                        log_to_file("[inventory] fim do inventário detectado, parando captura");
                        running.store(false, Ordering::SeqCst);
                        if let Some(win) = app.get_webview_window("main") {
                            if !win.is_visible().unwrap_or(true) {
                                let _ = win.show();
                            }
                            let _ = win.set_focus();
                        }
                        break;
                    }
                } else {
                    still_frames = 0;
                }
            }
            prev_pixels = Some(pixels);

            let path = format!("/tmp/wfhub_inv_{frame_idx}.png");
            save_debug_image(&image, &path);
            if image.save(&path).is_err() {
                log_to_file(&format!("[inventory] falha ao salvar frame {frame_idx}"));
                thread::sleep(Duration::from_millis(150));
                continue;
            }

            frame_idx += 1;

            if let Some(win) = app.get_webview_window("main") {
                let _ = win.emit("inventory-progress", ProgressPayload {
                    count: frame_idx,
                    phase: "capturing",
                });
            }

            let _ = Command::new("/usr/bin/python3")
                .arg(&scroll_script)
                .arg(&scan_type)
                .output();

            thread::sleep(Duration::from_millis(50));
        }

        log_to_file(&format!("[inventory] fase 1 concluída: {frame_idx} frames"));

        // ── Phase 2: single-call batch OCR ───────────────────────────────────
        log_to_file(&format!("[inventory] fase 2: OCR batch em {frame_idx} frames"));

        let ocr_running = Arc::new(AtomicBool::new(true));
        {
            let app_ka = app.clone();
            let ocr_running_ka = Arc::clone(&ocr_running);
            thread::spawn(move || {
                for _ in 0..60 {
                    thread::sleep(Duration::from_secs(5));
                    if !ocr_running_ka.load(Ordering::SeqCst) { break; }
                    if let Some(win) = app_ka.get_webview_window("main") {
                        let _ = win.emit("inventory-progress", ProgressPayload {
                            count: 0,
                            phase: "processing",
                        });
                    }
                }
            });
        }

        let mut ocr_cmd = Command::new("/usr/bin/python3");
        ocr_cmd.arg(&ocr_script)
            .arg("--batch")
            .arg(frame_idx.to_string())
            .arg(&scan_type);
        let out = ocr_cmd.output();

        ocr_running.store(false, Ordering::SeqCst);

        for i in 0..frame_idx {
            let _ = fs::remove_file(format!("/tmp/wfhub_inv_{i}.png"));
        }

        match out {
            Err(e) => log_to_file(&format!("[inventory] OCR falhou: {e}")),
            Ok(o) if !o.status.success() => {
                log_to_file(&format!(
                    "[inventory] OCR erro: {}",
                    String::from_utf8_lossy(&o.stderr).trim()
                ));
            }
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                if !stderr.trim().is_empty() {
                    log_to_file(&format!("[inventory] OCR log:\n{}", stderr.trim()));
                }
                let stdout = String::from_utf8_lossy(&o.stdout);
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(stdout.trim()) {
                    if let Some(arr) = parsed["items"].as_array() {
                        let mut items = items_arc.lock().unwrap();
                        for val in arr {
                            if let Some(s) = val.as_str() {
                                items.insert(s.to_string());
                            }
                        }
                    }
                }
            }
        }

        let final_count = items_arc.lock().unwrap().len();
        log_to_file(&format!("[inventory] fase 2 concluída: {final_count} itens únicos"));

        if let Some(win) = app.get_webview_window("main") {
            let _ = win.emit("inventory-progress", ProgressPayload {
                count: final_count,
                phase: "done",
            });
        }
    });

    Ok(())
}

#[tauri::command]
pub fn stop_inventory_scan(state: State<'_, InventoryState>) -> Result<usize, String> {
    state.running.store(false, Ordering::SeqCst);
    Ok(0)
}

#[tauri::command]
pub fn save_inventory_result(state: State<'_, InventoryState>) -> Result<usize, String> {
    let items     = state.items.lock().map_err(|e| e.to_string())?;
    let scan_type = state.scan_type.lock().map_err(|e| e.to_string())?;
    let count     = items.len();
    if !scan_type.is_empty() && count > 0 {
        merge_inventory_json(&scan_type, &items)?;
        log_to_file(&format!("[inventory] salvo: {count} itens ({scan_type})"));
    }
    Ok(count)
}

#[tauri::command]
pub fn read_inventory() -> Result<String, String> {
    let path = data_path("inventory.json");
    if !path.exists() {
        return Ok(r#"{"mods":[],"arcanes":[],"prime_parts":[]}"#.to_string());
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Capture one frame of the Warframe window and run the debug OCR script on it.
/// Returns raw JSON: { scan_type, raw_lines, matched }
#[tauri::command]
pub fn debug_inventory_ocr(app: AppHandle, scan_type: String) -> Result<String, String> {
    if !VALID_SCAN_TYPES.contains(&scan_type.as_str()) {
        return Err(format!("Invalid scan_type: {scan_type}"));
    }

    let frame = xcap::Window::all()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| w.title() == "Warframe")
        .ok_or_else(|| "Janela Warframe não encontrada. Abra o jogo e tente novamente.".to_string())?
        .capture_image()
        .map_err(|e| e.to_string())?;

    let image = image::DynamicImage::ImageRgba8(frame)
        .resize(1920, 1080, image::imageops::FilterType::Triangle);

    let tmp_path = "/tmp/wfhub_inv_debug.png";
    image.save(tmp_path).map_err(|e| e.to_string())?;
    // Persistent copy for manual re-runs (survives the cleanup below)
    let _ = fs::copy(tmp_path, "/tmp/wfhub_inv_debug_last.png");

    let script = resource_path(&app, "scripts/automation/inventory_ocr_debug.py");
    let out = Command::new("/usr/bin/python3")
        .arg(&script)
        .arg(tmp_path)
        .arg(&scan_type)
        .output()
        .map_err(|e| e.to_string())?;

    let _ = fs::remove_file(tmp_path);

    let stderr = String::from_utf8_lossy(&out.stderr);
    if !stderr.trim().is_empty() {
        log_to_file(&format!("[inventory_debug] OCR log:\n{}", stderr.trim()));
    }

    if !out.status.success() {
        return Err(format!(
            "OCR falhou (exit {}): {}",
            out.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(stdout)
}

#[tauri::command]
pub fn save_prime_parts(parts: Vec<String>) -> Result<(), String> {
    let path = data_path("inventory.json");

    let mut data: serde_json::Value = if path.exists() {
        let content = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if data["mods"].is_null()    { data["mods"]    = serde_json::json!([]); }
    if data["arcanes"].is_null() { data["arcanes"]  = serde_json::json!([]); }

    let mut sorted = parts.clone();
    sorted.sort();
    sorted.dedup();
    data["prime_parts"] = serde_json::json!(sorted);

    let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn focus_app(app_name: &str) {
    let script = format!(
        r#"tell application "System Events"
            repeat with proc in every process
                if name of proc is "{app_name}" then
                    set frontmost of proc to true
                end if
            end repeat
        end tell"#
    );
    let _ = Command::new("osascript").arg("-e").arg(&script).output();
}

fn focus_wine() {
    focus_app("wine");
}

fn merge_inventory_json(scan_type: &str, items: &HashSet<String>) -> Result<(), String> {
    let path = data_path("inventory.json");

    let mut data: serde_json::Value = if path.exists() {
        let content = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&content).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    let mut sorted: Vec<String> = items.iter().cloned().collect();
    sorted.sort();

    if data["mods"].is_null()        { data["mods"]        = serde_json::json!([]); }
    if data["arcanes"].is_null()     { data["arcanes"]      = serde_json::json!([]); }
    if data["prime_parts"].is_null() { data["prime_parts"]  = serde_json::json!([]); }
    data[scan_type] = serde_json::json!(sorted);
    data["scanned_at"] = serde_json::json!(utc_iso_now());

    let content = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

pub fn utc_iso_now_pub() -> String { utc_iso_now() }

fn utc_iso_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let (y, mo, d, h, mi, s) = epoch_to_ymd_hms(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

fn epoch_to_ymd_hms(secs: u64) -> (u64, u64, u64, u64, u64, u64) {
    let s = secs % 60;
    let total_min = secs / 60;
    let mi = total_min % 60;
    let total_hr = total_min / 60;
    let h = total_hr % 24;
    let total_days = total_hr / 24;

    let mut year = 1970u64;
    let mut days = total_days;
    loop {
        let days_in_year = if is_leap(year) { 366 } else { 365 };
        if days < days_in_year { break; }
        days -= days_in_year;
        year += 1;
    }

    let mut month = 1u64;
    loop {
        let dim = days_in_month(month, year);
        if days < dim { break; }
        days -= dim;
        month += 1;
    }

    (year, month, days + 1, h, mi, s)
}

fn is_leap(y: u64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

fn days_in_month(m: u64, y: u64) -> u64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if is_leap(y) { 29 } else { 28 },
        _ => 30,
    }
}
