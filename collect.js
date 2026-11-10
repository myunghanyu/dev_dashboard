// Data collection: git repos under ~/develop, Claude Code sessions, GitHub Actions (gh CLI).
const fs = require('fs')
const os = require('os')
const path = require('path')
const readline = require('readline')
const { execFile, spawn } = require('child_process')

const HOME = os.homedir()
const DEV = process.env.DEV_DIR || path.join(HOME, 'develop')
const CLAUDE_PROJECTS = path.join(HOME, '.claude', 'projects')
// GUI-launched Electron has a minimal PATH
process.env.PATH = [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local/bin')].join(':')

const run = (cmd, args, cwd) => new Promise((resolve, reject) =>
  execFile(cmd, args, { cwd, maxBuffer: 64 << 20, timeout: 60000 }, (err, out, errOut) =>
    err ? reject(new Error((errOut || err.message).trim())) : resolve(out)))

let reposCache
async function repos() {
  if (reposCache) return reposCache
  const found = []
  for (const a of fs.existsSync(DEV) ? fs.readdirSync(DEV, { withFileTypes: true }) : []) {
    if (!a.isDirectory()) continue
    const p = path.join(DEV, a.name)
    if (fs.existsSync(path.join(p, '.git'))) { found.push(p); continue }
    for (const b of fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory())) {
      if (fs.statSync(path.join(p, b.name, '.git'), { throwIfNoEntry: false })?.isDirectory()) found.push(path.join(p, b.name))
    }
  }
  const [name, email] = await Promise.all([
    run('git', ['config', '--global', 'user.name']).catch(() => ''),
    run('git', ['config', '--global', 'user.email']).catch(() => ''),
  ])
  const authors = [name.trim(), email.trim()].filter(Boolean).flatMap(a => ['--author', a])
  reposCache = await Promise.all(found.map(async p => {
    const url = await run('git', ['remote', 'get-url', 'origin'], p).catch(() => '')
    const m = url.match(/github\.com[:/](.+?)(\.git)?\s*$/)
    return { path: p, name: path.relative(DEV, p), slug: m && m[1], authors }
  }))
  return reposCache
}

// ponytail: keyword heuristic, swap for LLM classification if it misfiles too much
const FIX = /^(fix|hotfix|bugfix)\b|\b(fix(es|ed)?|bug|hotfix|issue|crash)\b|수정|버그|오류|에러|해결|고침|문제/i
const FEAT = /^feat\b|\b(add(s|ed)?|feature|implement(ed)?|new|support)\b|추가|구현|기능|지원|신규|개발/i
function classify(subject) {
  const s = subject.replace(/^\[[^\]]*\]\s*/, '')
  if (/^fix|^hotfix/i.test(subject) || FIX.test(s)) return 'fix'
  if (/^feat/i.test(subject) || FEAT.test(s)) return 'feat'
  return 'other'
}
function featureOf(subject, ref) {
  const m = subject.match(/^\[([^\]]+)\]/) || subject.match(/^\w+\(([^)]+)\)!?:/)
  if (m) return m[1].trim()
  const br = (ref || '').replace(/^refs\/(heads|remotes\/[^/]+)\//, '')
  return br && !/^(main|master|develop|dev|HEAD)$/.test(br) && !br.startsWith('refs/') ? br : '기타'
}

function parseLog(out) {
  return out.split('\x1e').slice(1).map(rec => {
    const [hash, date, subject, body, ref, rest = ''] = rec.split('\x1f')
    const ins = +(rest.match(/(\d+) insertion/) || [0, 0])[1]
    const del = +(rest.match(/(\d+) deletion/) || [0, 0])[1]
    return { hash, date, subject, ref, ins, del, withClaude: /co-authored-by:.*claude/i.test(body),
      type: classify(subject), feature: featureOf(subject, ref) }
  })
}

const LOGFMT = '--format=%x1e%H%x1f%aI%x1f%s%x1f%b%x1f%S%x1f'

async function commits(since, until) {
  const all = await Promise.all((await repos()).map(async r => {
    const out = await run('git', ['log', '--all', '--no-merges', '--source', '--shortstat', ...r.authors,
      `--since=${since}`, `--until=${until}`, LOGFMT], r.path).catch(() => '')
    const seen = new Set()
    return parseLog(out).filter(c => !seen.has(c.hash) && seen.add(c.hash)).map(c => ({ ...c, repo: r.name }))
  }))
  const seen = new Set() // same repo cloned twice -> count once
  return all.flat().filter(c => !seen.has(c.hash) && seen.add(c.hash)).sort((a, b) => b.date.localeCompare(a.date))
}

