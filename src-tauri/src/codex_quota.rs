//! 从 Codex Desktop 本地 rollout jsonl 里实时提取配额。
//!
//! Codex 客户端会在 `~/.codex/sessions/**/rollout-*.jsonl` 的 `event_msg` 行里
//! 写入 `rate_limits`。这里增量读取最新活跃文件，把它映射回当前账号的
//! `cached_quota`，避免常驻 UI 为了配额持续打网络接口。

use crate::account::{AccountStore, CachedQuota};
use crate::usage::UsageDisplay;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::SystemTime;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize)]
pub struct CodexQuotaUpdate {
    pub account_id: String,
    pub account_name: String,
    pub usage: UsageDisplay,
    pub source_path: String,
    pub observed_at: DateTime<Utc>,
}

#[derive(Debug, Clone)]
struct RolloutCursor {
    path: PathBuf,
    offset: u64,
}

#[derive(Debug, Clone)]
struct RateLimitSnapshot {
    primary_used_percent: f64,
    primary_reset_at: Option<i64>,
    primary_window_minutes: Option<i64>,
    secondary_used_percent: f64,
    secondary_reset_at: Option<i64>,
    secondary_window_minutes: Option<i64>,
    plan_type: Option<String>,
    has_credits: bool,
    credits_balance: Option<f64>,
}

pub fn start(
    store: Arc<Mutex<AccountStore>>,
    app: tauri::AppHandle,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        println!("[CodexQuota] 本地 rollout 配额监听已启动");
        let mut cursor: Option<RolloutCursor> = None;

        loop {
            if let Err(e) = tick(&store, &app, &mut cursor) {
                eprintln!("[CodexQuota] 监听失败: {}", e);
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    })
}

fn tick(
    store: &Arc<Mutex<AccountStore>>,
    app: &tauri::AppHandle,
    cursor: &mut Option<RolloutCursor>,
) -> Result<(), String> {
    let Some(path) = latest_rollout_file() else {
        return Ok(());
    };

    let is_new_file = cursor.as_ref().map(|c| c.path != path).unwrap_or(true);
    if is_new_file {
        *cursor = Some(RolloutCursor {
            path: path.clone(),
            offset: 0,
        });
    }

    let Some(cur) = cursor.as_mut() else {
        return Ok(());
    };
    let len = std::fs::metadata(&cur.path)
        .map_err(|e| format!("metadata {}: {}", cur.path.display(), e))?
        .len();
    if len < cur.offset {
        cur.offset = 0;
    }
    if len == cur.offset {
        return Ok(());
    }

    let snapshots = read_new_snapshots(cur)?;
    for snap in snapshots {
        if let Some(update) = apply_snapshot(store, &snap, &cur.path)? {
            crate::tray::update_tray_menu(app);
            let _ = app.emit("codex-quota-updated", &update);
        }
    }

    Ok(())
}

fn read_new_snapshots(cursor: &mut RolloutCursor) -> Result<Vec<RateLimitSnapshot>, String> {
    let mut file = std::fs::File::open(&cursor.path)
        .map_err(|e| format!("open {}: {}", cursor.path.display(), e))?;
    file.seek(SeekFrom::Start(cursor.offset))
        .map_err(|e| format!("seek {}: {}", cursor.path.display(), e))?;

    let mut reader = BufReader::new(file);
    let mut out = Vec::new();
    let mut offset = cursor.offset;

    loop {
        let mut line = String::new();
        let bytes = reader
            .read_line(&mut line)
            .map_err(|e| format!("read {}: {}", cursor.path.display(), e))?;
        if bytes == 0 {
            break;
        }

        let trimmed = line.trim();
        if trimmed.is_empty() {
            offset += bytes as u64;
            continue;
        }

        match serde_json::from_str::<Value>(trimmed) {
            Ok(v) => {
                if let Some(snap) = parse_rate_limits(&v) {
                    out.push(snap);
                }
                offset += bytes as u64;
            }
            Err(_) if !line.ends_with('\n') => {
                // 写入方可能刚好还没刷完整行；下次 tick 从本行开头重读。
                break;
            }
            Err(_) => {
                offset += bytes as u64;
            }
        }
    }

    cursor.offset = offset;
    Ok(out)
}

