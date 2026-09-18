// Agora desktop shell: spawn the bundled Node sidecar (agora server) on a
// free localhost port, then point the webview at it. Owns the sidecar's
// lifecycle: stale-PID reclaim on start, graceful kill on exit.

use std::fs::{self, File};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{Manager, RunEvent, WindowEvent};

static SIDECAR: OnceLock<Mutex<Option<Child>>> = OnceLock::new();
static SIDECAR_PORT: OnceLock<u16> = OnceLock::new();

fn home_dir() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"))
}

fn agora_home() -> PathBuf {
    std::env::var("AGORA_HOME").map(PathBuf::from).unwrap_or_else(|_| home_dir().join(".agora"))
}

fn pid_file() -> PathBuf {
    agora_home().join("app-sidecar.pid")
}

fn sidecar_port() -> u16 {
    SIDECAR_PORT.get().copied().unwrap_or(7878)
}

fn show_window(app: &tauri::AppHandle, path: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let url = format!("http://127.0.0.1:{}{}", sidecar_port(), path);
        if let Ok(parsed) = url.parse() {
            let _ = window.navigate(parsed);
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Switch sections from a menu the way the app itself does — set the hash and
/// let React re-render. `navigate()` would reload the whole webview (white
/// flash, every panel refetched) just to move between two tabs, which is
/// exactly how a wrapped web page behaves and a native app does not.
fn go_to_section(app: &tauri::AppHandle, section: &str) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(&format!(
            "window.location.hash='/{section}';window.dispatchEvent(new CustomEvent('agora:nav',{{detail:'{section}'}}))"
        ));
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Open the settings panel (same entry point as the in-app ⌘, handler).
fn open_settings(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval("window.dispatchEvent(new Event('agora:toggle-settings'))");
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_tray(app: &tauri::AppHandle) -> Result<(), tauri::Error> {
    let open = MenuItem::with_id(app, "open", "打开 Agora", true, None::<&str>)?;
    let usage = MenuItem::with_id(app, "usage", "用量看板", true, None::<&str>)?;
    let memory = MenuItem::with_id(app, "memory", "记忆中枢", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &usage, &memory, &quit])?;

    let icon_bytes: &[u8] = include_bytes!("../icons/32x32.png");
    let icon = Image::from_bytes(icon_bytes).expect("tray icon");

    TrayIconBuilder::new()
        .icon(icon)
        .tooltip("Agora — 本地 AI 中枢")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_window(app, "/"),
            "usage" => go_to_section(app, "usage"),
            "memory" => go_to_section(app, "memory"),
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Standard macOS menu bar (App/Edit/Window) — without this, Tauri ships no
/// menu at all, so system shortcuts like Cmd+C/V/Z and Cmd+Q silently do
/// nothing (the #1 tell that a window is "just a webview", not a real app).
fn build_menu(app: &tauri::AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let app_menu = Submenu::with_items(
        app,
        "Agora",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "nav:settings", "设置…", true, Some("CmdOrCtrl+,"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, None)?,
        ],
    )?;

    // The sections already answer to ⌘1..⌘4 in the frontend; listing them here
    // is what makes those shortcuts discoverable (and gives the menu bar the
    // shape people expect from a Mac app).
    let view_menu = Submenu::with_items(
        app,
        "视图",
        true,
        &[
            &MenuItem::with_id(app, "nav:usage", "用量看板", true, Some("CmdOrCtrl+1"))?,
            &MenuItem::with_id(app, "nav:kb", "知识库", true, Some("CmdOrCtrl+2"))?,
            &MenuItem::with_id(app, "nav:tools", "工具中心", true, Some("CmdOrCtrl+3"))?,
            &MenuItem::with_id(app, "nav:memory", "记忆中枢", true, Some("CmdOrCtrl+4"))?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &edit_menu, &view_menu, &window_menu])
}

fn pick_free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .expect("bind ephemeral port")
        .local_addr()
        .expect("local addr")
        .port()
}

/// Kill a stale sidecar from a previous (crashed) run, if any.
fn reclaim_stale_sidecar() {
    let path = pid_file();
    if let Ok(content) = fs::read_to_string(&path) {
        if let Ok(pid) = content.trim().parse::<u32>() {
            let _ = Command::new("kill").arg(pid.to_string()).status();
        }
        let _ = fs::remove_file(&path);
    }
}

/// Finder-launched apps get a minimal PATH; enrich it so agent detection
/// (whichBin) and tools like git keep working inside the sidecar.
fn enriched_path() -> String {
    let home = home_dir();
    let extras = [
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        home.join("bin").to_string_lossy().into_owned(),
        home.join(".local/bin").to_string_lossy().into_owned(),
        home.join(".hermes/node/bin").to_string_lossy().into_owned(),
    ];
    let current = std::env::var("PATH").unwrap_or_default();
    format!("{}:{}", extras.join(":"), current)
}

fn wait_ready(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(120));
    }
    false
}

