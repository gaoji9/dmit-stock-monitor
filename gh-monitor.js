/*
 * DMIT 补货监测 - GitHub Actions 版（数据源: vpsmap 主 + vpsme 备）
 *
 * 直接访问 DMIT 官网会被 Cloudflare 拦截（GitHub 机房 IP 无法通过人机验证），
 * 因此改用第三方库存追踪站（它们持续轮询 DMIT 官方购物车，约 10-15 分钟刷新一次）：
 *   1) vpsmap.net   - 结构化字段 data-stock-status，带检查时间戳
 *   2) vpsme.de     - 简单徽章 有货/缺货
 * 有货时立刻发送邮件（QQ）+ 微信推送（PushPlus）。
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const https = require('https');

const ROOT = process.env.GITHUB_WORKSPACE || __dirname;
const STATE_PATH = path.join(ROOT, 'state.json');
const CART_URL = 'https://www.dmit.io/cart.php?a=add&pid=253';

const QQ_AUTH_CODE = (process.env.QQ_AUTH_CODE || '').trim();
const SERVERCHAN_KEY = (process.env.SERVERCHAN_KEY || '').trim();
const QQ_FROM = process.env.QQ_FROM || '2415564765@qq.com';
const QQ_TO = process.env.QQ_TO || '2415564765@qq.com';
const REMIND_MINUTES = Number(process.env.REMIND_MINUTES) || 15;

const VPSMAP_URL = 'https://vpsmap.net/en/providers/dmit/locations/lax-pro/';
const VPSME_URL = 'https://www.vpsme.de/g/155';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function log(msg) {
  console.log('[' + new Date().toISOString() + '] ' + msg);
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (e) { return { lastStatus: null, lastAlertAt: 0 }; }
}
function saveState(s) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2) + '\n');
}

async function httpGet(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml' },
    signal: AbortSignal.timeout(timeoutMs || 30000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// ---------- 数据源1: vpsmap ----------
// 返回 { status: 'IN_STOCK'|'OUT_OF_STOCK'|null, detail: string, successAt: string|null }
function parseVpsmap(html) {
  const anchor = 'lax-as3-pro-tiny-253';
  const idx = html.indexOf(anchor);
  if (idx === -1) return { status: null, detail: 'vpsmap: 未找到 TINY 行', successAt: null };
  const rowEnd = html.indexOf('</tr>', idx);
  const slice = html.slice(idx, rowEnd === -1 ? undefined : rowEnd);
  const statusM = slice.match(/data-stock-status="([^"]+)"/);
  const successM = slice.match(/data-success="([^"]+)"/);
  const textM = slice.match(/<span class="badge[^"]*"[^>]*>([^<]+)<\/span>/);
  const raw = statusM ? statusM[1] : null;
  if (raw === 'in_stock') {
    return { status: 'IN_STOCK', detail: 'vpsmap: in_stock (' + (textM ? textM[1].trim() : '') + ')', successAt: successM ? successM[1] : null };
  }
  if (raw === 'out_of_stock') {
    return { status: 'OUT_OF_STOCK', detail: 'vpsmap: out_of_stock (' + (textM ? textM[1].trim() : '') + ')', successAt: successM ? successM[1] : null };
  }
  return { status: null, detail: 'vpsmap: 状态未知 (' + (raw || 'no-field') + ')', successAt: successM ? successM[1] : null };
}

// ---------- 数据源2: vpsme ----------
function parseVpsme(html) {
  const idx = html.indexOf('LAX.AS3.Pro.TINY');
  if (idx === -1) return { status: null, detail: 'vpsme: 未找到 TINY 卡片' };
  const slice = html.slice(idx, idx + 2500);
  const badge = slice.match(/badge badge-(in|out)"[^>]*>([^<]+)</);
  if (!badge) return { status: null, detail: 'vpsme: 未找到徽章' };
  const kind = badge[1];
  const text = badge[2].trim();
  if (kind === 'in') return { status: 'IN_STOCK', detail: 'vpsme: ' + text };
  if (kind === 'out') return { status: 'OUT_OF_STOCK', detail: 'vpsme: ' + text };
  return { status: null, detail: 'vpsme: 未知 (' + text + ')' };
}

// ---------- 邮件 ----------
function sendMail(subject, html) {
  return new Promise((resolve) => {
    if (!QQ_AUTH_CODE) { log('[mail] 未配置授权码，跳过'); return resolve(false); }
    const t = nodemailer.createTransport({
      host: 'smtp.qq.com', port: 465, secure: true,
      auth: { user: QQ_FROM, pass: QQ_AUTH_CODE },
      connectionTimeout: 30000, greetingTimeout: 30000, socketTimeout: 45000,
    });
    t.sendMail({ from: '"DMIT补货监测" <' + QQ_FROM + '>', to: QQ_TO, subject, html }, (err) => {
      if (err) { log('[mail] 发送失败: ' + err.message); resolve(false); }
      else { log('[mail] 发送成功: ' + subject); resolve(true); }
    });
  });
}

// ---------- 微信推送 (Server酱) ----------
function serverChanSend(title, content) {
  return new Promise((resolve) => {
    try {
      if (!/^[A-Za-z0-9]{10,}$/.test(SERVERCHAN_KEY)) {
        log('[微信推送] SERVERCHAN_KEY 无效或未配置，跳过');
        return resolve(false);
      }
      const host = SERVERCHAN_KEY.indexOf('SCT') === 0 ? 'sctapi.ftqq.com' : 'sc.ftqq.com';
      const body = 'title=' + encodeURIComponent(title) + '&desp=' + encodeURIComponent(content);
      const req = https.request({
        hostname: host, path: '/' + SERVERCHAN_KEY + '.send', method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
        timeout: 30000,
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            if (j.code === 0) { log('[微信推送] Server酱推送成功'); resolve(true); }
            else { log('[微信推送] Server酱推送失败: ' + (j.message || data)); resolve(false); }
          } catch (e) { log('[微信推送] 响应解析失败: ' + data.slice(0, 200)); resolve(false); }
        });
      });
      req.on('error', (e) => { log('[微信推送] Server酱推送失败: ' + e.message); resolve(false); });
      req.end(body);
    } catch (e) {
      log('[微信推送] 异常（已忽略，不影响监测）: ' + e.message);
      resolve(false);
    }
  });
}

function alertHtml(sourceDetail, checkedAt) {
  return [
    '<div style="font-family:微软雅黑,Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;border:2px solid #e74c3c;border-radius:10px;">',
    '<h2 style="color:#e74c3c;margin-top:0;">🎉 DMIT LAX.AS3.Pro.TINY 可能补货了！</h2>',
    '<p style="font-size:15px;">云端监测发现该套餐状态变为 <b>有货</b>：</p>',
    '<ul style="font-size:14px;">',
    '<li>产品：LAX.AS3.Pro.TINY</li>',
    '<li>机房：Los Angeles / Premium / AS3</li>',
    '<li>配置：1 核 / 2GB / 20GB SSD / 1TB流量 / 1Gbps</li>',
    '<li>价格：$10.90/月</li>',
    '<li>数据来源：' + (sourceDetail || '-') + '</li>',
    '<li>数据时间：' + (checkedAt || '-') + '</li>',
    '</ul>',
    '<p style="font-size:15px;"><b>立刻点下面按钮去 DMIT 官网下单核实（以官网为准，手慢无！）：</b></p>',
    '<p><a href="' + CART_URL + '" style="display:inline-block;background:#e74c3c;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:16px;">立即购买</a></p>',
    '<p style="font-size:12px;color:#999;">说明：云端监测通过第三方库存站获取数据（约10-15分钟延迟），最终以 DMIT 官网购物车为准。</p>',
    '</div>',
  ].join('');
}

const SOLD_OUT_HTML = [
  '<div style="font-family:微软雅黑,Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;border:1px solid #ccc;border-radius:10px;">',
  '<h2 style="margin-top:0;color:#555;">😢 又卖完了</h2>',
  '<p style="font-size:15px;">LAX.AS3.Pro.TINY 状态恢复为缺货。云端监测继续运行中，下次有货会再次提醒。</p>',
  '</div>',
].join('');

// ---------- 主流程 ----------
(async () => {
  // 测试提醒模式: node gh-monitor.js --testmail
  if (process.argv[2] === '--testmail') {
    const ok = await sendMail(
      '【测试邮件】DMIT 云端监测已上线',
      '<div style="font-family:微软雅黑;padding:20px;"><h3>✅ 云端监测测试邮件</h3>' +
      '<p>GitHub Actions 云端监测已正常运行，有货时会第一时间发邮件提醒你。</p></div>'
    );
    const ok2 = await serverChanSend(
      '【测试推送】DMIT 云端监测已上线',
      '<div style="font-family:微软雅黑;padding:20px;"><h3>✅ 云端监测测试推送</h3><p>有货时你会像现在这样收到微信提醒。</p></div>'
    );
    log((ok ? '测试邮件发送成功 ' : '测试邮件发送失败 ') + (ok2 ? '| 测试推送成功' : '| 推送未配置或失败'));
    process.exit(ok ? 0 : 2);
  }

  const state = loadState();

  // 1) vpsmap
  let mapRes = null;
  try {
    const html = await httpGet(VPSMAP_URL, 40000);
    mapRes = parseVpsmap(html);
    log('vpsmap: ' + mapRes.detail + (mapRes.successAt ? ' (successAt=' + mapRes.successAt + ')' : ''));
  } catch (e) {
    mapRes = { status: null, detail: 'vpsmap: 抓取失败 ' + e.message };
    log(mapRes.detail);
  }

  // 2) vpsme（无论 vpsmap 结果如何都抓，用于交叉印证）
  let meRes = null;
  try {
    const html = await httpGet(VPSME_URL, 40000);
    meRes = parseVpsme(html);
    log('vpsme: ' + meRes.detail);
  } catch (e) {
    meRes = { status: null, detail: 'vpsme: 抓取失败 ' + e.message };
    log(meRes.detail);
  }

  // 3) 判定：vpsmap 优先；vpsmap 失败时用 vpsme
  let result;
  if (mapRes.status) {
    result = mapRes;
  } else if (meRes.status) {
    result = meRes;
    result.detail = '（vpsmap不可用，用vpsme）' + meRes.detail;
  } else {
    result = { status: 'UNKNOWN', detail: mapRes.detail + ' | ' + meRes.detail };
  }
  // 交叉印证提示
  if (mapRes.status === 'IN_STOCK' && meRes.status === 'OUT_OF_STOCK') {
    result.detail += ' 【注意: vpsmap有货但vpsme仍显示缺货，可能刚补货，请以官网为准】';
  }
  log('判定: ' + result.status + ' - ' + result.detail);

  state.lastCheckAt = Date.now();
  state.lastCheckStatus = result.status;
  state.lastCheckDetail = result.detail;

  if (result.status === 'IN_STOCK') {
    const now = Date.now();
    const checkedAt = mapRes && mapRes.successAt ? mapRes.successAt.replace('T', ' ').replace('.000Z', ' UTC') : new Date().toISOString();
    if (state.lastStatus !== 'IN_STOCK') {
      log('！！！！！！检测到有货 ！！！！！！');
      await sendMail('【有货！】DMIT LAX.AS3.Pro.TINY 疑似上架，速购！', alertHtml(result.detail, checkedAt));
      await serverChanSend('【有货！】DMIT LAX.AS3.Pro.TINY 疑似上架，速购！', alertHtml(result.detail, checkedAt));
      state.lastAlertAt = now;
    } else if (now - (state.lastAlertAt || 0) >= REMIND_MINUTES * 60000) {
      log('仍处于有货状态，再次提醒');
      await sendMail('【再次提醒】DMIT LAX.AS3.Pro.TINY 仍可购买', alertHtml(result.detail, checkedAt));
      await serverChanSend('【再次提醒】DMIT LAX.AS3.Pro.TINY 仍可购买', alertHtml(result.detail, checkedAt));
      state.lastAlertAt = now;
    }
  } else if (result.status === 'OUT_OF_STOCK' && state.lastStatus === 'IN_STOCK') {
    await sendMail('【已售罄】DMIT LAX.AS3.Pro.TINY 恢复缺货', SOLD_OUT_HTML);
    await serverChanSend('【已售罄】DMIT LAX.AS3.Pro.TINY 恢复缺货', SOLD_OUT_HTML);
  }

  if (result.status === 'IN_STOCK' || result.status === 'OUT_OF_STOCK') {
    state.lastStatus = result.status;
  }
  saveState(state);

  process.exit(result.status === 'UNKNOWN' ? 2 : 0);
})().catch((e) => {
  log('异常: ' + (e && e.stack || e));
  process.exit(2);
});
