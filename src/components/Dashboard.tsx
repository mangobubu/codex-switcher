import { UsageDisplay } from '../hooks/useUsage';
import { Account } from '../hooks/useAccounts';
import { StatsBar } from './StatsBar';
import { UsageCard } from './UsageCard';
import './Dashboard.css';

interface DashboardProps {
    accounts: Account[];
    currentAccount: Account | null;
    usage: UsageDisplay | null;
    usageLoading: boolean;
    usageError: string | null;
    isCurrentInvalid?: boolean;
    onSwitch: (id: string) => void;
    onRefreshUsage: () => void;
    onNavigateToAccounts: () => void;
    onExport: () => void;
    proxyRunning?: boolean;
    syncStatus?: {
        is_synced: boolean;
        disk_email: string | null;
        matching_id: string | null;
    };
    onSyncWithDisk: () => void;
    onImportDiskAccount: (name: string) => void;
    onForceOverwriteDisk: () => void;
}

export function Dashboard({
    accounts,
    currentAccount,
    usage,
    usageLoading,
    usageError,
    isCurrentInvalid,
    onSwitch,
    onRefreshUsage,
    onNavigateToAccounts,
    onExport,
    proxyRunning,
    syncStatus,
    onSyncWithDisk,
    onImportDiskAccount,
    onForceOverwriteDisk,
}: DashboardProps) {
    // 切号现在永远写 disk auth.json（store ↔ disk 强一致），不一致仅出现在
    // 用户在 codex 中手动改了登录状态、或 disk 文件被外部进程改动这种边角场景。
    const isMismatched = !!(syncStatus && !syncStatus.is_synced);
    const isHarmless = isMismatched && proxyRunning;

    // v0.7+ 手机锚生效场景：disk 故意"落后"于 current，但 disk 身份 = anchor，
    // 这是 BY DESIGN 不是冲突。识别条件：有 anchor + anchor != current + disk 身份匹配 anchor。
    const anchorAccount = accounts.find(a => a.is_session_anchor);
    const anchorIsActiveLayer = !!(
        anchorAccount &&
        currentAccount &&
        anchorAccount.id !== currentAccount.id &&
        isMismatched &&
        syncStatus?.matching_id === anchorAccount.id
    );
    const quotaValue = (value: number | undefined) => (
        typeof value === 'number' && Number.isFinite(value) ? value : -1
    );

    const formatQuotaPercent = (value: number | undefined) => (
        typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}%` : '-'
    );

    const quotaTagClass = (value: number | undefined) => {
        if (typeof value !== 'number' || !Number.isFinite(value)) return 'neutral';
        if (value <= 0) return 'danger';
        if (value < 10) return 'warning';
        return 'good';
    };

    const quotaScore = (account: Account) => {
        const quota = account.cached_quota;
        if (!quota) return -1;
        return quotaValue(quota.weekly_left) * 0.65 + quotaValue(quota.five_hour_left) * 0.35;
    };

    // 获取最佳账号推荐：周配额和 5h 配额综合评分，周配额权重更高。
    const getBestAccount = () => {
        const candidates = [...accounts];
        if (candidates.length === 0) return null;

        return candidates.sort((a, b) => {
            const scoreDiff = quotaScore(b) - quotaScore(a);
            if (scoreDiff !== 0) return scoreDiff;

            const weeklyDiff = quotaValue(b.cached_quota?.weekly_left) - quotaValue(a.cached_quota?.weekly_left);
            if (weeklyDiff !== 0) return weeklyDiff;

            return quotaValue(b.cached_quota?.five_hour_left) - quotaValue(a.cached_quota?.five_hour_left);
        })[0] || null;
    };

    const bestAccount = getBestAccount();
    const isBestCurrent = !!(bestAccount && currentAccount && bestAccount.id === currentAccount.id);

    return (
        <div className="dashboard">
            {/* 问候语 */}
            <div className="dashboard-greeting">
                <h2>
                    你好, {currentAccount?.name.split('@')[0] || '用户'} 👋
                </h2>
            </div>

            {/* 统计卡片 */}
            <StatsBar accountCount={accounts.length} usage={usage} />

            {/* 手机锚生效：disk 锁定在 anchor，不显示警告而是 info 提示 */}
            {anchorIsActiveLayer && anchorAccount && (
                <div className="sync-info-banner anchor-active">
                    <div className="banner-content">
                        <span className="banner-icon">📱</span>
                        <div className="banner-text">
                            <strong>手机锚生效：</strong>
                            Codex.app 仍以 <span>{anchorAccount.name}</span> 身份在线（手机 bridge 不掉线），
                            代理出口已切到 <b>{currentAccount?.name}</b>。
                        </div>
                    </div>
                </div>
            )}

            {/* 旧的"磁盘落后/不一致"提示：anchor 生效时彻底隐藏（避免误导） */}
            {syncStatus && !syncStatus.is_synced && !anchorIsActiveLayer && (
                <div className={isHarmless ? 'sync-info-banner' : 'sync-warning-banner'}>
                    <div className="banner-content">
                        <span className="banner-icon">{isHarmless ? 'ℹ️' : '⚠️'}</span>
                        <div className="banner-text">
                            {isHarmless ? (
                                <>
                                    <strong>磁盘 auth.json 落后：</strong>
                                    停在 <span>{syncStatus.disk_email || '未知账号'}</span>
                                    （代理正在注入当前激活号的 token，<b>不影响 codex 工作</b>；
                                    关闭代理后 codex 会读到这个号）
                                </>
                            ) : (
                                <>
                                    <strong>登录状态不一致：</strong>
                                    检测到 IDE 正在使用 <span>{syncStatus.disk_email || '未知账号'}</span>
                                </>
                            )}
                        </div>
                    </div>
                    <div className="banner-actions">
                        {syncStatus.matching_id ? (
                            <button className="btn btn-sm btn-accent" onClick={onSyncWithDisk}>
                                {isHarmless ? '同步磁盘' : '修正激活状态'}
                            </button>
                        ) : (
                            <button className="btn btn-sm btn-primary" onClick={() => onImportDiskAccount(syncStatus.disk_email || '新账号')}>
                                立即导入该账号
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* 双栏布局 */}
            <div className="dashboard-grid">
                {/* 当前账号 */}
                <div className={`dashboard-card current-account ${isCurrentInvalid ? 'invalid' : ''}`}>
                    <div className="card-header">
                        <span className="card-icon">✓</span>
                        <h3>当前账号</h3>
                        {isCurrentInvalid && <span className="invalid-badge" title="授权已失效，请删除后重新登录">⚠️ 失效</span>}
                    </div>
                    {currentAccount ? (
                        <div className="current-account-content">
                            <div className="account-info">
                                <span className="email-icon">✉</span>
                                <span className="email">{currentAccount.name}</span>
                                {usage?.plan_type && (
                                    <span className="plan-badge">{usage.plan_type.toUpperCase()}</span>
                                )}
                            </div>

                            {isMismatched && !anchorIsActiveLayer ? (
                                <div className="mismatch-panel">
                                    <div className="mismatch-headline">
                                        与 ~/.codex/auth.json 身份不匹配
                                    </div>
                                    <div className="mismatch-detail">
                                        IDE 当前用：<span className="mono">{syncStatus?.disk_email || '未知'}</span>
                                    </div>
                                    <div className="mismatch-actions">
                                        <button
                                            className="btn btn-primary btn-sm"
                                            onClick={onForceOverwriteDisk}
                                        >
                                            用此账号覆盖 IDE
                                        </button>
                                        {syncStatus?.matching_id ? (
                                            <button className="btn btn-ghost btn-sm" onClick={onSyncWithDisk}>
                                                改用 IDE 当前
                                            </button>
                                        ) : (
                                            <button
                                                className="btn btn-ghost btn-sm"
                                                onClick={() => onImportDiskAccount(syncStatus?.disk_email || '新账号')}
                                            >
                                                导入 IDE 当前
                                            </button>
                                        )}
                                    </div>
                                </div>
                            ) : (
                                <UsageCard
                                    usage={usage}
                                    loading={usageLoading}
                                    error={usageError}
                                    onRefresh={onRefreshUsage}
                                />
                            )}

                            <button
                                className="btn btn-outline btn-full"
                                onClick={onNavigateToAccounts}
                            >
                                切换账号
                            </button>
                        </div>
                    ) : (
                        <div className="no-account">
                            <p>暂无账号</p>
                        </div>
                    )}
                </div>

                {/* 最佳账号推荐 */}
                <div className="dashboard-card best-accounts">
                    <div className="card-header">
                        <span className="card-icon">↗</span>
                        <h3>最佳账号推荐</h3>
                    </div>
                    <div className="best-accounts-list">
                        {bestAccount ? (
                            <div className="best-account-item">
                                <div className="account-label">
                                    <span className="label-text">推荐账号</span>
                                    <span className="account-email">{bestAccount.name}</span>
                                </div>
                                <div className="quota-tags">
                                    <span className={`quota-tag ${quotaTagClass(bestAccount.cached_quota?.five_hour_left)}`}>
                                        5h {formatQuotaPercent(bestAccount.cached_quota?.five_hour_left)}
                                    </span>
                                    <span className={`quota-tag ${quotaTagClass(bestAccount.cached_quota?.weekly_left)}`}>
                                        周 {formatQuotaPercent(bestAccount.cached_quota?.weekly_left)}
                                    </span>
                                </div>
                            </div>
                        ) : (
                            <p className="no-recommendation">暂无推荐</p>
                        )}
                    </div>
                    {bestAccount && (
                        <button
                            className="btn btn-accent btn-full"
                            disabled={isBestCurrent}
                            onClick={() => !isBestCurrent && onSwitch(bestAccount.id)}
                        >
                            {isBestCurrent ? '当前已是最佳' : '一键切换最佳'}
                        </button>
                    )}
                </div>
            </div>

            {/* 快速链接 */}
            <div className="dashboard-links">
                <button className="link-card" onClick={onNavigateToAccounts}>
                    <span>查看所有账号</span>
                    <span className="link-arrow">→</span>
                </button>
                <button className="link-card" onClick={onExport}>
                    <span>导出账号数据</span>
                    <span className="link-icon">↓</span>
                </button>
            </div>
        </div>
    );
}
