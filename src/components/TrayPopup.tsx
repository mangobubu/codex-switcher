import { useState, useEffect, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { PhysicalPosition } from '@tauri-apps/api/window';
// Rust 端 on_window_event(Focused(false)) 负责隐藏弹窗
import './TrayPopup.css';

interface QuotaInfo {
    five_hour_left: number;
    five_hour_reset_at: number | null;
    weekly_left: number;
    weekly_reset_at: number | null;
    plan_type: string;
}

interface AccountInfo {
    id: string;
    name: string;
    is_banned: boolean;
    is_token_invalid: boolean;
    is_logged_out: boolean;
    cached_quota: QuotaInfo | null;
}

interface ProxyStatus {
    enabled: boolean;
    port: number;
    is_running: boolean;
    total_requests: number;
    auto_switches: number;
}

interface TokenStats {
    total_input_tokens: number;
    total_output_tokens: number;
    total_tokens: number;
    total_cost_usd: number;
    total_requests: number;
    last_month_cost: number | null;
    last_month_tokens: number | null;
}

interface TrayData {
    account: AccountInfo | null;
    proxy: ProxyStatus;
    tokens: TokenStats;
    next_account: { name: string; score: number } | null;
    /** 当前 anchor 账号名（若有），current != anchor 时切号 disk 不动 */
    anchor: { name: string; is_current: boolean } | null;
}

interface CodexQuotaUpdate {
    account_id: string;
    usage: {
        plan_type: string;
        five_hour_left: number;
        five_hour_reset_at?: number | null;
        weekly_left: number;
        weekly_reset_at?: number | null;
    };
}

function formatCountdown(resetAt: number | null): string {
    if (!resetAt || resetAt <= 0) return '未知';
    const diff = resetAt - Math.floor(Date.now() / 1000);
    if (diff <= 0) return '即将重置';
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    return h > 0 ? `${h}小时 ${m}分钟` : `${m}分钟`;
}

function formatTokens(n: number): string {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
    return n.toString();
}

function statusClass(pct: number): string {
    if (pct > 50) return 'healthy';
    if (pct > 10) return 'warning';
    return 'critical';
}

function statusLabel(pct: number): string {
    if (pct > 50) return '充足';
    if (pct > 10) return '偏低';
    return '紧张';
}

export function TrayPopup() {
    const [data, setData] = useState<TrayData | null>(null);
    const [switching, setSwitching] = useState(false);
    const [pinned, setPinned] = useState(() => localStorage.getItem('tray-popup-pinned') === 'true');
    const cleanupManualDragRef = useRef<(() => void) | null>(null);

    const applyPinned = async (next: boolean) => {
        setPinned(next);
        localStorage.setItem('tray-popup-pinned', String(next));
        await invoke('set_tray_popup_pinned_cmd', { pinned: next });
    };

    const fetchData = async () => {
        try {
            const [proxy, tokens] = await Promise.all([
                invoke<ProxyStatus>('get_proxy_status'),
                invoke<TokenStats>('get_token_stats'),
            ]);

            // Get current account info from accounts list
            const accounts = await invoke<any[]>('get_accounts');
            const currentId = await invoke<string | null>('get_current_account_id');
            const account = currentId ? accounts.find((a: any) => a.id === currentId) : null;
            const anchorAcc = accounts.find((a: any) => a.is_session_anchor);

            setData({
                account: account ? {
                    id: account.id,
                    name: account.name,
                    is_banned: account.is_banned,
                    is_token_invalid: account.is_token_invalid,
                    is_logged_out: account.is_logged_out,
                    cached_quota: account.cached_quota,
                } : null,
                proxy,
                tokens,
                next_account: null, // Will be populated later
                anchor: anchorAcc
                    ? { name: anchorAcc.name, is_current: anchorAcc.id === currentId }
                    : null,
            });
        } catch (e) {
            console.error('Failed to fetch tray data:', e);
        }
    };

    useEffect(() => {
        document.documentElement.classList.add('is-tray-popup');
        document.body.classList.add('is-tray-popup');
        invoke('set_tray_popup_pinned_cmd', { pinned }).catch(console.error);
        fetchData();
        const interval = setInterval(fetchData, 10000);
        const unsub = listen('accounts-updated', fetchData);
        const unsubQuota = listen<CodexQuotaUpdate>('codex-quota-updated', (event) => {
            setData(prev => {
                if (!prev?.account || prev.account.id !== event.payload.account_id) return prev;
                const usage = event.payload.usage;
                return {
                    ...prev,
                    account: {
                        ...prev.account,
                        cached_quota: {
                            five_hour_left: usage.five_hour_left,
                            five_hour_reset_at: usage.five_hour_reset_at ?? null,
                            weekly_left: usage.weekly_left,
                            weekly_reset_at: usage.weekly_reset_at ?? null,
                            plan_type: usage.plan_type,
                        },
                    },
                };
            });
        });

        // 焦点丢失由 Rust 端 on_window_event 处理

        return () => {
            cleanupManualDragRef.current?.();
            clearInterval(interval);
            unsub.then(fn => fn());
            unsubQuota.then(fn => fn());
            document.documentElement.classList.remove('is-tray-popup');
            document.body.classList.remove('is-tray-popup');
        };
    }, [pinned]);

    const startManualDrag = async (event: ReactMouseEvent<HTMLElement>) => {
        cleanupManualDragRef.current?.();

        const win = getCurrentWebviewWindow();
        const origin = await win.outerPosition();
        const scaleFactor = await win.scaleFactor().catch(() => 1);
        const startX = event.screenX;
        const startY = event.screenY;
        let latestX = startX;
        let latestY = startY;
        let frame: number | null = null;

        const moveWindow = () => {
            frame = null;
            const nextX = Math.round(origin.x + (latestX - startX) * scaleFactor);
            const nextY = Math.round(origin.y + (latestY - startY) * scaleFactor);
            win.setPosition(new PhysicalPosition(nextX, nextY)).catch(console.error);
        };

        const handleMove = (moveEvent: globalThis.MouseEvent) => {
            latestX = moveEvent.screenX;
            latestY = moveEvent.screenY;
            if (frame === null) {
                frame = window.requestAnimationFrame(moveWindow);
            }
        };

        const stopDrag = () => {
            window.removeEventListener('mousemove', handleMove);
            window.removeEventListener('mouseup', stopDrag);
            if (frame !== null) {
                window.cancelAnimationFrame(frame);
            }
            cleanupManualDragRef.current = null;
        };

        cleanupManualDragRef.current = stopDrag;
        window.addEventListener('mousemove', handleMove);
        window.addEventListener('mouseup', stopDrag);
    };

    const handleDragStart = async (event: ReactMouseEvent<HTMLElement>) => {
        if (!pinned || event.button !== 0) return;
        const target = event.target as HTMLElement;
        if (target.closest('button, input, label')) return;
        event.preventDefault();

        invoke('start_tray_popup_drag_cmd')
            .catch(() => getCurrentWebviewWindow().startDragging())
            .catch(console.error);
        await startManualDrag(event);
    };

    const handleSwitch = async () => {
        setSwitching(true);
        try {
            await invoke('switch_to_next_account_internal_cmd');
        } catch {
            // fallback: try tray's method
        }
        await fetchData();
        setSwitching(false);
    };

    const handleRefresh = async () => {
        try {
            const currentId = await invoke<string | null>('get_current_account_id');
            if (!currentId) return;
            // Relay 账号走 refresh_relay_usage（GLM 等），订阅号走 OpenAI usage 路径。
            const accounts = await invoke<Array<{ id: string; kind?: string }>>('get_accounts');
            const acc = accounts.find(a => a.id === currentId);
            const isRelay = (acc?.kind ?? '').toLowerCase() === 'relay';
            if (isRelay) {
                await invoke('refresh_relay_usage', { id: currentId });
            } else {
                await invoke('get_quota_by_id', { id: currentId });
            }
            await fetchData();
        } catch (e) {
            console.error('Refresh failed:', e);
        }
    };

    const handleOpenDashboard = async () => {
        await invoke('show_main_window_cmd');
        getCurrentWebviewWindow().hide();
    };

    const q = data?.account?.cached_quota;
    const fiveH = q?.five_hour_left ?? 0;
    const weekly = q?.weekly_left ?? 0;

    return (
        <div className={`tray-popup ${pinned ? 'pinned' : ''}`}>
            {/* Header */}
            <div className="tp-header" data-tauri-drag-region={pinned ? true : undefined} onMouseDown={handleDragStart}>
                <div className="tp-title">
                    <div className="tp-logo">CS</div>
                    <div>
                        <div className="tp-name">Codex Switcher</div>
                        <div className="tp-subtitle">用量监控</div>
                    </div>
                </div>
                <label className="tp-pin-control" title="勾选后面板失焦不隐藏，可拖动标题栏并拉伸窗口">
                    <input
                        type="checkbox"
                        checked={pinned}
                        onChange={e => applyPinned(e.target.checked).catch(console.error)}
                    />
                    <span>常驻</span>
                </label>
                {data?.proxy.is_running && (
                    <div className="tp-badge running">代理已开</div>
                )}
            </div>

            {/* Account */}
            {data?.account && (
                <div className="tp-account">
                    {data.account.name}
                    <span className="tp-plan">{q?.plan_type || '-'}</span>
                    {data.account.is_banned && <span className="tp-banned">封号</span>}
                    {data.account.is_logged_out && !data.account.is_banned && <span className="tp-logged-out">已登出</span>}
                    {data.account.is_token_invalid && !data.account.is_banned && !data.account.is_logged_out && <span className="tp-invalid">失效</span>}
                </div>
            )}

            {/* Anchor 状态条：anchor != current 时显示"手机在 X，代理出口在 current"，帮用户秒懂当前 disk 锁在哪号 */}
            {data?.anchor && !data.anchor.is_current && (
                <div className="tp-anchor">
                    <span className="tp-anchor-icon">📱</span>
                    <span className="tp-anchor-text">
                        手机锚 <b>{data.anchor.name}</b> · 代理出口 <b>{data.account?.name}</b>
                    </span>
                </div>
            )}
            {data?.anchor && data.anchor.is_current && (
                <div className="tp-anchor matched">
                    <span className="tp-anchor-icon">📱</span>
                    <span className="tp-anchor-text">手机锚 = 当前号</span>
                </div>
            )}

            {/* Quota Cards */}
            <div className="tp-cards">
                <div className={`tp-card ${statusClass(fiveH)}`}>
                    <div className="tp-card-header">
                        <span className="tp-card-icon">5h</span>
                        <span>5H 配额</span>
                        <span className={`tp-status ${statusClass(fiveH)}`}>{statusLabel(fiveH)}</span>
                    </div>
                    <div className="tp-card-value">
                        {q ? Math.round(fiveH) : '-'}<span className="tp-unit">%</span>
                        <span className="tp-remaining">剩余</span>
                    </div>
                    <div className="tp-progress">
                        <div className={`tp-progress-bar ${statusClass(fiveH)}`} style={{ width: `${fiveH}%` }} />
                    </div>
                    <div className="tp-reset">
                        重置剩余 {q ? formatCountdown(q.five_hour_reset_at) : '-'}
                    </div>
                </div>

                <div className={`tp-card ${statusClass(weekly)}`}>
                    <div className="tp-card-header">
                        <span className="tp-card-icon">周</span>
                        <span>周配额</span>
                        <span className={`tp-status ${statusClass(weekly)}`}>{statusLabel(weekly)}</span>
                    </div>
                    <div className="tp-card-value">
                        {q ? Math.round(weekly) : '-'}<span className="tp-unit">%</span>
                        <span className="tp-remaining">剩余</span>
                    </div>
                    <div className="tp-progress">
                        <div className={`tp-progress-bar ${statusClass(weekly)}`} style={{ width: `${weekly}%` }} />
                    </div>
                    <div className="tp-reset">
                        重置剩余 {q ? formatCountdown(q.weekly_reset_at) : '-'}
                    </div>
                </div>
            </div>

            {/* Cost & Token Cards */}
            <div className="tp-cards">
                <div className="tp-card cost">
                    <div className="tp-card-header">
                        <span className="tp-card-icon">￥</span>
                        <span>费用统计</span>
                    </div>
                    <div className="tp-card-value cost-value">
                        ${(data?.tokens.total_cost_usd ?? 0).toFixed(2)}
                        <span className="tp-remaining">已用</span>
                    </div>
                    {data?.tokens.last_month_cost !== null && data?.tokens.last_month_cost !== undefined && (
                        <div className="tp-compare">
                            上月 ${data.tokens.last_month_cost.toFixed(2)}
                        </div>
                    )}
                </div>

                <div className="tp-card tokens">
                    <div className="tp-card-header">
                        <span className="tp-card-icon">#</span>
                        <span>Token 用量</span>
                    </div>
                    <div className="tp-card-value token-value">
                        {formatTokens(data?.tokens.total_tokens ?? 0)}
                        <span className="tp-remaining">Token</span>
                    </div>
                    <div className="tp-token-detail">
                        输入 {formatTokens(data?.tokens.total_input_tokens ?? 0)} / 输出 {formatTokens(data?.tokens.total_output_tokens ?? 0)}
                    </div>
                </div>
            </div>

            {/* Actions */}
            <div className="tp-actions">
                <button className="tp-btn primary" onClick={handleOpenDashboard}>
                    打开主页
                </button>
                <button className="tp-btn" onClick={handleRefresh}>
                    刷新
                </button>
                <button
                    className="tp-btn accent"
                    onClick={handleSwitch}
                    disabled={switching}
                >
                    {switching ? '切换中' : '切换'}
                </button>
            </div>
        </div>
    );
}
