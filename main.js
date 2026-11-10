const { app, BrowserWindow, ipcMain, clipboard, dialog, shell, Tray, Menu, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')
const c = require('./collect')

// same store for `npm start` and the installed app; --user-data-dir overrides (tests)
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', path.join(app.getPath('appData'), 'dev-dashboard'))

ipcMain.handle('history', async (_, since, until) => {
  const [commits, sessions] = await Promise.all([c.commits(since, until), c.sessions(since, until)])
  return { commits: c.linkTickets(c.linkSessions(commits, sessions), readTickets().tickets), sessions }
})
// repo -> 'FE' | 'BE' | 'Module' | 'Toy'
const CATS = () => path.join(app.getPath('userData'), 'categories.json')
const readCats = () => { try { return JSON.parse(fs.readFileSync(CATS(), 'utf8')) } catch { return {} } }
ipcMain.handle('categories', readCats)
ipcMain.handle('setCategory', (_, repo, cat) => {
  const cats = readCats()
  if (['FE', 'BE', 'Module', 'Toy'].includes(cat)) cats[repo] = cat; else delete cats[repo]
  fs.writeFileSync(CATS(), JSON.stringify(cats, null, 2))
  return cats
})
// tickets: { seq, tickets: [{ id, repo, type, title, desc, branch, base, startSha, status, createdAt }] }
const TICKETS = () => path.join(app.getPath('userData'), 'tickets.json')
const readTickets = () => { try { return JSON.parse(fs.readFileSync(TICKETS(), 'utf8')) } catch { return { seq: 0, tickets: [] } } }
const saveTickets = db => fs.writeFileSync(TICKETS(), JSON.stringify(db, null, 2))
ipcMain.handle('ticket', async (_, action, arg = {}) => {
  const db = readTickets()
  const t = db.tickets.find(t => t.id === arg.id)
  if (action !== 'list' && action !== 'create' && !t) throw new Error(`티켓 없음: ${arg.id}`)
  switch (action) {
    case 'list':
      return Promise.all(db.tickets.map(async t => ({ ...t, stats: await c.ticketStats(t) })))
    case 'create': {
      if (!arg.repo || !arg.title?.trim()) throw new Error('레포와 제목은 필수입니다.')
      const nt = { id: `T-${db.seq + 1}`, repo: arg.repo, type: ['feat', 'fix', 'chore', 'refactor'].includes(arg.type) ? arg.type : 'chore',
        title: arg.title.trim(), desc: (arg.desc || '').trim(), status: 'todo', createdAt: new Date().toISOString() }
      const br = (arg.branch || '').trim()
      if (!br.startsWith(nt.type + '/') || br.length <= nt.type.length + 1) throw new Error(`브랜치는 ${nt.type}/이름 형식이어야 합니다.`)
      nt.branch = br
      Object.assign(nt, await c.createTicketBranch(nt.repo, nt.branch, (arg.base || '').trim()))
      db.seq++; db.tickets.unshift(nt); saveTickets(db)
      return nt
    }
    case 'start':
      await c.checkoutTicket(t.repo, t.branch)
      if (t.status === 'todo') t.status = 'doing'
      break
    case 'changes':
      return c.ticketChanges(t.repo)
    case 'culprits':
      return c.ticketCulprits(t, db.tickets)
    case 'commit':
      await c.commitTicket(t.repo, t.branch, arg.message || '')
      if (t.status === 'todo') t.status = 'doing'
      break
    case 'push':
      await c.pushTicket(t.repo, t.branch)
      t.status = 'pushed'
      break
    case 'status':
      if (!c.TICKET_STATUS[arg.status]) throw new Error(`잘못된 상태: ${arg.status}`)
      t.status = arg.status
      break
    case 'delete': // keeps the git branch; only forgets the ticket
      db.tickets = db.tickets.filter(x => x !== t)
      break
    default: throw new Error(`unknown action ${action}`)
  }
  saveTickets(db)
  return true
})
ipcMain.handle('status', () => c.status())
ipcMain.handle('actions', (_, slugs) => c.actions(slugs))
ipcMain.handle('summarize', (_, prompt) => c.summarize(prompt))
ipcMain.handle('export', async (e, commits, label) => {
  const text = c.exportLines(commits, label)
  clipboard.writeText(text)
  const { filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender), {
    defaultPath: `dev-log-${label.replace(/[^\w-]+/g, '_')}.md`,
  })
  if (filePath) fs.writeFileSync(filePath, text)
  return { text, filePath }
})

ipcMain.handle('release', (_, repo) => c.releaseDraft(repo, readTickets().tickets))
ipcMain.handle('releaseCreate', (_, arg) => c.createReleasePR(arg))
// usage budget (local mode): { fiveHour, sevenDay } in tokens
const BUDGET = () => path.join(app.getPath('userData'), 'budget.json')
const readBudget = () => { try { return JSON.parse(fs.readFileSync(BUDGET(), 'utf8')) } catch { return {} } }
const usage = () => c.usageView(readBudget())
ipcMain.handle('usage', usage)
ipcMain.handle('budget', readBudget)
ipcMain.handle('setBudget', (_, b) => {
  const clean = {}
  for (const k of ['fiveHour', 'sevenDay']) if (Number(b[k]) > 0) clean[k] = Math.round(Number(b[k]))
  fs.writeFileSync(BUDGET(), JSON.stringify(clean, null, 2))
  updateTray()
  return usage()
})

// Menu-bar "battery": remaining % per window (plan limits if available, else local usage vs. budget).
let tray
const hm = iso => iso ? new Date(iso).toLocaleString('ko-KR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '-'
function updateTray() {
  const u = usage()
  tray.setTitle(u.windows.map(w => `${w.short} ${w.left != null ? w.left + '%' : w.detail}`).join(' · '))
  const line = w => ({ label: `${w.name}: ${w.left != null ? `${w.left}% 남음 · ` : ''}${w.detail}${w.resetsAt ? ` · 리셋 ${hm(w.resetsAt)}` : ''}`, enabled: false })
  tray.setContextMenu(Menu.buildFromTemplate([
    ...u.windows.map(line),
    { label: u.source === 'plan' ? 'Claude 플랜 한도 기준' : '로컬 세션 기록 기준 (직접 정한 한도 대비, 캐시 읽기 제외)', enabled: false },
    { type: 'separator' },
    { label: '대시보드 열기', click: showWindow },
    { label: '종료', role: 'quit' },
  ]))
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400, height: 900, backgroundColor: '#1a1a19', title: 'Dev Dashboard', icon: path.join(__dirname, 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), zoomFactor: 1.15 }, // ponytail: global zoom instead of re-sizing every px font
  })
  win.loadFile(path.join(__dirname, 'index.html'))
  win.webContents.setWindowOpenHandler(({ url }) => { // run links -> default browser
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
}
const showWindow = () => { const w = BrowserWindow.getAllWindows()[0]; w ? w.show() : createWindow() }

app.whenReady().then(() => {
  if (app.dock) app.dock.setIcon(path.join(__dirname, 'icon.png'))
  createWindow()
  tray = new Tray(nativeImage.createEmpty())
  updateTray()
  setInterval(updateTray, 60000)
  require('fs').watchFile(c.USAGE_FILE, { interval: 5000 }, updateTray)
})
// stay in the menu bar when the window is closed (macOS); quit from the tray menu
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', showWindow)