function repoForCwd(cwd, list) {
  const r = list.filter(r => cwd === r.path || cwd.startsWith(r.path + '/')).sort((a, b) => b.path.length - a.path.length)[0]
  return r ? r.name : (cwd.startsWith(DEV) ? path.relative(DEV, cwd).split('/')[0] || '(develop)' : cwd)
}

async function sessions(since, until) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return []
  const list = await repos()
  const t0 = Date.parse(since), t1 = Date.parse(until)
  const files = (fs.existsSync(CLAUDE_PROJECTS) ? fs.readdirSync(CLAUDE_PROJECTS) : []).flatMap(d => {
    const dir = path.join(CLAUDE_PROJECTS, d)
    try { return fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => path.join(dir, f)) } catch { return [] }
  }).filter(f => fs.statSync(f).mtimeMs >= t0)
  const res = await Promise.all(files.map(async f => {
    const s = { id: path.basename(f, '.jsonl'), prompts: 0, title: '', start: null, end: null, cwd: '' }
    for await (const line of readline.createInterface({ input: fs.createReadStream(f) })) {
      if (!line.includes('"type":"user"')) continue
      let j; try { j = JSON.parse(line) } catch { continue }
      const c = j.message && j.message.content
      if (typeof c !== 'string' || j.isMeta || j.isSidechain) continue
      const t = Date.parse(j.timestamp)
      if (!(t >= t0 && t < t1)) continue
      s.prompts++
      s.cwd = s.cwd || j.cwd || ''
      s.start = s.start || j.timestamp
      s.end = j.timestamp
      if (!s.title && !c.startsWith('<')) s.title = c.replace(/\s+/g, ' ').slice(0, 100)
    }
    return s.prompts ? { ...s, repo: repoForCwd(s.cwd, list) } : null
  }))
  return res.filter(Boolean).sort((a, b) => b.end.localeCompare(a.end))
}

// No Co-Authored-By trailer? A commit made during (or <1h after) a Claude session in the same repo counts too.
function linkSessions(commits, sessions) {
  for (const c of commits) {
    const t = Date.parse(c.date)
    c.withClaude ||= sessions.some(s => s.repo === c.repo && t >= Date.parse(s.start) && t <= Date.parse(s.end) + 36e5)
  }
  return commits
}

// Current / recent work, independent of the selected period.
async function status() {
  const list = await repos()
  const monthAgo = new Date(Date.now() - 30 * 864e5).toISOString()
  const sess = await sessions(monthAgo, new Date(Date.now() + 864e5).toISOString())
  const rows = await Promise.all(list.map(async r => {
    const [last, branch, porcelain] = await Promise.all([
      run('git', ['log', '-1', '--all', ...r.authors, '--format=%aI%x1f%s'], r.path).catch(() => ''),
      run('git', ['branch', '--show-current'], r.path).catch(() => ''),
      run('git', ['status', '--porcelain'], r.path).catch(() => ''),
    ])
    const [lastDate, lastSubject] = last.trim().split('\x1f')
    const dirty = porcelain.split('\n').filter(Boolean)
    let dirtyAt = 0
    for (const l of dirty.slice(0, 200)) {
      const st = fs.statSync(path.join(r.path, l.slice(3).split(' -> ').pop()), { throwIfNoEntry: false })
      if (st && st.isFile()) dirtyAt = Math.max(dirtyAt, st.mtimeMs)
    }
    const s = sess.find(s => s.repo === r.name)
    const activity = Math.max(lastDate ? Date.parse(lastDate) : 0, dirtyAt, s ? Date.parse(s.end) : 0)
    return { name: r.name, slug: r.slug, branch: branch.trim(), dirty: dirty.length, lastDate, lastSubject,
      session: s && { title: s.title, end: s.end }, activity: activity ? new Date(activity).toISOString() : null }
  }))
  return rows.filter(r => r.activity).sort((a, b) => b.activity.localeCompare(a.activity))
}

async function actions(slugs) {
  return Promise.all(slugs.map(async slug => {
    try {
      const out = await run('gh', ['run', 'list', '-R', slug, '-L', '20', '--json',
        'status,conclusion,workflowName,headBranch,event,createdAt,url,displayTitle'])
      return { slug, runs: JSON.parse(out) }
    } catch (e) { return { slug, error: e.message.split('\n')[0] } }
  }))
}

