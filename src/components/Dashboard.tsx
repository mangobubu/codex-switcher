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
    // 获取最佳账号推荐（配额最高的账号）
    const getBestAccount = () => {
        if (accounts.length === 0) return null;
        // 简单返回第一个非当前账号
        return accounts.find(a => a.id !== currentAccount?.id) || null;
    };

    const bestAccount = getBestAccount();

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

            {/* 同步状态：proxy 在跑 → 仅信息提示；proxy 关 → 警告 */}
            {syncStatus && !syncStatus.is_synced && (
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

                            {isMismatched ? (
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
                                <span className="quota-badge">100%</span>
                            </div>
                        ) : (
                            <p className="no-recommendation">暂无推荐</p>
                        )}
                    </div>
                    {accounts.length > 1 && (
                        <button
                            className="btn btn-accent btn-full"
                            onClick={() => bestAccount && onSwitch(bestAccount.id)}
                        >
                            一键切换最佳
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