fn main() {
    tauri::Builder::default()
        .on_menu_event(|app, event| match event.id().as_ref() {
            "nav:settings" => open_settings(app),
            id => {
                if let Some(section) = id.strip_prefix("nav:") {
                    go_to_section(app, section);
                }
            }
        })
        .plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {
            // Second launch: focus the existing window instead of spawning
            // a new sidecar (the plugin terminates this new process for us).
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            reclaim_stale_sidecar();
            let port = pick_free_port();
            let _ = SIDECAR_PORT.set(port);

            // sidecar binary is packed next to the app exe via externalBin
            let exe_dir = std::env::current_exe()
                .expect("current exe")
                .parent()
                .expect("exe parent")
                .to_path_buf();
            let sidecar_exe = exe_dir.join("node-runtime");

            let resource_dir = app.path().resource_dir().expect("resource dir");
            let server_entry = resource_dir.join("sidecar").join("dist").join("server.mjs");

            let _ = fs::create_dir_all(agora_home());
            let log_path = agora_home().join("app-sidecar.log");
            let log_out = File::create(&log_path).expect("sidecar log");
            let log_err = log_out.try_clone().expect("log clone");

            let child = Command::new(&sidecar_exe)
                .arg(&server_entry)
                .env("AGORA_PORT", port.to_string())
                .env("AGORA_HOME", agora_home())
                .env("PATH", enriched_path())
                .stdout(Stdio::from(log_out))
                .stderr(Stdio::from(log_err))
                .spawn()
                .expect("spawn agora sidecar");

            let _ = fs::write(pid_file(), child.id().to_string());
            let _ = SIDECAR.set(Mutex::new(Some(child)));

            let ready = wait_ready(port, Duration::from_secs(20));
            let window = app.get_webview_window("main").expect("main window");
            let target = if ready {
                format!("http://127.0.0.1:{port}")
            } else {
                // sidecar failed to come up — surface its log inline
                let _ = window.eval(&format!(
                    "document.body.innerHTML='<pre style=\"color:#f87171;background:#06070c;height:100vh;margin:0;padding:24px;font:12px/1.6 monospace;white-space:pre-wrap\">Agora sidecar 启动失败，日志：{}\\n\\n{}</pre>'",
                    log_path.display(),
                    fs::read_to_string(&log_path)
                        .unwrap_or_default()
                        .replace('\\', "\\\\").replace('\'', "\\'").replace('\n', "\\n")
                ));
                String::new()
            };
            if !target.is_empty() {
                window
                    .navigate(target.parse().expect("url parse"))
                    .expect("navigate");
            }

            app.set_menu(build_menu(app.handle())?)?;
            build_tray(app.handle())?;

            // Closing the window hides it — the hub keeps running in the
            // menu bar. Real exit happens via the tray 退出 item.
            if let Some(window) = app.get_webview_window("main") {
                let window_for_event = window.clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_for_event.hide();
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error building agora desktop")
        .run(|_app, event| match event {
            RunEvent::ExitRequested { .. } => {
                if let Some(lock) = SIDECAR.get() {
                    if let Ok(mut guard) = lock.lock() {
                        if let Some(mut child) = guard.take() {
                            let _ = child.kill();
                        }
                    }
                }
                let _ = fs::remove_file(pid_file());
            }
            _ => {}
        });
}
