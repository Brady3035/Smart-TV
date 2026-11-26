// Silo's playback control socket (/api/v2/playback/sessions/{id}/control/ws): the lane an admin's message, pause,
// resume, stop and terminate, and the server's restart notice, reach one playing session on. Without it, Silo's
// dashboard says the message can't be delivered, and a pause or stop ends the session once its deadline passes.
// Ported from Moonfin-Core's SiloPlaybackControlSocket.
//
// One lane for the app. It follows the Silo session the player plays, on the server that session plays from (its
// own ticket, URL and token), which isn't always the signed-in one. Each command is acknowledged, run by the code a
// Jellyfin remote's Playstate and DisplayMessage go through, and answered `completed` or `rejected`: a rejected
// result also calls off Silo's fallback, so the session isn't ended over it. Playback never waits on the lane: a
// server without it, a refused ticket or a dropped connection only means these commands don't arrive.

import {siloServerKey} from './siloSession';
import {openSiloSocket} from './siloSocket';

const trimSlash = (url) => String(url || '').replace(/\/+$/, '');

export const SILO_PLAYBACK_CONTROL_PROTOCOL = 'silo.playback-control.v2';
// What the hello says this client runs. Silo sends terminate even when it isn't listed.
export const SILO_PLAYBACK_CONTROL_COMMANDS = [
	'pause', 'unpause', 'play_pause', 'stop', 'display_message', 'server_restarting', 'server_shutting_down', 'terminate'
];

// A connection that stayed up this long counts as working, so the next drop starts the backoff over.
const STABLE_AFTER_MS = 30000;

export const siloPlaybackControlUrl = (baseUrl, sessionId) => `${trimSlash(baseUrl).replace(/^http/, 'ws')}` +
	`/api/v2/playback/sessions/${encodeURIComponent(sessionId)}/control/ws`;

export const siloPlaybackControlBackoff = (attempt) => Math.min(30000, 1000 * Math.pow(2, Math.min(attempt, 5))) +
	Math.floor(Math.random() * 500);

// The Jellyfin-shaped remote message a command runs as, or null for one this client doesn't run.
export const siloPlaybackControlMessage = (name, payload = {}) => {
	switch (name) {
		case 'pause':
			return {MessageType: 'Playstate', Data: {Command: 'Pause'}};
		case 'unpause':
			return {MessageType: 'Playstate', Data: {Command: 'Unpause'}};
		case 'play_pause':
			return {MessageType: 'Playstate', Data: {Command: 'PlayPause'}};
		case 'stop':
			return {MessageType: 'Playstate', Data: {Command: 'Stop'}};
		case 'display_message':
		case 'server_restarting':
		case 'server_shutting_down': {
			const text = typeof payload.message === 'string' ? payload.message.trim() : '';
			const title = typeof payload.title === 'string' ? payload.title.trim() : '';
			const body = text || title;
			if (!body) return null;
			return {MessageType: 'GeneralCommand', Data: {Name: 'DisplayMessage', Arguments: {Text: body, ...(text && title ? {Header: title} : null)}}};
		}
		default:
			return null;
	}
};

// An older Silo has no lane (404), this login may not use it (403), or the session is over or its lane isn't this
// installation's (409, 410). A 401 is the token, which the next ticket's call refreshes.
const ticketFinal = (err) => [403, 404, 409, 410].includes(err?.status);

/**
 * The app's side: `run(message)` is remoteControl.handleMessage; `plays(baseUrl, sessionId)` whether the player still
 * plays that session; `terminate(sessionId, reason, retire)` ends it the way a 410 progress refusal does;
 * `stopped(reason)` shows an admin's reason for a stop once the player has stopped; `transportHeld()` whether a watch
 * party room would take a pause or resume and do nothing with it.
 */
let handlers = null;
export const setSiloPlaybackControlHandlers = (next) => {
	handlers = next;
	return () => {
		if (handlers === next) handlers = null;
	};
};

// The lane being followed. Each followed session gets its own, so a command's handling and answer stay with it.
let current = null;

const send = (socket, frame) => {
	try {
		socket?.send(JSON.stringify(frame));
	} catch {
		// A connection that went away loses the answer; Silo falls back as it does without a lane.
	}
};