// "[repo] - feature: summary (commits N, +a/-d)" one line per feature group.
function exportLines(list, label) {
  const groups = new Map()
  for (const c of list) {
    const k = c.repo + '\0' + c.feature
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k).push(c)
  }
  const lines = [...groups.values()].sort((a, b) => a[0].repo.localeCompare(b[0].repo)).map(cs => {
    const subj = [...new Set(cs.map(c => c.subject.replace(/^\[[^\]]*\]\s*|^\w+(\([^)]*\))?!?:\s*/, '')))]
    const ins = cs.reduce((n, c) => n + c.ins, 0), del = cs.reduce((n, c) => n + c.del, 0)
    const text = subj.length > 3 ? `${subj.slice(0, 3).join('; ')} 외 ${subj.length - 3}건` : subj.join('; ')
    if (cs[0].ticket) {
      const t = cs[0].ticket
      return `[${cs[0].repo}] - ${t.title} (${t.id} · ${TICKET_TYPE[t.type]} · ${TICKET_STATUS[t.status]}, 커밋 ${cs.length}, +${ins}/-${del})`
    }
    const feat = cs[0].feature === '기타' ? '' : `${cs[0].feature}: `
    return `[${cs[0].repo}] - ${feat}${text} (커밋 ${cs.length}, +${ins}/-${del})`
  })
  const ins = list.reduce((n, c) => n + c.ins, 0), del = list.reduce((n, c) => n + c.del, 0)
  const fix = list.filter(c => c.type === 'fix').length, feat = list.filter(c => c.type === 'feat').length
  return [`# ${label} 개발 이력`, `총 커밋 ${list.length} / 기능 ${feat} / 수정 ${fix} / +${ins} -${del} 라인`, '', ...lines].join('\n')
}

function summarize(prompt) {
  return new Promise((resolve, reject) => {
    const p = spawn('claude', ['-p', '--no-session-persistence']) // don't show up as a session
    let out = '', err = ''
    const timer = setTimeout(() => p.kill(), 180000)
    p.stdout.on('data', d => out += d)
    p.stderr.on('data', d => err += d)
    p.on('error', reject)
    p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(err || `claude exited ${code}`)) })
    p.stdin.end(prompt)
  })
}

// Plan usage, saved by statusline.sh whenever a Claude Code session refreshes its status line.
const USAGE_FILE = path.join(HOME, '.claude', 'dev-dashboard-usage.json')
function readUsage(file = USAGE_FILE, nowSec = Date.now() / 1000) {
  let j; try { j = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
  const win = x => {
    if (!x) return null
    const reset = x.resets_at && x.resets_at <= nowSec // window rolled over since the snapshot
    const used = reset ? 0 : Math.round(x.used_percentage)
    return { used, left: 100 - used, resetsAt: reset || !x.resets_at ? null : new Date(x.resets_at * 1000).toISOString() }
  }
  const rl = j.rate_limits || {}
  return { fiveHour: win(rl.five_hour), sevenDay: win(rl.seven_day), savedAt: new Date(j.saved_at * 1000).toISOString() }
}

// Local usage from session logs: per assistant message, input + output + cache-write tokens
// (cache reads excluded: huge and cheap). Deduped by message id; files cached by mtime+size.
// ponytail: approximation of plan usage, not the server's meter; budget is user-set.
const usageCache = new Map() // file -> { key, rows: [[id, ms, n]] }
function localUsage(nowMs = Date.now(), root = CLAUDE_PROJECTS) {
  const files = []
  const walk = d => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.jsonl')) files.push(p)
    }
  }
  walk(root)
  const seen = new Set(), sum = { fiveHour: 0, sevenDay: 0 }
  for (const f of files) {
    const st = fs.statSync(f, { throwIfNoEntry: false })
    if (!st || st.mtimeMs < nowMs - 7 * 864e5) continue
    const key = `${st.mtimeMs}:${st.size}`
    let c = usageCache.get(f)
    if (!c || c.key !== key) {
      const rows = []
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.includes('"usage"')) continue
        let j; try { j = JSON.parse(line) } catch { continue }
        const m = j.message, u = m && m.usage
        if (!u || !m.id) continue
        rows.push([m.id, Date.parse(j.timestamp), (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0)])
      }
      usageCache.set(f, c = { key, rows })
    }
    for (const [id, ms, n] of c.rows) {
      if (seen.has(id)) continue
      seen.add(id)
      const age = nowMs - ms
      if (age <= 7 * 864e5) sum.sevenDay += n
      if (age <= 5 * 36e5) sum.fiveHour += n
    }
  }
  return sum
}

