// Auth page logic
const API = '';

function switchTab(tab) {
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
  document.getElementById('form-login').classList.toggle('hidden', tab !== 'login');
  document.getElementById('form-register').classList.toggle('hidden', tab !== 'register');
}

function togglePw(id, btn) {
  const inp = document.getElementById(id);
  inp.type = inp.type === 'password' ? 'text' : 'password';
  btn.textContent = inp.type === 'password' ? '👁' : '🙈';
}

function setLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (btn) btn.disabled = loading;
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; }
}

async function handleLogin(e) {
  e.preventDefault();
  showError('login-error', '');
  setLoading('login-btn', true);
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  try {
    const res = await fetch(`${API}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    localStorage.setItem('ameen_token', data.token);
    localStorage.setItem('ameen_user', JSON.stringify(data.user));
    window.location.href = '/app.html';
  } catch (err) {
    showError('login-error', err.message);
  } finally {
    setLoading('login-btn', false);
  }
}

async function handleRegister(e) {
  e.preventDefault();
  showError('reg-error', '');
  setLoading('reg-btn', true);
  const displayName = document.getElementById('reg-name').value.trim();
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  try {
    const res = await fetch(`${API}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password, displayName })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    localStorage.setItem('ameen_token', data.token);
    localStorage.setItem('ameen_user', JSON.stringify(data.user));
    window.location.href = '/app.html';
  } catch (err) {
    showError('reg-error', err.message);
  } finally {
    setLoading('reg-btn', false);
  }
}

// Animated particles
function createParticles() {
  const container = document.getElementById('particles');
  const colors = ['#6C63FF', '#3B82F6', '#00D4AA', '#8B84FF'];
  for (let i = 0; i < 25; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const size = Math.random() * 6 + 2;
    p.style.cssText = `
      width:${size}px; height:${size}px;
      left:${Math.random()*100}%;
      background:${colors[Math.floor(Math.random()*colors.length)]};
      animation-duration:${Math.random()*20+10}s;
      animation-delay:${Math.random()*10}s;
    `;
    container.appendChild(p);
  }
}

// Redirect if already logged in
if (localStorage.getItem('ameen_token')) {
  window.location.href = '/app.html';
}

createParticles();
