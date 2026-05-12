//! 切号时的 quota 快照
//!
//! 用途：用相邻两个快照之间的 `used_percent` 增量 + 该期间代理捕获到的 tokens
//! 反推 Plan 的窗口配额上限 —— 不需要把账号真的打到 usage_limit_reached。
//!
//! 上游 `/wham/usage` 只返回 used_percent（0-100 整数），没有绝对 token 计数。
//! 把"切号前后强制刷一次"作为采样事件，时间一长就能为每个 Plan / 窗口类型攒到
//! 足够多的 (Δpct, Δtokens) 样本，用 `get_plan_capacity_estimates` 算容量。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuotaSnapshot {
    pub ts: DateTime<Utc>,
    /// store 内部 id（与 TokenHistoryEntry.account_id 一致）
    pub account_id: String,
    pub email: String,
    pub plan_type: String,
    /// 0-100 整数
    pub five_hour_used_pct: i32,
    pub weekly_used_pct: i32,
    /// 上游返回的下一次重置时间戳，作为「窗口归属」锚点
    pub five_hour_reset_at: Option<i64>,
    pub weekly_reset_at: Option<i64>,
    /// 触发原因：`switch_out` / `switch_in` / `manual_refresh` / ...
    pub trigger: String,
}

pub fn path() -> PathBuf {
    dirs::home_dir()
        .expect("home dir")
        .join(".codex-switcher")
        .join("quota-snapshots.jsonl")
}

pub fn append(snap: &QuotaSnapshot) {
    if let Ok(json) = serde_json::to_string(snap) {
        use std::io::Write;
        let p = path();
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
        {
            let _ = writeln!(f, "{}", json);
        }
    }
}

pub fn read_all() -> Vec<QuotaSnapshot> {
    let content = std::fs::read_to_string(path()).unwrap_or_default();
    content
        .lines()
        .filter_map(|l| serde_json::from_str::<QuotaSnapshot>(l).ok())
        .collect()
}

/// 从一次成功的 `fetch_usage_direct` 结果同步写一条快照。
/// 各 quota refresh 路径调用，保证每个账号在窗口内有足够样本算 estimated_capacity。
pub fn append_from_usage(
    account_id: &str,
    email: &str,
    usage: &crate::usage::UsageDisplay,
    trigger: &str,
) {
    let snap = QuotaSnapshot {
        ts: Utc::now(),
        account_id: account_id.to_string(),
        email: email.to_string(),
        plan_type: usage.plan_type.clone(),
        five_hour_used_pct: usage.five_hour_used,
        weekly_used_pct: usage.weekly_used,
        five_hour_reset_at: usage.five_hour_reset_at,
        weekly_reset_at: usage.weekly_reset_at,
        trigger: trigger.to_string(),
    };
    append(&snap);
}
