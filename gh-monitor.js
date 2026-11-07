/*
 * DMIT 补货监测 - GitHub Actions 版
 * 每 5 分钟运行一次（由 .github/workflows/monitor.yml 调度）
 * 判断标准同电脑版：购物车页面显示 Out of Stock = 缺货；跳转 confproduct = 有货
 */
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const nodemailer = require('nodemailer');
const https = require('https');

const ROOT = process.env.GITHUB_WORKSPACE || __dirname;
const STATE_PATH = path.join(ROOT, 'state.json');
const CART_URL = 'https://www.dmit.io/cart.php?a=add&pid=253';

const QQ_AUTH_CODE = (process.env.QQ_AUTH_CODE || '').trim();
const PUSHPLUS_TOKEN = (process.env.PUSHPLUS_TOKEN || '').trim();
const QQ_FROM = process.env.QQ_FROM || '2415564765@qq.com';
const QQ_TO = process.env.QQ_TO || '2415564765@qq.com';
const REMIND_MINUTES = Number(process.env.REMIND_MINUTES) || 15;

const CHROME_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/opt/google/chrome/chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

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

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
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

// ---------- 微信推送 ----------
function pushPlusSend(title, content) {
  return new Promise((resolve) => {
    if (!PUSHPLUS_TOKEN) { log('[push] 未配置 token，跳过'); return resolve(false); }
    const data = JSON.stringify({ token: PUSHPLUS_TOKEN, title, content, template: 'html' });
    const req = https.request({
      hostname: 'www.pushplus.plus', path: '/send', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 30000,
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j.code === 200) { log('[push] 推送成功'); resolve(true); }
          else { log('[push] 推送失败: ' + (j.msg || body)); resolve(false); }
        } catch (e) { log('[push] 响应解析失败: ' + body.slice(0, 200)); resolve(false); }
      });
    });
    req.on('error', (e) => { log('[push] 推送失败: ' + e.message); resolve(false); });
    req.end(data);
  });
}

const ALERT_HTML = [
  '<div style="font-family:微软雅黑,Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;border:2px solid #e74c3c;border-radius:10px;">',
  '<h2 style="color:#e74c3c;margin-top:0;">🎉 DMIT LAX.AS3.Pro.TINY 有货了！</h2>',
  '<p style="font-size:15px;">你关注的 VPS 刚刚检测到 <b>可以下单</b>：</p>',
  '<ul style="font-size:14px;">',
  '<li>产品：LAX.AS3.Pro.TINY</li>',
  '<li>机房：Los Angeles / Premium / AS3</li>',
  '<li>配置：1 核 / 2GB / 20GB SSD / 1TB流量 / 1Gbps</li>',
  '<li>价格：$10.90/月</li>',
  '</ul>',
  '<p style="font-size:15px;"><b>请立刻点击下面的按钮去下单（手慢无！）：</b></p>',
  '<p><a href="' + CART_URL + '" style="display:inline-block;background:#e74c3c;color:#fff;padding:12px 24px;border-radius:6px;text-decoration:none;font-size:16px;">立即购买</a></p>',
  '<p style="font-size:13px;color:#888;">此邮件由 GitHub Actions 云端监测自动发送。</p>',
  '</div>',
].join('');

const SOLD_OUT_HTML = [
  '<div style="font-family:微软雅黑,Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px;border:1px solid #ccc;border-radius:10px;">',
  '<h2 style="margin-top:0;color:#555;">😢 又卖完了</h2>',
  '<p style="font-size:15px;">LAX.AS3.Pro.TINY 刚刚恢复为缺货状态。云端监测继续运行中，下次有货会再次提醒。</p>',
  '</div>',
].join('');

// ---------- 库存检查 ----------
async function checkStock(browser) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1280, height: 800 });
    let gotoErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.goto(CART_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        gotoErr = null;
        break;
      } catch (e) { gotoErr = e; }
    }
    if (gotoErr) return { status: 'ERROR', detail: '页面访问失败: ' + gotoErr.message };

    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      let info;
      try {
        info = await page.evaluate(() => ({
          url: location.href,
          title: document.title,
          text: (document.body ? document.body.innerText : '').slice(0, 5000),
        }));
      } catch (e) { info = { url: '', title: '', text: '' }; }

      if (info.url.indexOf('confproduct') !== -1) {
        return { status: 'IN_STOCK', detail: '购物车进入配置页面 -> 有货！' };
      }
      const t = info.text.toLowerCase();
      if (t.indexOf('out of stock on this item') !== -1) {
        return { status: 'OUT_OF_STOCK', detail: '购物车显示 Out of Stock' };
      }
      if (
        (info.title || '').toLowerCase().indexOf('just a moment') !== -1 ||
        (info.title || '').indexOf('请稍候') !== -1 ||
        t.indexOf('enable javascript and cookies') !== -1 ||
        t.indexOf('checking your browser') !== -1 ||
        t.indexOf('安全验证') !== -1 ||
        t.indexOf('ray id') !== -1
      ) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (t.indexOf('shopping cart') !== -1 || t.indexOf('client area') !== -1) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { status: 'UNKNOWN', detail: '90 秒内未能判定（疑似人机验证未通过）' };
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------- 主流程 ----------
(async () => {
  const state = loadState();
  const chromePath = findChrome();
  if (!chromePath) { log('未找到 Chrome，无法检查'); process.exit(2); }
  log('使用浏览器: ' + chromePath);

  let result;
  try {
    const browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: 'new',
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--mute-audio'],
    });
    result = await checkStock(browser);
    await browser.close().catch(() => {});
  } catch (e) {
    result = { status: 'ERROR', detail: '浏览器异常: ' + e.message };
  }

  log('本次检查: ' + result.status + ' - ' + result.detail);

  state.lastCheckAt = Date.now();
  state.lastCheckStatus = result.status;
  state.lastCheckDetail = result.detail;

  if (result.status === 'IN_STOCK') {
    const now = Date.now();
    if (state.lastStatus !== 'IN_STOCK') {
      log('！！！！！！检测到有货 ！！！！！！');
      await sendMail('【有货！】DMIT LAX.AS3.Pro.TINY 已上架，速购！', ALERT_HTML);
      await pushPlusSend('【有货！】DMIT LAX.AS3.Pro.TINY 已上架，速购！', ALERT_HTML);
      state.lastAlertAt = now;
    } else if (now - (state.lastAlertAt || 0) >= REMIND_MINUTES * 60000) {
      log('仍处于有货状态，再次提醒');
      await sendMail('【再次提醒】DMIT LAX.AS3.Pro.TINY 仍可购买', ALERT_HTML);
      await pushPlusSend('【再次提醒】DMIT LAX.AS3.Pro.TINY 仍可购买', ALERT_HTML);
      state.lastAlertAt = now;
    }
  } else if (result.status === 'OUT_OF_STOCK' && state.lastStatus === 'IN_STOCK') {
    await sendMail('【已售罄】DMIT LAX.AS3.Pro.TINY 恢复缺货', SOLD_OUT_HTML);
    await pushPlusSend('【已售罄】DMIT LAX.AS3.Pro.TINY 恢复缺货', SOLD_OUT_HTML);
  }

  if (result.status === 'IN_STOCK' || result.status === 'OUT_OF_STOCK') {
    state.lastStatus = result.status;
  }
  saveState(state);

  if (result.status === 'ERROR' || result.status === 'UNKNOWN') process.exit(2);
  process.exit(0);
})().catch((e) => {
  log('异常: ' + (e && e.stack || e));
  process.exit(2);
});
