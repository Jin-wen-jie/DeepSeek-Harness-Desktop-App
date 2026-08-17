/**
 * Preload for the harness GUI window: injects the app's own usage overlay,
 * anchored to the harness's bottom-left settings trigger.
 *
 * A floating "使用统计" pill is docked just above the GUI's own 设置 button
 * (locating the anchor in the live DOM and repositioning while the SPA
 * settles; a fixed fallback keeps it usable). Clicking it opens a FULL-SCREEN
 * overlay panel with:
 *   - a per-day token bar chart whose bars show that day's full usage on hover,
 *   - a per-model donut whose sectors show each model's usage share on hover,
 *   - range switching (最近7天/最近30天/全部) and the in-app update check.
 *
 * This is a sandboxed preload: no Node access beyond Electron's ipcRenderer,
 * and the page DOM is manipulated from its isolated world (DOM is shared, JS
 * globals are not). Styling goes through CSSOM and SVG presentation
 * attributes so the harness page's Content Security Policy can never block
 * the overlay.
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
}
const MODEL_COLORS = ['#4da6ff', '#f0883e', '#3fb950', '#a371f7', '#e3b341', '#39c5cf', '#f778ba', '#7d8590']

// ── state ─────────────────────────────────────────────────────────────────
let range = '7'
let updateState = 'idle'
let updateResult: { latest: string | null; assetUrl: string | null; assetName: string | null } | null = null
let installerPath: string | null = null
let snapshot: Record<string, unknown> | null = null
let panelOpen = false

let entry: HTMLButtonElement | null = null
let panel: HTMLDivElement | null = null
let tooltip: HTMLDivElement | null = null

/** Wire nodes that render() mutates — created once in buildPanel. */
const ui = {
  seg: [] as HTMLButtonElement[],
  barWrap: null as HTMLDivElement | null,
  donutWrap: null as HTMLDivElement | null,
  chipTotal: null as HTMLDivElement | null,
  chipInput: null as HTMLDivElement | null,
  chipOutput: null as HTMLDivElement | null,
  chipActive: null as HTMLDivElement | null,
  chipModels: null as HTMLDivElement | null,
  updateText: null as HTMLDivElement | null,
  updateBtn: null as HTMLButtonElement | null,
  dataPath: null as HTMLElement | null,
}

const fmt = (n: number): string => Number(n).toLocaleString('zh-CN')
const compact = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 })

/** Narrow IPC surface used by the overlay. */
interface UpdateCheckResult {
  status: string
  current: string
  latest: string | null
  hasUpdate: boolean
  error?: string
  assetUrl: string | null
  assetName: string | null
}
const api = {
  meta: (): Promise<{ filePath?: string } | null> => ipcRenderer.invoke('usage:meta') as Promise<{ filePath?: string } | null>,
  openDataDir: (): Promise<unknown> => ipcRenderer.invoke('usage:open-data-dir'),
  checkUpdate: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('update:check') as Promise<UpdateCheckResult>,
  downloadUpdate: (url: string): Promise<string> => ipcRenderer.invoke('update:download', url) as Promise<string>,
  installUpdate: (path: string): Promise<unknown> => ipcRenderer.invoke('update:install', path),
}

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
  ipcRenderer.on('usage:updated', () => { if (panelOpen) loadSnapshot() })
  ipcRenderer.on('update:progress', (_event: unknown, fraction: number) => {
    if (updateState === 'downloading') ui.updateBtn!.textContent = `下载中 ${Math.round(fraction * 100)}%`
    else if (updateState === 'available') ui.updateBtn!.textContent = '下载中…'
  })
}

/** Build the floating pill docked above the harness's own 设置 button. */
function buildEntry(root: HTMLElement): void {
  entry = document.createElement('button')
  entry.textContent = '📊 使用统计'
  entry.style.cssText = [
    'position:fixed', 'z-index:1', 'display:flex', 'align-items:center', 'gap:6px',
    'padding:7px 12px', 'border-radius:999px', 'background:#161b22', 'border:1px solid #30363d',
    'color:#e6edf3', 'font:12.5px system-ui,"Segoe UI","Microsoft YaHei",sans-serif',
    'cursor:pointer', 'box-shadow:0 4px 14px rgba(0,0,0,.35)',
  ].join(';')
  entry.addEventListener('click', togglePanel)
  root.appendChild(entry)
}

/**
 * Locate the harness's bottom-left 设置 trigger from the live DOM: the
 * bottom-most compact element whose accessible name mentions 设置.
 */
