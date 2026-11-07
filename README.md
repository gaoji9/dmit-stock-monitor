# DMIT 补货监测（GitHub Actions 版）

监测 DMIT **LAX.AS3.Pro.TINY**（洛杉矶 / Premium / AS3）的库存，每 5 分钟自动检查一次。
一旦有货，立刻发送 **邮件（QQ 邮箱）+ 微信推送（PushPlus）** 提醒。

## 数据源

DMIT 官网有 Cloudflare 防护，会拦截服务器机房 IP，因此云端版通过两个第三方库存追踪站获取数据
（它们持续轮询 DMIT 官方购物车，约 10-15 分钟刷新一次）：

- 主数据源：vpsmap.net（结构化库存字段 + 检查时间戳）
- 备数据源：vpsme.de（有货/缺货徽章）
- 两个来源相互印证；提醒邮件中会注明数据来源和时间，最终请以 DMIT 官网购物车为准

## 运行方式

- `.github/workflows/monitor.yml`：每 5 分钟定时执行（GitHub Actions，免费额度内）
- 敏感信息（邮箱授权码、推送 token）存于 **GitHub Secrets**
- 状态记录在 `state.json`，可通过状态页查看：https://gaoji9.github.io/dmit-stock-monitor/status/

## 目录结构

| 文件 | 说明 |
| --- | --- |
| `gh-monitor.js` | 抓取 + 判定 + 提醒主逻辑 |
| `.github/workflows/monitor.yml` | 定时任务（每 5 分钟） |
| `state.json` | 最近检查状态（自动更新） |
| `status/index.html` | 手机可查看的状态页 |