const createLane = (lane) => {
	const key = siloServerKey(lane.baseUrl);
	let socket = null;
	let closed = false;
	// Commands still running, so a lane let go of can wait for their answers.
	let running = 0;
	let attempts = 0;
	// Silo answers 503 both when the lane is off and while it rebuilds a session after a restart. Only a lane that was
	// up can be the second, so only it asks again.
	let everOpened = false;
	let retryTimer = null;

	const answer = (commandId, type, status, error) =>
		send(socket, {type, command_id: commandId, session_id: lane.sessionId, status, ...(error ? {error} : null)});

	const release = () => {
		clearTimeout(retryTimer);
		const old = socket;
		socket = null;
		if (!old) return;
		old.onclose = null;
		old.onmessage = null;
		try {
			old.close();
		} catch {
			// Already gone.
		}
	};

	const finish = () => {
		running -= 1;
		if (closed && running <= 0) release();
	};

	const handleCommand = async (frame) => {
		const id = frame.command_id;
		const name = frame.name;
		const payload = frame.payload && typeof frame.payload === 'object' ? frame.payload : {};
		const reason = typeof frame.reason === 'string' && frame.reason.trim() ? frame.reason.trim() : null;
		// The player moved on (Next before this session's stop closed its lane): its pause or stop would hit the new item.
		if (!handlers || !handlers.plays(lane.baseUrl, lane.sessionId)) {
			answer(id, 'result', 'rejected', 'not_playing');
			return;
		}
		const message = name === 'terminate' ? null : siloPlaybackControlMessage(name, payload);
		if (name !== 'terminate' && !message) {
			answer(id, 'result', 'rejected', 'unsupported');
			return;
		}
		running += 1;
		answer(id, 'ack', 'accepted');
		try {
			if (name === 'terminate') {
				await handlers.terminate(lane.sessionId, reason, lane.retire);
			} else {
				// In a watch party the room takes pause and resume, and a guest of a host-only room can't.
				if (message.MessageType === 'Playstate' && name !== 'stop' && handlers.transportHeld?.()) {
					throw new Error('Transport belongs to the watch party');
				}
				await handlers.run(message);
			}
			answer(id, 'result', 'completed');
		} catch {
			answer(id, 'result', 'rejected', 'failed');
			return;
		} finally {
			finish();
		}
		// A Jellyfin Stop can't carry text, so an admin's reason is shown once the stop has run.
		if (name === 'stop' && reason) {
			try {
				handlers?.stopped?.(reason);
			} catch {
				// The stop still happened.
			}
		}
	};

	const onFrame = (raw) => {
		if (closed) return;
		let frame;
		try {
			frame = JSON.parse(raw);
		} catch {
			return;
		}
		if (!frame || frame.type !== 'command' || typeof frame.command_id !== 'string' || !frame.command_id ||
			frame.session_id !== lane.sessionId) return;
		handleCommand(frame);
	};

	let connect = null;
	const retry = () => {
		if (closed || !lane.live()) return;
		retryTimer = setTimeout(connect, siloPlaybackControlBackoff(attempts));
		attempts += 1;
	};

	// Silo closes the connection after four hours or when the token it was opened with expires, and a drop while the
	// session still plays gets a fresh ticket. A token about to expire is refreshed by the ticket's own call.
	connect = async () => {
		retryTimer = null;
		if (closed || !lane.live()) return;
		let ticket;
		let next;
		try {
			ticket = await lane.ticket();
			if (typeof ticket?.ticket !== 'string' || !ticket.ticket) throw new Error('Silo sent no usable control ticket');
			if (closed) return;
			next = await openSiloSocket(siloPlaybackControlUrl(lane.baseUrl, lane.sessionId),
				[SILO_PLAYBACK_CONTROL_PROTOCOL, `silo.ticket.${ticket.ticket}`]);
		} catch (err) {
			if (!ticketFinal(err) && (everOpened || err?.status !== 503)) retry();
			return;
		}
		if (closed) {
			next.close();
			return;
		}
		let openedAt = 0;
		socket = next;
		next.onopen = () => {
			openedAt = Date.now();
			everOpened = true;
			send(next, {
				type: 'hello',
				session_id: lane.sessionId,
				client: {name: 'Moonfin', version: String(lane.appVersion || '0')},
				capabilities: {commands: SILO_PLAYBACK_CONTROL_COMMANDS}
			});
		};
		next.onmessage = (event) => onFrame(event.data);
		next.onclose = () => {
			if (socket !== next) return;
			socket = null;
			if (openedAt && Date.now() - openedAt >= STABLE_AFTER_MS) attempts = 0;
			retry();
		};
	};

	return {
		matches: (baseUrl, sessionId) => siloServerKey(baseUrl) === key && sessionId === lane.sessionId,
		start: () => connect(),
		// Commands still running send their results first (a stop ends its own session), then the connection goes.
		close: () => {
			closed = true;
			clearTimeout(retryTimer);
			if (running <= 0) release();
		}
	};
};

/**
 * A Silo session started playing. `lane` is {baseUrl, sessionId, appVersion, live(), ticket(), retire()}, all for the
 * server the session plays on. Lets go of a lane for another session.
 */
export const followSiloPlaybackControl = (lane) => {
	// A session that already stopped, or that the player no longer plays (a slow replan answering late), never takes
	// the lane from the one playing.
	if (!lane?.sessionId || !lane.baseUrl || typeof lane.live !== 'function' || !lane.live()) return;
	if (handlers && !handlers.plays(lane.baseUrl, lane.sessionId)) return;
	if (current?.matches(lane.baseUrl, lane.sessionId)) return;
	current?.close();
	current = createLane({...lane});
	current.start();
};

// The session stopped or Silo ended it.
export const endSiloPlaybackControl = (baseUrl, sessionId) => {
	if (!current?.matches(baseUrl, sessionId)) return;
	current.close();
	current = null;
};

// For tests.
export const resetSiloPlaybackControl = () => {
	current?.close();
	current = null;
};
