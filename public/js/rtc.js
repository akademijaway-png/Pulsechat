'use strict';
/* Video calls via WebRTC + Socket.IO signaling.
   Full-screen UI: ringing, incoming, active, controls, camera switching. */

import { emit } from './socket.js';
import { el, esc, avatarHtml, toast, playRing, callDurationLabel } from './ui.js';
import { icon } from './icons.js';

const ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
];
const RING_MS = 45000;

let call = null; // current call state machine

function mediaError(err) {
  if (err && err.name === 'NotAllowedError') return 'Camera and microphone access was blocked. Allow it in your browser settings and try again.';
  if (err && err.name === 'NotFoundError') return 'No camera or microphone was found on this device.';
  if (err && err.name === 'NotReadableError') return 'Your camera or microphone is being used by another application.';
  return 'Could not access the camera or microphone.';
}

async function getMedia() {
  return navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
    audio: true,
  });
}

/* ---------------- caller: start ---------------- */

export async function startCall(user) {
  if (!user) return;
  if (call) {
    toast('A call is already in progress.', 'info');
    return;
  }
  call = {
    id: null,
    clientId: crypto.randomUUID(),
    role: 'caller',
    peer: user,
    status: 'ringing',
    muted: false,
    camOff: false,
    facing: 'user',
    startedAt: Date.now(),
  };
  try {
    call.localStream = await getMedia();
  } catch (err) {
    toast(mediaError(err), 'error');
    call = null;
    return;
  }
  renderOutgoing();
  emit('call:invite', { to: user.id, clientId: call.clientId });
  call.ringTimer = setTimeout(() => {
    if (call && call.status === 'ringing') {
      toast(`${user.displayName} did not answer.`, 'info');
      closeCall();
    }
  }, RING_MS);
}

/* ---------------- callee: incoming ---------------- */

export function onIncoming(payload) {
  if (call) {
    // Already busy — politely decline automatically.
    emit('call:decline', { callId: payload.callId });
    return;
  }
  playRing();
  call = {
    id: payload.callId,
    clientId: payload.clientId,
    role: 'callee',
    peer: payload.caller,
    status: 'ringing',
    muted: false,
    camOff: false,
    facing: 'user',
    startedAt: Date.now(),
  };
  renderIncoming();
  call.ringTimer = setTimeout(() => {
    if (call && call.status === 'ringing') {
      toast('Missed call', 'info');
      closeCall();
    }
  }, RING_MS);
}

async function acceptCall() {
  if (!call || call.role !== 'callee') return;
  try {
    call.localStream = await getMedia();
  } catch (err) {
    toast(mediaError(err), 'error');
    emit('call:decline', { callId: call.id });
    closeCall();
    return;
  }
  clearTimeout(call.ringTimer);
  call.status = 'connecting';
  initPC();
  renderActive('Connecting…');
  emit('call:accept', { callId: call.id });
}

function declineCall() {
  if (!call) return;
  emit('call:decline', { callId: call.id });
  closeCall();
}

/* ---------------- peer events ---------------- */

export function onAccepted(payload) {
  if (!call || call.role !== 'caller') return;
  if (payload.clientId && payload.clientId !== call.clientId) return;
  if (payload.callId) call.id = payload.callId;
  clearTimeout(call.ringTimer);
  call.status = 'connecting';
  initPC();
  renderActive('Connecting…');
  (async () => {
    try {
      const offer = await call.pc.createOffer();
      await call.pc.setLocalDescription(offer);
      sendSignal({ type: 'offer', sdp: call.pc.localDescription });
    } catch (err) {
      console.error('[rtc] offer failed', err);
      toast('Could not start the video call.', 'error');
      closeCall();
    }
  })();
}

export function onDeclined() {
  if (!call) return;
  toast(`${call.peer.displayName} declined the call.`, 'info');
  closeCall();
}

export function onCancelled() {
  if (!call) return;
  toast('The call was cancelled.', 'info');
  closeCall();
}

export function onTimeout() {
  if (!call) return;
  if (call.status === 'ringing' || call.status === 'connecting') {
    toast(call.role === 'caller' ? 'No answer.' : 'Missed call.', 'info');
    closeCall();
  }
}

