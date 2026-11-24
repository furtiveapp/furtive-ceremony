// Furtive trusted setup ceremony: the coordinator.
//
// It hands out turns one at a time, gives each contributor the latest key,
// takes their new key back and holds it until the public verifier (a GitHub
// Action anyone can read) has checked it. Only a checked key becomes the next
// "latest". The coordinator never sees anyone's randomness: that stays in the
// contributor's browser and is thrown away there.
//
//   GET  /state                  status, the public transcript, queue length
//   POST /join {name}            take a ticket in the queue
//   GET  /turn?ticket=           keep the ticket alive; says when it is your turn
//   GET  /zkey                   the latest accepted key (anyone may download it)
//   PUT  /contribute?ticket=     your new key, while it is your turn
//   GET  /result?ticket=         verifying, accepted or rejected
//   GET  /pending      (verifier) the key waiting to be checked
//   POST /verdict      (verifier) accept or reject it
//   POST /admin/init   (verifier) load the starting key, once
//   POST /admin/status (verifier) open or close the ceremony
//
// Secrets: VERIFIER_KEY (shared with the GitHub verifier), GH_TOKEN (optional,
// lets the coordinator start the verifier at once instead of waiting for its timer).
import { DurableObject } from 'cloudflare:workers'

const CHUNK = 1_900_000 // SQLite rows hold up to 2 MB
const MAX_ZKEY = 20_000_000
const TURN_MS = 10 * 60_000 // time to download, contribute and upload
const VERIFY_MS = 20 * 60_000 // time the verifier gets before the turn is dropped
const STALE_MS = 45_000 // a queued ticket not heard from in this long is dropped

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs (name TEXT NOT NULL, i INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (name, i));
CREATE TABLE IF NOT EXISTS contributions (n INTEGER PRIMARY KEY, name TEXT NOT NULL, hash TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS queue (ticket TEXT PRIMARY KEY, name TEXT NOT NULL, ip TEXT NOT NULL, joined INTEGER NOT NULL, seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS results (ticket TEXT PRIMARY KEY, n INTEGER NOT NULL, state TEXT NOT NULL, hash TEXT, at INTEGER NOT NULL);`

const json = (body, status = 200) => Response.json(body, { status })
const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} _.@-]/gu, '').trim().slice(0, 40) || 'anonymous'

export class Ceremony extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
    this.sql.exec(SCHEMA)
  }

  get(k, d = null) {
    const r = this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]
    return r ? JSON.parse(r.v) : d
  }
  set(k, v) {
    if (v === null) this.sql.exec('DELETE FROM meta WHERE k = ?', k)
    else this.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, JSON.stringify(v))
  }
  putBlob(name, bytes) {
    this.sql.exec('DELETE FROM blobs WHERE name = ?', name)
    for (let i = 0, at = 0; at < bytes.length; i++, at += CHUNK) this.sql.exec('INSERT INTO blobs (name, i, data) VALUES (?, ?, ?)', name, i, bytes.slice(at, at + CHUNK).buffer)
  }
  getBlob(name) {
    const rows = this.sql.exec('SELECT data FROM blobs WHERE name = ? ORDER BY i', name).toArray()
    if (!rows.length) return null
    const parts = rows.map((r) => new Uint8Array(r.data))
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
    let at = 0
    for (const p of parts) out.set(p, (at += p.length) - p.length)
    return out
  }
  moveBlob(from, to) {
    this.sql.exec('DELETE FROM blobs WHERE name = ?', to)
    this.sql.exec('UPDATE blobs SET name = ? WHERE name = ?', to, from)
  }
  count() {
    return this.sql.exec('SELECT COUNT(*) AS c FROM contributions').one().c
  }
  finish(ticket, n, state, hash) {
    this.sql.exec('INSERT OR REPLACE INTO results (ticket, n, state, hash, at) VALUES (?, ?, ?, ?, ?)', ticket, n, state, hash, Date.now())
  }

  // Drop dead tickets and turns that ran out of time; hand the next turn out.
  tidy(now) {
    this.sql.exec('DELETE FROM queue WHERE seen < ?', now - STALE_MS)
    const lease = this.get('lease')
    if (lease && lease.expires < now) {
      if (lease.phase === 'verifying') this.finish(lease.ticket, lease.n, 'rejected', null)
      this.sql.exec('DELETE FROM blobs WHERE name = ?', 'pending')
      this.set('lease', null)
    }
    if (!this.get('lease') && this.get('status') === 'open') {
      const next = this.sql.exec('SELECT ticket, name FROM queue ORDER BY joined LIMIT 1').toArray()[0]
      if (next) {
        this.sql.exec('DELETE FROM queue WHERE ticket = ?', next.ticket)
        this.set('lease', { ticket: next.ticket, name: next.name, n: this.count() + 1, phase: 'contributing', expires: now + TURN_MS })
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url)
    const now = Date.now()
    const route = `${request.method} ${url.pathname}`
    const ticket = url.searchParams.get('ticket') || ''
    const authed = this.env.VERIFIER_KEY && request.headers.get('authorization') === `Bearer ${this.env.VERIFIER_KEY}`

    if (route === 'GET /state') {
      this.tidy(now)
      const lease = this.get('lease')
      return json({
        status: this.get('status', 'setup'),
        contributions: this.sql.exec('SELECT n, name, hash, at FROM contributions ORDER BY n').toArray(),
        queue: this.sql.exec('SELECT COUNT(*) AS c FROM queue').one().c,
        busy: lease ? { n: lease.n, phase: lease.phase } : null,
        final: this.get('final'),
      })
    }

    if (route === 'POST /join') {
      if (this.get('status') !== 'open') return json({ error: 'The ceremony is not open right now.' }, 409)
      const { name } = await request.json().catch(() => ({}))
      const ip = request.headers.get('cf-connecting-ip') || ''
      this.sql.exec('DELETE FROM queue WHERE ip = ?', ip) // one place in line per connection
      const t = crypto.randomUUID()
      this.sql.exec('INSERT INTO queue (ticket, name, ip, joined, seen) VALUES (?, ?, ?, ?, ?)', t, cleanName(name), ip, now, now)
      this.tidy(now)
      return json({ ticket: t })
    }

    if (route === 'GET /turn') {
      this.sql.exec('UPDATE queue SET seen = ? WHERE ticket = ?', now, ticket)
      this.tidy(now)
      const lease = this.get('lease')
      if (lease?.ticket === ticket) return json({ turn: true, n: lease.n, phase: lease.phase, expires: lease.expires })
      const mine = this.sql.exec('SELECT joined FROM queue WHERE ticket = ?', ticket).toArray()[0]
      if (!mine) return json({ error: 'Your place in line ran out. Join again.' }, 404)
      const ahead = this.sql.exec('SELECT COUNT(*) AS c FROM queue WHERE joined < ?', mine.joined).one().c + (lease ? 1 : 0)
      return json({ turn: false, ahead })
    }

    if (route === 'GET /zkey') {
      const z = this.getBlob('latest')
      if (!z) return json({ error: 'Not started yet.' }, 404)
      return new Response(z, { headers: { 'content-type': 'application/octet-stream', 'x-contributions': String(this.count()), 'cache-control': 'no-store' } })
    }

    if (route === 'PUT /contribute') {
      this.tidy(now)
      const lease = this.get('lease')
      if (!lease || lease.ticket !== ticket || lease.phase !== 'contributing') return json({ error: 'It is not your turn, or your turn ran out.' }, 409)
      const bytes = new Uint8Array(await request.arrayBuffer())
      if (bytes.length < 1_000_000 || bytes.length > MAX_ZKEY) return json({ error: 'That file is not a contribution.' }, 400)
      this.putBlob('pending', bytes)
      const hash = String(request.headers.get('x-contribution-hash') || '').replace(/[^0-9a-f]/gi, '').slice(0, 128)
      this.set('lease', { ...lease, phase: 'verifying', claimed: hash, expires: now + VERIFY_MS })
      this.finish(ticket, lease.n, 'verifying', hash)
      if (this.env.GH_TOKEN && this.env.GH_REPO) this.ctx.waitUntil(dispatch(this.env))
      return json({ n: lease.n, state: 'verifying' })
    }

    if (route === 'GET /result') {
      const r = this.sql.exec('SELECT n, state, hash FROM results WHERE ticket = ?', ticket).toArray()[0]
      return r ? json(r) : json({ error: 'Unknown ticket.' }, 404)
    }

    // ---------- the verifier ----------
    if (!authed) return json({ error: 'Not found.' }, 404)

    if (route === 'GET /pending') {
      const lease = this.get('lease')
      const z = lease?.phase === 'verifying' ? this.getBlob('pending') : null
      if (!z) return new Response(null, { status: 204 })
      return new Response(z, { headers: { 'content-type': 'application/octet-stream', 'x-n': String(lease.n), 'x-name': encodeURIComponent(lease.name), 'x-claimed': lease.claimed || '' } })
    }

    if (route === 'POST /verdict') {
      const { n, ok, hash, reason } = await request.json()
      const lease = this.get('lease')
      if (!lease || lease.phase !== 'verifying' || lease.n !== n) return json({ error: 'Nothing waiting with that number.' }, 409)
      if (ok) {
        if (!/^[0-9a-f]{128}$/.test(hash)) return json({ error: 'Bad hash.' }, 400)
        this.moveBlob('pending', 'latest')
        this.sql.exec('INSERT INTO contributions (n, name, hash, at) VALUES (?, ?, ?, ?)', n, lease.name, hash, now)
        this.finish(lease.ticket, n, 'accepted', hash)
      } else {
        this.sql.exec('DELETE FROM blobs WHERE name = ?', 'pending')
        this.finish(lease.ticket, n, 'rejected', null)
        console.log(JSON.stringify({ rejected: n, reason }))
      }
      this.set('lease', null)
      this.tidy(now)
      return json({ ok: true })
    }

    if (route === 'POST /admin/init') {
      if (this.getBlob('latest')) return json({ error: 'Already started.' }, 409)
      this.putBlob('latest', new Uint8Array(await request.arrayBuffer()))
      this.set('status', 'closed')
      return json({ ok: true })
    }

    if (route === 'POST /admin/status') {
      const { status, final } = await request.json()
      if (!['open', 'closed', 'finished'].includes(status)) return json({ error: 'Bad status.' }, 400)
      this.set('status', status)
      if (final) this.set('final', final)
      return json({ ok: true })
    }

    return json({ error: 'Not found.' }, 404)
  }
}

async function dispatch(env) {
  await fetch(`https://api.github.com/repos/${env.GH_REPO}/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.GH_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'furtive-ceremony', 'content-type': 'application/json' },
    body: JSON.stringify({ event_type: 'contribution' }),
  }).catch(() => {})
}

function cors(request, env) {
  const origin = request.headers.get('origin') || ''
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim())
  return {
    'access-control-allow-origin': allowed.includes(origin) ? origin : allowed[0] || '',
    'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
    'access-control-allow-headers': 'content-type, x-contribution-hash',
    'access-control-expose-headers': 'x-contributions',
    vary: 'origin',
  }
}

export default {
  async fetch(request, env) {
    const headers = cors(request, env)
    if (request.method === 'OPTIONS') return new Response(null, { headers })
    const stub = env.CEREMONY.get(env.CEREMONY.idFromName('transact-v1'))
    const res = await stub.fetch(request)
    const out = new Response(res.body, res)
    for (const [k, v] of Object.entries(headers)) out.headers.set(k, v)
    return out
  },
}
