/**
 * Preload for the harness GUI window: injects the app's own usage overlay
 * at the bottom-left, anchored to the harness's settings trigger.
 *
 * The overlay is a floating "使用统计" pill docked just above the GUI's own
 * bottom-left 设置 button (the anchor is located from the real DOM and
 * repositioned while the SPA settles; a fixed fallback keeps it usable when
 * the layout differs). Clicking it opens a dark panel with a per-day token
 * bar chart, an input/output/cache donut, range switching, and the in-app
 * update check.
 *
 * This is a sandboxed preload: it has no Node access beyond Electron's
 * ipcRenderer, and it manipulates the page DOM from its isolated world (DOM
 * is shared, JS globals are not). All styling goes through CSSOM and SVG
 * presentation attributes so the harness page's Content Security Policy can
 * never block the overlay.
 * @module gui-usage-preload
 */

import { ipcRenderer } from 'electron'

// Skip the inline loading/error pages (data: URLs) — the overlay belongs to
// the real harness GUI only.
if (!/^data:/.test(location.href)) {
  main()
}

function main(): void {
  const start = (): void => {
    if (document.body !== null) init()
    else setTimeout(start, 50)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => start())
  else start()
}

/** Root element id — also guards against double injection. */
const ROOT_ID = 'dsh-desktop-usage-root'

// ── tiny DOM/builders (CSSOM only — CSP-proof) ────────────────────────────
function div(styles: Record<string, string>, children: Array<Node | string> = []): HTMLDivElement {
  const node = document.createElement('div')
  Object.assign(node.style, styles)
  for (const child of children) node.append(typeof child === 'string' ? document.createTextNode(child) : child)
  return node
}

function button(text: string, styles: Record<string, string>, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button')
  node.textContent = text
  Object.assign(node.style, styles)
  node.addEventListener('click', onClick)
  return node
}

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

// ── palette ───────────────────────────────────────────────────────────────
const COLORS = {
  bg: '#0d1117', panel: '#161b22', panel2: '#1c2128', border: '#21262d',
  text: '#e6edf3', muted: '#8b949e', faint: '#6e7681',
  accent: '#4da6ff', green: '#3fb950', red: '#f85149',
  input: '#4da6ff', cacheRead: '#3fb950', cacheWrite: '#6e7681', output: '#f0883e',
}

// ── state ─────────────────────────────────────────────────────────────────
let range = '7'
let updateState = 'idle'
let updateResult: { latest: string | null; assetUrl: string | null; assetName: string | null } | null = null
let installerPath: string | null = null
let snapshot: Record<string, unknown> | null = null

// entry + panel elements
let entry: HTMLButtonElement | null = null
let panel: HTMLDivElement | null = null
let bodyBackdrop: HTMLDivElement | null = null
let panelTransformed = false // whether the panel is laid out

const fmt = (n: number): string => Number(n).toLocaleString('zh-CN')
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })

// ── init ──────────────────────────────────────────────────────────────────
function init(): void {
  if (document.getElementById(ROOT_ID) !== null) return
  const root = div({ position: 'fixed', top: '0', left: '0', width: '0', height: '0', zIndex: '2147483000' })
  root.id = ROOT_ID
  document.body.appendChild(root)
  buildEntry(root)
  buildPanel(root)
  positionEntry()
  repositionLoop(root)
  bindUpdates()
}

/** Build the floating pill docked above the harness's own 设置 button. */
function buildEntry(root: HTMLElement): void {
  entry = document.createElement('button')
  entry.textContent = '📊 使用统计'
  entry.style.cssText = [
    'position:fixed', 'z-index:1',
    'display:flex', 'align-items:center', 'gap:6px',
    'padding:7px 12px', 'border-radius:999px',
    'background:#161b22', 'border:1px solid #30363d',
    'color:#e6edf3', 'font:12.5px system-ui,"Segoe UI","Microsoft YaHei",sans-serif',
    'cursor:pointer', 'box-shadow:0 4px 14px rgba(0,0,0,.35)',
  ].join(';')
  entry.addEventListener('mouseenter', () => { entry!.style.borderColor = COLORS.accent })
  entry.addEventListener('mouseleave', () => { entry!.style.borderColor = '#30363d' })
  entry.addEventListener('click', togglePanel)
  root.appendChild(entry)
}

/**
 * Locate the harness's bottom-left 设置 trigger from the live DOM. We look
 * for the bottom-most compact element whose accessible name mentions 设置.
 */