function settingsAnchor(): { top: number; left: number } | null {
  let best: { top: number; left: number } | null = null
  const all = document.querySelectorAll('button, a, [role="button"], [aria-label], [title], [class]')
  for (let i = 0; i < all.length; i++) {
    const node = all[i] as HTMLElement
    const rect = node.getBoundingClientRect()
    if (rect.width < 8 || rect.height < 8 || rect.bottom > window.innerHeight - 4) continue
    const label = String(node.getAttribute('aria-label') ?? '') + String(node.getAttribute('title') ?? '') + String(node.textContent ?? '').trim()
    if (!label.includes('设置')) continue
    if (best === null || rect.bottom > best.top) best = { top: rect.bottom, left: rect.left }
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

// ── panel (full screen) ───────────────────────────────────────────────────
function buildPanel(root: HTMLElement): void {
  panel = div({
    position: 'fixed', inset: '0', width: '100%', height: '100%', display: 'none',
    background: COLORS.bg, color: COLORS.text, overflow: 'auto', zIndex: '0',
    font: '13px/1.5 system-ui,"Segoe UI","Microsoft YaHei",sans-serif',
    padding: '20px 26px 36px',
  })

  const head = div({ display: 'flex', alignItems: 'center', gap: '16px', position: 'sticky', top: '0', background: COLORS.bg, padding: '4px 0 12px', zIndex: '1' })
  const title = div({ fontSize: '20px', fontWeight: '650', letterSpacing: '.2px' }, ['📊 使用统计'])
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
  ui.updateText = div({ fontSize: '12px', color: COLORS.muted })
  ui.updateBtn = button('检查更新', { border: '1px solid #30363d', background: '#1c2128', color: '#e6edf3', fontSize: '12.5px', padding: '5px 14px', borderRadius: '7px', cursor: 'pointer' }, onUpdateClick)
  const close = button('✕', { border: '0', background: 'transparent', color: '#8b949e', fontSize: '16px', cursor: 'pointer', marginLeft: '4px' }, hidePanel)
  head.append(title, seg, ui.updateText, ui.updateBtn, close)
  panel.appendChild(head)

  // stat chips
  const chips = div({ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: '12px', marginTop: '4px' })
  ui.chipTotal = chip('🧾 Token 用量', chips)
  ui.chipInput = chip('📥 输入 Tokens', chips)
  ui.chipOutput = chip('📤 输出 Tokens', chips)
  ui.chipActive = chip('🔥 活跃天数', chips)
  ui.chipModels = chip('🤖 使用模型', chips)
  panel.appendChild(chips)

  // charts row
  const charts = div({ display: 'grid', gridTemplateColumns: '1fr 360px', gap: '16px', marginTop: '14px' })
  const barBlock = div({ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: '12px', padding: '14px 16px' })
  ui.barWrap = div({})
  barBlock.append(div({ fontSize: '13px', color: COLORS.muted, marginBottom: '10px' }, ['每日 Token 趋势 · 鼠标悬停查看当天明细']), ui.barWrap)
  const donutBlock = div({ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: '12px', padding: '14px 16px' })
  ui.donutWrap = div({})
  donutBlock.append(div({ fontSize: '13px', color: COLORS.muted, marginBottom: '8px' }, ['模型用量占比 · 鼠标悬停查看']), ui.donutWrap)
  charts.append(barBlock, donutBlock)
  panel.appendChild(charts)

  // footer
  const foot = div({
    display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap', marginTop: '18px',
    paddingTop: '12px', borderTop: `1px solid ${COLORS.border}`, fontSize: '11.5px', color: COLORS.faint,
  })
  const note = div({}, ['Token 数据来自本地会话日志，每 20 秒自动刷新 · 永久保留。'])
  const openDir = button('打开数据目录', { border: '1px solid #21262d', background: '#1c2128', color: '#8b949e', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer', marginLeft: 'auto' }, () => { void api.openDataDir() })
  ui.dataPath = div({ fontFamily: 'monospace', color: COLORS.muted, maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' })
  foot.append(note, ui.dataPath, openDir)
  panel.appendChild(foot)

  // shared hover tooltip
  tooltip = div({
    position: 'fixed', zIndex: '2', display: 'none', pointerEvents: 'none',
    background: '#242a33', border: '1px solid #3d454f', color: COLORS.text,
    fontSize: '11.5px', lineHeight: '1.55', padding: '7px 10px', borderRadius: '8px',
    boxShadow: '0 6px 18px rgba(0,0,0,.4)', whiteSpace: 'pre', maxWidth: '300px',
  })
  root.appendChild(tooltip)

  root.appendChild(panel)
  void api.meta().then((m) => { if (m !== null && m.filePath !== undefined) ui.dataPath!.textContent = String(m.filePath) })
  loadSnapshot()
}

function chip(title: string, parent: HTMLElement): HTMLDivElement {
  const c = div({ background: COLORS.panel, border: `1px solid ${COLORS.border}`, borderRadius: '10px', padding: '10px 12px' })
  const t = div({ fontSize: '11.5px', color: COLORS.muted }, [title])
  const v = div({ fontSize: '17px', fontWeight: '650', marginTop: '4px', letterSpacing: '.2px' })
  c.append(t, v)
  parent.appendChild(c)
  return v
}

function togglePanel(): void {
  if (panel === null) return
  panelOpen = !panelOpen
  panel.style.display = panelOpen ? 'block' : 'none'
  if (panelOpen) loadSnapshot()
}

function hidePanel(): void {
  if (panel === null) return
  panelOpen = false
  panel.style.display = 'none'
  hideTooltip()
}

/** Show a hover tooltip near an element's position. */
function showTooltip(x: number, y: number, lines: string[]): void {
  if (tooltip === null) return
  tooltip.textContent = lines.join('\n')
  tooltip.style.display = 'block'
  const w = tooltip.offsetWidth
  tooltip.style.left = Math.max(8, Math.min(x + 14, window.innerWidth - w - 10)) + 'px'
  tooltip.style.top = Math.max(8, y + 14) + 'px'
}

function hideTooltip(): void {
  if (tooltip !== null) tooltip.style.display = 'none'
}

// ── data & render ─────────────────────────────────────────────────────────
function reload(): void {
  for (const b of ui.seg) {
    const target = range === '7' ? '最近7天' : range === '30' ? '最近30天' : '全部'
    b.style.background = b.textContent === target ? 'rgba(77,166,255,.18)' : 'transparent'
    b.style.color = b.textContent === target ? '#fff' : '#8b949e'
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
  const models = snapshot['models'] as Array<{ model: string; tokens: number; share: number }>
  const activeDays = Number(snapshot['activeDays'])
  const totalTokens = totals['inputTokens'] + totals['outputTokens'] + totals['cacheReadTokens'] + totals['cacheWriteTokens']
  const inputBilled = totals['inputTokens'] + totals['cacheReadTokens'] + totals['cacheWriteTokens']

  ui.chipTotal!.textContent = compact.format(totalTokens)
  ui.chipTotal!.title = `${fmt(totalTokens)} = 输入 + 输出 + 缓存`
  ui.chipInput!.textContent = compact.format(inputBilled)
  ui.chipInput!.title = `计费输入（含缓存） ${fmt(inputBilled)}`
  ui.chipOutput!.textContent = compact.format(totals['outputTokens'] ?? 0)
  ui.chipActive!.textContent = String(activeDays)
  ui.chipModels!.textContent = String(models.length)

  ui.barWrap!.replaceChildren(barChart(rows))
  ui.donutWrap!.replaceChildren(donutChart(models, totalTokens))
}

/** Per-day token bar chart; hovering a bar shows that day's full usage. */
function barChart(rows: Array<{ date: string; label: string; day: Record<string, number> }>): SVGElement {
  const W = 680, H = 200, PLOT_H = 138, BASELINE = 168
  const svg = svgEl('svg', { width: '100%', viewBox: `0 0 ${W} ${H}` } as Record<string, string>)
  const data = rows.map((r) => ({
    label: r.label,
    date: r.date,
    day: r.day,
    value: (r.day['inputTokens'] ?? 0) + (r.day['outputTokens'] ?? 0) + (r.day['cacheReadTokens'] ?? 0) + (r.day['cacheWriteTokens'] ?? 0),
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
    bar.addEventListener('mousemove', (ev: MouseEvent) => {
      showTooltip(ev.clientX, ev.clientY, [
        `${d.label} · ${d.date}`,
        `总 Tokens：${fmt(d.value)}`,
        `输入：${fmt(d.day['inputTokens'] ?? 0)}`,
        `缓存读取：${fmt(d.day['cacheReadTokens'] ?? 0)} · 写入：${fmt(d.day['cacheWriteTokens'] ?? 0)}`,
        `输出：${fmt(d.day['outputTokens'] ?? 0)}`,
        `消息：${fmt(d.day['messages'] ?? 0)} 条`,
      ])
    })
    bar.addEventListener('mouseleave', hideTooltip)
    svg.append(bar)
    const step = Math.max(1, Math.ceil(n / 9))
    if (i % step === 0) {
      const text = svgEl('text', { x: x + w / 2, y: H - 4, 'font-size': 10, fill: '#6e7681', 'text-anchor': 'middle' })
      text.textContent = d.label
      svg.append(text)
    }
  }
  return svg
}

/** Per-model donut; hovering a sector shows that model's usage share. */
function donutChart(models: Array<{ model: string; tokens: number; share: number }>, total: number): HTMLDivElement {
  const wrap = div({ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' })
  if (models.length === 0) {
    wrap.append(div({ color: COLORS.faint, fontSize: '12px', padding: '30px 0' }, ['暂无模型用量数据']))
    return wrap
  }
  const SIZE = 170, R = 62, CX = SIZE / 2, CY = SIZE / 2
  const svg = svgEl('svg', { width: '100%', viewBox: `0 0 ${SIZE} ${SIZE}` } as Record<string, string>)
  const circumference = 2 * Math.PI * R
  let offset = 0
  models.forEach((entry, i) => {
    const color = MODEL_COLORS[i % MODEL_COLORS.length]
    const dash = Math.max(0, entry.share * circumference)
    const sector = svgEl('circle', {
      cx: CX, cy: CY, r: R, fill: 'none', stroke: color, 'stroke-width': 24,
      'stroke-dasharray': `${dash} ${circumference - dash}`,
      'stroke-dashoffset': -offset, transform: `rotate(-90 ${CX} ${CY})`,
      'stroke-linecap': 'butt',
    })
    if (entry.share > 0) {
      sector.addEventListener('mousemove', (ev: MouseEvent) => {
        showTooltip(ev.clientX, ev.clientY, [
          `模型：${entry.model}`,
          `用量：${fmt(entry.tokens)} tokens`,
          `占比：${Math.round(entry.share * 100)}%`,
        ])
      })
      sector.addEventListener('mouseleave', hideTooltip)
      sector.style.cursor = 'pointer'
    }
    svg.append(sector)
    offset += dash
  })
  const totalText = svgEl('text', { x: CX, y: CY - 2, 'text-anchor': 'middle', 'font-size': 16, fill: '#e6edf3', 'font-weight': '650' })
  totalText.textContent = compact.format(total)
  svg.append(totalText)
  const totalLabel = svgEl('text', { x: CX, y: CY + 14, 'text-anchor': 'middle', 'font-size': 9, fill: '#6e7681' })
  totalLabel.textContent = '总 Tokens'
  svg.append(totalLabel)
  wrap.append(svg)

  // legend: every model with its share.
  const legend = div({ width: '100%', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '3px 14px', fontSize: '11px' })
  models.forEach((entry, i) => {
    const row = div({ display: 'flex', alignItems: 'center', gap: '6px', color: COLORS.muted })
    const dot = div({ width: '9px', height: '9px', borderRadius: '3px', background: MODEL_COLORS[i % MODEL_COLORS.length], flex: 'none' })
    const name = div({ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '130px' }, [entry.model])
    const pct = div({ marginLeft: 'auto', color: COLORS.text }, [`${Math.round(entry.share * 100)}%`])
    row.append(dot, name, pct)
    legend.append(row)
  })
  wrap.append(legend)
  return wrap
}

// ── update flow ────────────────────────────────────────────────────────────
function setUpdateText(text: string): void {
  if (ui.updateText !== null) {
    ui.updateText.textContent = text
    ui.updateText.style.color = updateState === 'latest' ? COLORS.green : updateState === 'error' ? COLORS.red : COLORS.muted
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
    if (r.status === 'error') {
      updateState = 'error'
      ui.updateBtn!.textContent = '重试'
      ui.updateBtn!.disabled = false
      setUpdateText(r.error ?? '检查更新失败。')
      return
    }
    if (!r.hasUpdate) {
      updateState = 'latest'
      ui.updateBtn!.textContent = '检查更新'
      ui.updateBtn!.disabled = false
      setUpdateText(`已是最新版本 v${r.current}`)
      return
    }
    updateState = 'available'
    updateResult = r
    ui.updateBtn!.textContent = '下载更新'
    ui.updateBtn!.disabled = false
    setUpdateText(`发现新版本 v${r.latest}（当前 v${r.current}）`)
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
