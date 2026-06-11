use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent},
    webview::WebviewWindowBuilder,
    AppHandle, Manager,
};

const POPUP_WIDTH: f64 = 380.0;
const POPUP_HEIGHT: f64 = 410.0;
const POPUP_MARGIN: f64 = 8.0;
const TRAY_MENU_SHOW: &str = "show_main_window";
const TRAY_MENU_QUIT: &str = "quit_app";
static POPUP_PINNED: AtomicBool = AtomicBool::new(false);

/// 初始化系统托盘
pub fn init(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    // 加载并缩放图标
    let icon_bytes = include_bytes!("../icons/app-icon-squircle.png");
    let base_img =
        image::load_from_memory(icon_bytes).map_err(|e| format!("加载图标失败: {}", e))?;

    let target_size = 128;
    let content_size = 105;
    let padding = (target_size - content_size) / 2;

    let scaled_content = base_img.resize(
        content_size,
        content_size,
        image::imageops::FilterType::Lanczos3,
    );
    let mut final_img = image::RgbaImage::new(target_size, target_size);

    image::imageops::overlay(
        &mut final_img,
        &scaled_content,
        padding as i64,
        padding as i64,
    );

    let (width, height) = final_img.dimensions();
    let icon = Image::new_owned(final_img.into_raw(), width, height);
    let show_item = MenuItem::with_id(app, TRAY_MENU_SHOW, "打开主窗口", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, TRAY_MENU_QUIT, "退出应用", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show_item, &separator, &quit_item])?;

    let _tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(false)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_MENU_SHOW => show_main_window_from_cmd(app),
            TRAY_MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray: &TrayIcon, event: TrayIconEvent| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                position,
                ..
            } = event
            {
                // 左键点击 → 弹出 popup；右键保留给系统菜单。
                toggle_popup(tray.app_handle(), position);
            }
        })
        .build(app)?;

    println!("[Tray] 系统托盘已启动");
    Ok(())
}

/// 显示/隐藏 tray popup 窗口
fn toggle_popup(app: &AppHandle, position: tauri::PhysicalPosition<f64>) {
    let label = "tray-popup";

    // 如果已存在，切换显示/隐藏
    if let Some(win) = app.get_webview_window(label) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            return;
        }
        // 重新定位并显示
        let _ = position_popup(&win, position);
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }

    // 首次创建
    let url = tauri::WebviewUrl::App("index.html".into());

    match WebviewWindowBuilder::new(app, label, url)
        .title("Codex Switcher")
        .inner_size(POPUP_WIDTH, POPUP_HEIGHT)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
    {
        Ok(win) => {
            // 监听焦点丢失 → 自动隐藏
            let win_clone = win.clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    if is_popup_pinned() {
                        return;
                    }
                    let _ = win_clone.hide();
                }
            });

            let _ = position_popup(&win, position);
            let _ = win.show();
            let _ = win.set_focus();
        }
        Err(e) => eprintln!("[Tray] 创建 popup 窗口失败: {}", e),
    }
}

/// 将 popup 窗口定位到托盘图标附近（macOS 顶部菜单栏下方）
fn position_popup(
    win: &tauri::WebviewWindow,
    tray_pos: tauri::PhysicalPosition<f64>,
) -> Result<(), String> {
    let monitor = win
        .available_monitors()
        .ok()
        .and_then(|monitors| {
            monitors.into_iter().find(|monitor| {
                let pos = monitor.position();
                let size = monitor.size();
                let left = pos.x as f64;
                let top = pos.y as f64;
                let right = left + size.width as f64;
                let bottom = top + size.height as f64;

                tray_pos.x >= left
                    && tray_pos.x <= right
                    && tray_pos.y >= top
                    && tray_pos.y <= bottom
            })
        })
        .or_else(|| win.current_monitor().ok().flatten());

    let scale = monitor
        .as_ref()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or_else(|| win.scale_factor().unwrap_or(1.0));
    let popup_width = POPUP_WIDTH * scale;
    let popup_height = POPUP_HEIGHT * scale;
    let margin = POPUP_MARGIN * scale;

    let (left, top, right, bottom) = monitor
        .map(|monitor| {
            let area = monitor.work_area();
            let left = area.position.x as f64;
            let top = area.position.y as f64;
            let right = left + area.size.width as f64;
            let bottom = top + area.size.height as f64;
            (left, top, right, bottom)
        })
        .unwrap_or((0.0, 0.0, f64::INFINITY, f64::INFINITY));

    let max_x = right - popup_width;
    let x = if max_x < left {
        left
    } else {
        (tray_pos.x - popup_width / 2.0).clamp(left, max_x)
    };

    let below_y = tray_pos.y + margin;
    let above_y = tray_pos.y - popup_height - margin;
    let popup_y = if below_y + popup_height <= bottom {
        below_y
    } else if above_y >= top {
        above_y
    } else {
        let max_y = bottom - popup_height;
        if max_y < top {
            top
        } else {
            max_y
        }
    };

    win.set_position(tauri::Position::Physical(tauri::PhysicalPosition::new(
        x.round() as i32,
        popup_y.round() as i32,
    )))
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn set_popup_pinned(pinned: bool) {
    POPUP_PINNED.store(pinned, Ordering::Relaxed);
}

pub fn is_popup_pinned() -> bool {
    POPUP_PINNED.load(Ordering::Relaxed)
}

pub fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        #[cfg(target_os = "macos")]
        app.set_activation_policy(tauri::ActivationPolicy::Regular)
            .unwrap_or(());
    }
}

/// 供 Tauri command 调用的入口
pub fn show_main_window_from_cmd(app: &AppHandle) {
    show_main_window(app);
    if is_popup_pinned() {
        return;
    }
    // 非常驻时打开主窗口后隐藏 popup，保持旧体验。
    if let Some(popup) = app.get_webview_window("tray-popup") {
        let _ = popup.hide();
    }
}

/// 更新托盘 tooltip（不再需要完整菜单）
///
/// **关键**：`tray.set_tooltip` 是 Tauri/Cocoa GUI API，内部走 mpmc channel
/// 等主线程在 NSApplication runloop 处理。如果调用时**还持有 store.lock()**，
/// 而主线程刚好在执行 UI 的 `get_accounts`（也要拿同一把 store lock），就死锁：
///   - tokio worker: 持 store.lock() → 调 set_tooltip → 等主线程
///   - 主线程: 在 get_accounts → 等 store.lock()
/// 修法：tooltip 构建放在内层 block 让 guard 在 set_tooltip 前 drop。
pub fn update_tray_menu(app: &AppHandle) {
    let state = app.state::<crate::AppState>();
    let tooltip = {
        let store = match state.store.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        if let Some(current_id) = &store.current {
            if let Some(acc) = store.accounts.get(current_id) {
                let quota = acc
                    .cached_quota
                    .as_ref()
                    .map(|q| format!(" | 5H: {:.0}%  周: {:.0}%", q.five_hour_left, q.weekly_left))
                    .unwrap_or_default();
                format!("Codex Switcher - {}{}", acc.name, quota)
            } else {
                "Codex Switcher".to_string()
            }
        } else {
            "Codex Switcher - 未登录".to_string()
        }
        // store guard 在 block 结束（这一行）时 drop，set_tooltip 在外面跑
    };

    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}
