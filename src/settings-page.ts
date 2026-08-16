/**
 * The app's own settings page, focused on one thing: token usage
 * statistics, plus the in-app update check. Self-contained dark-themed
 * page served as a `data:` URL, talking to the main process only through
 * the `usageAPI` bridge from the settings preload.
 *
 * Token totals come from the harness's session logs (parsed in the main
 * process every few seconds); request/message counters are live HTTP
 * observations. The page renders a range toggle, four summary cards, and a
 * per-day breakdown table.
 * @module settings-page
 */

/**
 * The full settings page document. The inline script avoids backticks and
 * `${}` so the outer template literal needs no escaping.
 */
const PAGE_HTML = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>设置</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --panel-2: #1c2128; --border: #21262d;
    --text: #e6edf3; --muted: #8b949e; --faint: #6e7681;
    --accent: #4da6ff; --accent-soft: rgba(77, 166, 255, .12);
    --green: #3fb950; --red: #f85149;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: var(--bg); color: var(--text); height: 100vh; overflow: hidden;
    font: 14px/1.5 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .page { height: 100vh; overflow-y: auto; padding: 22px 28px 40px; }

  .top { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .top h1 { font-size: 20px; font-weight: 650; letter-spacing: .2px; margin-right: 6px; }
  .seg { display: flex; gap: 2px; background: var(--panel-2); border-radius: 8px; padding: 3px; }
  .seg button {
    border: 0; background: transparent; color: var(--muted); font: inherit;
    font-size: 12.5px; padding: 4px 14px; border-radius: 6px; cursor: pointer;
  }
  .seg button:hover { color: var(--text); }
  .seg button.active { background: var(--accent-soft); color: #fff; font-weight: 600; }

  .update { margin-left: auto; display: flex; align-items: center; gap: 10px; }
  .update .state { font-size: 12px; color: var(--muted); max-width: 260px; }
  .update .state.latest { color: var(--green); }
  .update .state.error { color: var(--red); }
  button.action {
    border: 1px solid var(--border); background: var(--panel-2); color: var(--text);
    font: inherit; font-size: 12.5px; padding: 5px 14px; border-radius: 7px; cursor: pointer;
  }
  button.action:hover { border-color: var(--accent); color: var(--accent); }
  button.action.primary { background: var(--accent-soft); border-color: rgba(77, 166, 255, .45); }
  button.action:disabled { opacity: .5; cursor: default; }

  .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-top: 16px; }
  .card {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 14px 16px; min-height: 96px;
  }
  .card .card-top { display: flex; align-items: center; gap: 9px; }
  .card .icon {
    width: 30px; height: 30px; border-radius: 8px; flex: none;
    display: flex; align-items: center; justify-content: center; font-size: 15px;
    background: var(--accent-soft);
  }
  .card .title { font-size: 12px; color: var(--muted); }
  .card .value { margin-top: 8px; font-size: 22px; font-weight: 650; letter-spacing: .2px; }
  .card .sub { margin-top: 2px; font-size: 11.5px; color: var(--faint); }

  .panel {
    margin-top: 16px; background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; overflow: hidden;
  }
  .panel-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 13px 18px; border-bottom: 1px solid var(--border);
  }
  .panel-head h2 { font-size: 13.5px; font-weight: 600; }
  .panel-head .hint { font-size: 11.5px; color: var(--faint); }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left; font-size: 11px; font-weight: 600; color: var(--faint);
    padding: 9px 18px; letter-spacing: .04em; text-transform: uppercase;
    border-bottom: 1px solid var(--border);
  }
  th.num, td.num { text-align: right; }
  td {
    padding: 8px 18px; font-size: 13px; color: var(--text);
    border-bottom: 1px solid rgba(33, 38, 45, .55);
  }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover { background: var(--panel-2); }
  tbody tr.today { background: rgba(77, 166, 255, .055); }
  td .chip {
    display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 11.5px;
    background: var(--panel-2); color: var(--muted);
  }
  tr.today .chip { background: var(--accent-soft); color: var(--accent); }
  td .key { margin-left: 8px; font-size: 11.5px; color: var(--faint); }
  td .bar-cell { display: flex; align-items: center; gap: 10px; }
  .bar { flex: 1; max-width: 200px; height: 6px; border-radius: 3px; background: var(--panel-2); overflow: hidden; }
  .bar i { display: block; height: 100%; background: linear-gradient(90deg, #2f81f7, var(--accent)); border-radius: 3px; }
  .bar-val { width: 64px; text-align: right; font-size: 12px; color: var(--muted); }

  .empty { padding: 34px 18px; text-align: center; color: var(--muted); font-size: 13px; }
  .empty b { color: var(--text); }

  .foot {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 11px 18px; border-top: 1px solid var(--border);
    font-size: 11.5px; color: var(--faint);
  }
  .foot code { color: var(--muted); font-size: 11px; }
  .foot button {
    margin-left: auto; border: 1px solid var(--border); background: var(--panel-2);
    color: var(--text); font: inherit; font-size: 11.5px; padding: 3px 12px;
    border-radius: 6px; cursor: pointer;
  }
  .foot button:hover { border-color: var(--accent); color: var(--accent); }

  #toast {
    position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%) translateY(8px);
    background: #242a33; border: 1px solid #3d454f; color: var(--text); font-size: 12.5px;
    padding: 7px 16px; border-radius: 8px; opacity: 0; pointer-events: none;
    transition: opacity .18s, transform .18s; z-index: 10;
  }
  #toast.show { opacity: 1; transform: translateX(-50%); }
