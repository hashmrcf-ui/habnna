/**
 * Ameen Call Engine — LiveKit SFU
 * Calls routed via LiveKit for security monitoring capability
 */

const AmeenCall = (() => {
  let room = null;
  let currentCallType = null;
  let remoteUserId = null;
  let callStartTime = null;
  let timerInterval = null;

  // ── Start Outgoing Call ──────────────────────────────────────────
  async function startCall(targetUserId, targetName, targetAvatar, callType = 'audio') {
    remoteUserId = targetUserId;
    currentCallType = callType;

    // Generate unique room name for this direct call
    const roomName = [socket.id.slice(0,8), targetUserId.slice(0,8)].sort().join('-');

    try {
      // Signal the other user via socket (same flow as before)
      socket.emit('call:offer', {
        targetUserId,
        callType,
        roomName          // ← send room name instead of WebRTC offer
      });

      showCallOverlay({ name: targetName, avatar: targetAvatar, callType, state: 'calling' });

      // Join LiveKit room
      await joinRoom(roomName, callType);

    } catch (e) {
      showCallError('فشل الاتصال: ' + e.message);
    }
  }

  // ── Handle Incoming Call ─────────────────────────────────────────
  function handleIncomingCall({ callerId, callerName, callerAvatar, callType, roomName }) {
    remoteUserId = callerId;
    currentCallType = callType;
    window._pendingCall = { callerId, roomName };
    showIncomingCallUI({ callerName, callerAvatar, callType });
  }

  // ── Answer Call ──────────────────────────────────────────────────
  async function answerCall() {
    const { callerId, roomName } = window._pendingCall || {};
    if (!roomName) return;

    hideIncomingCallUI();
    showCallOverlay({
      name: document.getElementById('incoming-caller-name')?.textContent || '',
      avatar: document.getElementById('incoming-caller-avatar')?.src || '',
      callType: currentCallType,
      state: 'connected'
    });

    try {
      await joinRoom(roomName, currentCallType);
      startCallTimer();
    } catch (e) {
      showCallError('فشل الاتصال: ' + e.message);
    }
  }

  // ── Join LiveKit Room ────────────────────────────────────────────
  async function joinRoom(roomName, callType) {
    if (!window.LivekitClient) {
      throw new Error('LiveKit SDK غير محمّل');
    }

    // Get token from server
    const token = localStorage.getItem('ameen_token');
    const res = await fetch('/api/call/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ roomName, callType })
    });
    const { token: lkToken, url } = await res.json();

    room = new LivekitClient.Room({
      adaptiveStream: true,
      dynacast: true
    });

    // Handle remote tracks
    room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind === LivekitClient.Track.Kind.Video) {
        const el = document.getElementById('call-remote-video');
        if (el) track.attach(el);
      } else if (track.kind === LivekitClient.Track.Kind.Audio) {
        const el = document.getElementById('call-remote-audio');
        if (el) track.attach(el);
        else track.attach(); // auto-attach to new audio element
      }
    });

    room.on(LivekitClient.RoomEvent.ParticipantDisconnected, () => {
      endCall(false);
    });

    room.on(LivekitClient.RoomEvent.Connected, () => {
      updateCallState('connected');
      startCallTimer();
    });

    await room.connect(url, lkToken);

    // Publish local tracks
    const tracks = await LivekitClient.createLocalTracks({
      audio: true,
      video: callType === 'video'
    });

    for (const track of tracks) {
      await room.localParticipant.publishTrack(track);
      if (track.kind === LivekitClient.Track.Kind.Video) {
        const el = document.getElementById('call-local-video');
        if (el) track.attach(el);
      }
    }
  }

  // ── Reject Call ──────────────────────────────────────────────────
  function rejectCall() {
    if (window._pendingCall) {
      socket.emit('call:reject', { callerId: window._pendingCall.callerId });
      window._pendingCall = null;
    }
    hideIncomingCallUI();
  }

  // ── End Call ─────────────────────────────────────────────────────
  function endCall(notify = true) {
    if (notify && remoteUserId) {
      socket.emit('call:end', { targetUserId: remoteUserId });
    }

    stopTimer();

    if (room) {
      room.localParticipant.tracks.forEach(pub => {
        pub.track?.stop();
      });
      room.disconnect();
      room = null;
    }

    remoteUserId = null;
    currentCallType = null;
    window._pendingCall = null;

    hideCallOverlay();
    hideIncomingCallUI();
  }

  // ── Toggle Mute ──────────────────────────────────────────────────
  function toggleMute() {
    if (!room) return;
    const audioTrack = [...room.localParticipant.tracks.values()]
      .find(p => p.kind === LivekitClient.Track.Kind.Audio);
    if (!audioTrack) return;
    const enabled = !audioTrack.isMuted;
    enabled ? audioTrack.mute() : audioTrack.unmute();
    const btn = document.getElementById('call-mute-btn');
    if (btn) {
      btn.classList.toggle('active', enabled);
      btn.innerHTML = enabled ? muteIcon() : micIcon();
    }
  }

  // ── Toggle Video ─────────────────────────────────────────────────
  function toggleVideo() {
    if (!room) return;
    const videoTrack = [...room.localParticipant.tracks.values()]
      .find(p => p.kind === LivekitClient.Track.Kind.Video);
    if (!videoTrack) return;
    videoTrack.isMuted ? videoTrack.unmute() : videoTrack.mute();
    const btn = document.getElementById('call-video-btn');
    if (btn) btn.classList.toggle('active', videoTrack.isMuted);
  }

  // ── Call Timer ───────────────────────────────────────────────────
  function startCallTimer() {
    callStartTime = Date.now();
    timerInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - callStartTime) / 1000);
      const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const s = String(elapsed % 60).padStart(2, '0');
      const timer = document.getElementById('call-timer');
      if (timer) timer.textContent = `${m}:${s}`;
    }, 1000);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
    callStartTime = null;
  }

  // ── UI Functions ─────────────────────────────────────────────────
  function showCallOverlay({ name, avatar, callType, state }) {
    const overlay = document.getElementById('call-overlay');
    if (!overlay) return;
    overlay.classList.remove('hidden');
    overlay.dataset.callType = callType;
    document.getElementById('call-peer-name').textContent = name;
    document.getElementById('call-peer-avatar').src = avatar;
    document.getElementById('call-type-label').textContent = callType === 'video' ? '📹 مكالمة مرئية' : '🎙️ مكالمة صوتية';
    updateCallState(state);
    const videoArea = document.getElementById('call-video-area');
    if (videoArea) videoArea.classList.toggle('hidden', callType !== 'video');
    const videoBtn = document.getElementById('call-video-btn');
    if (videoBtn) videoBtn.style.display = callType === 'video' ? 'flex' : 'none';
  }

  function updateCallState(state) {
    const statusEl = document.getElementById('call-status');
    if (!statusEl) return;
    if (state === 'calling') statusEl.textContent = 'جارٍ الاتصال...';
    else if (state === 'connected') {
      statusEl.textContent = '00:00';
      statusEl.id = 'call-timer';
    }
  }

  function hideCallOverlay() {
    const overlay = document.getElementById('call-overlay');
    if (overlay) overlay.classList.add('hidden');
    const timer = document.getElementById('call-timer');
    if (timer) { timer.textContent = ''; timer.id = 'call-status'; }
    const rv = document.getElementById('call-remote-video');
    if (rv) rv.srcObject = null;
    const lv = document.getElementById('call-local-video');
    if (lv) lv.srcObject = null;
  }

  function showIncomingCallUI({ callerName, callerAvatar, callType }) {
    const ui = document.getElementById('incoming-call-ui');
    if (!ui) return;
    ui.classList.remove('hidden');
    document.getElementById('incoming-caller-name').textContent = callerName;
    document.getElementById('incoming-caller-avatar').src = callerAvatar;
    document.getElementById('incoming-call-type').textContent = callType === 'video' ? '📹 مكالمة مرئية واردة' : '🎙️ مكالمة صوتية واردة';
    try {
      const ctx = new AudioContext();
      function ring() {
        const o = ctx.createOscillator(); o.type = 'sine';
        o.frequency.setValueAtTime(440, ctx.currentTime);
        o.frequency.setValueAtTime(480, ctx.currentTime + 0.5);
        const g = ctx.createGain(); g.gain.setValueAtTime(0.3, ctx.currentTime);
        g.gain.setValueAtTime(0, ctx.currentTime + 0.8);
        o.connect(g); g.connect(ctx.destination);
        o.start(); o.stop(ctx.currentTime + 0.8);
      }
      ring(); window._ringInterval = setInterval(ring, 1500);
    } catch(e) {}
  }

  function hideIncomingCallUI() {
    const ui = document.getElementById('incoming-call-ui');
    if (ui) ui.classList.add('hidden');
    clearInterval(window._ringInterval);
  }

  function showCallError(msg) { if (typeof showToast === 'function') showToast('❌ ' + msg); }
  function micIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`; }
  function muteIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`; }

  return {
    startCall, handleIncomingCall, answerCall, rejectCall, endCall,
    toggleMute, toggleVideo
  };
})();