fn parse_rate_limits(v: &Value) -> Option<RateLimitSnapshot> {
    let limits = v
        .get("payload")
        .and_then(|payload| payload.get("rate_limits"))
        .or_else(|| v.get("rate_limits"))?;
    let primary = limits.get("primary")?;
    let secondary = limits.get("secondary")?;
    if primary.is_null() || secondary.is_null() {
        return None;
    }

    let primary_used_percent = percent_to_f64(primary.get("used_percent")?)?;
    let secondary_used_percent = percent_to_f64(secondary.get("used_percent")?)?;
    let credits = limits.get("credits").unwrap_or(&Value::Null);
    let has_credits = credits
        .get("has_credits")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
        || credits
            .get("unlimited")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

    Some(RateLimitSnapshot {
        primary_used_percent,
        primary_reset_at: primary.get("resets_at").and_then(number_to_i64),
        primary_window_minutes: primary.get("window_minutes").and_then(number_to_i64),
        secondary_used_percent,
        secondary_reset_at: secondary.get("resets_at").and_then(number_to_i64),
        secondary_window_minutes: secondary.get("window_minutes").and_then(number_to_i64),
        plan_type: limits
            .get("plan_type")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
        has_credits,
        credits_balance: credits.get("balance").and_then(number_to_f64),
    })
}

fn apply_snapshot(
    store: &Arc<Mutex<AccountStore>>,
    snap: &RateLimitSnapshot,
    source_path: &Path,
) -> Result<Option<CodexQuotaUpdate>, String> {
    let mut s = store.lock().map_err(|e| e.to_string())?;
    let Some(account_id) = resolve_target_account_id(&s) else {
        return Ok(None);
    };
    let Some(account) = s.accounts.get_mut(&account_id) else {
        return Ok(None);
    };
    if !account.is_chatgpt_oauth()
        || account.is_banned
        || account.is_token_invalid
        || account.is_logged_out
    {
        return Ok(None);
    }

    let plan_type = snap
        .plan_type
        .clone()
        .or_else(|| account.cached_quota.as_ref().map(|q| q.plan_type.clone()))
        .unwrap_or_else(|| "unknown".to_string());
    let usage = snapshot_to_usage(snap, &plan_type);
    let next_cached = usage_to_cached(&usage);

    let changed = account
        .cached_quota
        .as_ref()
        .map(|q| {
            q.five_hour_left.round() as i32 != next_cached.five_hour_left.round() as i32
                || q.weekly_left.round() as i32 != next_cached.weekly_left.round() as i32
                || q.five_hour_reset_at != next_cached.five_hour_reset_at
                || q.weekly_reset_at != next_cached.weekly_reset_at
                || q.plan_type != next_cached.plan_type
        })
        .unwrap_or(true);

    if !changed {
        return Ok(None);
    }

    account.cached_quota = Some(next_cached);
    account.is_token_invalid = false;
    account.is_logged_out = false;
    let account_name = account.name.clone();
    s.save()?;

    Ok(Some(CodexQuotaUpdate {
        account_id,
        account_name,
        usage,
        source_path: source_path.to_string_lossy().to_string(),
        observed_at: Utc::now(),
    }))
}

fn resolve_target_account_id(store: &AccountStore) -> Option<String> {
    // 代理开启时，Codex 请求由本应用注入 store.current 的 token；这时 current 是权威。
    if store.settings.proxy_enabled {
        if let Some(id) = store.current.as_ref() {
            if store
                .accounts
                .get(id)
                .map(|a| a.is_chatgpt_oauth())
                .unwrap_or(false)
            {
                return Some(id.clone());
            }
        }
    }

    // 代理未开启或 current 不是订阅号时，回退到磁盘 auth.json 匹配到的账号。
    if let Ok(disk_auth) = AccountStore::read_codex_auth() {
        if let Some((id, _)) = store.accounts.iter().find(|(_, a)| {
            a.is_chatgpt_oauth() && AccountStore::auth_identity_matches(&a.auth_json, &disk_auth)
        }) {
            return Some(id.clone());
        }
    }

    store.current.as_ref().and_then(|id| {
        store
            .accounts
            .get(id)
            .filter(|a| a.is_chatgpt_oauth())
            .map(|_| id.clone())
    })
}

fn snapshot_to_usage(snap: &RateLimitSnapshot, plan_type: &str) -> UsageDisplay {
    let five_hour_used = used_display_percent(snap.primary_used_percent);
    let five_hour_left = left_display_percent(snap.primary_used_percent);
    let weekly_used = used_display_percent(snap.secondary_used_percent);
    let weekly_left = left_display_percent(snap.secondary_used_percent);
    UsageDisplay {
        plan_type: plan_type.to_string(),
        five_hour_used,
        five_hour_left,
        five_hour_label: limits_label(snap.primary_window_minutes, "5H 限额"),
        five_hour_reset: reset_text(snap.primary_reset_at),
        five_hour_reset_at: snap.primary_reset_at,
        weekly_used,
        weekly_left,
        weekly_label: limits_label(snap.secondary_window_minutes, "周限额"),
        weekly_reset: reset_text(snap.secondary_reset_at),
        weekly_reset_at: snap.secondary_reset_at,
        credits_balance: snap.credits_balance,
        has_credits: snap.has_credits,
        is_valid_for_cli: true,
    }
}