</style>
</head>
<body>
<div class="page">
  <div class="top">
    <h1>使用统计</h1>
    <div class="seg">
      <button data-range="7" class="active">最近7天</button>
      <button data-range="30">最近30天</button>
      <button data-range="all">全部</button>
    </div>
    <div class="update">
      <span class="state" id="updateState"></span>
      <button class="action" id="updateBtn">检查更新</button>
    </div>
  </div>

  <section class="cards">
    <div class="card"><div class="card-top"><span class="icon">🧾</span><span class="title">Token 用量</span></div><div class="value" id="v-total">0</div><div class="sub">输入 + 输出 + 缓存</div></div>
    <div class="card"><div class="card-top"><span class="icon">📥</span><span class="title">输入 Tokens</span></div><div class="value" id="v-input">0</div><div class="sub" id="v-input-sub">含缓存读取/写入</div></div>
    <div class="card"><div class="card-top"><span class="icon">📤</span><span class="title">输出 Tokens</span></div><div class="value" id="v-output">0</div><div class="sub">模型输出</div></div>
    <div class="card"><div class="card-top"><span class="icon">🔥</span><span class="title">活跃天数</span></div><div class="value" id="v-active">0</div><div class="sub">有请求的天数</div></div>
  </section>

  <section class="panel">
    <div class="panel-head"><h2>每日用量</h2><span class="hint" id="rangeHint"></span></div>
    <div class="empty" id="emptyHint" style="display:none">
      <b id="emptyTitle">还没有用量记录</b><br><span id="emptyBody">开始使用后，这里会按天累计并永久保存。</span>
    </div>
    <table id="dailyTable">
      <thead><tr>
        <th>日期</th><th class="num">消息</th><th class="num">输入</th><th class="num">输出</th>
        <th class="num">合计</th><th>用量</th>
      </tr></thead>
      <tbody id="dailyBody"></tbody>
    </table>
    <div class="foot">
      <span>Token 数据来自本地会话日志，每 20 秒自动刷新；历史永久保留。</span>
      <span>数据文件：<code id="dataPath"></code></span>
      <button id="openDir">打开数据目录</button>
    </div>
  </section>