function settingsAnchor(): { top: number; left: number } | null {
  let best: { top: number; left: number; tag: string } | null = null
  const all = document.querySelectorAll('button, a, [role="button"], [aria-label], [title], [class]')
  for (let i = 0; i < all.length; i++) {
    const node = all[i] as HTMLElement
    if (node instanceof HTMLElement === false) continue
    const rect = node.getBoundingClientRect()
    if (rect.width < 8 || rect.height < 8 || rect.bottom > window.innerHeight - 4) continue
    const label = String(node.getAttribute('aria-label') ?? '') + String(node.getAttribute('title') ?? '') + String(node.textContent ?? '').trim()
    if (!label.includes('设置')) continue
    if (best === null || rect.bottom > best.top) best = { top: rect.bottom, left: rect.left, tag: label.slice(0, 12) }
  }
  return best
}

/** Dock the pill just above the settings anchor, with a safe fallback. */
function positionEntry(): void {
  if (entry === null) return
  const anchor = settingsAnchor()
  if (anchor !== null && anchor.top < window.innerHeight - 8) {
    entry.style.left = Math.max(8, Math.round(anchor.left)) + 'px'
    entry.style.bottom = Math.round(window.innerHeight - anchor.top + 8) + 'px'
  } else {
    entry.style.left = '12px'
    entry.style.bottom = '64px'
  }
}

/** The SPA re-layouts for a while after load — keep the pill docked. */
function repositionLoop(root: HTMLElement): void {
  const stop = Date.now() + 15_000
  const tick = (): void => {
    if (Date.now() > stop) return
    positionEntry()
    setTimeout(tick, 1_000)
  }
  setTimeout(tick, 1_000)
  window.addEventListener('resize', positionEntry)
}

function bindUpdates(): void {
  ipcRenderer.on('usage:updated', () => { loadSnapshot() })
  ipcRenderer.on('update:progress', (_event: unknown, fraction: number) => {
    if (updateState === 'downloading') setUpdateText(`下载中 ${Math.round(fraction * 100)}%`)
    else if (updateState === 'available') setUpdateText('正在下载…')
  })
}

// ── panel ─────────────────────────────────────────────────────────────────
/** Wire nodes that render() mutates — created once in buildPanel. */
let ui = {
  seg: [] as HTMLButtonElement[],
  rangeHint: null as HTMLDivElement | null,
  barTitle: null as HTMLDivElement | null,
  barWrap: null as HTMLDivElement | null,
  donutWrap: null as HTMLDivElement | null,
  chipTotal: null as HTMLDivElement | null,
  chipInput: null as HTMLDivElement | null,
  chipOutput: null as HTMLDivElement | null,
  chipActive: null as HTMLDivElement | null,
  updateText: null as HTMLDivElement | null,
  updateBtn: null as HTMLButtonElement | null,
  dataPath: null as HTMLElement | null,
}

