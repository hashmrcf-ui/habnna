/**
 * Ameen Call Engine — WebRTC Voice & Video Calls
 * Peer-to-peer encrypted calls using STUN servers
 */

const AmeenCall = (() => {
  // State
  let localStream = null;
  let remoteStream = null;
  let peerConnection = null;
  let currentCallType = null;  // 'audio' | 'video'
  let remoteUserId = null;
  let callStartTime = null;
  let timerInterval = null;
  let isCaller = false;

  const STUN_SERVERS = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  };

  // ── Start Outgoing Call ──────────────────────────────────────────
  async function startCall(targetUserId, targetName, targetAvatar, callType = 'audio') {
    remoteUserId = targetUserId;
    currentCallType = callType;
    isCaller = true;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: callType === 'video'
      });
    } catch (e) {
      showCallError('لا يمكن الوصول إلى ' + (callType === 'video' ? 'الكاميرا/المايك' : 'المايكروفون'));
      return;
    }

    showCallOverlay({ name: targetName, avatar: targetAvatar, callType, state: 'calling' });

    if (callType === 'video') {
      document.getElementById('call-local-video').srcObject = localStream;
    }

    peerConnection = createPeerConnection(targetUserId);

    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit('call:offer', { targetUserId, offer, callType });
  }

  // ── Handle Incoming Call ─────────────────────────────────────────
  function handleIncomingCall({ callerId, callerName, callerAvatar, offer, callType }) {
    remoteUserId = callerId;
    currentCallType = callType;
    isCaller = false;

    // Store offer for when user answers
    window._pendingOffer = { offer, callerId };

    showIncomingCallUI({ callerName, callerAvatar, callType });
  }

  // ── Answer Call ──────────────────────────────────────────────────
  async function answerCall() {
    const { offer, callerId } = window._pendingOffer;
    remoteUserId = callerId;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: currentCallType === 'video'
      });
    } catch (e) {
      rejectCall();
      showCallError('لا يمكن الوصول إلى ' + (currentCallType === 'video' ? 'الكاميرا/المايك' : 'المايكروفون'));
      return;
    }

    hideIncomingCallUI();
    showCallOverlay({
      name: document.getElementById('incoming-caller-name')?.textContent || '',
      avatar: document.getElementById('incoming-caller-avatar')?.src || '',
      callType: currentCallType,
      state: 'connected'
    });

    if (currentCallType === 'video') {
      document.getElementById('call-local-video').srcObject = localStream;
    }

    peerConnection = createPeerConnection(callerId);
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('call:answer', { callerId, answer });
    startCallTimer();
  }

  // ── Create Peer Connection ───────────────────────────────────────
  function createPeerConnection(targetId) {
    const pc = new RTCPeerConnection(STUN_SERVERS);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) {
        socket.emit('call:ice-candidate', { targetUserId: targetId, candidate });
      }
    };

    pc.ontrack = ({ streams }) => {
      remoteStream = streams[0];
      const remoteVideo = document.getElementById('call-remote-video');
      const remoteAudio = document.getElementById('call-remote-audio');
      if (remoteVideo && currentCallType === 'video') {
        remoteVideo.srcObject = remoteStream;
      } else if (remoteAudio) {
        remoteAudio.srcObject = remoteStream;
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        updateCallState('connected');
        startCallTimer();
      } else if (['disconnected', 'failed', 'closed'].includes(pc.connectionState)) {
        endCall(false);
      }
    };

    return pc;
  }

  // ── Handle Remote ICE Candidates ─────────────────────────────────
  async function handleIceCandidate(candidate) {
    if (peerConnection && candidate) {
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {}
    }
  }

  // ── Handle Answer ────────────────────────────────────────────────
  async function handleAnswer(answer) {
    if (peerConnection) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  // ── Reject Call ──────────────────────────────────────────────────
  function rejectCall() {
    if (window._pendingOffer) {
      socket.emit('call:reject', { callerId: window._pendingOffer.callerId });
      window._pendingOffer = null;
    }
    hideIncomingCallUI();
  }

  // ── End Call ─────────────────────────────────────────────────────
  function endCall(notify = true) {
    if (notify && remoteUserId) {
      socket.emit('call:end', { targetUserId: remoteUserId });
    }

    // Cleanup
    stopTimer();
    if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
    if (peerConnection) { peerConnection.close(); peerConnection = null; }
    remoteUserId = null;
    currentCallType = null;
    window._pendingOffer = null;

    hideCallOverlay();
    hideIncomingCallUI();
  }

  // ── Toggle Mute ──────────────────────────────────────────────────
  function toggleMute() {
    if (!localStream) return;
    const enabled = localStream.getAudioTracks()[0]?.enabled;
    localStream.getAudioTracks().forEach(t => t.enabled = !enabled);
    const btn = document.getElementById('call-mute-btn');
    if (btn) {
      btn.classList.toggle('active', enabled);
      btn.title = enabled ? 'تشغيل الصوت' : 'كتم الصوت';
      btn.innerHTML = enabled ? muteIcon() : micIcon();
    }
  }

  // ── Toggle Video ─────────────────────────────────────────────────
  function toggleVideo() {
    if (!localStream) return;
    const enabled = localStream.getVideoTracks()[0]?.enabled;
    localStream.getVideoTracks().forEach(t => t.enabled = !enabled);
    const btn = document.getElementById('call-video-btn');
    if (btn) btn.classList.toggle('active', enabled);
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

    // Show video elements if video call
    const videoArea = document.getElementById('call-video-area');
    if (videoArea) videoArea.classList.toggle('hidden', callType !== 'video');

    // Hide video-only toggle if audio call
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
    const remoteVideo = document.getElementById('call-remote-video');
    if (remoteVideo) remoteVideo.srcObject = null;
    const localVideo = document.getElementById('call-local-video');
    if (localVideo) localVideo.srcObject = null;
  }

  function showIncomingCallUI({ callerName, callerAvatar, callType }) {
    const ui = document.getElementById('incoming-call-ui');
    if (!ui) return;
    ui.classList.remove('hidden');
    document.getElementById('incoming-caller-name').textContent = callerName;
    document.getElementById('incoming-caller-avatar').src = callerAvatar;
    document.getElementById('incoming-call-type').textContent = callType === 'video' ? '📹 مكالمة مرئية واردة' : '🎙️ مكالمة صوتية واردة';
    // Play ringtone
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
      ring();
      window._ringInterval = setInterval(ring, 1500);
    } catch(e) {}
  }

  function hideIncomingCallUI() {
    const ui = document.getElementById('incoming-call-ui');
    if (ui) ui.classList.add('hidden');
    clearInterval(window._ringInterval);
  }

  function showCallError(msg) {
    showToast('❌ ' + msg);
  }

  function micIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2a3 3 0 0 1 3 3v7a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`; }
  function muteIcon() { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`; }

  return {
    startCall, handleIncomingCall, answerCall, rejectCall, endCall,
    toggleMute, toggleVideo, handleIceCandidate, handleAnswer
  };
})();