export function onUnavailable() {
  if (!call || call.role !== 'caller') return;
  toast(`${call.peer.displayName} is unavailable right now.`, 'info');
  closeCall();
}

export function onEnded(payload) {
  if (!call) return;
  const wasActive = call.status === 'active';
  if (payload.by !== stateMeId() && wasActive) {
    toast('Call ended.', 'info');
  }
  closeCall(wasActive ? 'Call ended' : undefined);
}

export function onCallError(payload) {
  toast((payload && payload.message) || 'The call could not be started.', 'error');
  closeCall();
}

/* ---------------- signaling ---------------- */

export async function onSignal(payload) {
  if (!call || !call.pc) return;
  if (payload.from !== call.peer.id || payload.callId !== call.id) return;
  const data = payload.data;
  if (!data) return;
  try {
    if (data.type === 'offer') {
      await call.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      const answer = await call.pc.createAnswer();
      await call.pc.setLocalDescription(answer);
      sendSignal({ type: 'answer', sdp: call.pc.localDescription });
    } else if (data.type === 'answer') {
      await call.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    } else if (data.type === 'ice' && data.candidate) {
      await call.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    }
  } catch (err) {
    console.error('[rtc] signaling error', err);
  }
}

function sendSignal(data) {
  emit('signal', { to: call.peer.id, callId: call.id, clientId: call.clientId, data });
}

function stateMeId() {
  // avoid importing state at module top for a one-liner
  return document.body.dataset.meId ? Number(document.body.dataset.meId) : null;
}

/* ---------------- WebRTC plumbing ---------------- */

