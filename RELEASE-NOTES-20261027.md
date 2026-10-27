# CODIO — Your Private Radio · 0.1.7 Preview · 2026-10-27

## 中文

更新 Windows x64 便携包，首次按 MIT 公开当前源码与自动测试；GitHub 介绍改为中英双语。下载入口替代 2026-10-20 包，旧版保留用于回退。

- 启动准备检查纳入已排队及执行中的推荐更新，防止旧批次完整时过早允许进入；授权失效进入可重试状态。
- 失焦/后台减少非必要 Canvas、CSS 动画和界面时钟刷新；不停止音频、下一首准备和关键衔接调度。
- AI DJ 精简发送的画像与状态，保留最新明确偏好和真实推荐阶段；补齐英文/中英混合偏好权限校验，避免明确表达被错误拒绝。
- DeepSeek 错误区分认证、余额、限流、网络、超时和请求边界。响应正文也受超时约束；截断工具回复不会执行。保存操作后模型断线仍不重复执行。
- 偏好保存、重排排队和隐藏队列提交分别报告；不擅自播放，也不因反馈突然替换当前可见的 24 首。

下载 `CODIO-0.1.7-Windows-x64-20261027.zip`，正常退出旧程序，完整解压并运行 `CODIO.exe`，保留用户数据。`SHA256SUMS.txt` 用于校验。Source code 附件是开发源码，不是桌面程序。

不附带账号、Key、听歌数据或音乐文件。程序当前未签名，不建议关闭系统安全防护。第三方依赖许可与音乐服务权限独立保留。

## English

Updated Windows x64 portable build, first MIT-licensed source/test snapshot, and bilingual project introduction. The new download replaces the 2026-10-20 link; the previous release remains available for rollback.

- Startup readiness includes queued and active recommendation updates; expired authorization is retryable rather than bypassed.
- Unfocused/background windows stop unnecessary Canvas/CSS animation and visual-clock updates while audio and essential transition scheduling continue.
- AI DJ sends a compact, current state rather than full profile exports. English/mixed-language explicit preferences pass the same verified local scope checks.
- DeepSeek failures distinguish authentication, balance, rate limits, network, timeout and request boundaries. The deadline covers response-body reading; truncated tool responses cannot execute. A failed final model reply never repeats successful tools.
- Preference persistence, queued reranking and confirmed hidden-queue commits are separate facts. Preference statements do not start playback or unexpectedly replace the visible 24 songs.

Quit the old app, fully extract `CODIO-0.1.7-Windows-x64-20261027.zip`, run `CODIO.exe`, and keep existing user data. Verify against `SHA256SUMS.txt`. Automatic Source code downloads are developer sources, not the Windows app.

No accounts, API keys, personal listening data or music files are included. The Windows binary is unsigned; do not disable system security. Third-party licenses and service/content permissions remain separate.

## Validation boundary / 验证边界

自动检查 / Automated checks: **716 tests passed, 0 failed**. Application and clean public-source builds passed. Source lint: 0 errors, 6 pre-existing warnings. Full `tsc --noEmit` retains 3 pre-existing Cloudflare environment-type errors (`cloudflare:workers`, `Fetcher`, `D1Database`); it is not reported as a clean type check. Desktop syntax and diff checks passed.

源码/发行文件检查、自动测试和构建与真实试听分开记录。本次发布不启动用户的真实账户做 UI 或播放验收。Live service probing does not prove native UI/playback acceptance or guarantee future provider availability.