function buildPanel(root: HTMLElement): void {
  bodyBackdrop = div({
    position: 'fixed', inset: '0', background: 'rgba(1,4,9,.55)', display: 'none', zIndex: '0',
  })
  bodyBackdrop.addEventListener('click', hidePanel)
  root.appendChild(bodyBackdrop)

  panel = div({
    position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
    width: '720px', maxWidth: '92vw', maxHeight: '82vh', overflow: 'auto',
    background: COLORS.bg, border: `1px solid ${COLORS.border}`, borderRadius: '12px',
    boxShadow: '0 18px 50px rgba(0,0,0,.5)', color: COLORS.text, display: 'none',
    font: '13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif',
    padding: '18px 20px 16px', zIndex: '1',
  })
  const head = div({ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '14px' })
  const title = div({ fontSize: '17px', fontWeight: '650' }, ['📊 使用统计'])
  const seg = div({ display: 'flex', gap: '2px', background: COLORS.panel2, borderRadius: '8px', padding: '3px' })
  for (const [value, label] of [['7', '最近7天'], ['30', '最近30天'], ['all', '全部']] as const) {
    const b = document.createElement('button')
    b.textContent = label
    b.style.cssText = [
      'border:0', 'background:transparent', 'color:#8b949e', 'font:inherit', 'font-size:12.5px',
      'padding:4px 12px', 'border-radius:6px', 'cursor:pointer',
    ].join(';')
    b.addEventListener('click', () => { range = value; reload() })
    if (value === range) b.style.background = 'rgba(77,166,255,.18)', b.style.color = '#fff'
    seg.appendChild(b)
    ui.seg.push(b)
  }
  const close = button('✕', { border: '0', background: 'transparent', color: '#8b949e', fontSize: '15px', cursor: 'pointer', marginLeft: 'auto' }, hidePanel)
  head.append(title, seg, close)
  panel.appendChild(head)

  // charts row
  const charts = div({ display: 'grid', gridTemplateColumns: '1fr 300px', gap: '16px' })
  const barBlock = div({ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: '10px', padding: '12px 14px' })
  ui.barTitle = div({ fontSize: '12.5px', color: COLORS.muted, marginBottom: '10px' })
  ui.barWrap = div({})
  barBlock.append(ui.barTitle, ui.barWrap)
  const donutBlock = div({ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: '10px', padding: '12px 14px', textAlign: 'center' })
  const donutTitle = div({ fontSize: '12.5px', color: COLORS.muted, marginBottom: '6px' }, ['用量构成'])
  ui.donutWrap = div({})
  donutBlock.append(donutTitle, ui.donutWrap)
  charts.append(barBlock, donutBlock)
  panel.appendChild(charts)

  // stat chips
  const chips = div({ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: '10px', marginTop: '14px' })
  ui.chipTotal = chip('🧾 Token 用量', '', chips)
  ui.chipInput = chip('📥 输入 Tokens', '', chips)
  ui.chipOutput = chip('📤 输出 Tokens', '', chips)
  ui.chipActive = chip('🔥 活跃天数', '', chips)
  panel.appendChild(chips)

  // update row
  const up = div({ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '14px' })
  ui.updateText = div({ fontSize: '12px', color: COLORS.muted })
  ui.updateBtn = button('检查更新', { border: '1px solid #30363d', background: '#1c2128', color: '#e6edf3', fontSize: '12.5px', padding: '5px 14px', borderRadius: '7px', cursor: 'pointer', marginLeft: 'auto' }, onUpdateClick)
  up.append(ui.updateText, ui.updateBtn)
  panel.appendChild(up)

  // footer
  const foot = div({
    display: 'flex', alignItems: 'center', gap: '10px', marginTop: '12px',
    paddingTop: '10px', borderTop: '1px solid ' + COLORS.border, fontSize: '11px', color: COLORS.faint,
  })
  const note = div({}, ['Token 来自本地会话日志，每 20 秒自动刷新 · 永久保留。'])
  const openDir = button('打开数据目录', { border: '1px solid #21262d', background: '#1c2128', color: '#8b949e', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', marginLeft: 'auto' }, () => { void api.openDataDir() })
  ui.dataPath = div({ fontFamily: 'monospace', color: COLORS.muted, maxWidth: '260px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
  foot.append(note, ui.dataPath, openDir)
  panel.appendChild(foot)

  root.appendChild(panel)
  root.appendChild(bodyBackdrop)
  void api.meta().then((m) => { if (m !== null && m.filePath !== undefined) ui.dataPath!.textContent = String(m.filePath) })
  loadSnapshot()
}

function chip(title: string, sub: string, parent: HTMLElement): HTMLDivElement {
  const c = div({ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: '10px', padding: '10px 12px' })
  const t = div({ fontSize: '11.5px', color: COLORS.muted }, [title])
  const v = div({ fontSize: '16px', fontWeight: '650', marginTop: '4px', letterSpacing: '.2px' })
  c.append(t, v)
  parent.appendChild(c)
  return v
}

function togglePanel(): void {
  panelTransformed = !panelTransformed
  if (panel === null || bodyBackdrop === null) return
  panel.style.display = panelTransformed ? 'block' : 'none'
  bodyBackdrop.style.display = panelTransformed ? 'block' : 'none'
}

function hidePanel(): void {
  panelTransformed = false
  if (panel !== null && bodyBackdrop !== null) {
    panel.style.display = 'none'
    bodyBackdrop.style.display = 'none'
  }
}

// ── data & render ─────────────────────────────────────────────────────────
function reload(): void {
  for (const b of ui.seg) {
    b.style.background = b.textContent === (range === '7' ? '最近7天' : range === '30' ? '最近30天' : '全部') ? 'rgba(77,166,255,.18)' : 'transparent'
    b.style.color = b.textContent === (range === '7' ? '最近7天' : range === '30' ? '最近30天' : '全部') ? '#fff' : '#8b949e'
  }
  loadSnapshot()
}

function loadSnapshot(): void {
  void ipcRenderer.invoke('usage:snapshot', range).then((data) => {
    snapshot = data as Record<string, unknown>
    render()
  })
}

function render(): void {
  if (snapshot === null || panel === null) return
  const rows = snapshot['rows'] as Array<{ date: string; label: string; day: Record<string, number> }>
  const totals = snapshot['totals'] as Record<string, number>
  const activeDays = Number(snapshot['activeDays'])
  const totalTokens = totals['inputTokens'] + totals['outputTokens'] + totals['cacheReadTokens'] + totals['cacheWriteTokens']
  const inputBilled = totals['inputTokens'] + totals['cacheReadTokens'] + totals['cacheWriteTokens']

  ui.barTitle!.textContent = `每日 Token 趋势 · ${range === 'all' ? '全部' : '最近' + range + '天'}`
  ui.barWrap!.replaceChildren(barChart(rows))
  // Mutually exclusive donut segments: uncached input, cache reads, cache
  // writes, output — their sum equals the total shown in the center.
  ui.donutWrap!.replaceChildren(donutChart(
    totals['inputTokens'] ?? 0,
    totals['outputTokens'] ?? 0,
    totals['cacheReadTokens'] ?? 0,
    totals['cacheWriteTokens'] ?? 0,
    totalTokens,
  ))

  ui.chipTotal!.textContent = compact.format(totalTokens)
  ui.chipTotal!.title = fmt(totalTokens) + ' = 输入 + 输出 + 缓存'
  ui.chipInput!.textContent = compact.format(inputBilled)
  ui.chipInput!.title = '计费输入（含缓存）' + fmt(inputBilled)
  ui.chipOutput!.textContent = compact.format(totals['outputTokens'] ?? 0)
  ui.chipActive!.textContent = String(activeDays)
}

// ── charts (pure SVG, CSP-safe presentation attributes) ───────────────────
function barChart(rows: Array<{ date: string; label: string; day: Record<string, number> }>): SVGElement {
  const W = 640, H = 190, PLOT_H = 130, BASELINE = 160
  const svg = svgEl('svg', { width: '100%', viewBox: `0 0 ${W} ${H}` } as Record<string, string>)
  const data = rows.map((r) => ({
    label: r.label,
    value: (r.day['inputTokens'] ?? 0) + (r.day['outputTokens'] ?? 0) + (r.day['cacheReadTokens'] ?? 0) + (r.day['cacheWriteTokens'] ?? 0),
    date: r.date,
  }))
  const max = Math.max(1, ...data.map((d) => d.value))
  const n = data.length
  const slot = W / n
  svg.append(svgEl('line', { x1: 0, y1: BASELINE, x2: W, y2: BASELINE, stroke: '#21262d', 'stroke-width': 1 }))
  for (let i = 0; i < n; i++) {
    const d = data[i]
    const bh = d.value > 0 ? Math.max(3, (d.value / max) * PLOT_H) : 0
    const x = i * slot + slot * 0.16
    const w = Math.max(2, slot * 0.68)
    const y = BASELINE - bh
    const bar = svgEl('rect', { x, y, width: w, height: bh, rx: 3, fill: d.value > 0 ? (i === 0 ? '#4da6ff' : '#2f81f7') : '#21262d' })
    const title = svgEl('title', {})
    title.textContent = `${d.date} · ${compact.format(d.value)} tokens`
    bar.appendChild(title)
    svg.append(bar)
    // sparse x labels
    const step = Math.max(1, Math.ceil(n / 8))
    if (i % step === 0) {
      const text = svgEl('text', { x: x + w / 2, y: H - 2, 'font-size': 10, fill: '#6e7681', 'text-anchor': 'middle' })
      text.textContent = d.label
      svg.append(text)
    }
  }
  return svg
}

function donutChart(input: number, output: number, cacheRead: number, cacheWrite: number, total: number): SVGElement {
  const SIZE = 150, R = 54, CX = SIZE / 2, CY = SIZE / 2
  const svg = svgEl('svg', { width: '100%', viewBox: `0 0 ${SIZE} ${SIZE + 30}` } as Record<string, string>)
  const raw: Array<[number, string, string]> = [
    [input, COLORS.input, '输入'],
    [output, COLORS.output, '输出'],
    [cacheRead, COLORS.cacheRead, '缓存读取'],
    [cacheWrite, COLORS.cacheWrite, '缓存写入'],
  ]
  const segments = raw.filter(([value]) => value > 0)
  const circumference = 2 * Math.PI * R
  let offset = 0
  if (segments.length > 0) {
    for (const [value, color] of segments) {
      const dash = Math.max(0, (value / total) * circumference)
      svg.append(svgEl('circle', {
        cx: CX, cy: CY, r: R, fill: 'none', stroke: color, 'stroke-width': 22,
        'stroke-dasharray': `${dash} ${circumference - dash}`,
        'stroke-dashoffset': -offset, transform: `rotate(-90 ${CX} ${CY})`,
      }))
      offset += dash
    }
  } else {
    svg.append(svgEl('circle', { cx: CX, cy: CY, r: R, fill: 'none', stroke: '#21262d', 'stroke-width': 22 }))
  }
  const totalText = svgEl('text', { x: CX, y: CY - 2, 'text-anchor': 'middle', 'font-size': 15, fill: '#e6edf3', 'font-weight': '650' })
  totalText.textContent = compact.format(total)
  svg.append(totalText)
  const totalLabel = svgEl('text', { x: CX, y: CY + 14, 'text-anchor': 'middle', 'font-size': 9, fill: '#6e7681' })
  totalLabel.textContent = '总 Tokens'
  svg.append(totalLabel)
  let legendX = 4
  for (const [value, color, name] of segments) {
    const text = svgEl('text', { x: legendX, y: SIZE + 12, 'font-size': 9.5, fill: '#8b949e' })
    const dot = svgEl('tspan', { fill: color, 'font-weight': '700' })
    dot.textContent = '● '
    text.appendChild(dot)
    text.appendChild(document.createTextNode(`${name} ${Math.round((value / total) * 100)}%`))
    svg.append(text)
    legendX += (name.length + 6) * 9.5
  }
  return svg
}

// ── update flow ────────────────────────────────────────────────────────────
function setUpdateText(text: string): void {
  if (ui.updateText !== null) {
    ui.updateText.textContent = text
    ui.updateText.style.color = updateState === 'latest' ? COLORS.green : updateState === 'error' ? '#f85149' : COLORS.muted
  }
}

function onUpdateClick(): void {
  switch (updateState) {
    case 'idle': case 'latest': case 'error': doCheck(); break
    case 'available': doDownload(); break
    case 'ready': doInstall(); break
  }
}

function doCheck(): void {
  updateState = 'checking'
  ui.updateBtn!.textContent = '检查中…'
  ui.updateBtn!.disabled = true
  setUpdateText('正在检查最新版本…')
  void api.checkUpdate().then((r) => {
    if (r === null || r.status === 'error') {
      updateState = 'error'
      ui.updateBtn!.textContent = '重试'
      ui.updateBtn!.disabled = false
      setUpdateText(r !== null && r.error ? r.error : '检查更新失败。')
      return
    }
    if (!r.hasUpdate) {
      updateState = 'latest'
      ui.updateBtn!.textContent = '检查更新'
      ui.updateBtn!.disabled = false
      setUpdateText('已是最新版本 v' + r.current)
      return
    }
    updateState = 'available'
    updateResult = r
    ui.updateBtn!.textContent = '下载更新'
    ui.updateBtn!.disabled = false
    setUpdateText('发现新版本 v' + r.latest + '（当前 v' + r.current + '）')
  })
}

function doDownload(): void {
  if (updateResult === null || updateResult.assetUrl === null) { setUpdateText('没有找到安装包下载地址。'); return }
  updateState = 'downloading'
  ui.updateBtn!.textContent = '下载中…'
  ui.updateBtn!.disabled = true
  void api.downloadUpdate(updateResult.assetUrl).then((p) => {
    installerPath = p
    updateState = 'ready'
    ui.updateBtn!.textContent = '立即安装'
    ui.updateBtn!.disabled = false
    setUpdateText('下载完成，点击安装后将退出并启动安装程序。')
  }).catch((e) => {
    updateState = 'error'
    ui.updateBtn!.textContent = '重试'
    ui.updateBtn!.disabled = false
    setUpdateText('下载失败：' + String(e))
  })
}

function doInstall(): void {
  if (installerPath === null) return
  void api.installUpdate(installerPath)
  setUpdateText('正在启动安装程序…')
}

/** Shape of the `update:check` response (mirrors updater.UpdateCheckResult). */
interface UpdateCheckResult {
  status: string
  current: string
  latest: string | null
  hasUpdate: boolean
  error?: string
  assetUrl: string | null
  assetName: string | null
}

/** Narrow IPC surface used by the overlay. */
const api = {
  meta: (): Promise<{ filePath?: string } | null> => ipcRenderer.invoke('usage:meta') as Promise<{ filePath?: string } | null>,
  openDataDir: (): Promise<unknown> => ipcRenderer.invoke('usage:open-data-dir'),
  checkUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('update:check') as Promise<UpdateCheckResult>,
  downloadUpdate: (url: string): Promise<string> => ipcRenderer.invoke('update:download', url) as Promise<string>,
  installUpdate: (path: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('update:install', path) as Promise<{ ok: boolean }>,
}
