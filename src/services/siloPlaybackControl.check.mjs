// Self-check for Silo's playback control lane and the session hooks that drive it:
//   node --conditions=browser src/services/siloPlaybackControl.check.mjs
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { stubUnloadable } from '../../scripts/stubUnloadable.mjs'

stubUnloadable()
// The socket opener reaches the platform code; here it opens the fake WebSocket below.
registerHooks({
  resolve(spec, ctx, next) {
    if (/\/siloSocket(\.js)?$/.test(spec)) {
      return { url: 'data:text/javascript,' + encodeURIComponent('export const openSiloSocket = async (url, protocols) => new WebSocket(url, protocols)'), shortCircuit: true }
    }
    return next(spec, ctx)
  },
})

const { endSiloPlaybackControl, followSiloPlaybackControl, resetSiloPlaybackControl, setSiloPlaybackControlHandlers, siloPlaybackControlMessage } =
  await import('./siloPlaybackControl.js')
const { createSiloPlayback } = await import('./siloPlayback.js')
const { siloItemMediaSources } = await import('./siloMediaSources.js')

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve() // eslint-disable-line no-await-in-loop
}

// Timers wait until the check runs them.
let timers = []
globalThis.setTimeout = (fn) => timers.push(fn)
globalThis.clearTimeout = (id) => { if (id) timers[id - 1] = null }
const runTimers = async () => {
  const due = timers
  timers = []
  due.forEach((fn) => fn && fn())
  await flush()
}

let sockets = []
globalThis.WebSocket = function FakeSocket(url, protocols) {
  sockets.push(this)
  Object.assign(this, { url, protocols, sent: [], closed: false })
  this.send = (raw) => this.sent.push(JSON.parse(raw))
  this.close = () => { this.closed = true }
}

const refusal = (status) => Object.assign(new Error(`HTTP ${status}`), { status })
const log = { run: [], terminate: [], stopped: [] }
let plays = true
let held = false
let runResult = async () => {}
setSiloPlaybackControlHandlers({
  run: (message) => { log.run.push(message); return runResult() },
  plays: () => plays,
  terminate: async (...args) => { log.terminate.push(args) },
  stopped: (reason) => log.stopped.push(reason),
  transportHeld: () => held,
})

const reset = () => {
  resetSiloPlaybackControl()
  sockets = []
  timers = []
  log.run = []
  log.terminate = []
  log.stopped = []
  plays = true
  held = false
  runResult = async () => {}
}

const laneFor = (overrides = {}) => {
  let n = 0
  const lane = { baseUrl: 'http://silo:8090', sessionId: 's1', appVersion: '3.2.0', live: () => true, retire: () => {}, tickets: 0, ...overrides }
  lane.ticket = overrides.ticket || (async () => { lane.tickets++; return { ticket: `t${++n}` } })
  return lane
}

const opened = async () => {
  await flush()
  const socket = sockets[sockets.length - 1]
  socket.onopen()
  return socket
}
const command = async (socket, frame) => {
  socket.onmessage({ data: JSON.stringify({ type: 'command', session_id: 's1', payload: {}, ...frame }) })
  await flush()
}
const statuses = (socket) => socket.sent.filter((f) => f.type !== 'hello').map((f) => `${f.type}:${f.command_id}:${f.status}${f.error ? ':' + f.error : ''}`)

// A playing session opens its lane with a ticket and says hello.
reset()
followSiloPlaybackControl(laneFor())
let socket = await opened()
assert.equal(socket.url, 'ws://silo:8090/api/v2/playback/sessions/s1/control/ws')
assert.deepEqual(socket.protocols, ['silo.playback-control.v2', 'silo.ticket.t1'])
assert.deepEqual(socket.sent[0], {
  type: 'hello', session_id: 's1', client: { name: 'Moonfin', version: '3.2.0' },
  capabilities: { commands: ['pause', 'unpause', 'play_pause', 'stop', 'display_message', 'server_restarting', 'server_shutting_down', 'terminate'] },
})

// A message and a pause are acknowledged, run and completed; an unknown command, or another session's, is not run.
await command(socket, { command_id: 'c1', name: 'display_message', payload: { message: ' Restart at 9 ', title: 'Admin' } })
await command(socket, { command_id: 'c2', name: 'pause' })
await command(socket, { command_id: 'c3', name: 'seek' })
await command(socket, { command_id: 'c4', name: 'pause', session_id: 'other' })
assert.deepEqual(log.run, [
  { MessageType: 'GeneralCommand', Data: { Name: 'DisplayMessage', Arguments: { Text: 'Restart at 9', Header: 'Admin' } } },
  { MessageType: 'Playstate', Data: { Command: 'Pause' } },
])
assert.deepEqual(statuses(socket), ['ack:c1:accepted', 'result:c1:completed', 'ack:c2:accepted', 'result:c2:completed', 'result:c3:rejected:unsupported'])

