import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { emit } from '@tauri-apps/api/event';
import './ConfirmModal.css';

interface PendingRelayImport {
  source: string;
  name: string;
  base_url: string;
  api_key: string;
  homepage: string | null;
  usage_preset: string | null;
  usage_script_unknown: boolean;
}

function maskKey(key: string): string {
  if (key.length <= 12) return key.slice(0, 4) + '…';
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

export function RelayImportConfirm() {
  const [pending, setPending] = useState<PendingRelayImport | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = listen<PendingRelayImport>('deep-link://import-pending', (event) => {
      setPending(event.payload);
      setError(null);
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  if (!pending) return null;

  const close = () => {
    setPending(null);
    setError(null);
    setSubmitting(false);
  };

  const onConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await invoke('add_relay_account', {
        name: pending.name,
        baseUrl: pending.base_url,
        apiKey: pending.api_key,
        homepage: pending.homepage ?? null,
        usagePreset: pending.usage_preset ?? null,
        notes: `via ${pending.source} deep link`,
      });
      // 通知 App 刷新账号列表
      await emit('accounts-updated');
      close();
    } catch (e) {
      setError(typeof e === 'string' ? e : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={submitting ? undefined : close}>
      <div className="modal-content confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-header">
          <div className="confirm-icon">🔗</div>
          <h3 className="confirm-title">导入中转站账号</h3>
        </div>

        <div className="confirm-body">
          <p style={{ marginTop: 0, color: '#6b7280', fontSize: 13 }}>
            来源: <code>{pending.source}://</code> deep link
          </p>

          <table style={{ width: '100%', fontSize: 13, marginTop: 8 }}>
            <tbody>
              <tr>
                <td style={{ color: '#6b7280', padding: '4px 8px 4px 0', verticalAlign: 'top' }}>名称</td>
                <td style={{ padding: '4px 0', wordBreak: 'break-all' }}>{pending.name}</td>
              </tr>
              <tr>
                <td style={{ color: '#6b7280', padding: '4px 8px 4px 0', verticalAlign: 'top' }}>Base URL</td>
                <td style={{ padding: '4px 0', wordBreak: 'break-all', fontFamily: 'ui-monospace, Menlo, monospace' }}>
                  {pending.base_url}
                </td>
              </tr>
              <tr>
                <td style={{ color: '#6b7280', padding: '4px 8px 4px 0', verticalAlign: 'top' }}>API Key</td>
                <td style={{ padding: '4px 0', fontFamily: 'ui-monospace, Menlo, monospace' }}>
                  {maskKey(pending.api_key)}
                </td>
              </tr>
              {pending.homepage && (
                <tr>
                  <td style={{ color: '#6b7280', padding: '4px 8px 4px 0', verticalAlign: 'top' }}>主页</td>
                  <td style={{ padding: '4px 0', wordBreak: 'break-all' }}>{pending.homepage}</td>
                </tr>
              )}
              <tr>
                <td style={{ color: '#6b7280', padding: '4px 8px 4px 0', verticalAlign: 'top' }}>Usage</td>
                <td style={{ padding: '4px 0' }}>
                  {pending.usage_preset
                    ? <code>{pending.usage_preset}</code>
                    : <span style={{ color: '#9ca3af' }}>不拉取</span>}
                </td>
              </tr>
            </tbody>
          </table>

          {pending.usage_script_unknown && (
            <p style={{ marginTop: 12, padding: '8px 10px', background: '#fef3c7', color: '#92400e', borderRadius: 4, fontSize: 12 }}>
              ⚠️ 链接里携带的 <code>usageScript</code> 未在内置白名单中，已忽略。账号仍可正常使用，
              但额度查询不会自动进行。导入后可在账号详情中手动选 usage preset。
            </p>
          )}

          {error && (
            <p style={{ marginTop: 12, padding: '8px 10px', background: '#fee2e2', color: '#991b1b', borderRadius: 4, fontSize: 12 }}>
              导入失败: {error}
            </p>
          )}
        </div>

        <div className="confirm-footer">
          <button className="btn-cancel" onClick={close} disabled={submitting}>
            取消
          </button>
          <button className="btn-confirm" onClick={onConfirm} disabled={submitting}>
            {submitting ? '导入中…' : '导入'}
          </button>
        </div>
      </div>
    </div>
  );
}
