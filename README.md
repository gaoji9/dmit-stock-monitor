# DMIT 补货监测（GitHub Actions 版）

监测 DMIT 官网 **LAX.AS3.Pro.TINY**（洛杉矶 / Premium / AS3）的库存，
每 5 分钟自动检查一次。一旦有货，立刻发送 **邮件（QQ 邮箱）+ 微信推送（PushPlus）** 提醒。

- 判断依据：DMIT 购物车页面（`cart.php?a=add&pid=253`）——
  显示 "Out of Stock" = 缺货；跳转到配置页 = 有货。
- 所有敏感信息（邮箱授权码、推送 token）均存放在 **GitHub Secrets**，不会出现在代码里。
- 检查状态会写入 `state.json`，可通过状态页查看：https://gaoji9.github.io/dmit-stock-monitor/status/

## 目录结构

| 文件 | 说明 |
| --- | --- |
| `gh-monitor.js` | 检查 + 提醒主逻辑 |
| `.github/workflows/monitor.yml` | 定时任务（每 5 分钟） |
| `state.json` | 最近检查状态（自动更新） |
| `status/index.html` | 手机可查看的状态页 |