// A failure is rejected; a session the player moved on from is rejected without being run.
runResult = async () => { throw new Error('nope') }
await command(socket, { command_id: 'c5', name: 'unpause' })
runResult = async () => {}
plays = false
await command(socket, { command_id: 'c6', name: 'stop' })
assert.deepEqual(statuses(socket).slice(5), ['ack:c5:accepted', 'result:c5:rejected:failed', 'result:c6:rejected:not_playing'])
plays = true

// A watch party guest's pause is rejected; a stop still runs and shows the admin's reason after it.
held = true
log.run = []
await command(socket, { command_id: 'c7', name: 'pause' })
await command(socket, { command_id: 'c8', name: 'stop', reason: ' Maintenance ' })
assert.deepEqual(log.run.map((m) => m.Data.Command), ['Stop'])
assert.deepEqual(log.stopped, ['Maintenance'])
assert.deepEqual(statuses(socket).slice(-3), ['result:c7:rejected:failed', 'ack:c8:accepted', 'result:c8:completed'])
held = false

// A stop that fails shows no reason.
log.stopped = []
runResult = async () => { throw new Error('no player') }
await command(socket, { command_id: 'c8b', name: 'stop', reason: 'Maintenance' })
runResult = async () => {}
assert.deepEqual(log.stopped, [])
assert.deepEqual(statuses(socket).slice(-1), ['result:c8b:rejected:failed'])

// A terminate ends the session with the admin's reason.
await command(socket, { command_id: 'c9', name: 'terminate', reason: 'Bye', payload: null })
assert.equal(log.terminate.length, 1)
assert.deepEqual(log.terminate[0].slice(0, 2), ['s1', 'Bye'])
assert.deepEqual(statuses(socket).slice(-2), ['ack:c9:accepted', 'result:c9:completed'])

// A stop that ends the session still sends its result before the lane closes.
let finishStop
runResult = () => new Promise((resolve) => { finishStop = resolve })
await command(socket, { command_id: 'c10', name: 'stop' })
endSiloPlaybackControl('http://silo:8090/', 's1')
assert.equal(socket.closed, false)
finishStop()
await flush()
assert.deepEqual(statuses(socket).slice(-1), ['result:c10:completed'])
assert.equal(socket.closed, true)

// A drop while the session plays reconnects with a fresh ticket; once it stopped playing, it doesn't.
reset()
let live = true
let lane = laneFor({ live: () => live })
followSiloPlaybackControl(lane)
socket = await opened()
socket.onclose()
await runTimers()
assert.deepEqual(sockets[1].protocols, ['silo.playback-control.v2', 'silo.ticket.t2'])
live = false
sockets[1].onclose()
await runTimers()
assert.equal(lane.tickets, 2)

// A refused ticket is tried again, except when Silo has no lane, it's turned off (503 before the lane was ever up), this
// login may not use it, or the session is over.
for (const [status, tickets] of [[401, 2], [503, 1], [403, 1], [404, 1], [409, 1], [410, 1]]) {
  reset()
  let n = 0
  lane = laneFor({ ticket: async () => { n++; if (n === 1) throw refusal(status); return { ticket: 't' } } })
  followSiloPlaybackControl(lane)
  await flush()
  await runTimers()
  assert.equal(n, tickets, `ticket refused with ${status}`)
}

// Once the lane was up, a 503 is a server rebuilding the session after a restart, so it's asked again.
reset()
let refuse = false
lane = laneFor()
const mint = lane.ticket
lane.ticket = async () => { if (refuse) { refuse = false; lane.tickets++; throw refusal(503) } return mint() }
followSiloPlaybackControl(lane)
socket = await opened()
refuse = true
socket.onclose()
await runTimers()
await runTimers()
assert.equal(lane.tickets, 3)
assert.equal(sockets.length, 2)

// A replan of the same session keeps its lane; another session (on another server here) lets the first go.
reset()
followSiloPlaybackControl(laneFor())
const first = await opened()
followSiloPlaybackControl(laneFor())
await flush()
assert.equal(sockets.length, 1)
followSiloPlaybackControl(laneFor({ baseUrl: 'https://other.example', sessionId: 's2' }))
const second = await opened()
assert.equal(first.closed, true)
assert.equal(second.url, 'wss://other.example/api/v2/playback/sessions/s2/control/ws')

// A session the player doesn't play, or one already stopped, takes no lane.
reset()
plays = false
followSiloPlaybackControl(laneFor())
await flush()
assert.equal(sockets.length, 0)
plays = true
followSiloPlaybackControl(laneFor({ live: () => false }))
await flush()
assert.equal(sockets.length, 0)
// Nor does it take the lane from the one playing.
followSiloPlaybackControl(laneFor())
socket = await opened()
followSiloPlaybackControl(laneFor({ sessionId: 's0', live: () => false }))
await flush()
assert.equal(socket.closed, false)