function initPC() {
  const pc = new RTCPeerConnection({ iceServers: ICE });
  call.pc = pc;
  call.localStream.getTracks().forEach((t) => pc.addTrack(t, call.localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal({ type: 'ice', candidate: e.candidate });
  };
  pc.ontrack = (e) => {
    if (e.streams && e.streams[0]) {
      call.remoteStream = e.streams[0];
      attachRemote(e.streams[0]);
    }
  };
  pc.onconnectionstatechange = () => {
    if (!call) return;
    if (pc.connectionState === 'connected') {
      call.status = 'active';
      startTimer();
      setStatus('Connected');
    } else if (pc.connectionState === 'failed') {
      toast('The video call could not connect.', 'error');
      closeCall();
    }
  };
}

function attachRemote(stream) {
  const video = document.getElementById('remoteVideo');
  if (!video) return;
  video.srcObject = stream;
  video.play().catch(() => {});
}

/* ---------------- rendering ---------------- */

function screen() {
  return el('div', { class: 'call-screen', id: 'call-screen' });
}

function renderIncoming() {
  const peer = call.peer;
  const s = screen();
  s.append(
    el('div', { class: 'call-ringing-bg' }, [
      el('div', { class: 'ring-avatar', html: avatarHtml(peer, 'xl') }),
      el('div', { style: 'text-align:center' }, [
        el('div', { class: 'call-status', text: peer.displayName }),
        el('div', { class: 'call-timer', text: 'Incoming video call…' }),
      ]),
      el('div', { class: 'call-controls' }, [
        el('button', { class: 'call-btn decline', html: icon('phoneMissed'), title: 'Decline', onclick: declineCall }),
        el('button', { class: 'call-btn accept', html: icon('video'), title: 'Accept', onclick: acceptCall }),
      ]),
    ])
  );
  mount(s);
}

function renderOutgoing() {
  const peer = call.peer;
  const s = screen();
  s.append(
    el('div', { class: 'call-ringing-bg' }, [
      el('div', { class: 'ring-avatar', html: avatarHtml(peer, 'xl') }),
      el('div', { style: 'text-align:center' }, [
        el('div', { class: 'call-status', text: peer.displayName }),
        el('div', { class: 'call-timer', text: 'Ringing…' }),
      ]),
      el('div', { class: 'call-controls' }, [
        controlBtn('mic', 'Mute', () => toggleMute()),
        el('button', { class: 'call-btn end', html: icon('phoneMissed'), title: 'Cancel call', onclick: () => { emit('call:cancel', { clientId: call.clientId }); closeCall(); } }),
        controlBtn('camOn', 'Camera', () => toggleCam()),
      ]),
    ])
  );
  mount(s);
}

function renderActive(statusText) {
  const peer = call.peer;
  const s = screen();
  s.append(
    el('video', { id: 'remoteVideo', class: 'call-remote-video', autoplay: true, playsinline: true }),
    el('div', { class: 'call-local-preview', id: 'localPreview' }, [
      el('video', { id: 'localVideo', autoplay: true, muted: true, playsinline: true }),
    ]),
    el('div', { class: 'call-top-info' }, [
      el('div', { class: 'call-status', text: peer.displayName }),
      el('div', { class: 'call-timer', id: 'call-timer', text: statusText }),
    ]),
    el('div', { class: 'call-controls' }, [
      controlBtn('mic', 'Mute', () => toggleMute()),
      controlBtn('switchCam', 'Flip camera', () => switchCamera()),
      controlBtn('camOn', 'Camera', () => toggleCam()),
      el('button', { class: 'call-btn end', html: icon('phoneMissed'), title: 'End call', onclick: () => { emit('call:end', { callId: call.id }); closeCall('Call ended'); } }),
    ])
  );
  mount(s);
  const localVideo = document.getElementById('localVideo');
  if (localVideo) {
    localVideo.srcObject = call.localStream;
    localVideo.play().catch(() => {});
  }
}

function controlBtn(iconName, label, action) {
  return el('button', { class: 'call-btn', id: 'ctrl-' + iconName, html: icon(iconName), title: label, onclick: action });
}

function mount(s) {
  const root = document.getElementById('modal-root');
  root.replaceChildren(s);
}

function setStatus(text) {
  const t = document.getElementById('call-timer');
  if (t) t.textContent = text;
}

function startTimer() {
  clearInterval(call.timer);
  const base = Date.now();
  call.timer = setInterval(() => {
    const t = document.getElementById('call-timer');
    if (t) t.textContent = callDurationLabel(Date.now() - base);
  }, 500);
}

/* ---------------- controls ---------------- */

function toggleMute() {
  if (!call) return;
  call.muted = !call.muted;
  const track = call.localStream && call.localStream.getAudioTracks()[0];
  if (track) track.enabled = !call.muted;
  const btn = document.getElementById('ctrl-mic');
  if (btn) {
    btn.innerHTML = icon(call.muted ? 'micOff' : 'mic');
    btn.classList.toggle('off', call.muted);
  }
}

function toggleCam() {
  if (!call) return;
  call.camOff = !call.camOff;
  const track = call.localStream && call.localStream.getVideoTracks()[0];
  if (track) track.enabled = !call.camOff;
  const preview = document.getElementById('localPreview');
  if (preview) preview.classList.toggle('hidden', call.camOff);
  const btn = document.getElementById('ctrl-camOn');
  if (btn) {
    btn.innerHTML = icon(call.camOff ? 'camOff' : 'camOn');
    btn.classList.toggle('off', call.camOff);
  }
}

async function switchCamera() {
  if (!call || !navigator.mediaDevices) return;
  const videoTrack = call.localStream && call.localStream.getVideoTracks()[0];
  const facing = videoTrack && videoTrack.getSettings && videoTrack.getSettings().facingMode;
  const next = facing === 'environment' ? 'user' : 'environment';
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: next }, audio: false });
    const newTrack = newStream.getVideoTracks()[0];
    const sender = call.pc && call.pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender && newTrack) await sender.replaceTrack(newTrack);
    if (videoTrack) {
      call.localStream.removeTrack(videoTrack);
      videoTrack.stop();
    }
    if (newTrack) call.localStream.addTrack(newTrack);
    const localVideo = document.getElementById('localVideo');
    if (localVideo) {
      localVideo.srcObject = call.localStream;
      localVideo.play().catch(() => {});
    }
  } catch (err) {
    toast('Could not switch camera.', 'error');
  }
}

/* ---------------- teardown ---------------- */

export function closeCall(statusText) {
  if (!call) return;
  clearTimeout(call.ringTimer);
  clearInterval(call.timer);
  if (call.pc) {
    try {
      call.pc.close();
    } catch {
      /* ignore */
    }
  }
  if (call.localStream) call.localStream.getTracks().forEach((t) => t.stop());
  const root = document.getElementById('modal-root');
  root.replaceChildren();
  call = null;
  // refresh call history so the new entry shows up
  import('./views/calls.js').then((m) => m.refresh && m.refresh());
}