</div>
<div id="toast"></div>
<script>
(function () {
  var api = window.usageAPI
  if (!api) return
  var state = { range: '7', snapshot: null }

  function $(id) { return document.getElementById(id) }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }
  var compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })
  function fmt(n) { return Number(n).toLocaleString('zh-CN') }
  var toastTimer = null
  function toast(text) {
    var el = $('toast')
    el.textContent = text
    el.classList.add('show')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(function () { el.classList.remove('show') }, 2400)
  }

  function render() {
    var s = state.snapshot
    if (!s) return
    var t = s.totals
    var total = t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens
    var input = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens
    $('v-total').textContent = compact.format(total)
    $('v-input').textContent = compact.format(input)
    $('v-input-sub').textContent = '含缓存读取 ' + compact.format(t.cacheReadTokens) + ' · 写入 ' + compact.format(t.cacheWriteTokens)
    $('v-output').textContent = compact.format(t.outputTokens)
    $('v-active').textContent = String(s.activeDays)

    var first = s.rows.length > 0 ? s.rows[s.rows.length - 1].date : '—'
    var last = s.rows.length > 0 ? s.rows[0].date : '—'
    $('rangeHint').textContent = '共 ' + s.rows.length + ' 天 · ' + first + ' 至 ' + last

    var max = 1
    s.rows.forEach(function (r) {
      var v = r.day.inputTokens + r.day.outputTokens + r.day.cacheReadTokens + r.day.cacheWriteTokens
      if (v > max) max = v
    })
    var tbody = $('dailyBody')
    tbody.innerHTML = ''
    s.rows.forEach(function (r) {
      var day = r.day
      var v = day.inputTokens + day.outputTokens + day.cacheReadTokens + day.cacheWriteTokens
      var tr = document.createElement('tr')
      if (r.label === '今天') tr.className = 'today'
      var w = v > 0 ? Math.max(4, Math.round(v / max * 100)) : 0
      tr.innerHTML =
        '<td><span class="chip">' + esc(r.label) + '</span><span class="key">' + esc(r.date) + '</span></td>' +
        '<td class="num">' + fmt(day.messages) + '</td>' +
        '<td class="num">' + fmt(day.inputTokens + day.cacheReadTokens + day.cacheWriteTokens) + '</td>' +
        '<td class="num">' + fmt(day.outputTokens) + '</td>' +
        '<td class="num">' + fmt(v) + '</td>' +
        '<td class="bar-cell"><div class="bar"><i style="width:' + w + '%"></i></div><span class="bar-val">' + compact.format(v) + '</span></td>'
      tbody.appendChild(tr)
    })

    var hasTokens = s.daysTotal > 0 && t.inputTokens + t.outputTokens > 0
    $('emptyHint').style.display = hasTokens ? 'none' : ''
    $('dailyTable').style.display = hasTokens ? '' : 'none'
    if (!hasTokens && s.daysTotal === 0) {
      $('emptyTitle').textContent = '正在扫描会话日志…'
      $('emptyBody').textContent = '首次扫描需要几秒钟，之后每 20 秒自动更新。'
    }
  }

  function load() {
    api.getSnapshot(state.range).then(function (s) { state.snapshot = s; render() })
  }

  document.querySelectorAll('[data-range]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.range = btn.getAttribute('data-range')
      document.querySelectorAll('[data-range]').forEach(function (b) {
        b.classList.toggle('active', b === btn)
      })
      load()
    })
  })

  // ── update flow ─────────────────────────────────────────
  var update = { state: 'idle', result: null, installerPath: null }
  var updateBtn = $('updateBtn')
  var updateState = $('updateState')
  function setUpdate(mode, text) {
    update.state = mode
    updateState.textContent = text || ''
    updateState.className = 'state'
    if (mode === 'latest') updateState.className = 'state latest'
    if (mode === 'error') updateState.className = 'state error'
    if (mode === 'idle') { updateBtn.textContent = '检查更新'; updateBtn.disabled = false; updateBtn.className = 'action' }
    if (mode === 'checking') { updateBtn.textContent = '检查中…'; updateBtn.disabled = true }
    if (mode === 'available') { updateBtn.textContent = '下载更新'; updateBtn.className = 'action primary'; updateBtn.disabled = false }
    if (mode === 'downloading') { updateBtn.textContent = '下载中…'; updateBtn.disabled = true }
    if (mode === 'ready') { updateBtn.textContent = '立即安装'; updateBtn.className = 'action primary'; updateBtn.disabled = false }
    if (mode === 'error') { updateBtn.textContent = '重试'; updateBtn.className = 'action'; updateBtn.disabled = false }
  }
  function doCheck() {
    setUpdate('checking', '正在检查最新版本…')
    api.checkUpdate().then(function (r) {
      if (r.status === 'error') { setUpdate('error', r.error); return }
      if (!r.hasUpdate) { setUpdate('latest', '已是最新版本 v' + r.current); return }
      update.result = r
      setUpdate('available', '发现新版本 v' + r.latest + '（当前 v' + r.current + '）')
    })
  }
  function doDownload() {
    var r = update.result
    if (!r || !r.assetUrl) { setUpdate('error', '没有找到安装包下载地址。'); return }
    setUpdate('downloading', '正在下载 ' + (r.assetName || '') + ' …')
    api.downloadUpdate(r.assetUrl).then(function (p) {
      update.installerPath = p
      setUpdate('ready', '下载完成，点击安装后将自动退出并启动安装程序。')
    })
  }
  function doInstall() {
    if (!update.installerPath) return
    api.installUpdate(update.installerPath)
    setUpdate('downloading', '正在启动安装程序…')
  }
  updateBtn.addEventListener('click', function () {
    if (update.state === 'idle' || update.state === 'latest' || update.state === 'error') doCheck()
    else if (update.state === 'available') doDownload()
    else if (update.state === 'ready') doInstall()
  })
  api.onUpdateProgress(function (f) {
    if (update.state === 'downloading') {
      updateBtn.textContent = '下载中 ' + Math.round(f * 100) + '%'
    }
  })

  $('openDir').addEventListener('click', function () { api.openDataDir() })
  api.getMeta().then(function (m) {
    if (m && m.filePath) $('dataPath').textContent = m.filePath
  })
  api.onUpdated(function () { load() })
  load()
})();
</script>
</body>
</html>`

/** The settings page as a loadable `data:` URL. */
export const SETTINGS_PAGE_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(PAGE_HTML)
