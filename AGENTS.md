## 非常重要，必须遵守的铁律

1. 全程使用简体中文（包括思考过程）回答我

2. 每次实施修改前，都要先列出一个计划，供我确认后才能修改（如果是非常琐碎的单行修复、对已有计划的微小后续补充，或者是简单的查错，不需要生成计划即可直接执行以加快沟通效率）

3. 不要自行启动服务，我会自己手动启动

4. git 提交消息必须使用中文，要详细，且必须遵守以下示例格式（每个功能说明都需要换行处理）：

   ```
    feat: 新增开启云同步服务时的隐私授权说明书弹窗

    - 在 Settings.vue 模板底部挂载高颜值的隐私授权说明书模态框，设计极具商业合规感的可滚动排版及交互按钮

    - 完善包含四大核心条款（高强度加密传输、隐私不透露承诺、纯粹流转用途、一键彻底销毁权）的安全隐私保障协议文本

    - 重构 handleCloudModeChange 方法，在用户开启云同步开关时实行强制拦截，首先拉起隐私说明书弹窗供阅读实现精细的回调控制逻辑：

      用户点击“同意并开启”（handlePrivacyAgree）：关闭弹窗，正常导入并执行云登录/备份数据上传

      用户点击“拒绝并保持本地”（handlePrivacyReject）：关闭弹窗，温和提示并将云服务开关状态安全回滚为关闭（false）

    - 本地静态类型自检 vue-tsc --noEmit 成功通过，0 警告，0 报错
   ```
   
# Project agents — codex-switcher

Tauri 2 desktop app that proxies codex CLI / Claude Code traffic across
multiple ChatGPT / Relay accounts. Routing rules from
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` apply here too.

## Local conventions

- Rust + React. `npx tauri dev` for live reload, `npx tauri build
  --bundles app` for production .app.
- Source: `src-tauri/src/` (Rust) + `src/` (React/TS). Frontend: Vite,
  no UI lib (pure CSS).
- Don't introduce dependencies you can do without.

## Architecture

- `src-tauri/src/proxy.rs` — main HTTP+WS proxy. Get familiar with
  `handle_request` / `handle_websocket` / `get_upstream` (3-branch:
  ChatGPT / OpenAI key / Relay) before touching it.
- `src-tauri/src/account.rs` — `AccountKind` (Legacy / ChatgptOauth /
  OpenaiKey / Relay) + `AppSettings`.
- `src-tauri/src/output_compress.rs` — Phase-1 shell-output compressor
  hooked into both Codex WS and Claude SSE paths in proxy.rs.
- `src-tauri/src/usage.rs` — quota fetchers per account kind.

## When editing

- After ANY proxy.rs change, restart the running Codex Switcher.app to
  reload (the proxy is in-process).
- Settings UI lives in `src/components/Settings.tsx`. Mirror the existing
  toggle pattern — don't invent new layouts.
- Two macs run this: local + mini mac (192.168.2.6 LAN / mini-mac-zt
  ZeroTier). Big changes go through `tar -czf + scp` after replacing
  /Applications/Codex Switcher.app locally.

## When NOT to use glance

This project deals with proxying chat completion APIs — don't ask glance
to "research" the OpenAI / Claude wire format. Read the official docs
yourself or look at `proxy.rs` directly.