const fmtTok = n => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n)
// One shape for the UI: real plan limits when Claude Code provides them, else local usage vs. the user's budget.
function usageView(budget = {}, plan = readUsage(), local = localUsage()) {
  const W = [['fiveHour', '5시간', '5h'], ['sevenDay', '주간', '주']]
  if (plan && (plan.fiveHour || plan.sevenDay)) return { source: 'plan', savedAt: plan.savedAt, windows: W.filter(([k]) => plan[k]).map(([k, name, short]) => (
    { name, short, left: plan[k].left, detail: `${plan[k].used}% 사용`, resetsAt: plan[k].resetsAt })) }
  return { source: 'local', windows: W.map(([k, name, short]) => {
    const used = local[k], b = budget[k]
    return b > 0
      ? { name, short, left: Math.max(0, Math.round(100 - used / b * 100)), detail: `${fmtTok(used)} / ${fmtTok(b)}` }
      : { name, short, left: null, detail: fmtTok(used) }
  }) }
}

// ---- tickets: branch per ticket, commit/push through the app ----
const TICKET_TYPE = { feat: 'feat', fix: 'fix', chore: 'chore', refactor: 'refactor' }
const TICKET_STATUS = { todo: '할 일', doing: '진행 중', pushed: '푸시됨', done: '완료' }
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40)
const branchName = t => `${TICKET_TYPE[t.type] ? t.type : 'chore'}/${t.id}${slug(t.title) ? '-' + slug(t.title) : ''}`

async function repoPath(name) {
  const r = (await repos()).find(r => r.name === name)
  if (!r) throw new Error(`레포를 찾을 수 없음: ${name}`)
  return r.path
}
const refExists = (p, ref) => run('git', ['rev-parse', '--verify', '--quiet', ref], p).then(() => true, () => false)
const currentBranch = async p => (await run('git', ['branch', '--show-current'], p)).trim()

