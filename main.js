const { app, BrowserWindow, ipcMain, clipboard, dialog, shell, Tray, Menu, nativeImage } = require('electron')
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')
const { randomUUID } = require('crypto')
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
// tickets: { seq, tickets: [{ id, repo, type, title, desc, note, images, branch, base, startSha, status, createdAt }] }
const TICKETS = () => path.join(app.getPath('userData'), 'tickets.json')
const readTickets = () => { try { return JSON.parse(fs.readFileSync(TICKETS(), 'utf8')) } catch { return { seq: 0, tickets: [] } } }
const IMGDIR = id => path.join(app.getPath('userData'), 'ticket-images', id)
const IMG_EXT = ['png', 'jpg', 'gif', 'webp']
const saveTickets = db => fs.writeFileSync(TICKETS(), JSON.stringify(db, null, 2))

// Claude inside the app (no Terminal): `claude -p` streams JSON into the ticket's chat; follow-ups resume t.sid.
// runs[ticketId] = { busy, items: [{ t: 'me'|'text'|'tool'|'end'|'err', s }], proc } — in memory; after a restart the chat resumes t.sid.
const runs = {}
const emit = (id, item) => BrowserWindow.getAllWindows().forEach(w => w.webContents.send('claude', id, item))
const brief = i => i.command || i.file_path || i.pattern || i.description || i.url || JSON.stringify(i).slice(0, 120)
async function runClaude(t, fresh, text) {
  const r = runs[t.id] ||= { items: [] }
  if (r.busy) throw new Error('Claude가 아직 작업 중입니다. 끝나거나 중지한 뒤 보내세요.')
  // ponytail: permission mode 'auto' (risky actions get denied, Claude says so) — the app can't answer prompts
  const proc = spawn('claude', ['-p', fresh ? '--session-id' : '--resume', t.sid, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'auto', '--max-turns', '30'], { cwd: await c.repoPath(t.repo) })
  Object.assign(r, { busy: true, proc })
  const add = item => { r.items.push(item); emit(t.id, item) }
  add({ t: 'me', s: fresh ? `${t.id} 작업 시작` : text })
  proc.stdin.end(fresh ? `[${t.id}] ${t.title}\n\n${t.desc}${t.note ? `\n\n메모:\n${t.note}` : ''}${t.images?.length ? `\n\n첨부 이미지 (Read 도구로 확인하세요):\n${t.images.map(n => path.join(IMGDIR(t.id), n)).join('\n')}` : ''}\n\n지금 체크아웃된 브랜치 ${t.branch} 에서 작업하세요. 커밋은 하지 마세요(앱에서 커밋합니다).` : text)
  let buf = '', err = '', ended = false
  proc.stdout.on('data', d => {
    const lines = (buf + d).split('\n'); buf = lines.pop()
    for (const l of lines) {
      let ev; try { ev = JSON.parse(l) } catch { continue }
      if (ev.type === 'assistant') for (const x of ev.message?.content || []) {
        if (x.type === 'text' && x.text.trim()) add({ t: 'text', s: x.text })
        if (x.type === 'tool_use') add({ t: 'tool', s: `${x.name} · ${brief(x.input || {})}` })
      }
      if (ev.type === 'result') { ended = true; add(ev.subtype === 'error_max_turns' ? { t: 'err', s: '턴 상한(30)에 도달해 멈췄습니다. 이어서 말하면 계속합니다.' } : ev.is_error ? { t: 'err', s: ev.result || '오류로 끝났습니다.' } : { t: 'end', s: '' }) }
    }
  })
  proc.stderr.on('data', d => { err = (err + d).slice(-2000) })
  proc.on('error', e => { err = e.message })
  proc.on('close', code => {
    r.busy = false; r.proc = null
    if (!ended) add({ t: 'err', s: code === null ? '중지했습니다.' : err.trim() || `종료 코드 ${code}` })
  })
  return true
}
ipcMain.handle('ticket', async (_, action, arg = {}) => {
  const db = readTickets()
  const t = db.tickets.find(t => t.id === arg.id)
  if (action !== 'list' && action !== 'create' && !t) throw new Error(`티켓 없음: ${arg.id}`)
  switch (action) {
    case 'list':
      return Promise.all(db.tickets.map(async t => ({ ...t, stats: await c.ticketStats(t), running: !!runs[t.id]?.busy })))
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
    case 'claude':
      return c.openClaude(t.repo)
    case 'ask': { // checkout + 진행 중 + start Claude in the app
      if (runs[t.id]?.busy) throw new Error('Claude가 아직 작업 중입니다.')
      await c.checkoutTicket(t.repo, t.branch)
      const fresh = !t.sid
      t.sid ||= randomUUID(); t.status = 'doing'; saveTickets(db)
      return runClaude(t, fresh, '이어서 작업해 주세요.')
    }
    case 'say':
      if (!t.sid) throw new Error("이 티켓의 Claude 세션이 없습니다. 먼저 'Claude에게 시키기'를 누르세요.")
      return runClaude(t, false, arg.text || '')
    case 'run':
      return runs[t.id] ? { busy: runs[t.id].busy, items: runs[t.id].items } : null
    case 'stop':
      runs[t.id]?.proc?.kill(); return true
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
    case 'prDraft':
      return c.ticketPRDraft(t)
    case 'pr': // base comes from ticketPRDraft (develop > dev > main > master)
      if (!['develop', 'dev', 'main', 'master'].includes(arg.base)) throw new Error('develop · dev · main · master 로만 PR 을 올릴 수 있습니다.')
      if (!arg.title?.trim()) throw new Error('제목은 필수입니다.')
      t.pr = await c.createReleasePR({ repo: t.repo, base: arg.base, head: t.branch, title: arg.title.trim(), body: arg.body || '' })
      saveTickets(db)
      return t.pr
    case 'status':
      if (!c.TICKET_STATUS[arg.status]) throw new Error(`잘못된 상태: ${arg.status}`)
      t.status = arg.status
      break
    case 'edit':
      if (!arg.title?.trim()) throw new Error('제목은 필수입니다.')
      t.title = arg.title.trim(); t.desc = String(arg.desc || '').trim(); t.note = String(arg.note || '').trim()
      break
    case 'images': // data URLs: CSP blocks file:// images
      return (t.images || []).map(n => ({ name: n, url: `data:image/${path.extname(n).slice(1).replace('jpg', 'jpeg')};base64,` + fs.readFileSync(path.join(IMGDIR(t.id), n)).toString('base64') }))
    case 'addImage': {
      const ext = (arg.type || '').split('/')[1]?.replace('jpeg', 'jpg')
      if (!IMG_EXT.includes(ext)) throw new Error('png/jpg/gif/webp 이미지만 첨부할 수 있습니다.')
      const n = `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`
      fs.mkdirSync(IMGDIR(t.id), { recursive: true })
      fs.writeFileSync(path.join(IMGDIR(t.id), n), Buffer.from(arg.data, 'base64'))
      ;(t.images ||= []).push(n)
      break
    }
    case 'delImage':
      if (!t.images?.includes(arg.name)) throw new Error('이미지 없음')
      fs.rmSync(path.join(IMGDIR(t.id), arg.name), { force: true })
      t.images = t.images.filter(n => n !== arg.name)
      break
    case 'delete': // keeps the git branch; only forgets the ticket
      db.tickets = db.tickets.filter(x => x !== t)
      fs.rmSync(IMGDIR(t.id), { recursive: true, force: true })
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
