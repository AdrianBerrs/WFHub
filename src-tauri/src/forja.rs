use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Seek, SeekFrom},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};

use tauri::{AppHandle, Emitter, Manager, State};

use crate::{log_to_file, project_root};

// ─── Item config ──────────────────────────────────────────────────────────────

struct ForjaItemCfg {
    display_name:     &'static str,
    cooldown_secs:    u64,
    trigger_keyword:  &'static str,
    trigger_required: &'static str,
}

static ITEMS: &[(&str, ForjaItemCfg)] = &[
    (
        "decodificador_1x",
        ForjaItemCfg {
            display_name:     "Decodificador (1×)",
            cooldown_secs:    55,
            trigger_keyword:  "DFoundry",
            trigger_required: "Background.lua",
        },
    ),
];

fn find_item(key: &str) -> Option<&'static ForjaItemCfg> {
    ITEMS.iter().find(|(k, _)| *k == key).map(|(_, cfg)| cfg)
}

// ─── Managed state ────────────────────────────────────────────────────────────

pub struct ForjaState {
    pub running:     Arc<AtomicBool>,
    pub item_key:    Arc<Mutex<String>>,
    pub craft_count: Arc<Mutex<usize>>,
}

impl Default for ForjaState {
    fn default() -> Self {
        Self {
            running:     Arc::new(AtomicBool::new(false)),
            item_key:    Arc::new(Mutex::new(String::new())),
            craft_count: Arc::new(Mutex::new(0)),
        }
    }
}

// ─── Event payload ────────────────────────────────────────────────────────────

#[derive(serde::Serialize, Clone)]
struct ForjaPayload {
    phase: &'static str, // "idle" | "waiting" | "acting"
    count: usize,
    item:  String,
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn emit_status(app: &AppHandle, phase: &'static str, count: usize, item: &str) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.emit("forja-status", ForjaPayload {
            phase,
            count,
            item: item.to_string(),
        });
    }
}

// ─── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn start_forja(
    state: State<'_, ForjaState>,
    app: AppHandle,
    item_key: String,
) -> Result<(), String> {
    if state.running.load(Ordering::SeqCst) {
        return Err("Monitor já está rodando".into());
    }
    if find_item(&item_key).is_none() {
        return Err(format!("Item desconhecido: {item_key}"));
    }

    state.running.store(true, Ordering::SeqCst);
    *state.item_key.lock().map_err(|e| e.to_string())? = item_key.clone();
    *state.craft_count.lock().map_err(|e| e.to_string())? = 0;

    let running     = Arc::clone(&state.running);
    let craft_count = Arc::clone(&state.craft_count);

    thread::spawn(move || {
        let cfg = match find_item(&item_key) {
            Some(c) => c,
            None => {
                running.store(false, Ordering::SeqCst);
                return;
            }
        };

        let log_path    = crate::get_log_path();
        let click_script = project_root().join("scripts/automation/forja_click.py");

        log_to_file(&format!(
            "[forja] monitor iniciado: {} (cooldown={}s)",
            cfg.display_name, cfg.cooldown_secs
        ));

        // Seek to end of log so we only react to new entries
        let mut position: u64 = fs::metadata(&log_path)
            .map(|m| m.len())
            .unwrap_or(0);

        let mut count = 0usize;
        emit_status(&app, "waiting", count, &item_key);

        loop {
            if !running.load(Ordering::SeqCst) {
                break;
            }

            thread::sleep(Duration::from_millis(200));

            let Ok(meta) = fs::metadata(&log_path) else { continue; };
            let current_len = meta.len();

            if current_len <= position {
                // Log truncated or unchanged
                if current_len < position { position = current_len; }
                continue;
            }

            let Ok(mut file) = File::open(&log_path) else { continue; };
            if file.seek(SeekFrom::Start(position)).is_err() { continue; }
            position = current_len;

            let reader = BufReader::new(file);
            let mut triggered = false;
            for line in reader.lines().map_while(Result::ok) {
                if line.contains(cfg.trigger_keyword) && line.contains(cfg.trigger_required) {
                    triggered = true;
                    break;
                }
            }

            if !triggered { continue; }

            log_to_file(&format!("[forja] item pronto! executando cliques ({})...", cfg.display_name));
            emit_status(&app, "acting", count, &item_key);

            let _ = Command::new("/usr/bin/python3")
                .arg(&click_script)
                .arg(&item_key)
                .output();

            count += 1;
            *craft_count.lock().unwrap() = count;

            log_to_file(&format!("[forja] fabricação #{count} iniciada. aguardando {}s...", cfg.cooldown_secs));
            emit_status(&app, "waiting", count, &item_key);

            // Sleep cooldown (interruptible by stop)
            let deadline = Duration::from_secs(cfg.cooldown_secs);
            let step     = Duration::from_millis(200);
            let mut elapsed = Duration::ZERO;
            while elapsed < deadline {
                if !running.load(Ordering::SeqCst) { break; }
                thread::sleep(step);
                elapsed += step;
            }
        }

        running.store(false, Ordering::SeqCst);
        log_to_file("[forja] monitor encerrado");
        emit_status(&app, "idle", 0, &item_key);
    });

    Ok(())
}

#[tauri::command]
pub fn stop_forja(state: State<'_, ForjaState>) -> Result<usize, String> {
    state.running.store(false, Ordering::SeqCst);
    let count = *state.craft_count.lock().map_err(|e| e.to_string())?;
    Ok(count)
}