fn usage_to_cached(u: &UsageDisplay) -> CachedQuota {
    CachedQuota {
        five_hour_left: u.five_hour_left as f64,
        five_hour_reset: u.five_hour_reset.clone(),
        five_hour_reset_at: u.five_hour_reset_at,
        five_hour_label: u.five_hour_label.clone(),
        weekly_left: u.weekly_left as f64,
        weekly_reset: u.weekly_reset.clone(),
        weekly_reset_at: u.weekly_reset_at,
        weekly_label: u.weekly_label.clone(),
        plan_type: u.plan_type.clone(),
        is_valid_for_cli: true,
        updated_at: Utc::now(),
    }
}

fn percent_to_f64(v: &Value) -> Option<f64> {
    let n = number_to_f64(v)?;
    if n.is_finite() {
        Some(n.clamp(0.0, 100.0))
    } else {
        None
    }
}

fn used_display_percent(used_percent: f64) -> i32 {
    used_percent.ceil().clamp(0.0, 100.0) as i32
}

fn left_display_percent(used_percent: f64) -> i32 {
    (100.0 - used_percent).floor().clamp(0.0, 100.0) as i32
}

fn number_to_f64(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_i64().map(|n| n as f64))
        .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
}

fn number_to_i64(v: &Value) -> Option<i64> {
    v.as_i64()
        .or_else(|| v.as_f64().map(|n| n as i64))
        .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
}

fn limits_label(window_minutes: Option<i64>, default_label: &str) -> String {
    match window_minutes {
        Some(m) if m <= 310 => "5H 限额".to_string(),
        Some(m) if m <= 1_500 => "24H 限额".to_string(),
        Some(m) if m <= 10_140 => "周限额".to_string(),
        Some(m) if m > 0 => format!("{}H 限额", (m + 59) / 60),
        _ => default_label.to_string(),
    }
}

fn reset_text(reset_at: Option<i64>) -> String {
    let Some(ts) = reset_at else {
        return "未知".to_string();
    };
    let now = Utc::now().timestamp();
    let diff = ts - now;
    if diff <= 0 {
        return "即将重置".to_string();
    }

    let days = diff / 86_400;
    let hours = (diff % 86_400) / 3_600;
    let minutes = (diff % 3_600) / 60;
    if days > 0 {
        format!("{}天后重置", days)
    } else if hours > 0 {
        format!("{}小时{}分钟后重置", hours, minutes)
    } else if minutes > 0 {
        format!("{}分钟后重置", minutes)
    } else {
        "即将重置".to_string()
    }
}

fn latest_rollout_file() -> Option<PathBuf> {
    let root = dirs::home_dir()?.join(".codex").join("sessions");
    if !root.exists() {
        return None;
    }
    let files = walk_jsonl(&root);
    let mut best: Option<(SystemTime, PathBuf)> = None;
    for path in files {
        let mtime = match std::fs::metadata(&path).and_then(|m| m.modified()) {
            Ok(mtime) => mtime,
            Err(_) => continue,
        };
        match &best {
            Some((best_time, _)) if &mtime <= best_time => {}
            _ => best = Some((mtime, path)),
        }
    }
    best.map(|(_, path)| path)
}

fn walk_jsonl(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let year_dirs = match std::fs::read_dir(root) {
        Ok(dirs) => dirs,
        Err(_) => return out,
    };
    for year in year_dirs.flatten() {
        if !year.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let month_dirs = match std::fs::read_dir(year.path()) {
            Ok(dirs) => dirs,
            Err(_) => continue,
        };
        for month in month_dirs.flatten() {
            if !month.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let day_dirs = match std::fs::read_dir(month.path()) {
                Ok(dirs) => dirs,
                Err(_) => continue,
            };
            for day in day_dirs.flatten() {
                if !day.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let files = match std::fs::read_dir(day.path()) {
                    Ok(files) => files,
                    Err(_) => continue,
                };
                for file in files.flatten() {
                    let path = file.path();
                    if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                        continue;
                    }
                    if path
                        .file_name()
                        .and_then(|s| s.to_str())
                        .map(|name| name.starts_with("rollout-"))
                        .unwrap_or(false)
                    {
                        out.push(path);
                    }
                }
            }
        }
    }
    out
}