// Notices show like a message; an empty one isn't run.
assert.deepEqual(siloPlaybackControlMessage('server_restarting', { title: 'Server restarting', message: 'Back in a minute' }).Data.Arguments,
  { Text: 'Back in a minute', Header: 'Server restarting' })
assert.deepEqual(siloPlaybackControlMessage('server_shutting_down', { title: 'Going down' }).Data.Arguments, { Text: 'Going down' })
assert.equal(siloPlaybackControlMessage('display_message', { message: '  ' }), null)
reset()

// The session hooks: a start opens the lane, a preview gets none, a stop or a retire ends it, and a session Silo
// retired is let go of when the next plan for the title starts a new one.
const version = { file_id: 5, container: 'mkv', duration: 60, video_tracks: [{ codec: 'h264', width: 1920, height: 1080 }], audio_tracks: [{ codec: 'aac', channels: 2 }], subtitle_tracks: [] }
const sessionHooks = (answers) => {
  const calls = []
  const playing = []
  const ended = []
  const playback = createSiloPlayback({
    call: async (path, options = {}) => {
      calls.push(`${options.method || 'GET'} ${path}`)
      const answer = answers[`${options.method || 'GET'} ${path}`]
      return typeof answer === 'function' ? answer() : answer
    },
    getBaseUrl: () => 'http://silo:8090',
    getUserId: () => 'p1',
    getAccessToken: () => 'tok',
    getDeviceInfo: () => ({ appVersion: '3.0.0' }),
    platform: 'webos',
    getItem: async () => ({ MediaSources: siloItemMediaSources({ versions: [version] }, 'movie-1') }),
    onSessionPlaying: (l) => playing.push(l),
    onSessionEnded: (id) => ended.push(id),
    wait: async () => {},
  })
  return { playback, calls, playing, ended, deletes: () => calls.filter((c) => c.startsWith('DELETE')).length }
}
const capabilities = { state: 'available', allowed: true, protocol_versions: [3], installation_id: 'inst', features: [] }
let sessionNumber = 0
const plan = (id) => ({
  outcome: 'playable', session_id: id,
  playback_plan: { delivery: 'original_http', plan_id: 'p', plan_attempt_key: 'k', effective_media_file_id: 5, stream: { url: `/api/v2/stream/${id}` }, timeline: {} },
})

let hooks = sessionHooks({
  'GET /api/v2/playback/capabilities': capabilities,
  'POST /api/v2/playback/start': () => plan('s1'),
  'DELETE /api/v2/playback/s1': { outcome: 'stopped' },
})
await hooks.playback.previewPlaybackInfo('movie-1', {})
await hooks.playback.reportPlaybackStart({ PlaySessionId: 's1' })
assert.equal(hooks.playing.length, 0)
await hooks.playback.getPlaybackInfo('movie-1', {})
await hooks.playback.reportPlaybackStart({ PlaySessionId: 's1' })
assert.equal(hooks.playing.length, 1)
const playingLane = hooks.playing[0]
assert.equal(playingLane.installationId, 'inst')
assert.equal(playingLane.live(), true)
let deletes = hooks.deletes()
await hooks.playback.reportPlaybackStopped({ PlaySessionId: 's1', PositionTicks: 1 })
assert.equal(hooks.deletes(), deletes + 1)
assert.deepEqual(hooks.ended.slice(-1), ['s1'])
assert.equal(playingLane.live(), false)
// An admin's terminate retires the session: the player's stop sends Silo nothing more.
await hooks.playback.getPlaybackInfo('movie-1', {})
await hooks.playback.reportPlaybackStart({ PlaySessionId: 's1' })
hooks.playing[1].retire()
deletes = hooks.deletes()
await hooks.playback.reportPlaybackStopped({ PlaySessionId: 's1', PositionTicks: 1 })
assert.equal(hooks.deletes(), deletes)

hooks = sessionHooks({
  'GET /api/v2/playback/capabilities': capabilities,
  'POST /api/v2/playback/start': () => plan(`r${++sessionNumber}`),
  'POST /api/v2/playback/r1/progress': () => { throw refusal(404) },
})
await hooks.playback.getPlaybackInfo('movie-1', {})
await hooks.playback.reportPlaybackProgress({ PlaySessionId: 'r1', PositionTicks: 1 })
assert.deepEqual(hooks.ended, [])
await hooks.playback.getPlaybackInfo('movie-1', {})
assert.deepEqual(hooks.ended, ['r1'])

console.log('siloPlaybackControl ok')
