import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

const port = Number(process.env.DASHBOARD_PORT || 8787)
const dataDir = path.resolve('data')
const statsPath = path.join(dataDir, 'stats.json')
const eventsPath = path.join(dataDir, 'events.jsonl')

async function readJson(pathname: string, fallback: unknown) {
  try { return JSON.parse(await readFile(pathname, 'utf8')) } catch { return fallback }
}

async function status() {
  const stats = await readJson(statsPath, { cycles: 0, spentUsd: 0 })
  let events: unknown[] = []
  try {
    events = (await readFile(eventsPath, 'utf8')).trim().split('\n').filter(Boolean).slice(-50).reverse().map((line) => JSON.parse(line))
  } catch { /* no activity yet */ }
  return { stats, events, leaderboard: { rank: null, note: 'Official Flipt leaderboard endpoint is not publicly available to this runner.' } }
}

const page = `<!doctype html><html><head><meta charset="utf-8"><title>Flipt Testnet Bot</title><style>body{font:16px system-ui;background:#101114;color:#edf0f4;max-width:980px;margin:40px auto;padding:0 20px}h1{margin-bottom:4px}.muted{color:#aab3c1}.cards{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}.card{background:#1a1d23;border:1px solid #303642;border-radius:10px;padding:16px;min-width:120px}.value{font-size:28px;font-weight:700}table{width:100%;border-collapse:collapse;background:#1a1d23}th,td{padding:10px;text-align:left;border-bottom:1px solid #303642;font-family:ui-monospace,monospace;font-size:13px}th{color:#aab3c1}</style></head><body><h1>Flipt Testnet Bot</h1><p class="muted" id="rank"></p><section class="cards" id="cards"></section><h2>Recent activity</h2><table><thead><tr><th>Time</th><th>Action</th><th>Token</th><th>Amount</th><th>Transaction</th></tr></thead><tbody id="events"></tbody></table><script>const esc=v=>String(v??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));async function refresh(){const d=await fetch('/api/status').then(r=>r.json());const s=d.stats;document.querySelector('#rank').textContent='Leaderboard rank: '+(d.leaderboard.rank??d.leaderboard.note);document.querySelector('#cards').innerHTML=[['Gas USDC',Number(s.nativeGasUsdc||0).toFixed(2)],['Flipt USDC',Number(s.fliptUsdc||0).toFixed(2)],['Cycles',s.cycles],['Creates',s.create],['Buys',s.buy],['Sells',s.sell],['Collected',s.collect],['Spent USDC',Number(s.spentUsd||0).toFixed(2)]].map(([k,v])=>'<div class="card"><div class="muted">'+k+'</div><div class="value">'+esc(v||0)+'</div></div>').join('');document.querySelector('#events').innerHTML=d.events.map(e=>'<tr><td>'+esc(e.at)+'</td><td>'+esc(e.action)+'</td><td>'+esc(e.token||'?')+'</td><td>'+esc(e.amountUsd||e.initialBuyUsd||e.tokenAmount||'?')+'</td><td>'+esc(e.hash||'?')+'</td></tr>').join('')}refresh();setInterval(refresh,5000)</script></body></html>`

createServer(async (request, response) => {
  if (request.url === '/api/status') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(await status()))
    return
  }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page)
}).listen(port, () => console.log(`Dashboard: http://localhost:${port}`))