// Creates the ticket branch without checking it out, so a dirty working tree is never touched.
async function createTicketBranch(repo, branch, base) {
  const p = await repoPath(repo)
  if (base && !/^[\w./-]+$/.test(base) || /^-/.test(base || '')) throw new Error(`잘못된 기준 브랜치: ${base}`)
  if (/^-/.test(branch)) throw new Error(`잘못된 브랜치 이름: ${branch}`)
  await run('git', ['check-ref-format', '--branch', branch], p).catch(() => { throw new Error(`잘못된 브랜치 이름: ${branch}`) })
  if (await refExists(p, `refs/heads/${branch}`)) throw new Error(`이미 있는 브랜치: ${branch}`)
  if (!base) for (const b of ['develop', 'main', 'master']) {
    if (await refExists(p, `refs/heads/${b}`) || await refExists(p, `refs/remotes/origin/${b}`)) { base = b; break }
  }
  base ||= await currentBranch(p)
  await run('git', ['fetch', 'origin', base], p).catch(() => {}) // offline / no remote: use local base
  const start = await refExists(p, `refs/remotes/origin/${base}`) ? `origin/${base}` : base
  await run('git', ['branch', '--no-track', branch, start], p)
  return { base, startSha: (await run('git', ['rev-parse', start], p)).trim() }
}
async function checkoutTicket(repo, branch) { await run('git', ['switch', branch], await repoPath(repo)) }
async function ticketChanges(repo) {
  const p = await repoPath(repo)
  return { branch: await currentBranch(p), files: (await run('git', ['status', '--porcelain'], p)).split('\n').filter(Boolean) }
}
async function commitTicket(repo, branch, message) {
  const p = await repoPath(repo), cur = await currentBranch(p)
  if (cur !== branch) throw new Error(`현재 브랜치가 ${cur} 입니다. 먼저 '작업 시작'으로 ${branch} 로 전환하세요.`)
  if (!message.trim()) throw new Error('커밋 메시지가 비었습니다.')
  await run('git', ['add', '-A'], p)
  return run('git', ['commit', '-m', message], p)
}
async function pushTicket(repo, branch) { return run('git', ['push', '-u', 'origin', branch], await repoPath(repo)) }
async function ticketStats(t) {
  try {
    const cs = parseLog(await run('git', ['log', '--no-merges', '--shortstat', LOGFMT, `${t.startSha}..refs/heads/${t.branch}`], await repoPath(t.repo)))
    return { commits: cs.length, ins: cs.reduce((n, c) => n + c.ins, 0), del: cs.reduce((n, c) => n + c.del, 0), last: cs[0] && cs[0].date }
  } catch { return { commits: 0, ins: 0, del: 0, gone: true } } // branch deleted
}
// Commit belongs to a ticket if its message carries the id, or it was reached via the ticket branch.
function linkTickets(commits, tickets) {
  for (const c of commits) {
    const id = (c.subject.match(/\bT-\d+\b/) || [])[0]
    const ref = (c.ref || '').replace(/^refs\/(heads|remotes\/[^/]+)\//, '')
    const t = tickets.find(t => t.repo === c.repo && (t.id === id || t.branch === ref))
    if (t) Object.assign(c, { ticket: t, feature: `${t.id} ${t.title}`, type: t.type })
  }
  return commits
}

// ---- root cause of a fix: blame the lines the fix changed (SZZ) ----
// "git show -U0" -> old-side ranges the fix touched. Pure additions (count 0) blame the line above.
function parseHunks(diff) {
  const out = []; let file = null
  for (const l of diff.split('\n')) {
    if (l.startsWith('--- ')) file = l === '--- /dev/null' ? null : l.slice(6) // "--- a/path"
    const m = file && l.match(/^@@ -(\d+)(?:,(\d+))? \+/)
    if (!m) continue
    const start = +m[1], count = m[2] == null ? 1 : +m[2]
    if (count) out.push({ file, start, count })
    else if (start > 0) out.push({ file, start, count: 1 })
  }
  return out
}
// Candidate commits that introduced what a fix ticket changed, most-blamed first.
// "Fixes: <sha>" in a fix commit message is taken as given.
// ponytail: SZZ heuristic; reformat/rename commits can show up as false culprits
const ticketCulprits = async (t, tickets) => culprits(await repoPath(t.repo), `${t.startSha}..refs/heads/${t.branch}`, t.repo, tickets)
async function culprits(p, range, repo, tickets) {
  const fixes = (await run('git', ['rev-list', '--no-merges', range], p)).split('\n').filter(Boolean)
  const own = new Set(fixes), lines = new Map(), explicit = new Set()
  for (const sha of fixes) {
    const msg = await run('git', ['show', '-s', '--format=%B', sha], p)
    for (const m of msg.matchAll(/^Fixes:\s*([0-9a-f]{7,40})/gim)) {
      const full = (await run('git', ['rev-parse', '--verify', '--quiet', m[1] + '^{commit}'], p).catch(() => '')).trim()
      if (full) explicit.add(full)
    }
    for (const h of parseHunks(await run('git', ['show', '-U0', '--no-color', '--format=', sha], p))) {
      const out = await run('git', ['blame', '-w', '--porcelain', '-L', `${h.start},+${h.count}`, `${sha}^`, '--', h.file], p).catch(() => '')
      for (const m of out.matchAll(/^([0-9a-f]{40}) \d+ \d+/gm)) if (!own.has(m[1])) lines.set(m[1], (lines.get(m[1]) || 0) + 1)
    }
  }
  const hashes = [...explicit, ...[...lines.keys()].filter(h => !explicit.has(h)).sort((a, b) => lines.get(b) - lines.get(a))].slice(0, 5)
  if (!hashes.length) return []
  const cs = linkTickets(parseLog(await run('git', ['log', '--no-walk=unsorted', '--shortstat', LOGFMT.replace('%S%x1f', '%an%x1f'), ...hashes], p)).map(c => ({ ...c, author: c.ref, ref: '', repo })), tickets)
  return cs.map(c => ({ hash: c.hash, subject: c.subject, date: c.date, author: c.author, withClaude: c.withClaude,
    ticket: c.ticket && c.ticket.id, lines: lines.get(c.hash) || 0, explicit: explicit.has(c.hash) }))
}

// ---- release PR: develop/dev -> main/master, everyone's commits ----
const RELEASE_GROUPS = [['feat', '✨ Features'], ['fix', '🐛 Fixes'], ['refactor', '♻️ Refactor'], ['other', '🧹 Chore / 기타']]
function releaseType(c) {
  if (c.ticket) return c.ticket.type === 'chore' ? 'other' : c.ticket.type
  const m = c.subject.replace(/^\[[^\]]*\]\s*/, '').match(/^(\w+)(\([^)]*\))?!?:/)
  if (m) return ['feat', 'fix', 'refactor'].includes(m[1].toLowerCase()) ? m[1].toLowerCase() : 'other'
  return classify(c.subject)
}
// "feat(auth): x" -> "auth: x"; bracket scopes like "[mbe] x" stay as written
const releaseLine = c => {
  const scoped = /^\w+\([^)]*\)!?:/.test(c.subject)
  const subj = scoped ? c.subject.replace(/^\w+\(([^)]*)\)!?:\s*/, '$1: ') : c.subject.replace(/^\w+!?:\s*/, '')
  const tid = c.ticket && !c.subject.includes(c.ticket.id) ? `[${c.ticket.id}] ` : ''
  return `- ${tid}${subj} (${c.hash.slice(0, 7)})`
}
function releaseBody({ head, base, commits, prs, diffstat }) {
  if (!commits.length) return `${head} 에 ${base} 로 배포할 새 커밋이 없습니다.`
  const authors = [...new Set(commits.map(c => c.author))]
  const out = [`## 🚀 Release: ${head} → ${base}`, '', `- 커밋 ${commits.length}개 · 작성자 ${authors.join(', ')}`]
  if (diffstat) out.push(`- 변경: ${diffstat}`)
  for (const [type, title] of RELEASE_GROUPS) {
    const cs = commits.filter(c => releaseType(c) === type)
    if (cs.length) out.push('', `### ${title}`, ...cs.map(releaseLine))
  }
  if (prs.length) out.push('', '### 포함된 PR', ...prs.map(pr => `- #${pr.number} ${pr.branch}${pr.title ? ` — ${pr.title}` : ''}`))
  return out.join('\n')
}
function parseMerges(out) {
  return out.split('\x1e').map(r => r.trim()).filter(Boolean).map(r => {
    const [subject, body = ''] = r.split('\x1f')
    const m = subject.match(/^Merge pull request #(\d+) from [^/\s]+\/(\S+)/)
    return m && { number: +m[1], branch: m[2], title: body.trim().split('\n')[0] }
  }).filter(Boolean)
}
async function releaseDraft(repo, tickets = []) {
  const p = await repoPath(repo), slug = (await repos()).find(r => r.name === repo).slug
  await run('git', ['fetch', 'origin', '--prune', '--quiet'], p).catch(() => {})
  const pick = async names => { for (const n of names) if (await refExists(p, `refs/remotes/origin/${n}`)) return n }
  const head = await pick(['develop', 'dev']), base = await pick(['main', 'master'])
  if (!head || !base) throw new Error('origin 에 develop(또는 dev) 와 main(또는 master) 브랜치가 모두 있어야 합니다.')
  const range = `origin/${base}..origin/${head}`
  const [log, merges, diffstat] = await Promise.all([
    run('git', ['log', '--no-merges', '--shortstat', '--format=%x1e%H%x1f%aI%x1f%s%x1f%b%x1f%aN%x1f', range], p),
    run('git', ['log', '--merges', '--format=%s%x1f%b%x1e', range], p),
    run('git', ['diff', '--shortstat', `origin/${base}...origin/${head}`], p),
  ])
  // author rides in the ref slot of LOGFMT's layout
  const commits = linkTickets(parseLog(log).map(c => ({ ...c, author: c.ref, ref: '', repo })), tickets)
  const prs = parseMerges(merges)
  const date = new Date().toISOString().slice(0, 10)
  const openPr = slug ? await run('gh', ['pr', 'list', '-R', slug, '--base', base, '--head', head, '--state', 'open', '--json', 'number,url,title'])
    .then(o => JSON.parse(o)[0] || null, () => null) : null
  return { repo, slug, head, base, count: commits.length, openPr,
    title: `Release ${date}: ${head} → ${base}`, body: releaseBody({ head, base, commits, prs, diffstat: diffstat.trim() }) }
}
async function createReleasePR({ repo, base, head, title, body }) {
  const slug = (await repos()).find(r => r.name === repo)?.slug
  if (!slug) throw new Error('GitHub 원격이 없는 레포입니다.')
  if (![base, head].every(b => /^[\w./-]+$/.test(b) && !b.startsWith('-'))) throw new Error('잘못된 브랜치')
  return (await run('gh', ['pr', 'create', '-R', slug, '--base', base, '--head', head, '--title', title, '--body', body])).trim()
}

module.exports = { culprits, ticketCulprits, parseHunks, localUsage, usageView, releaseDraft, createReleasePR, USAGE_FILE, readUsage, TICKET_STATUS, branchName, createTicketBranch, checkoutTicket, ticketChanges, commitTicket, pushTicket, ticketStats, linkTickets, linkSessions, repos, commits, sessions, status, actions, exportLines, summarize }

if (require.main === module) (async () => {
  const assert = require('assert')
  assert.equal(classify('[mbe] submodule update'), 'other')
  assert.equal(classify('fix(api): null deref'), 'fix')
  assert.equal(classify('[ssm] 시험용 ssm.ini 기능 추가'), 'feat')
  assert.equal(classify('[ui] 버그 수정'), 'fix')
  assert.deepEqual(parseHunks('--- a/x.js\n+++ b/x.js\n@@ -3,2 +3,2 @@\n@@ -10 +10 @@\n@@ -20,0 +21,4 @@\n@@ -0,0 +1 @@\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,9 @@\n'),
    [{ file: 'x.js', start: 3, count: 2 }, { file: 'x.js', start: 10, count: 1 }, { file: 'x.js', start: 20, count: 1 }])
  { // culprits: the fix edits a line from "bad", so "bad" is blamed, not "other" or the fix itself
    const g = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-szz-'))
    const git = (...a) => run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], g)
    const commit = async (file, text, msg) => { fs.writeFileSync(path.join(g, file), text); await git('add', '-A'); await git('commit', '-qm', msg); return (await git('rev-parse', 'HEAD')).trim() }
    await git('init', '-q')
    await commit('a.js', 'one\ntwo\nthree\n', 'init')
    const bad = await commit('a.js', 'one\nTWO_BUG\nthree\n', 'feat: T-7 two')
    const other = await commit('b.js', 'x\n', 'chore: other')
    await commit('a.js', 'one\nTWO\nthree\n', 'fix: two')
    let cs = await culprits(g, `${other}..HEAD`, 'r', [{ id: 'T-7', repo: 'r', type: 'feat' }])
    assert.deepEqual(cs.map(c => [c.hash, c.lines, c.explicit, c.ticket, c.author]), [[bad, 1, false, 'T-7', 't']])
    await commit('b.js', 'y\n', `fix: b\n\nFixes: ${other.slice(0, 8)}`)
    cs = await culprits(g, `${other}..HEAD`, 'r', [])
    assert.deepEqual(cs.map(c => [c.hash, c.explicit]), [[other, true], [bad, false]])
    fs.rmSync(g, { recursive: true })
  }
  assert.equal(featureOf('[mbe] x', ''), 'mbe')
  assert.equal(featureOf('feat(auth): x', ''), 'auth')
  assert.equal(featureOf('wip', 'refs/heads/feat/mbe'), 'feat/mbe')
  assert.equal(featureOf('wip', 'refs/heads/main'), '기타')
  assert.equal(linkSessions([{ repo: 'a', date: '2026-01-01T01:30:00Z' }, { repo: 'b', date: '2026-01-01T01:30:00Z' }],
    [{ repo: 'a', start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' }]).map(c => c.withClaude).join(), 'true,false')
  assert.equal(branchName({ id: 'T-3', type: 'fix', title: 'Login crash 수정' }), 'fix/T-3-login-crash')
  assert.equal(branchName({ id: 'T-4', type: 'feat', title: '국내 판매' }), 'feat/T-4')
  assert.equal(branchName({ id: 'T-5', type: 'refactor', title: 'Split service' }), 'refactor/T-5-split-service')
  const tk = [{ id: 'T-3', repo: 'a', branch: 'fix/T-3-x', title: 'X', type: 'fix', status: 'doing' }]
  const linked = linkTickets([{ repo: 'a', subject: '[T-3] wip', ref: 'refs/heads/main' }, { repo: 'a', subject: 'more', ref: 'refs/heads/fix/T-3-x' },
    { repo: 'b', subject: '[T-3] other repo', ref: '' }, { repo: 'a', subject: 'unrelated', ref: 'refs/heads/main' }], tk)
  assert.deepEqual(linked.map(c => c.feature), ['T-3 X', 'T-3 X', undefined, undefined])
  assert.match(exportLines(linked.slice(0, 2).map(c => ({ ...c, ins: 1, del: 0 })), 'w'), /\[a\] - X \(T-3 · fix · 진행 중, 커밋 2, \+2\/-0\)/)
  const uf = path.join(os.tmpdir(), 'dd-usage-test.json')
  fs.writeFileSync(uf, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 32.4, resets_at: 1000 }, seven_day: { used_percentage: 61, resets_at: 5000 } }, saved_at: 900 }))
  const u = readUsage(uf, 2000)
  assert.deepEqual([u.fiveHour.used, u.fiveHour.left, u.fiveHour.resetsAt, u.sevenDay.left], [0, 100, null, 39]) // 5h window already reset
  assert.equal(readUsage(uf + '.missing'), null)
  // local usage: dedupe by message id, windows, cache reads excluded
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-local-')), T0 = Date.parse('2026-01-08T00:00:00Z')
  const msg = (id, hoursAgo, i, o, cw, cr) => JSON.stringify({ timestamp: new Date(T0 - hoursAgo * 36e5).toISOString(),
    message: { id, usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: cw, cache_read_input_tokens: cr } } })
  fs.writeFileSync(path.join(ud, 's.jsonl'), [msg('a', 1, 10, 20, 30, 999), msg('a', 1, 10, 20, 30, 999), msg('b', 24, 100, 0, 0, 0), msg('c', 24 * 8, 5000, 0, 0, 0)].join('\n'))
  fs.utimesSync(path.join(ud, 's.jsonl'), T0 / 1000, T0 / 1000)
  assert.deepEqual(localUsage(T0, ud), { fiveHour: 60, sevenDay: 160 })
  const v1 = usageView({ fiveHour: 120 }, null, { fiveHour: 60, sevenDay: 160 })
  assert.deepEqual(v1.windows.map(w => [w.left, w.detail]), [[50, '60 / 120'], [null, '160']])
  assert.equal(usageView({}, { fiveHour: { used: 30, left: 70 }, savedAt: 'x' }, {}).source, 'plan')
  console.log('local usage now:', JSON.stringify(localUsage()))
  const rb = releaseBody({ head: 'develop', base: 'main', diffstat: '3 files changed, 10 insertions(+)', prs: parseMerges('Merge pull request #12 from org/feat/x\x1fAdd X\n\x1e'),
    commits: [{ subject: 'feat(auth): login', hash: 'aaaaaaa1', author: 'a' }, { subject: '[ui] 버그 수정', hash: 'bbbbbbb2', author: 'b' },
      { subject: 'refactor: split', hash: 'ccccccc3', author: 'a' }, { subject: 'wip', hash: 'ddddddd4', author: 'a', ticket: { id: 'T-9', type: 'chore' } }] })
  assert.match(rb, /### ✨ Features\n- auth: login \(aaaaaaa\)/)
  assert.match(rb, /### 🐛 Fixes\n- \[ui\] 버그 수정 \(bbbbbbb\)/)
  assert.match(rb, /### ♻️ Refactor\n- split \(ccccccc\)/)
  assert.match(rb, /### 🧹 Chore \/ 기타\n- \[T-9\] wip \(ddddddd\)/)
  assert.match(rb, /### 포함된 PR\n- #12 feat\/x — Add X/)
  assert.match(rb, /작성자 a, b/)
  const p = parseLog('\x1eabc\x1f2026-01-01T00:00:00Z\x1f[a] fix bug\x1fCo-Authored-By: Claude <x>\x1frefs/heads/main\x1f\n\n 2 files changed, 10 insertions(+), 3 deletions(-)\n')
  assert.deepEqual([p[0].ins, p[0].del, p[0].withClaude, p[0].type, p[0].feature], [10, 3, true, 'fix', 'a'])
  const since = new Date(Date.now() - 7 * 864e5).toISOString(), until = new Date().toISOString()
  const [c, s, st] = await Promise.all([commits(since, until), sessions(since, until), status()])
  console.log(`repos=${(await repos()).length} commits(7d)=${c.length} sessions(7d)=${s.length} current=${st[0] && st[0].name}`)
  console.log(exportLines(c, '최근 7일'))
  console.log('ok')
})()
