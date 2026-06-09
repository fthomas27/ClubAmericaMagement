const { useState, useEffect, useMemo, useCallback, useRef } = React;

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
const TOKEN_KEY = 'ca_token';

async function api(path, { method = 'GET', body } = {}) {
  const token = localStorage.getItem(TOKEN_KEY);
  const res = await fetch('/api' + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      window.dispatchEvent(new Event('ca:session-expired'));
    }
    const err = new Error((data && data.error) || 'Request failed');
    err.status = res.status;
    err.code = data && data.error;
    throw err;
  }
  return data;
}

// Fire-and-forget click tracking — never blocks the UI.
function track(event, label = '') {
  fetch('/api/track', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, label }),
  }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Small UI primitives
// ---------------------------------------------------------------------------
function Badge({ children, tone = 'gold' }) {
  const tones = {
    gold: 'bg-gold/15 text-gold border-gold/40',
    red: 'bg-red/15 text-red border-red/40',
    green: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40',
    slate: 'bg-cream/10 text-cream/70 border-cream/20',
    blue: 'bg-sky-500/15 text-sky-300 border-sky-500/40',
  };
  return (
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border transition-all duration-200 ${tones[tone] || tones.slate}`}>
      {children}
    </span>
  );
}

function statusTone(status) {
  if (status === 'Complete') return 'green';
  if (status === 'In Progress') return 'blue';
  return 'slate';
}

function roleLabel(role) {
  return { admin: 'Admin', manager: 'Manager', member: 'Member' }[role] || role;
}

function Button({ children, onClick, variant = 'primary', type = 'button', className = '', disabled }) {
  const variants = {
    primary: 'bg-red hover:bg-red/85 text-cream hover:shadow-lg hover:shadow-red/25',
    gold: 'bg-gold hover:bg-gold/85 text-navy font-semibold hover:shadow-lg hover:shadow-gold/20',
    ghost: 'bg-transparent border border-cream/25 hover:border-gold text-cream hover:text-gold',
    danger: 'bg-transparent border border-red/60 text-red hover:bg-red hover:text-cream',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 rounded-md text-sm transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed active:scale-95 ${variants[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-xs uppercase tracking-wider text-cream/60 mb-1">{label}</span>
      {children}
    </label>
  );
}

const inputCls =
  'w-full bg-navy border border-cream/20 rounded-md px-3 py-2 text-cream placeholder-cream/30 focus:outline-none focus:border-gold/80 focus:ring-2 focus:ring-gold/15 transition-colors';

// ---------------------------------------------------------------------------
// Shared UX primitives: loading, empty states, confirmation, retry, CSV export
// ---------------------------------------------------------------------------
function Spinner({ className = 'w-4 h-4' }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
    </svg>
  );
}

// Full-section loading placeholder.
function Loading({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-2 py-10 text-cream/50 text-sm ca-fade-in">
      <Spinner /> {label}
    </div>
  );
}

// Friendly empty state with an optional call-to-action.
function EmptyState({ icon = '📭', title, hint, action, className = '' }) {
  return (
    <div className={`text-center py-10 px-4 border border-dashed border-cream/15 rounded-lg ${className}`}>
      <div className="text-3xl mb-2 opacity-70">{icon}</div>
      {title && <div className="text-cream/80 font-medium">{title}</div>}
      {hint && <div className="text-sm text-cream/50 mt-1 max-w-md mx-auto">{hint}</div>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

// Error state with a Retry button, for failed loads.
function ErrorState({ message = 'Something went wrong.', onRetry }) {
  return (
    <div className="text-center py-8 px-4 border border-dashed border-red/30 rounded-lg">
      <div className="text-2xl mb-2">⚠️</div>
      <div className="text-cream/80 text-sm">{message}</div>
      {onRetry && <div className="mt-4 flex justify-center"><Button variant="ghost" onClick={onRetry}>Try again</Button></div>}
    </div>
  );
}

// Confirmation dialog component + a promise-based hook so any handler can do:
//   const [confirmEl, confirm] = useConfirm();
//   if (await confirm({ message: '…', danger: true })) { … }
function ConfirmDialog({ title = 'Are you sure?', message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[60] p-4" onClick={onCancel}>
      <div className="bg-navy2 border border-cream/15 rounded-xl p-5 max-w-sm w-full ca-scale-in" onClick={(e) => e.stopPropagation()}>
        <div className="font-display text-lg text-gold mb-1">{title}</div>
        {message && <p className="text-sm text-cream/70 mb-4 whitespace-pre-wrap">{message}</p>}
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" onClick={onCancel}>{cancelLabel}</Button>
          <Button variant={danger ? 'danger' : 'gold'} onClick={onConfirm}>{confirmLabel}</Button>
        </div>
      </div>
    </div>
  );
}

function useConfirm() {
  const [state, setState] = useState(null);
  const confirm = useCallback((opts) => new Promise((resolve) => {
    setState({ opts: typeof opts === 'string' ? { message: opts } : (opts || {}), resolve });
  }), []);
  const finish = (val) => { setState((s) => { if (s) s.resolve(val); return null; }); };
  const el = state ? (
    <ConfirmDialog {...state.opts} onConfirm={() => finish(true)} onCancel={() => finish(false)} />
  ) : null;
  return [el, confirm];
}

// Runs an async action while tracking loading + error — ideal for buttons/forms.
function useAction() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const run = useCallback(async (fn) => {
    setLoading(true); setError('');
    try { return await fn(); }
    catch (e) { setError((e && e.message) || 'Something went wrong'); throw e; }
    finally { setLoading(false); }
  }, []);
  return { loading, error, setError, run };
}

// Relative time for notifications etc. SQLite stores UTC as "YYYY-MM-DD HH:MM:SS".
function timeAgo(iso) {
  if (!iso) return '';
  const norm = iso.includes('T') ? iso : iso.replace(' ', 'T');
  const d = new Date(norm + (norm.endsWith('Z') ? '' : 'Z'));
  const secs = Math.floor((Date.now() - d.getTime()) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60); if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60); if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24); if (days < 7) return days + 'd ago';
  return d.toLocaleDateString();
}

// Format a "YYYY-MM-DD" date string as "Jun 5" for display in task cards.
function fmtShortDate(iso) {
  if (!iso) return '';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T12:00:00') : new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Trigger a client-side CSV download from an array of plain objects.
function downloadCSV(filename, rows) {
  if (!rows || !rows.length) return;
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const csv = [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Logo
// Drop your official artwork at public/logo.png and it shows automatically,
// overriding everything below. Until that file exists, we render a faithful
// recreation of the Club America wordmark using the brand colors and fonts.
// ---------------------------------------------------------------------------
const LOGO_SRC = '/logo.png';
const BRAND_NAVY = '#1A4E6E';
const BRAND_RED = '#CC1C2E';

// CSS recreation of the logo (script "Club America" + star + tagline).
function LogoMark({ big }) {
  return (
    <div className="text-center leading-none select-none">
      <div className="relative inline-block">
        <span
          className="block"
          style={{ fontFamily: '"Kaushan Script", cursive', color: BRAND_NAVY, fontSize: big ? '40px' : '20px', lineHeight: 1 }}
        >
          Club
        </span>
        <span
          className="block"
          style={{ fontFamily: '"Kaushan Script", cursive', color: BRAND_RED, fontSize: big ? '64px' : '30px', lineHeight: 0.9, marginTop: big ? '-6px' : '-3px' }}
        >
          America
        </span>
        <span
          aria-hidden="true"
          style={{ position: 'absolute', top: big ? '-6px' : '-3px', right: big ? '-22px' : '-12px', color: BRAND_RED, fontSize: big ? '34px' : '17px' }}
        >
          ★
        </span>
      </div>
      <div
        style={{ fontFamily: '"Bebas Neue", sans-serif', color: BRAND_NAVY, letterSpacing: '0.08em', fontSize: big ? '22px' : '11px', marginTop: big ? '6px' : '3px' }}
      >
        AT PARK CITY HIGH SCHOOL
      </div>
      <div
        style={{ fontFamily: '"DM Sans", sans-serif', color: BRAND_RED, fontWeight: 700, fontSize: big ? '11px' : '7px', letterSpacing: '0.05em', marginTop: big ? '6px' : '2px' }}
      >
        POWERED BY TPUSA
      </div>
    </div>
  );
}

function Logo({ size = 'sidebar' }) {
  const [failed, setFailed] = useState(false);
  const big = size === 'login';

  // The artwork uses navy lettering, so it sits on a white rounded panel to
  // stay legible against the dark navy app background.
  return (
    <div className={big ? 'flex justify-center' : ''}>
      <div className="bg-white rounded-xl p-3 inline-block shadow-lg">
        {failed ? (
          <LogoMark big={big} />
        ) : (
          <img
            src={LOGO_SRC}
            alt="Club America at Park City High School"
            onError={() => setFailed(true)}
            className={`object-contain ${big ? 'max-h-40 w-auto' : 'max-h-16 w-auto'}`}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Login + forced password change
// ---------------------------------------------------------------------------
function Login({ onLogin, onBack }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = await api('/auth/login', { method: 'POST', body: { username, password } });
      localStorage.setItem(TOKEN_KEY, data.token);
      onLogin(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 ca-fade-in">
      <div className="w-full max-w-md">
        <div className="mb-8 ca-slide-up">
          <Logo size="login" />
        </div>
        <form onSubmit={submit} className="bg-navy2 border border-cream/10 rounded-xl p-6 space-y-4 ca-slide-up" style={{ animationDelay: '60ms' }}>
          <Field label="Username">
            <input className={inputCls} value={username} autoFocus
              onChange={(e) => setUsername(e.target.value)} placeholder="e.g. fthomas" />
          </Field>
          <Field label="Password">
            <input className={inputCls} type="password" value={password}
              onChange={(e) => setPassword(e.target.value)} placeholder="Password" />
          </Field>
          {error && <div className="text-red text-sm">{error}</div>}
          <Button type="submit" variant="gold" className="w-full" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign In'}
          </Button>
          {onBack && (
            <button type="button" onClick={onBack} className="block mx-auto text-xs text-cream/50 hover:text-gold">
              ← Back to homepage
            </button>
          )}
        </form>
      </div>
    </div>
  );
}

function ChangePassword({ user, onDone, forced }) {
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (pw.length < 4) return setError('Password must be at least 4 characters');
    if (pw !== confirm) return setError('Passwords do not match');
    setLoading(true);
    try {
      const data = await api('/auth/change-password', { method: 'POST', body: { newPassword: pw } });
      if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
      onDone(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4 ca-fade-in">
      <form onSubmit={submit} className="w-full max-w-md bg-navy2 border border-cream/10 rounded-xl p-6 space-y-4 ca-scale-in">
        <div className="font-display text-3xl text-gold">{forced ? 'Set Your Password' : 'Change Password'}</div>
        {forced && (
          <p className="text-sm text-cream/60">
            Welcome, {user.displayName}. For security you must replace your default
            password before continuing.
          </p>
        )}
        <Field label="New Password">
          <input className={inputCls} type="password" value={pw} autoFocus
            onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Field label="Confirm Password">
          <input className={inputCls} type="password" value={confirm}
            onChange={(e) => setConfirm(e.target.value)} />
        </Field>
        {error && <div className="text-red text-sm">{error}</div>}
        <Button type="submit" variant="gold" className="w-full" disabled={loading}>
          {loading ? 'Saving…' : 'Save Password'}
        </Button>
      </form>
    </div>
  );
}

// Read an image file and downscale it to a square-ish data URL (keeps payload small).
function resizeImage(file, max, cb) {
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, max / Math.max(width, height));
      const w = Math.round(width * scale), h = Math.round(height * scale);
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      cb(c.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => cb(null);
    img.src = ev.target.result;
  };
  reader.onerror = () => cb(null);
  reader.readAsDataURL(file);
}

// Interactive square-crop modal backed by a canvas.
// `src` is the raw (full-size) image data URL; `onCrop` receives the cropped JPEG data URL.
function CropModal({ src, onCrop, onCancel }) {
  const [crop, setCrop] = useState(null);
  const [drag, setDrag] = useState(null);
  const imgRef = useRef(null);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });

  function initCrop(img) {
    const dw = img.offsetWidth, dh = img.offsetHeight;
    setImgSize({ w: dw, h: dh });
    const size = Math.round(Math.min(dw, dh) * 0.8);
    setCrop({ x: Math.round((dw - size) / 2), y: Math.round((dh - size) / 2), size });
  }

  function onImgLoad(e) { initCrop(e.target); }

  function startDrag(e, type) {
    e.preventDefault();
    setDrag({ type, sx: e.clientX, sy: e.clientY, crop: { ...crop } });
  }

  function onMove(e) {
    if (!drag) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    const { x: ox, y: oy, size: os } = drag.crop;
    const { w: dw, h: dh } = imgSize;
    if (drag.type === 'move') {
      setCrop({ x: Math.max(0, Math.min(dw - os, ox + dx)), y: Math.max(0, Math.min(dh - os, oy + dy)), size: os });
      return;
    }
    let d;
    if (drag.type === 'se') d = Math.min(dx, dy);
    else if (drag.type === 'sw') d = Math.min(-dx, dy);
    else if (drag.type === 'ne') d = Math.min(dx, -dy);
    else d = Math.min(-dx, -dy);
    let ns = Math.max(50, os + d), nx = ox, ny = oy;
    if (drag.type === 'se') {
      ns = Math.min(ns, dw - ox, dh - oy);
    } else if (drag.type === 'sw') {
      nx = ox + os - ns; if (nx < 0) { ns += nx; nx = 0; } ns = Math.min(ns, dh - oy);
    } else if (drag.type === 'ne') {
      ny = oy + os - ns; if (ny < 0) { ns += ny; ny = 0; } ns = Math.min(ns, dw - ox);
    } else {
      nx = ox + os - ns; ny = oy + os - ns;
      if (nx < 0) { ns += nx; nx = 0; ny = oy + os - ns; }
      if (ny < 0) { ns += ny; ny = 0; nx = ox + os - ns; }
    }
    if (nx + ns > dw) ns = dw - nx;
    if (ny + ns > dh) ns = dh - ny;
    setCrop({ x: Math.round(nx), y: Math.round(ny), size: Math.max(50, Math.round(ns)) });
  }

  function applyCrop() {
    const img = imgRef.current;
    if (!img || !crop) return;
    const sx = img.naturalWidth / imgSize.w, sy = img.naturalHeight / imgSize.h;
    const c = document.createElement('canvas');
    c.width = 512; c.height = 512;
    c.getContext('2d').drawImage(img, crop.x * sx, crop.y * sy, crop.size * sx, crop.size * sy, 0, 0, 512, 512);
    onCrop(c.toDataURL('image/jpeg', 0.82));
  }

  const HS = 14;
  return (
    <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50 p-4"
      onMouseMove={onMove} onMouseUp={() => setDrag(null)} onMouseLeave={() => setDrag(null)}>
      <div className="bg-navy2 border border-cream/10 rounded-xl p-5 max-w-2xl w-full ca-scale-in">
        <div className="font-display text-xl text-gold mb-1">Crop Photo</div>
        <p className="text-xs text-cream/50 mb-3">Drag the circle to reposition · drag a corner to resize</p>
        <div className="relative inline-block select-none">
          <img ref={imgRef} src={src} alt="" className="block max-h-96 max-w-full rounded" onLoad={onImgLoad} draggable={false} />
          {crop && imgSize.w > 0 && (
            <>
              <svg className="absolute inset-0 pointer-events-none" width={imgSize.w} height={imgSize.h}>
                <defs>
                  <mask id="cm">
                    <rect width={imgSize.w} height={imgSize.h} fill="white" />
                    <circle cx={crop.x + crop.size / 2} cy={crop.y + crop.size / 2} r={crop.size / 2} fill="black" />
                  </mask>
                </defs>
                <rect width={imgSize.w} height={imgSize.h} fill="rgba(0,0,0,0.6)" mask="url(#cm)" />
                <circle cx={crop.x + crop.size / 2} cy={crop.y + crop.size / 2} r={crop.size / 2}
                  fill="none" stroke="white" strokeWidth="2" strokeDasharray="6 3" />
              </svg>
              <div className="absolute rounded-full cursor-move"
                style={{ left: crop.x, top: crop.y, width: crop.size, height: crop.size }}
                onMouseDown={(e) => startDrag(e, 'move')} />
              {[['nw', 0, 0], ['ne', crop.size - HS, 0], ['sw', 0, crop.size - HS], ['se', crop.size - HS, crop.size - HS]].map(([id, cx, cy]) => (
                <div key={id} className="absolute bg-white border border-gold/60 rounded-sm"
                  style={{ left: crop.x + cx, top: crop.y + cy, width: HS, height: HS, cursor: `${id}-resize`, zIndex: 10 }}
                  onMouseDown={(e) => { e.stopPropagation(); startDrag(e, id); }} />
              ))}
            </>
          )}
        </div>
        <div className="flex gap-2 mt-4">
          <button type="button" className="bg-gold text-navy font-semibold px-4 py-2 rounded-md text-sm hover:bg-gold/90" onClick={applyCrop}>Apply Crop</button>
          <button type="button" className="border border-cream/25 text-cream px-4 py-2 rounded-md text-sm hover:border-cream/50" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// Profile setup — runs right after the password step on first login, and is
// reachable later via "Edit profile". Collects a photo and an intro bio.
function ProfileSetup({ me, forced, onDone, onSkip }) {
  const [photo, setPhoto] = useState('');
  const [rawSrc, setRawSrc] = useState(''); // original file src for re-cropping
  const [bio, setBio] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [cropping, setCropping] = useState(false);

  useEffect(() => {
    api('/me/profile').then((d) => { setPhoto(d.photo || ''); setBio(d.bio || ''); setEmail(d.email || ''); setPhone(d.phone || ''); }).catch(() => {});
  }, []);

  function onFile(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { setError('Please choose an image file (JPG, PNG, or WebP).'); return; }
    // Reject oversized files up front, before showing the crop UI.
    const MAX_MB = 10;
    if (f.size > MAX_MB * 1024 * 1024) {
      setError(`That image is ${(f.size / (1024 * 1024)).toFixed(1)} MB — please choose one under ${MAX_MB} MB.`);
      return;
    }
    setError('');
    const reader = new FileReader();
    reader.onload = (ev) => { setRawSrc(ev.target.result); setCropping(true); };
    reader.onerror = () => setError("Couldn't read that image — try another.");
    reader.readAsDataURL(f);
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (forced && !photo) { setError('Please add a professional headshot.'); return; }
    if (forced && bio.trim().length < 40) { setError('Please write a short intro — a sentence or two about yourself.'); return; }
    if (forced && !email.trim()) { setError('Please add an email so you get notified about tasks and approvals.'); return; }
    setLoading(true);
    try {
      const d = await api('/me/profile', { method: 'PUT', body: { photo, bio, email, phone } });
      onDone(d.user);
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  const card = (
    <div className="w-full max-w-lg bg-navy2 border border-cream/10 rounded-xl p-6 space-y-4">
      <div>
        <div className="font-display text-3xl text-gold">{forced ? 'Set Up Your Profile' : 'Edit Profile'}</div>
        {forced && <p className="text-sm text-cream/60 mt-1">Welcome, {me.displayName.split(' ')[0]}! Add a professional photo and a short intro — this is what the public sees on the Meet the Board page.</p>}
      </div>

      <div className="flex items-center gap-4">
        <div className="w-24 h-24 rounded-full bg-navy3 border-2 border-gold/40 overflow-hidden flex items-center justify-center shrink-0">
          {photo
            ? <img src={photo} alt="preview" className="w-full h-full object-cover" />
            : <span className="text-cream/40 text-xs text-center px-2">No photo</span>}
        </div>
        <div className="space-y-2">
          <label className="cursor-pointer block">
            <span className="inline-block bg-transparent border border-cream/25 hover:border-gold text-cream text-sm px-4 py-2 rounded-md">Choose photo…</span>
            <input type="file" accept="image/*" className="hidden" onChange={onFile} />
          </label>
          {photo && rawSrc && (
            <button type="button" className="text-xs text-gold/80 hover:text-gold underline-offset-2 hover:underline"
              onClick={() => setCropping(true)}>Re-crop</button>
          )}
          <div className="text-xs text-cream/40">A clear, professional headshot.</div>
        </div>
      </div>

      <Field label="Email (for task & approval notifications)">
        <input type="email" className={inputCls} value={email}
          onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      </Field>

      <Field label="Phone (optional — shown in Board Directory)">
        <input type="tel" className={inputCls} value={phone}
          onChange={(e) => setPhone(e.target.value)} placeholder="(555) 000-0000" />
      </Field>

      <Field label="Introduce yourself (a paragraph or two)">
        <textarea className={inputCls + ' min-h-[140px] resize-y'} value={bio}
          onChange={(e) => setBio(e.target.value)} placeholder="Tell the club a bit about you — your year, what you're involved in, and why you're part of Club America." />
      </Field>

      {error && <div className="text-red text-sm">{error}</div>}
      <div className="flex gap-2">
        <Button type="submit" variant="gold" disabled={loading}>{loading ? 'Saving…' : 'Save Profile'}</Button>
        {forced && onSkip && <Button variant="ghost" onClick={onSkip}>Skip for now</Button>}
      </div>
    </div>
  );

  const cropModal = cropping && rawSrc && (
    <CropModal
      src={rawSrc}
      onCrop={(cropped) => { setPhoto(cropped); setCropping(false); }}
      onCancel={() => setCropping(false)}
    />
  );

  if (forced) {
    return <>{cropModal}<form onSubmit={submit} className="min-h-screen flex items-center justify-center p-4 ca-fade-in">{card}</form></>;
  }
  return <>{cropModal}<form onSubmit={submit} className="max-w-lg">{card}</form></>;
}

// ---------------------------------------------------------------------------
// Task page (used for self and for managed reports)
// ---------------------------------------------------------------------------
const DAY_LABELS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function TaskCard({ task, canEdit, onChange, onDelete, me }) {
  const [saving, setSaving] = useState(false);
  const recurringDays = task.isRecurring && task.recurringDays
    ? String(task.recurringDays).split(',').map(Number).filter((d) => d >= 0 && d <= 6).map((d) => DAY_LABELS[d]).join(', ')
    : null;
  const safeDocUrl = task.docUrl ? (task.docUrl.startsWith('http://') || task.docUrl.startsWith('https://') ? task.docUrl : 'https://' + task.docUrl) : '';
  return (
    <div className="bg-navy2 border border-cream/10 rounded-lg p-4 hover:border-cream/25 hover:-translate-y-0.5 hover:shadow-md hover:shadow-black/25 transition-all duration-200">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-cream truncate">{task.name}</div>
          {task.description && <div className="text-sm text-cream/60 mt-1 whitespace-pre-wrap">{task.description}</div>}
          {safeDocUrl && (
            <a href={safeDocUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-2 text-xs text-sky-300 hover:text-sky-200 transition-colors">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>
              Open Document
            </a>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Badge tone={statusTone(task.status)}>{task.status}</Badge>
          {recurringDays && <span className="text-[10px] text-gold/70">↻ {recurringDays}</span>}
        </div>
      </div>
      <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-cream/50">
        {task.dueDate && <span>Due {fmtShortDate(task.dueDate)}</span>}
        <span>Assigned by <span className="text-gold/80">{task.assignedByName}</span></span>
        {task.approvalStatus === 'pending' && <Badge tone="red">Pending approval</Badge>}
      </div>
      {canEdit && task.approvalStatus === 'approved' && (
        <div className="flex items-center gap-2 mt-3">
          <div className="flex items-center gap-2">
            <select
              className="bg-navy border border-cream/20 rounded px-2 py-1 text-sm disabled:opacity-50"
              value={task.status}
              disabled={saving}
              onChange={async (e) => {
                setSaving(true);
                try { await onChange(task, { status: e.target.value }); } catch (_) {}
                finally { setSaving(false); }
              }}
            >
              <option>Not Started</option>
              <option>In Progress</option>
              <option>Complete</option>
            </select>
            {saving && <span className="flex items-center gap-1 text-xs text-cream/40"><Spinner className="w-3 h-3" /> Saving…</span>}
          </div>
          {onDelete && (
            <button onClick={() => onDelete(task)} className="text-xs text-red/80 hover:text-red ml-auto">
              Delete
            </button>
          )}
        </div>
      )}
      {me && <TaskComments taskId={task.id} me={me} />}
    </div>
  );
}

function RecurringDaysPicker({ value, onChange }) {
  const days = value || [];
  function toggle(d) {
    if (days.includes(d)) onChange(days.filter((x) => x !== d));
    else onChange([...days, d].sort((a, b) => a - b));
  }
  return (
    <div>
      <span className="block text-xs uppercase tracking-wider text-cream/60 mb-1.5">Repeat on days</span>
      <div className="flex gap-1.5 flex-wrap">
        {DAY_LABELS.map((label, d) => (
          <button key={d} type="button" onClick={() => toggle(d)}
            className={`px-2.5 py-1 rounded text-xs font-medium transition-all duration-150 ${days.includes(d) ? 'bg-gold text-navy' : 'bg-navy border border-cream/20 text-cream/60 hover:border-gold/50 hover:text-gold'}`}>
            {label}
          </button>
        ))}
      </div>
      {days.length > 0 && <div className="text-[11px] text-gold/60 mt-1">↻ Repeats {days.map((d) => DAY_LABELS[d]).join(', ')}</div>}
    </div>
  );
}

function NewTaskForm({ targetUserId, onCreated }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [docUrl, setDocUrl] = useState('');
  const [recurringDays, setRecurringDays] = useState([]);
  const { loading, error, setError, run } = useAction();

  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) { setError('Please enter a task name.'); return; }
    if (dueDate && dueDate < new Date().toISOString().slice(0, 10)) { setError("Due date can't be in the past."); return; }
    try {
      await run(() => api('/tasks', { method: 'POST', body: {
        name: name.trim(), description: description.trim(), dueDate: dueDate || null, targetUserId,
        docUrl: docUrl.trim(), isRecurring: recurringDays.length > 0 ? 1 : 0, recurringDays: recurringDays.join(','),
      }}));
      setName(''); setDescription(''); setDueDate(''); setDocUrl(''); setRecurringDays([]); setOpen(false);
      onCreated();
    } catch (_) {}
  }

  if (!open) return <Button variant="ghost" onClick={() => setOpen(true)}>+ New Task</Button>;
  return (
    <form onSubmit={submit} className="bg-navy2 border border-gold/30 rounded-lg p-4 space-y-3 ca-slide-up">
      <Field label="Task Name"><input className={inputCls} value={name} autoFocus onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Description"><textarea className={inputCls} rows="2" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="Due Date"><input type="date" className={inputCls} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
      <Field label="Document URL (optional)"><input className={inputCls} value={docUrl} placeholder="https://docs.google.com/…" onChange={(e) => setDocUrl(e.target.value)} /></Field>
      <RecurringDaysPicker value={recurringDays} onChange={setRecurringDays} />
      {error && <div className="text-red text-sm">{error}</div>}
      <div className="flex gap-2">
        <Button type="submit" variant="gold" disabled={loading || !name.trim()}>{loading ? <span className="flex items-center gap-2"><Spinner /> Creating…</span> : 'Create'}</Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={loading}>Cancel</Button>
      </div>
    </form>
  );
}

function AssignTaskForm({ me, users, onCreated }) {
  const [open, setOpen] = useState(false);
  const [targetUserId, setTargetUserId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [docUrl, setDocUrl] = useState('');
  const [recurringDays, setRecurringDays] = useState([]);
  const [msg, setMsg] = useState('');
  const { loading, error, setError, run } = useAction();

  const others = users.filter((u) => u.id !== me.id);

  async function submit(e) {
    e.preventDefault();
    setMsg('');
    if (!targetUserId) { setError('Please choose who to send this to.'); return; }
    if (!name.trim()) { setError('Please enter a task name.'); return; }
    if (dueDate && dueDate < new Date().toISOString().slice(0, 10)) { setError("Due date can't be in the past."); return; }
    try {
      const data = await run(() => api('/tasks', { method: 'POST', body: {
        name: name.trim(), description: description.trim(), dueDate: dueDate || null, targetUserId: Number(targetUserId),
        docUrl: docUrl.trim(), isRecurring: recurringDays.length > 0 ? 1 : 0, recurringDays: recurringDays.join(','),
      }}));
      setName(''); setDescription(''); setDueDate(''); setDocUrl(''); setRecurringDays([]); setTargetUserId('');
      setMsg(data.task.approvalStatus === 'pending'
        ? 'Sent — awaiting manager approval.'
        : 'Task assigned.');
      onCreated();
    } catch (_) {}
  }

  if (!open) return <Button variant="ghost" onClick={() => setOpen(true)}>↗ Send Task to Someone</Button>;
  return (
    <form onSubmit={submit} className="bg-navy2 border border-cream/15 rounded-lg p-4 space-y-3 ca-slide-up">
      <div className="font-display text-xl text-gold">Send a Task</div>
      <Field label="To">
        <select className={inputCls} value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)}>
          <option value="">Select a board member…</option>
          {others.map((u) => <option key={u.id} value={u.id}>{u.displayName} — {u.title || roleLabel(u.role)}</option>)}
        </select>
      </Field>
      <Field label="Task Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Description"><textarea className={inputCls} rows="2" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="Due Date"><input type="date" className={inputCls} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
      <Field label="Document URL (optional)"><input className={inputCls} value={docUrl} placeholder="https://docs.google.com/…" onChange={(e) => setDocUrl(e.target.value)} /></Field>
      <RecurringDaysPicker value={recurringDays} onChange={setRecurringDays} />
      {me.role !== 'admin' && <p className="text-xs text-cream/40">Tasks you send are held until the recipient's manager approves them.</p>}
      {error && <div className="text-red text-sm">{error}</div>}
      {msg && <div className="text-emerald-300 text-sm">{msg}</div>}
      <div className="flex gap-2">
        <Button type="submit" variant="gold" disabled={loading}>{loading ? <span className="flex items-center gap-2"><Spinner /> Sending…</span> : 'Send'}</Button>
        <Button variant="ghost" onClick={() => { setOpen(false); setMsg(''); setError(''); }} disabled={loading}>Close</Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Per-user page feature sections & admin toggle panel
// ---------------------------------------------------------------------------
function Toggle({ enabled, onChange, disabled }) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      aria-pressed={!!enabled}
      className={`relative w-12 h-7 rounded-full transition-all duration-200 disabled:opacity-50 shrink-0 ${enabled ? 'bg-emerald-500 shadow-md shadow-emerald-500/30' : 'bg-cream/20'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white shadow transition-all duration-200 ${enabled ? 'translate-x-5' : ''}`} />
    </button>
  );
}

function BannerSection({ title, url }) {
  const safeUrl = ensureHttps(url);
  return (
    <a
      href={safeUrl || '#'}
      target={safeUrl && safeUrl !== '#' ? '_blank' : undefined}
      rel="noopener noreferrer"
      className="block w-full bg-gold/15 border border-gold/40 rounded-xl px-6 py-5 text-center font-display text-2xl text-gold hover:bg-gold/25 hover:border-gold/70 hover:shadow-md hover:shadow-gold/10 transition-all duration-200 active:scale-[0.99] mb-6"
    >
      {title || 'Click Here →'}
    </a>
  );
}

function AnnouncementSection({ text }) {
  return (
    <div className="bg-red/10 border-l-4 border-red rounded-r-xl px-5 py-4 mb-6 flex gap-3 items-start">
      <span className="text-xl mt-0.5 shrink-0">📌</span>
      <div className="text-cream whitespace-pre-wrap">{text}</div>
    </div>
  );
}


function CopyableFormSection({ title, fields }) {
  const parsedFields = useMemo(() => {
    if (Array.isArray(fields)) return fields;
    try { return JSON.parse(fields || '[]'); } catch (_) { return []; }
  }, [fields]);

  const [values, setValues] = useState({});
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');

  function setField(field, val) {
    setValues((v) => ({ ...v, [field]: val }));
  }

  async function copyToClipboard() {
    const heading = title || 'Form Submission';
    const lines = [`📋 ${heading}`, ''];
    for (const f of parsedFields) {
      lines.push(`${f}: ${values[f] || '—'}`);
    }
    lines.push('', `Submitted: ${new Date().toLocaleDateString()}`);
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      setCopyError('');
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {
      setCopyError('Copy failed — please copy manually.');
    }
  }

  if (parsedFields.length === 0) return null;

  return (
    <div className="bg-navy2 border border-cream/10 rounded-xl p-5 mb-6">
      <div className="font-display text-2xl text-gold mb-4">{title || 'Log'}</div>
      <div className="grid sm:grid-cols-2 gap-3 mb-4">
        {parsedFields.map((f) => (
          <Field key={f} label={f}>
            <input className={inputCls} value={values[f] || ''} onChange={(e) => setField(f, e.target.value)} placeholder={`Enter ${f.toLowerCase()}…`} />
          </Field>
        ))}
      </div>
      <Button variant="gold" onClick={copyToClipboard}>
        {copied ? '✓ Copied to Clipboard!' : 'Copy to Clipboard'}
      </Button>
      {copyError && <p className="text-xs text-red mt-2">{copyError}</p>}
      {!copyError && <p className="text-xs text-cream/40 mt-2">Fill in the fields above, then copy and paste anywhere.</p>}
    </div>
  );
}

function PageAdminControls({ targetUser, onUpdated }) {
  const [settings, setSettings] = useState(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fieldInput, setFieldInput] = useState('');
  const [error, setError] = useState('');

  async function load() {
    setError('');
    try {
      const d = await api(`/users/${targetUser.id}/page-settings`);
      setSettings(d.settings);
      setFieldInput(d.settings.formFields.join(', '));
    } catch (err) { setError(err.message); }
  }

  useEffect(() => { if (open) load(); }, [open, targetUser.id]);

  async function save(patch) {
    setBusy(true);
    setError('');
    try {
      const d = await api(`/users/${targetUser.id}/page-settings`, { method: 'PUT', body: patch });
      setSettings(d.settings);
      if (patch.formFields !== undefined) setFieldInput(d.settings.formFields.join(', '));
      onUpdated && onUpdated(d.settings);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function toggle(key) {
    if (!settings || busy) return;
    await save({ [key]: !settings[key] });
  }

  if (!open) return (
    <div className="mb-4">
      <button
        onClick={() => setOpen(true)}
        className="text-sm text-gold/60 hover:text-gold flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gold/20 hover:border-gold/50 transition-all duration-150 active:scale-95"
      >
        ⚙ Page Settings
      </button>
    </div>
  );

  return (
    <div className="bg-navy2 border border-gold/30 rounded-xl p-5 mb-6 ca-slide-up">
      <div className="flex items-center justify-between mb-5">
        <div className="font-display text-xl text-gold">Page Settings — {targetUser.displayName}</div>
        <button onClick={() => setOpen(false)} className="text-cream/50 hover:text-cream text-2xl leading-none">×</button>
      </div>

      {!settings ? (
        <div className="text-cream/40 text-sm">Loading…</div>
      ) : (
        <div className="divide-y divide-cream/10">

          <div className="py-4 first:pt-0">
            <div className="flex items-start justify-between gap-4 mb-2">
              <div>
                <div className="text-cream font-medium">Full-Width Banner Link</div>
                <div className="text-cream/50 text-sm">A prominent full-screen-wide button linking to any URL.</div>
              </div>
              <Toggle enabled={settings.bannerEnabled} onChange={() => toggle('bannerEnabled')} disabled={busy} />
            </div>
            {settings.bannerEnabled && (
              <div className="grid sm:grid-cols-2 gap-3 mt-3">
                <Field label="Button Text / Title">
                  <input className={inputCls} defaultValue={settings.bannerTitle}
                    onBlur={(e) => e.target.value !== settings.bannerTitle && save({ bannerTitle: e.target.value })}
                    placeholder="e.g. View Chapter Resources" />
                </Field>
                <Field label="Link URL">
                  <input className={inputCls} defaultValue={settings.bannerUrl}
                    onBlur={(e) => e.target.value !== settings.bannerUrl && save({ bannerUrl: e.target.value })}
                    placeholder="https://…" />
                </Field>
              </div>
            )}
          </div>

          <div className="py-4">
            <div className="flex items-start justify-between gap-4 mb-2">
              <div>
                <div className="text-cream font-medium">Pinned Announcement</div>
                <div className="text-cream/50 text-sm">A highlighted note visible at the top of their page.</div>
              </div>
              <Toggle enabled={settings.announcementEnabled} onChange={() => toggle('announcementEnabled')} disabled={busy} />
            </div>
            {settings.announcementEnabled && (
              <div className="mt-3">
                <Field label="Announcement Text">
                  <textarea className={inputCls} rows="2" defaultValue={settings.announcementText}
                    onBlur={(e) => e.target.value !== settings.announcementText && save({ announcementText: e.target.value })}
                    placeholder="e.g. Please submit your weekly report by Friday." />
                </Field>
              </div>
            )}
          </div>

          <div className="py-4">
            <div className="flex items-start justify-between gap-4 mb-2">
              <div>
                <div className="text-cream font-medium">Copyable Log Form</div>
                <div className="text-cream/50 text-sm">A fillable form the member copies to clipboard (e.g. recruitment quota log).</div>
              </div>
              <Toggle enabled={settings.formEnabled} onChange={() => toggle('formEnabled')} disabled={busy} />
            </div>
            {settings.formEnabled && (
              <div className="mt-3 space-y-3">
                <Field label="Form Title">
                  <input className={inputCls} defaultValue={settings.formTitle}
                    onBlur={(e) => e.target.value !== settings.formTitle && save({ formTitle: e.target.value })}
                    placeholder="e.g. Recruitment Log" />
                </Field>
                <Field label="Fields (comma-separated)">
                  <input className={inputCls} value={fieldInput}
                    onChange={(e) => setFieldInput(e.target.value)}
                    onBlur={() => save({ formFields: fieldInput.split(',').map((f) => f.trim()).filter(Boolean) })}
                    placeholder="e.g. Grade, Week, New Members, Running Total" />
                </Field>
                {settings.formFields.length > 0 && (
                  <div className="text-xs text-cream/40">Current fields: {settings.formFields.join(', ')}</div>
                )}
              </div>
            )}
          </div>

          <div className="py-4 pb-0">
            <div className="flex items-start justify-between gap-4 mb-2">
              <div>
                <div className="text-cream font-medium">Bio / About Section</div>
                <div className="text-cream/50 text-sm">A short bio or description shown at the top of their My Page.</div>
              </div>
              <Toggle enabled={settings.bioEnabled} onChange={() => toggle('bioEnabled')} disabled={busy} />
            </div>
            {settings.bioEnabled && (
              <div className="mt-3">
                <Field label="Bio Text">
                  <textarea className={inputCls} rows="3" defaultValue={settings.bioText}
                    onBlur={(e) => e.target.value !== settings.bioText && save({ bioText: e.target.value })}
                    placeholder="e.g. Grade 11 · Public Engagement · passionate about community outreach." />
                </Field>
              </div>
            )}
          </div>

        </div>
      )}
      {error && <div className="text-red text-sm mt-3">{error}</div>}
    </div>
  );
}

function TeamAnnouncementsDisplay({ announcements }) {
  if (!announcements || announcements.length === 0) return null;
  return (
    <div className="space-y-3 mb-6">
      {announcements.map((a) => (
        <div key={a.id} className="bg-gold/10 border border-gold/40 rounded-xl px-5 py-4 flex gap-3 items-start">
          <span className="text-xl mt-0.5 shrink-0">📢</span>
          <div>
            <div className="text-xs text-gold/70 mb-1">{a.authorName}{a.authorTitle ? ` · ${a.authorTitle}` : ''}</div>
            <div className="text-cream whitespace-pre-wrap">{a.text}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function TeamAnnouncementView({ me, reports }) {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/team-announcement')
      .then((d) => { if (d.announcement) setText(d.announcement.text); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, []);

  async function publish() {
    setBusy(true); setError(''); setSaved(false);
    try {
      await api('/team-announcement', { method: 'PUT', body: { text } });
      setSaved(true);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const [confirmEl, confirm] = useConfirm();

  async function remove() {
    if (!(await confirm({ title: 'Remove announcement?', message: "This will disappear from your reports' pages.", confirmLabel: 'Remove', danger: true }))) return;
    setBusy(true); setSaved(false);
    try {
      await api('/team-announcement', { method: 'DELETE' });
      setText('');
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const scope = me.role === 'admin'
    ? 'all board members'
    : reports.length > 0
      ? `your ${reports.length} direct report${reports.length === 1 ? '' : 's'}`
      : 'your direct reports';

  return (
    <div className="max-w-2xl">
      {confirmEl}
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-2">Team Announcement</h1>
      <p className="text-cream/50 mb-6">
        Post a message that appears at the top of the My Page for {scope}. One active announcement at a time.
      </p>

      {!loaded ? <div className="text-cream/40">Loading…</div> : (
        <div className="bg-navy2 border border-cream/10 rounded-xl p-5 space-y-4">
          <Field label="Announcement">
            <textarea
              className={inputCls} rows="4"
              value={text}
              onChange={(e) => { setText(e.target.value); setSaved(false); }}
              placeholder="e.g. Reminder: chapter meeting this Thursday at 3:30 PM in Room 214." />
          </Field>
          {error && <div className="text-red text-sm">{error}</div>}
          {saved && <div className="text-emerald-300 text-sm">✓ Published — now visible to {scope}.</div>}
          <div className="flex gap-2 flex-wrap">
            <Button variant="gold" onClick={publish} disabled={busy || !text.trim()}>
              {busy ? 'Saving…' : 'Publish'}
            </Button>
            {text.trim() && (
              <Button variant="danger" onClick={remove} disabled={busy}>Remove</Button>
            )}
          </div>
        </div>
      )}

      {text.trim() && (
        <div className="mt-6">
          <div className="text-xs text-cream/50 uppercase tracking-wider mb-2">How reports see it</div>
          <div className="bg-gold/10 border border-gold/40 rounded-xl px-5 py-4 flex gap-3 items-start">
            <span className="text-xl mt-0.5 shrink-0">📢</span>
            <div>
              <div className="text-xs text-gold/70 mb-1">{me.displayName}{me.title ? ` · ${me.title}` : ''}</div>
              <div className="text-cream whitespace-pre-wrap">{text}</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskPage({ me, userId, users, refreshSignal }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [pageSettings, setPageSettings] = useState(null);
  const [teamAnnouncements, setTeamAnnouncements] = useState([]);
  const [confirmEl, confirm] = useConfirm();
  const isSelf = userId === me.id;
  const canManagePage = !isSelf && (me.role === 'admin' || me.role === 'manager');

  const load = useCallback(async () => {
    setError('');
    try {
      const [taskData, settingsData, annData] = await Promise.all([
        api(`/users/${userId}/tasks`),
        api(`/users/${userId}/page-settings`).catch(() => ({ settings: {} })),
        api(`/users/${userId}/announcements`).catch(() => ({ announcements: [] })),
      ]);
      setData(taskData);
      setPageSettings(settingsData.settings);
      setTeamAnnouncements(annData.announcements || []);
    } catch (err) { setError(err.message); }
  }, [userId]);

  useEffect(() => { load(); }, [load, refreshSignal]);

  async function changeTask(task, patch) {
    try {
      await api(`/tasks/${task.id}`, { method: 'PATCH', body: patch });
      load();
    } catch (err) { setError(err.message); }
  }
  async function deleteTask(task) {
    if (!(await confirm({ title: 'Delete task?', message: `“${task.name}” will be permanently removed.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api(`/tasks/${task.id}`, { method: 'DELETE' });
      load();
    } catch (err) { setError(err.message); }
  }

  function reloadSettings(newSettings) {
    if (newSettings) {
      setPageSettings(newSettings);
    } else {
      api(`/users/${userId}/page-settings`)
        .then((d) => setPageSettings(d.settings))
        .catch(() => {});
    }
  }

  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <Loading label="Loading page…" />;

  const { user, tasks } = data;
  const ps = pageSettings || {};
  const grouped = {
    'Not Started': tasks.filter((t) => t.status === 'Not Started'),
    'In Progress': tasks.filter((t) => t.status === 'In Progress'),
    'Complete': tasks.filter((t) => t.status === 'Complete'),
  };

  return (
    <div className="max-w-5xl">
      {confirmEl}
      {error && (
        <div className="mb-4 flex items-center justify-between gap-3 bg-red/10 border border-red/30 rounded-md px-3 py-2 text-sm text-red">
          <span>{error}</span>
          <button className="text-red/70 hover:text-red" onClick={() => setError('')}>✕</button>
        </div>
      )}
      <div className="flex items-end justify-between mb-6 flex-wrap gap-2">
        <div>
          <h1 className="font-display text-4xl sm:text-5xl text-cream leading-none">
            {isSelf ? 'My Page' : user.displayName}
          </h1>
          <div className="text-cream/50 mt-1">{user.title || roleLabel(user.role)} · @{user.username}</div>
        </div>
        <Badge tone="gold">{tasks.length} task{tasks.length === 1 ? '' : 's'}</Badge>
      </div>

      <TeamAnnouncementsDisplay announcements={teamAnnouncements} />

      {canManagePage && <PageAdminControls targetUser={user} onUpdated={reloadSettings} />}

      {ps.bannerEnabled && <BannerSection title={ps.bannerTitle} url={ps.bannerUrl} />}
      {ps.announcementEnabled && <AnnouncementSection text={ps.announcementText} />}
      {ps.bioEnabled && <BioSection text={ps.bioText} />}
      {ps.formEnabled && <CopyableFormSection title={ps.formTitle} fields={ps.formFields} />}

      <div className="space-y-3 mb-6">
        <NewTaskForm targetUserId={isSelf ? undefined : userId} onCreated={load} />
        {isSelf && <AssignTaskForm me={me} users={users} onCreated={load} />}
      </div>

      {tasks.length === 0 && (
        <EmptyState
          icon="✅"
          title={isSelf ? 'No tasks yet' : `${user.displayName.split(' ')[0]} has no tasks yet`}
          hint={isSelf ? 'Use “+ New Task” above to add your first one, or send a task to a teammate.' : 'Use “+ New Task” above to assign them something to work on.'}
        />
      )}

      {tasks.length > 0 && <div className="grid md:grid-cols-3 gap-4">
        {['Not Started', 'In Progress', 'Complete'].map((col) => (
          <div key={col}>
            <div className="font-display text-xl text-gold mb-2">{col} <span className="text-cream/30 text-base">({grouped[col].length})</span></div>
            <div className="space-y-3">
              {grouped[col].map((t) => (
                <TaskCard key={t.id} task={t} canEdit={true} onChange={changeTask} onDelete={deleteTask} me={me} />
              ))}
            </div>
          </div>
        ))}
      </div>}

      {isSelf && (
        <div className="mt-10">
          <MeetTheBoard />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pending Approvals
// ---------------------------------------------------------------------------
function Approvals({ onChanged, refreshSignal }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null); // `${id}:${action}`
  const load = useCallback(async () => {
    setError('');
    try { const d = await api('/approvals'); setItems(d.approvals); }
    catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load, refreshSignal]);

  async function act(task, action) {
    setBusy(`${task.id}:${action}`);
    setError('');
    try {
      await api(`/tasks/${task.id}/${action}`, { method: 'POST' });
      await load();
      onChanged && onChanged();
    } catch (err) { setError(err.message); }
    finally { setBusy(null); }
  }

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-6">Pending Approvals</h1>
      {error && <div className="mb-4"><ErrorState message={error} onRetry={load} /></div>}
      {items === null && !error && <Loading label="Loading approvals…" />}
      {items !== null && items.length === 0 && (
        <EmptyState icon="🎉" title="You're all caught up" hint="Tasks waiting for your approval will show up here." />
      )}
      <div className="space-y-3">
        {(items || []).map((t) => (
          <div key={t.id} className="bg-navy2 border border-gold/30 rounded-lg p-4 hover:border-gold/50 hover:shadow-md hover:shadow-black/20 transition-all duration-200">
            <div className="font-medium text-cream">{t.name}</div>
            {t.description && <div className="text-sm text-cream/60 mt-1">{t.description}</div>}
            <div className="text-xs text-cream/50 mt-2">
              For <span className="text-gold/80">{t.ownerName}</span> · from <span className="text-gold/80">{t.assignedByName}</span>
              {t.dueDate && <> · due {t.dueDate}</>}
            </div>
            <div className="flex gap-2 mt-3">
              <Button variant="gold" disabled={!!busy} onClick={() => act(t, 'approve')}>{busy === `${t.id}:approve` ? <span className="flex items-center gap-2"><Spinner /> Approving…</span> : 'Approve'}</Button>
              <Button variant="danger" disabled={!!busy} onClick={() => act(t, 'reject')}>{busy === `${t.id}:reject` ? <span className="flex items-center gap-2"><Spinner /> Rejecting…</span> : 'Reject'}</Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// "Get Involved" inbox — club-join + board-application submissions routed here.
function SubmissionsInbox({ onChanged, refreshSignal }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState('');
  const [confirmEl, confirm] = useConfirm();
  const load = useCallback(async () => {
    setError('');
    try { const d = await api('/submissions'); setItems(d.submissions); }
    catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load, refreshSignal]);

  async function toggle(s) {
    setBusyId(s.id);
    try {
      await api(`/submissions/${s.id}/handled`, { method: 'POST' });
      await load();
      onChanged && onChanged();
    } catch (err) { setError(err.message); }
    finally { setBusyId(''); }
  }
  async function remove(s) {
    if (!(await confirm({ title: 'Delete submission?', message: `${s.name}'s ${s.type === 'board' ? 'board application' : 'club-join request'} will be permanently deleted.`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api(`/submissions/${s.id}`, { method: 'DELETE' });
      await load();
      onChanged && onChanged();
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="max-w-3xl">
      {confirmEl}
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-2">Get Involved</h1>
      <p className="text-cream/50 mb-6">Club-join and board applications submitted from the public homepage.</p>
      {error && <div className="mb-4"><ErrorState message={error} onRetry={load} /></div>}
      {items === null && !error && <Loading label="Loading submissions…" />}
      {items !== null && items.length === 0 && (
        <EmptyState icon="📨" title="No submissions yet" hint="Club-join requests and board applications from the public homepage will appear here." />
      )}
      <div className="space-y-3">
        {(items || []).map((s) => (
          <div key={s.id} className={`bg-navy2 border rounded-lg p-4 transition-all duration-200 hover:shadow-md hover:shadow-black/20 ${s.handled ? 'border-cream/10 opacity-70' : 'border-gold/30 hover:border-gold/50'}`}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="font-medium text-cream">{s.name} <span className="text-cream/40 text-sm">· {s.email}</span></div>
              <div className="flex gap-2 flex-wrap">
                <Badge tone={s.type === 'board' ? 'red' : 'blue'}>{s.type === 'board' ? 'Board Application' : 'Join the Club'}</Badge>
                {s.grade && <Badge tone="gold">Grade {s.grade}</Badge>}
                {s.handled ? <Badge tone="green">Handled</Badge> : <Badge tone="slate">New</Badge>}
              </div>
            </div>
            {s.message && <div className="text-sm text-cream/70 mt-2 whitespace-pre-line">{s.message}</div>}
            <div className="text-xs text-cream/40 mt-2">{timeAgo(s.createdAt)}</div>
            <div className="flex gap-2 mt-3 items-center">
              <a href={`mailto:${s.email}`} className="text-xs text-gold/80 hover:text-gold mr-auto">Email {s.name.split(' ')[0]}</a>
              <Button variant={s.handled ? 'ghost' : 'gold'} onClick={() => toggle(s)} disabled={busyId === s.id}>
                {busyId === s.id ? <span className="flex items-center gap-2"><Spinner /> Saving…</span> : s.handled ? 'Reopen' : 'Mark handled'}
              </Button>
              <Button variant="danger" onClick={() => remove(s)}>Delete</Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Org Chart
// ---------------------------------------------------------------------------
function OrgNode({ title, name, tone = 'gold', children }) {
  const ring = tone === 'red' ? 'border-red' : tone === 'gold' ? 'border-gold' : 'border-cream/30';
  const titleColor = tone === 'red' ? 'text-red' : 'text-gold';
  return (
    <div className="flex flex-col items-center">
      <div className={`bg-navy2 border-2 ${ring} rounded-xl px-5 py-3 text-center min-w-[160px] sm:min-w-[200px] shadow-xl hover:shadow-2xl hover:-translate-y-0.5 transition-all duration-200`}>
        <div className={`font-display text-lg sm:text-xl ${titleColor} leading-tight font-bold`}>{title}</div>
        {name && <div className="text-sm sm:text-base text-cream/90 mt-0.5 font-medium">{name}</div>}
      </div>
      {children && <div className="w-0.5 h-6 bg-cream/40" />}
      {children && <div className="flex flex-wrap justify-center gap-4 sm:gap-6">{children}</div>}
    </div>
  );
}

function OrgChart() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    api('/orgchart').then((d) => setUsers(d.users)).catch((err) => setError(err.message || 'Failed to load org chart'));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!users && !error) return <Loading label="Loading org chart…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const isGradeRep = (u) => (u.title || '').toLowerCase().includes('grade rep');
  const gradeReps = users.filter(isGradeRep);
  const boardMembers = users.filter((u) => !isGradeRep(u));

  const byId = {};
  boardMembers.forEach((u) => { byId[u.id] = { ...u, children: [] }; });
  const roots = [];
  boardMembers.forEach((u) => {
    if (u.managerId && byId[u.managerId]) byId[u.managerId].children.push(byId[u.id]);
    else roots.push(byId[u.id]);
  });

  function renderNode(node, depth = 0) {
    if (depth > 20) return null;
    const tone = node.bigBoard ? 'red' : 'slate';
    const childNodes = node.children.length > 0 ? node.children.map((n) => renderNode(n, depth + 1)) : null;
    return (
      <OrgNode key={node.id} title={node.title || roleLabel(node.role)} name={node.displayName} tone={tone}>
        {childNodes}
      </OrgNode>
    );
  }

  return (
    <div className="w-full">
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-2">Org Chart</h1>
      <p className="text-cream/50 mb-8">Club America — {(() => { const y = new Date().getFullYear(); const s = new Date().getMonth() >= 7 ? y : y - 1; return `${s}–${String(s + 1).slice(2)}`; })()} Board</p>

      <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      <div className="flex flex-col items-center gap-6 pb-10 min-w-max sm:min-w-0 mx-auto">
        {roots.map((r, i) => (
          <React.Fragment key={r.id}>
            {i > 0 && <div className="w-0.5 h-6 bg-cream/40" />}
            {renderNode(r)}
          </React.Fragment>
        ))}

        {gradeReps.length > 0 && (
          <div className="w-full mt-8">
            <div className="font-display text-3xl text-gold text-center mb-1">Grade Representatives</div>
            <div className="text-center text-cream/40 text-sm mb-4 tracking-wide uppercase">On the Board · Grade Reps</div>
            <div className="flex flex-wrap justify-center gap-4">
              {gradeReps.map((u) => (
                <div key={u.id} className="bg-navy2 border-2 border-gold/60 rounded-xl px-5 py-3 text-center min-w-[160px] shadow-lg">
                  <div className="text-xs uppercase tracking-wider text-gold/70 mb-1 font-semibold">Grade Rep</div>
                  <div className="text-base text-cream/90 font-semibold">{u.displayName}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap justify-center gap-6 text-sm text-cream/50 mt-8 pt-5 border-t border-cream/10 w-full">
          <span className="flex items-center gap-2"><span className="inline-block w-4 h-4 rounded border-2 border-red" /> Big Board</span>
          <span className="flex items-center gap-2"><span className="inline-block w-4 h-4 rounded border-2 border-gold/60" /> Grade Representative</span>
          <span className="flex items-center gap-2"><span className="inline-block w-4 h-4 rounded border-2 border-cream/30" /> Board Member</span>
        </div>
      </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin Panel
// ---------------------------------------------------------------------------
function PodcastToggle() {
  const [enabled, setEnabled] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    setError('');
    api('/home/settings')
      .then((d) => setEnabled(!!d.home.podcastEnabled))
      .catch((err) => setError(err.message || 'Failed to load settings'));
  }, []);

  async function toggle() {
    if (enabled === null || busy) return;
    setBusy(true);
    setError('');
    try {
      const d = await api('/home', { method: 'PUT', body: { podcastEnabled: !enabled } });
      setEnabled(!!d.home.podcastEnabled);
    } catch (err) {
      setError(err.message || 'Failed to save toggle');
    } finally { setBusy(false); }
  }

  return (
    <div className="bg-navy2 border border-cream/10 rounded-xl p-5 mb-8">
      <div className="font-display text-2xl text-gold mb-1">Homepage</div>
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="text-cream">Podcast section</div>
          <div className="text-cream/50 text-sm">
            {enabled === null ? 'Loading…'
              : enabled ? 'Visible on the homepage.'
              : 'Hidden — shows an "Under Construction" message instead.'}
          </div>
        </div>
        <button
          onClick={toggle}
          disabled={enabled === null || busy}
          aria-pressed={!!enabled}
          className={`relative w-14 h-8 rounded-full transition-colors disabled:opacity-50 ${enabled ? 'bg-emerald-500' : 'bg-cream/20'}`}
        >
          <span className={`absolute top-1 left-1 w-6 h-6 rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : ''}`} />
        </button>
      </div>
      {error && <div className="text-red text-sm mt-2">{error}</div>}
    </div>
  );
}

function EditMemberModal({ user, onSaved, onClose }) {
  const [firstName, setFirstName] = useState(user.firstName || user.displayName.split(' ')[0] || '');
  const [lastName, setLastName] = useState(user.lastName || user.displayName.split(' ').slice(1).join(' ') || '');
  const [username, setUsername] = useState(user.username || '');
  const [title, setTitle] = useState(user.title || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function save(e) {
    e.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api(`/admin/users/${user.id}`, { method: 'PATCH', body: { firstName, lastName, username, title } });
      onSaved();
      onClose();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <form onSubmit={save} onClick={(e) => e.stopPropagation()}
        className="bg-navy2 border border-gold/30 rounded-xl p-6 max-w-md w-full space-y-4 ca-scale-in">
        <div className="font-display text-2xl text-gold">Edit Profile</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="First Name">
            <input className={inputCls} value={firstName} onChange={(e) => setFirstName(e.target.value)} required />
          </Field>
          <Field label="Last Name">
            <input className={inputCls} value={lastName} onChange={(e) => setLastName(e.target.value)} />
          </Field>
        </div>
        <Field label="Username">
          <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value.toLowerCase())}
            pattern="[a-z0-9._\-]+" title="Letters, numbers, dots, hyphens, underscores only" required />
        </Field>
        <Field label="Title / Position">
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Grade Rep" />
        </Field>
        {error && <div className="text-red text-sm">{error}</div>}
        <div className="flex gap-2">
          <Button type="submit" variant="gold" disabled={saving}>{saving ? 'Saving…' : 'Save Changes'}</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </div>
  );
}

function AdminPanel({ users, reload }) {
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState('member');
  const [managerId, setManagerId] = useState('');
  const [grade, setGrade] = useState('');
  const [email, setEmail] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [editTarget, setEditTarget] = useState(null);
  const [adding, setAdding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmEl, confirm] = useConfirm();

  async function addUser(e) {
    e.preventDefault();
    setNotice('');
    if (!first.trim()) { setError('First name is required.'); return; }
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) { setError('Please enter a valid email.'); return; }
    setError(''); setAdding(true);
    try {
      const d = await api('/admin/users', { method: 'POST', body: {
        firstName: first.trim(), lastName: last.trim(), title, role, managerId: managerId ? Number(managerId) : null, grade, email,
      }});
      setNotice(`Added ${d.user.displayName} — username "${d.user.username}", default password "${d.defaultPassword}".`);
      setFirst(''); setLast(''); setTitle(''); setRole('member'); setManagerId(''); setGrade(''); setEmail('');
      reload();
    } catch (err) { setError(err.message); }
    finally { setAdding(false); }
  }

  async function updateUser(u, patch) {
    setError('');
    setSaving(true);
    try {
      await api(`/admin/users/${u.id}`, { method: 'PATCH', body: patch });
      reload();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  async function removeUser(u) {
    if (!(await confirm({ title: `Remove ${u.displayName}?`, message: 'Their direct reports roll up to their manager. This cannot be undone.', confirmLabel: 'Remove', danger: true }))) return;
    setError('');
    try {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' });
      reload();
    } catch (err) { setError(err.message); }
  }
  async function resetPw(u) {
    if (!(await confirm({ title: `Reset password?`, message: `${u.displayName}'s password will be reset to their default and they'll set a new one at next login.`, confirmLabel: 'Reset password' }))) return;
    setSaving(true);
    try {
      const d = await api(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
      setNotice(`${u.displayName}'s password reset to default "${d.defaultPassword}". They'll set a new one at next login.`);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  const byId = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u])), [users]);

  return (
    <div className="max-w-5xl">
      {confirmEl}
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-6">Admin Panel</h1>

      <PodcastToggle />

      <form onSubmit={addUser} className="bg-navy2 border border-gold/30 rounded-xl p-5 mb-8 grid sm:grid-cols-2 gap-4">
        <div className="sm:col-span-2 font-display text-2xl text-gold">Add a Board Member</div>
        <Field label="First Name"><input className={inputCls} value={first} onChange={(e) => setFirst(e.target.value)} required /></Field>
        <Field label="Last Name"><input className={inputCls} value={last} onChange={(e) => setLast(e.target.value)} /></Field>
        <Field label="Title / Position"><input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Grade Rep" /></Field>
        <Field label="Role">
          <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="member">Member</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin (President / VP)</option>
          </select>
        </Field>
        <Field label="Reports To">
          <select className={inputCls} value={managerId} onChange={(e) => setManagerId(e.target.value)}>
            <option value="">— none —</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
        </Field>
        <Field label="Grade (for grade reps — receives that grade's join forms)">
          <select className={inputCls} value={grade} onChange={(e) => setGrade(e.target.value)}>
            <option value="">— n/a —</option>
            {GRADES.map((g) => <option key={g} value={g}>{gradeOption(g)}</option>)}
          </select>
        </Field>
        <Field label="Email (for notifications)"><input type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="optional" /></Field>
        <div className="sm:col-span-2 flex items-center gap-3">
          <Button type="submit" variant="gold" disabled={adding || !first.trim()}>{adding ? <span className="flex items-center gap-2"><Spinner /> Adding…</span> : 'Add Member'}</Button>
          <span className="text-xs text-cream/40">Username is generated as first-initial + last name.</span>
        </div>
        {notice && <div className="sm:col-span-2 text-emerald-300 text-sm">{notice}</div>}
        {error && <div className="sm:col-span-2 text-red text-sm">{error}</div>}
      </form>

      <div className="flex items-center gap-3 mb-3">
        <div className="font-display text-2xl text-gold">All Members ({users.length})</div>
        {saving && <span className="flex items-center gap-1.5 text-xs text-cream/50"><Spinner className="w-3 h-3" /> Saving…</span>}
      </div>
      <div className="space-y-3">
        {users.map((u) => (
          <div key={u.id} className="bg-navy2 border border-cream/10 rounded-xl p-4 hover:border-cream/20 transition-colors duration-150">
            <div className="flex items-start justify-between gap-3 flex-wrap mb-3">
              <div>
                <div className="text-cream font-medium">{u.displayName}</div>
                <div className="text-cream/40 text-xs">@{u.username}{u.title ? ` · ${u.title}` : ''}</div>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                {u.firstLogin ? <Badge tone="red">First login</Badge> : <Badge tone="green">Active</Badge>}
                <button onClick={() => setEditTarget(u)} className="text-xs text-cream/60 hover:text-cream">Edit Profile</button>
                <button onClick={() => resetPw(u)} className="text-xs text-gold/80 hover:text-gold">Reset PW</button>
                <button onClick={() => removeUser(u)} className="text-xs text-red/80 hover:text-red">Remove</button>
              </div>
            </div>
            <div className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 text-xs">
              <div>
                <div className="text-cream/50 uppercase tracking-wider mb-1">Role</div>
                <select className="bg-navy border border-cream/20 rounded px-2 py-1 text-xs w-full disabled:opacity-40"
                  value={u.role} disabled={saving} onChange={(e) => updateUser(u, { role: e.target.value })}>
                  <option value="member">Member</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <div className="text-cream/50 uppercase tracking-wider mb-1">Reports To</div>
                <select className="bg-navy border border-cream/20 rounded px-2 py-1 text-xs w-full disabled:opacity-40"
                  value={u.managerId || ''} disabled={saving} onChange={(e) => updateUser(u, { managerId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— none —</option>
                  {users.filter((x) => x.id !== u.id).map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}
                </select>
              </div>
              <div>
                <div className="text-cream/50 uppercase tracking-wider mb-1">Grade</div>
                <select className="bg-navy border border-cream/20 rounded px-2 py-1 text-xs w-full disabled:opacity-40"
                  value={u.grade || ''} disabled={saving} onChange={(e) => updateUser(u, { grade: e.target.value })}>
                  <option value="">—</option>
                  {GRADES.map((g) => <option key={g} value={g}>{gradeOption(g)}</option>)}
                </select>
              </div>
              <div>
                <div className="text-cream/50 uppercase tracking-wider mb-1">Managed Grade</div>
                <select className="bg-navy border border-cream/20 rounded px-2 py-1 text-xs w-full"
                  value={u.managedGrade || ''} disabled={saving} onChange={(e) => updateUser(u, { managedGrade: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— none —</option>
                  {[9,10,11,12].map((g) => <option key={g} value={g}>{g}th Grade</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <div className="text-cream/50 uppercase tracking-wider mb-1">Permissions</div>
                {[
                  { key: 'bigBoard', label: 'Big Board' },
                  { key: 'canManageRoster', label: 'Manage Roster' },
                  { key: 'canAnnounce', label: 'Announce' },
                  { key: 'canEditHome', label: 'Edit Site' },
                  { key: 'canViewLogistics', label: 'View Login Activity' },
                  { key: 'canManageSocial', label: 'Social Media Manager' },
                ].map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={!!u[key]}
                      disabled={saving}
                      onChange={(e) => updateUser(u, { [key]: e.target.checked })}
                      className="accent-gold disabled:opacity-40" />
                    <span className="text-cream/70">{label}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
      {editTarget && (
        <EditMemberModal user={editTarget} onSaved={reload} onClose={() => setEditTarget(null)} />
      )}

      <RoleDescriptionsAdmin />
    </div>
  );
}

function RoleDescriptionsAdmin() {
  const [items, setItems] = useState([]);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    api('/role-descriptions').then((d) => setItems(d.descriptions || [])).catch(() => {});
  }, []);

  async function save(title, description) {
    setSaving(true);
    setNotice('');
    try {
      const d = await api(`/role-descriptions/${encodeURIComponent(title)}`, { method: 'PUT', body: { description } });
      setItems((prev) => {
        const exists = prev.find((x) => x.positionTitle === title);
        if (exists) return prev.map((x) => x.positionTitle === title ? d.description : x);
        return [...prev, d.description];
      });
      setNotice('Saved.');
      setEditTitle(''); setEditDesc(''); setNewTitle(''); setNewDesc('');
    } catch (err) { setNotice(err.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="mt-10">
      <div className="font-display text-2xl text-gold mb-4">Role Descriptions</div>
      <div className="space-y-3 mb-6">
        {items.map((item) => (
          <div key={item.positionTitle} className="bg-navy2 border border-cream/10 rounded-xl p-4">
            {editTitle === item.positionTitle ? (
              <div className="space-y-2">
                <div className="text-cream font-medium">{item.positionTitle}</div>
                <textarea className={inputCls} rows="3" value={editDesc}
                  onChange={(e) => setEditDesc(e.target.value)} autoFocus />
                <div className="flex gap-2">
                  <Button variant="gold" disabled={saving} onClick={() => save(item.positionTitle, editDesc)}>
                    {saving ? <span className="flex items-center gap-1"><Spinner className="w-3 h-3" /> Saving…</span> : 'Save'}
                  </Button>
                  <Button variant="ghost" onClick={() => setEditTitle('')}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-cream font-medium">{item.positionTitle}</div>
                  {item.description ? (
                    <div className="text-cream/60 text-sm mt-1 whitespace-pre-wrap">{item.description}</div>
                  ) : (
                    <div className="text-cream/30 text-sm mt-1 italic">No description yet.</div>
                  )}
                </div>
                <button onClick={() => { setEditTitle(item.positionTitle); setEditDesc(item.description || ''); }}
                  className="text-xs text-gold/70 hover:text-gold shrink-0">Edit</button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="bg-navy2 border border-gold/20 rounded-xl p-4 space-y-3">
        <div className="text-cream/70 text-sm font-medium">Add a new role description</div>
        <Field label="Position Title"><input className={inputCls} value={newTitle} placeholder="e.g. Vice President" onChange={(e) => setNewTitle(e.target.value)} /></Field>
        <Field label="Description"><textarea className={inputCls} rows="3" value={newDesc} placeholder="Describe this role's responsibilities…" onChange={(e) => setNewDesc(e.target.value)} /></Field>
        {notice && <div className="text-emerald-300 text-sm">{notice}</div>}
        <Button variant="gold" disabled={saving || !newTitle.trim()} onClick={() => save(newTitle.trim(), newDesc.trim())}>
          {saving ? <span className="flex items-center gap-1"><Spinner className="w-3 h-3" /> Saving…</span> : 'Add Role'}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public homepage (/home) + in-portal editable view
// ---------------------------------------------------------------------------
function InstagramIcon({ className = 'w-5 h-5' }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
    </svg>
  );
}

// Ensure external URLs always have a protocol so they don't become relative links.
function ensureHttps(url) {
  if (!url) return '';
  if (/^javascript:/i.test(url.trim())) return '#';
  return /^https?:\/\//i.test(url) ? url : 'https://' + url;
}

// A "Follow on Instagram" button, only rendered when a link is configured.
function InstagramLink({ url, className = '' }) {
  if (!url) return null;
  return (
    <a href={ensureHttps(url)} target="_blank" rel="noopener"
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-md bg-gradient-to-r from-red to-gold text-cream text-sm font-medium hover:opacity-90 transition-opacity ${className}`}>
      <InstagramIcon className="w-4 h-4" /> Follow on Instagram
    </a>
  );
}

// Pull a YouTube video id from common URL shapes; null if it's just a page/channel.
function ytId(url) {
  if (!url) return null;
  const m = String(url).match(/(?:youtube\.com\/(?:watch\?v=|embed\/|live\/)|youtu\.be\/)([\w-]{11})/);
  return m ? m[1] : null;
}

function fmtEvent(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const allDay = d.getHours() === 0 && d.getMinutes() === 0;
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (allDay) return date;
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

// Shows upcoming events when a calendar is connected; otherwise falls back to
// the manually-entered "Next Meeting" details.
function MeetingCard({ home, events }) {
  const hasEvents = events && events.length > 0;
  return (
    <section className="bg-navy2 border border-gold/30 rounded-2xl p-6 hover:border-gold/50 hover:shadow-lg hover:shadow-black/20 transition-all duration-200">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-3xl text-gold">{hasEvents ? 'Upcoming Events' : 'Next Meeting'}</h2>
        <span className="text-red text-xl">📅</span>
      </div>
      {hasEvents ? (
        <ul className="mt-4 space-y-3">
          {events.map((e, i) => (
            <li key={i} className="border-l-2 border-gold/50 pl-3">
              <div className="text-lg text-cream font-medium leading-tight">{e.title}</div>
              <div className="text-sm text-gold/80">{fmtEvent(e.start)}</div>
              {e.location && <div className="text-sm text-cream/50">{e.location}</div>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="mt-4 space-y-3">
          {[['Date', home.meetingDate], ['Time', home.meetingTime], ['Location', home.meetingLocation]].map(([label, val]) => (
            <div key={label}>
              <div className="text-xs uppercase tracking-wider text-cream/50">{label}</div>
              <div className="text-2xl text-cream font-medium">{val || '—'}</div>
            </div>
          ))}
          {home.calendarConfigured && (
            <p className="text-xs text-cream/40">No upcoming events found on the connected calendar.</p>
          )}
        </div>
      )}
    </section>
  );
}

function PodcastCard({ home }) {
  const id = ytId(home.podcastUrl);
  return (
    <section className="bg-navy2 border border-red/30 rounded-2xl p-6 hover:border-red/50 hover:shadow-lg hover:shadow-black/20 transition-all duration-200">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-3xl text-red">The Podcast</h2>
        <span className="text-xl">🎙️</span>
      </div>

      {!home.podcastEnabled ? (
        <div className="mt-4 aspect-video w-full rounded-lg overflow-hidden bg-navy3 flex flex-col items-center justify-center text-center px-4">
          <span className="text-4xl mb-2">🚧</span>
          <div className="font-display text-2xl text-gold">Under Construction</div>
          <div className="text-cream/40 text-sm mt-1">The podcast is coming soon — check back later.</div>
        </div>
      ) : (
        <React.Fragment>
          <div className="mt-4 aspect-video w-full rounded-lg overflow-hidden bg-navy3 flex items-center justify-center">
            {id ? (
              <iframe className="w-full h-full" src={`https://www.youtube.com/embed/${id}`}
                title="Club America Podcast" frameBorder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowFullScreen />
            ) : (
              <div className="text-cream/40 text-sm px-4 text-center">
                {home.podcastUrl ? 'Linked page (no inline preview)' : 'No podcast linked yet'}
              </div>
            )}
          </div>
          {home.podcastUrl && (
            <a href={ensureHttps(home.podcastUrl)} target="_blank" rel="noopener"
              onClick={() => track('podcast_watch', home.podcastUrl)}
              className="mt-4 inline-block bg-gold hover:bg-gold/85 text-navy font-semibold text-sm px-4 py-2 rounded-md transition-colors">
              ▶ Watch on YouTube
            </a>
          )}
        </React.Fragment>
      )}
    </section>
  );
}

function HomeEditor({ onSaved }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [calRefreshing, setCalRefreshing] = useState(false);
  const [calMsg, setCalMsg] = useState('');

  async function refreshCalendar() {
    setCalRefreshing(true); setCalMsg('');
    try {
      const d = await api('/home/calendar/refresh', { method: 'POST' });
      setCalMsg(`✓ Refreshed — ${d.events.length} upcoming event${d.events.length === 1 ? '' : 's'} loaded.`);
      onSaved && onSaved();
    } catch (err) { setCalMsg('✗ ' + err.message); }
    finally { setCalRefreshing(false); }
  }

  async function start() {
    setError(''); setSaved(false);
    try {
      // Load the full settings (including the private calendar URL).
      const d = await api('/home/settings');
      setForm(d.home);
      setOpen(true);
    } catch (err) { setError(err.message); }
  }
  async function submit(e) {
    e.preventDefault();
    setError(''); setSaving(true);
    try {
      const d = await api('/home', { method: 'PUT', body: {
        meetingDate: form.meetingDate,
        meetingTime: form.meetingTime,
        meetingLocation: form.meetingLocation,
        podcastUrl: form.podcastUrl,
        calendarUrl: form.calendarUrl,
        instagramUrl: form.instagramUrl,
        aboutText: form.aboutText,
        podcastEnabled: form.podcastEnabled,
      }});
      onSaved(d.home);
      setSaved(true);
      setOpen(false);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <section className="bg-navy2 border border-cream/10 rounded-2xl p-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-display text-2xl text-cream">Website Controls</h2>
          <p className="text-cream/50 text-sm">President, VP, and the Digital Presence Manager can edit the meeting details, calendar feed, and podcast link shown on the public homepage.</p>
        </div>
        {!open && <Button variant="ghost" onClick={start}>Edit page</Button>}
      </div>
      {saved && !open && <div className="text-emerald-300 text-sm mt-3">Saved — the public homepage is updated.</div>}
      {open && form && (
        <form onSubmit={submit} className="mt-5 grid sm:grid-cols-2 gap-4">
          <div className="sm:col-span-2">
            <Field label="Calendar feed URL (iCal / .ics — e.g. Google Calendar public address)">
              <input className={inputCls} value={form.calendarUrl || ''} onChange={set('calendarUrl')} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" />
            </Field>
            <div className="flex items-center gap-3 mt-2 flex-wrap">
              <p className="text-xs text-cream/40 flex-1">When set, the homepage shows the next 3 events from this calendar automatically. Leave blank to use the manual meeting fields below. Events cache for 5 minutes.</p>
              {form.calendarUrl && (
                <button type="button" onClick={refreshCalendar} disabled={calRefreshing}
                  className="text-xs px-3 py-1.5 rounded-md border border-gold/40 text-gold/80 hover:border-gold hover:text-gold transition-colors disabled:opacity-40 shrink-0">
                  {calRefreshing ? 'Refreshing…' : '↺ Force Reload'}
                </button>
              )}
            </div>
            {calMsg && (
              <p className={`text-xs mt-1 ${calMsg.startsWith('✓') ? 'text-emerald-300' : 'text-red'}`}>{calMsg}</p>
            )}
          </div>
          <Field label="Meeting date (fallback)"><input className={inputCls} value={form.meetingDate || ''} onChange={set('meetingDate')} placeholder="e.g. Thursday, June 12" /></Field>
          <Field label="Meeting time (fallback)"><input className={inputCls} value={form.meetingTime || ''} onChange={set('meetingTime')} placeholder="e.g. 3:30 PM" /></Field>
          <div className="sm:col-span-2"><Field label="Meeting location (fallback)"><input className={inputCls} value={form.meetingLocation || ''} onChange={set('meetingLocation')} placeholder="e.g. Room 214" /></Field></div>
          <div className="sm:col-span-2"><Field label="Podcast link (YouTube video or page URL)"><input className={inputCls} value={form.podcastUrl || ''} onChange={set('podcastUrl')} placeholder="https://www.youtube.com/watch?v=…" /></Field></div>
          <div className="sm:col-span-2"><Field label="Instagram link"><input className={inputCls} value={form.instagramUrl || ''} onChange={set('instagramUrl')} placeholder="https://www.instagram.com/yourclub" /></Field></div>
          <div className="sm:col-span-2"><Field label="About / Mission (shown on the public homepage)"><textarea className={inputCls + ' min-h-[120px] resize-y'} value={form.aboutText || ''} onChange={set('aboutText')} placeholder="Tell visitors who Club America is and what you stand for…" /></Field></div>
          {error && <div className="sm:col-span-2 text-red text-sm">{error}</div>}
          <div className="sm:col-span-2 flex gap-2">
            <Button type="submit" variant="gold" disabled={saving}>{saving ? <span className="flex items-center gap-2"><Spinner /> Saving…</span> : 'Save'}</Button>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>Cancel</Button>
          </div>
        </form>
      )}
      {error && !open && <div className="text-red text-sm mt-3">{error}</div>}
    </section>
  );
}

const GRADES = ['9', '10', '11', '12'];
const GRADE_LABELS = { '9': 'Freshman', '10': 'Sophomore', '11': 'Junior', '12': 'Senior' };
const gradeOption = (g) => `${g}th — ${GRADE_LABELS[g] || ''}`;

// "About Us" section, rendered only when the board has filled it in.
function AboutSection({ home }) {
  if (!home.aboutText) return null;
  return (
    <section className="bg-navy2 border border-cream/10 rounded-2xl p-6">
      <h2 className="font-display text-2xl text-gold mb-2">About Us</h2>
      <p className="text-cream/80 whitespace-pre-line leading-relaxed">{home.aboutText}</p>
    </section>
  );
}

// Public "Get Involved" — a join-the-club form and a board-application form.
function GetInvolved() {
  const [tab, setTab] = useState('club'); // club | board
  const [form, setForm] = useState({ name: '', email: '', grade: '', message: '' });
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!form.name.trim()) { setError('Please enter your name.'); return; }
    if (!form.grade) { setError('Please select your grade.'); return; }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) { setError('Please enter a valid email address.'); return; }
    setBusy(true);
    try {
      await api('/submissions', { method: 'POST', body: { ...form, type: tab } });
      setDone(true);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const TabBtn = ({ id, children }) => (
    <button type="button" onClick={() => { setTab(id); setDone(false); setError(''); }}
      className={`px-4 py-2 rounded-md text-sm transition-all duration-150 active:scale-95 ${tab === id ? 'bg-red text-cream shadow-md shadow-red/20' : 'bg-navy border border-cream/20 text-cream/70 hover:border-gold hover:text-cream/90'}`}>
      {children}
    </button>
  );

  return (
    <section className="bg-navy2 border border-gold/30 rounded-2xl p-6">
      <h2 className="font-display text-3xl text-gold mb-1">Get Involved</h2>
      <p className="text-cream/60 text-sm mb-4">Join the club or apply for the board — tell us your grade and we'll connect you with the right person.</p>

      <div className="flex gap-2 mb-5">
        <TabBtn id="club">Join the Club</TabBtn>
        <TabBtn id="board">Board Application</TabBtn>
      </div>

      {done ? (
        <div className="text-center py-6 ca-slide-up">
          <div className="text-4xl mb-2">🎉</div>
          <div className="font-display text-2xl text-gold">Thanks, {form.name.split(' ')[0] || 'friend'}!</div>
          <p className="text-cream/70 mt-1">
            {tab === 'club'
              ? "We got your info — your grade rep or the VP will reach out soon."
              : "We got your board application — the VP and President will be in touch."}
          </p>
          <button className="mt-4 text-gold/80 hover:text-gold text-sm"
            onClick={() => { setForm({ name: '', email: '', grade: '', message: '' }); setDone(false); }}>
            Submit another
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="grid sm:grid-cols-2 gap-4">
          <Field label="Name"><input className={inputCls} value={form.name} onChange={set('name')} required /></Field>
          <Field label="Email"><input type="email" className={inputCls} value={form.email} onChange={set('email')} required /></Field>
          <Field label="Grade">
            <select className={inputCls} value={form.grade} onChange={set('grade')} required>
              <option value="">Select…</option>
              {GRADES.map((g) => <option key={g} value={g}>{gradeOption(g)}</option>)}
            </select>
          </Field>
          <div className="sm:col-span-2">
            <Field label={tab === 'board' ? 'Why do you want to join the board?' : 'Anything you want us to know? (optional)'}>
              <textarea className={inputCls + ' min-h-[90px]'} value={form.message} onChange={set('message')} />
            </Field>
          </div>
          {error && <div className="sm:col-span-2 text-red text-sm">{error}</div>}
          <div className="sm:col-span-2">
            <Button type="submit" variant="gold" disabled={busy}>
              {busy ? <span className="flex items-center gap-2"><Spinner /> Submitting…</span> : tab === 'board' ? 'Submit Application' : 'Join the Club'}
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

function HomeAnnouncementBanner({ home }) {
  if (!home.homeAnnouncementEnabled || !home.homeAnnouncement) return null;
  return (
    <div className="bg-red/15 border border-red/50 rounded-xl px-5 py-4 flex gap-3 items-start">
      <span className="text-xl mt-0.5 shrink-0">📣</span>
      <div className="text-cream whitespace-pre-wrap">{home.homeAnnouncement}</div>
    </div>
  );
}

function ValuesSection() {
  return (
    <section className="grid sm:grid-cols-3 gap-4">
      <div className="bg-navy2 border border-gold/30 rounded-2xl p-6 text-center space-y-3 hover:border-gold/60 hover:-translate-y-1 hover:shadow-lg hover:shadow-black/25 transition-all duration-200">
        <h3 className="font-display text-2xl text-gold">Faith</h3>
        <p className="text-cream/60 text-sm leading-relaxed">Our rights come from God, not government — we stand on that truth every day.</p>
      </div>
      <div className="bg-navy2 border border-red/30 rounded-2xl p-6 text-center space-y-3 hover:border-red/60 hover:-translate-y-1 hover:shadow-lg hover:shadow-black/25 transition-all duration-200">
        <h3 className="font-display text-2xl text-red">Freedom</h3>
        <p className="text-cream/60 text-sm leading-relaxed">Free speech, individual liberty, and constitutional rights — defended loudly on campus.</p>
      </div>
      <div className="bg-navy2 border border-cream/15 rounded-2xl p-6 text-center space-y-3 hover:border-cream/30 hover:-translate-y-1 hover:shadow-lg hover:shadow-black/25 transition-all duration-200">
        <h3 className="font-display text-2xl text-cream">Community</h3>
        <p className="text-cream/60 text-sm leading-relaxed">Real friendships built around a shared love for America and its founding ideals.</p>
      </div>
    </section>
  );
}

function HomeAnnouncementEditor({ home, onSaved }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(home.homeAnnouncement || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => { setText(home.homeAnnouncement || ''); }, [home.homeAnnouncement]);

  async function publish() {
    setBusy(true); setError(''); setSaved(false);
    try {
      const d = await api('/home/announcement', { method: 'PUT', body: { text } });
      onSaved(d.home);
      setSaved(true);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  if (!open) return (
    <section className="bg-navy2 border border-cream/10 rounded-2xl p-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-display text-2xl text-cream">Homepage Announcement</h2>
          <p className="text-cream/50 text-sm">
            {home.homeAnnouncementEnabled
              ? 'An announcement banner is live on the homepage.'
              : 'No active announcement — post one to show a banner to everyone.'}
          </p>
        </div>
        <Button variant="ghost" onClick={() => setOpen(true)}>
          {home.homeAnnouncementEnabled ? 'Edit' : 'Post Announcement'}
        </Button>
      </div>
    </section>
  );

  return (
    <section className="bg-navy2 border border-cream/10 rounded-2xl p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="font-display text-2xl text-cream">Homepage Announcement</h2>
        <button onClick={() => setOpen(false)} aria-label="Close" className="text-cream/50 hover:text-cream text-2xl leading-none">×</button>
      </div>
      <Field label="Announcement (leave blank to remove)">
        <textarea className={inputCls} rows="3"
          value={text} onChange={(e) => { setText(e.target.value); setSaved(false); }}
          placeholder="e.g. Welcome back — chapter elections are next Tuesday at 3:30 PM." />
      </Field>
      {error && <div className="text-red text-sm">{error}</div>}
      {saved && (
        <div className="text-emerald-300 text-sm">
          ✓ {text.trim() ? 'Announcement published — visible to everyone.' : 'Announcement removed.'}
        </div>
      )}
      <div className="flex gap-2">
        <Button variant="gold" onClick={publish} disabled={busy}>
          {busy ? 'Saving…' : text.trim() ? 'Publish' : 'Clear Announcement'}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </section>
  );
}

// ---- Meet the Board (public, data-driven org chart with click-for-bio) ------
function Avatar({ member, size = 56 }) {
  if (member.hasPhoto) {
    return <img src={`/api/users/${member.id}/photo`} alt={member.displayName}
      style={{ width: size, height: size }} className="rounded-full object-cover border-2 border-gold/40" />;
  }
  const initials = (member.displayName || '?').split(/\s+/).map((s) => s[0]).slice(0, 2).join('').toUpperCase();
  return (
    <div style={{ width: size, height: size }}
      className="rounded-full bg-navy3 border-2 border-gold/40 flex items-center justify-center text-gold font-display">
      {initials}
    </div>
  );
}

function buildBoardTree(members) {
  const byId = {};
  members.forEach((m) => { byId[m.id] = { ...m, children: [] }; });
  const roots = [];
  members.forEach((m) => {
    if (m.managerId && byId[m.managerId]) byId[m.managerId].children.push(byId[m.id]);
    else roots.push(byId[m.id]);
  });
  return roots;
}

function BoardModal({ member, onClose }) {
  useEffect(() => {
    const fn = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fn);
    return () => document.removeEventListener('keydown', fn);
  }, [onClose]);
  return (
    <div onClick={onClose} className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div onClick={(e) => e.stopPropagation()} className="bg-navy2 border border-gold/30 rounded-2xl max-w-md w-full p-6 relative max-h-[85vh] overflow-y-auto ca-scale-in">
        <button onClick={onClose} aria-label="Close" className="absolute top-2 right-4 text-cream/60 hover:text-cream text-3xl leading-none">×</button>
        <div className="flex items-center gap-4">
          <Avatar member={member} size={84} />
          <div className="min-w-0">
            <div className="font-display text-2xl text-cream leading-tight">{member.displayName}</div>
            <div className="text-gold">{member.title || roleLabel(member.role)}</div>
            {member.grade && <div className="text-cream/40 text-xs mt-0.5">Grade {member.grade}</div>}
          </div>
        </div>
        <p className="text-cream/80 mt-4 whitespace-pre-line leading-relaxed">
          {member.bio || "This board member hasn't added an intro yet."}
        </p>
      </div>
    </div>
  );
}

function MeetTheBoard() {
  const [members, setMembers] = useState(null);
  const [sel, setSel] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/board')
      .then((d) => setMembers(d.members))
      .catch((err) => setError(err.message || 'Failed to load board'));
  }, []);

  if (error) return (
    <section className="bg-navy2/40 border border-cream/10 rounded-2xl p-6">
      <h2 className="font-display text-3xl text-gold mb-4">Meet the Board</h2>
      <ErrorState message={error} onRetry={() => { setError(''); setMembers(null); api('/board').then((d) => setMembers(d.members)).catch((e) => setError(e.message)); }} />
    </section>
  );
  if (!members || members.length === 0) return null;

  const tree = buildBoardTree(members);
  const renderNode = (node, depth = 0) => {
    if (depth > 20) return null;
    return (
      <div key={node.id} className="flex flex-col items-center">
        <button onClick={() => { setSel(node); track('board_profile', node.displayName); }}
          className="bg-navy2 border border-cream/15 rounded-xl px-4 py-3 flex flex-col items-center gap-2 w-36 hover:border-gold hover:-translate-y-1 hover:shadow-md hover:shadow-black/30 transition-all duration-200">
          <Avatar member={node} size={56} />
          <div className="text-cream text-sm font-medium text-center leading-tight">{node.displayName}</div>
          <div className="text-gold/80 text-xs text-center leading-tight">{node.title || roleLabel(node.role)}</div>
        </button>
        {node.children.length > 0 && <div className="w-px h-4 bg-cream/20" />}
        {node.children.length > 0 && (
          <div className="flex flex-wrap justify-center gap-4">{node.children.map((n) => renderNode(n, depth + 1))}</div>
        )}
      </div>
    );
  };

  return (
    <section className="bg-navy2/40 border border-cream/10 rounded-2xl p-6">
      <h2 className="font-display text-3xl text-gold mb-1">Meet the Board</h2>
      <p className="text-cream/60 text-sm mb-6">Tap anyone to learn more about them.</p>
      <div className="flex flex-col items-center gap-4 overflow-x-auto pb-2">
        {tree.map(renderNode)}
      </div>
      {sel && <BoardModal member={sel} onClose={() => setSel(null)} />}
    </section>
  );
}

function FlagBackground() {
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      <svg
        viewBox="0 0 1900 1000"
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 w-full h-full"
        style={{ opacity: 0.22 }}
      >
        <defs>
          <linearGradient id="flagGrad" x1="0" y1="0" x2="1" y2="0" gradientUnits="objectBoundingBox">
            <stop offset="0%"   stopColor="#CC1C2E" stopOpacity="1" />
            <stop offset="38%"  stopColor="#F5F0E8" stopOpacity="0.5" />
            <stop offset="62%"  stopColor="#F5F0E8" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#002868" stopOpacity="1" />
          </linearGradient>
          <linearGradient id="vFade" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
            <stop offset="50%"  stopColor="white" stopOpacity="1" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </linearGradient>
          <mask id="bottomFade">
            <rect x="0" y="0" width="1900" height="1000" fill="url(#vFade)" />
          </mask>
          <polygon id="fstar"
            points="0,-10 2.94,-4.05 9.51,-3.09 4.76,1.55 5.88,8.09 0,5 -5.88,8.09 -4.76,1.55 -9.51,-3.09 -2.94,-4.05"
          />
        </defs>
        <g mask="url(#bottomFade)">
          {Array.from({ length: 13 }, (_, i) => (
            <rect
              key={i}
              x="0" y={i * 76.92} width="1900" height="76.92"
              fill="url(#flagGrad)"
              fillOpacity={i % 2 === 0 ? 1 : 0.2}
              stroke="#F5F0E8" strokeWidth="0.6" strokeOpacity="0.3"
            />
          ))}
          <rect x="0" y="0" width="760" height="538.5"
            fill="#001f5c" fillOpacity="0.5"
            stroke="#F5F0E8" strokeWidth="1" strokeOpacity="0.35"
          />
          {(() => {
            const stars = [];
            const cw = 760, ch = 538.5;
            const rowH = ch / 10;
            const colW6 = cw / 7;
            const colW5 = cw / 6;
            for (let row = 0; row < 9; row++) {
              const y = rowH * (row + 0.5);
              const isWide = row % 2 === 0;
              const cols = isWide ? 6 : 5;
              const colW = isWide ? colW6 : colW5;
              for (let col = 0; col < cols; col++) {
                stars.push(
                  <use key={`${row}-${col}`} href="#fstar"
                    transform={`translate(${colW * (col + 0.5)},${y})`}
                    fill="#F5F0E8" fillOpacity="0.85"
                  />
                );
              }
            }
            return stars;
          })()}
        </g>
      </svg>
    </div>
  );
}

function Home({ mode = 'public', me = null, editable = false, onEnterPortal, onBack }) {
  const [home, setHome] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { const d = await api('/home'); setHome(d.home); setEvents(d.events || []); }
    catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <div className="p-8 max-w-lg mx-auto"><ErrorState message={error} onRetry={load} /></div>;
  if (!home) return <div className="flex items-center justify-center gap-2 text-cream/50 p-8"><Spinner /> Loading…</div>;

  const canAnnounce = me && (me.role === 'admin' || !!me.canAnnounce);

  const cards = (
    <div className="grid md:grid-cols-2 gap-6">
      <MeetingCard home={home} events={events} />
      <PodcastCard home={home} />
    </div>
  );

  // Dedicated "Edit Website" tab: editor first, then a live preview.
  if (mode === 'editor') {
    return (
      <div className="max-w-5xl space-y-8">
        <div>
          <h1 className="font-display text-4xl sm:text-5xl text-cream leading-none">Edit Website</h1>
          <p className="text-cream/50 mt-1">Update what visitors see on the public homepage at <span className="text-gold/80">/home</span>.</p>
        </div>
        <HomeEditor onSaved={load} />
        <div className="space-y-6">
          <div className="font-display text-2xl text-gold">Live Preview</div>
          <HomeAnnouncementBanner home={home} />
          <AboutSection home={home} />
          {cards}
          {home.instagramUrl && <InstagramLink url={home.instagramUrl} />}
        </div>
      </div>
    );
  }

  // In-portal "Home" view — mirrors the public landing page exactly, minus the standalone login header.
  if (mode === 'portal') {
    return (
      <div className="min-h-screen">
        <div style={{ background: 'radial-gradient(1000px 540px at 50% -5%, rgba(204,28,46,0.40), transparent 65%), radial-gradient(600px 300px at 85% 30%, rgba(201,168,76,0.07), transparent 55%)' }}>
          <section className="max-w-5xl mx-auto px-4 sm:px-6 pt-12 pb-16 text-center relative overflow-hidden">
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none select-none" aria-hidden="true">
              <div className="font-display text-[280px] sm:text-[380px] leading-none opacity-[0.035] text-cream">★</div>
            </div>
            <div className="relative">
              <p className="font-display text-xs tracking-[0.5em] text-gold/60 uppercase mb-3 ca-fade-in">Park City High School</p>
              <h1 className="font-display text-7xl sm:text-9xl text-cream leading-none ca-slide-up" style={{ animationDelay: '60ms' }}>CLUB AMERICA</h1>
              <p className="text-cream/65 max-w-lg mx-auto mt-5 text-base sm:text-lg leading-relaxed ca-fade-in" style={{ animationDelay: '160ms' }}>
                Faith, freedom, and community — standing up for America's founding principles at Park City High School.
              </p>
              {home.instagramUrl && (
                <div className="mt-8 flex justify-center">
                  <InstagramLink url={home.instagramUrl} />
                </div>
              )}
            </div>
          </section>
        </div>
        {home.homeAnnouncementEnabled && home.homeAnnouncement && (
          <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-6">
            <HomeAnnouncementBanner home={home} />
          </div>
        )}
        <main className="max-w-5xl mx-auto px-4 sm:px-6 pb-20 space-y-8 mt-8">
          <AboutSection home={home} />
          <ValuesSection />
          {cards}
          <div id="meet-the-board"><MeetTheBoard /></div>
          <div id="get-involved"><GetInvolved /></div>
        </main>
        {canAnnounce && (
          <div className="max-w-5xl mx-auto px-4 sm:px-6 pb-8">
            <HomeAnnouncementEditor home={home} onSaved={(h) => setHome(h)} />
          </div>
        )}
        <footer className="border-t border-cream/10 py-10">
          <div className="max-w-5xl mx-auto px-4 sm:px-6">
            <div className="flex flex-col sm:flex-row items-center justify-between gap-6 text-sm text-cream/40">
              <div className="flex flex-col sm:flex-row items-center gap-3">
                <span className="font-display text-base tracking-widest text-cream/30">CLUB AMERICA</span>
                <span className="hidden sm:inline text-cream/20">·</span>
                <span>Park City High School · Powered by TPUSA</span>
              </div>
              {home.instagramUrl && (
                <a href={ensureHttps(home.instagramUrl)} target="_blank" rel="noopener"
                  className="inline-flex items-center gap-2 hover:text-gold transition-colors">
                  <InstagramIcon className="w-4 h-4" /> Instagram
                </a>
              )}
            </div>
          </div>
        </footer>
      </div>
    );
  }

  // Public landing page (full screen).
  return (
    <div className="min-h-screen">
      <div className="relative overflow-hidden">
        <FlagBackground />
        <header className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 pt-6 flex items-center justify-between gap-3">
          <Logo size="sidebar" />
          <Button variant="primary" onClick={onEnterPortal}>Board Portal Login →</Button>
        </header>
        <section className="relative z-10 max-w-5xl mx-auto px-4 sm:px-6 pt-12 pb-16 text-center">
          <div className="relative">
            <p className="font-display text-xs tracking-[0.5em] text-gold/60 uppercase mb-3 ca-fade-in">Park City High School</p>
            <h1 className="font-display text-7xl sm:text-9xl text-cream leading-none ca-slide-up" style={{ animationDelay: '60ms' }}>CLUB AMERICA</h1>
            <p className="text-cream/65 max-w-lg mx-auto mt-5 text-base sm:text-lg leading-relaxed ca-fade-in" style={{ animationDelay: '160ms' }}>
              Faith, freedom, and community — standing up for America's founding principles at Park City High School.
            </p>
            <div className="mt-8 flex flex-wrap gap-3 justify-center items-center ca-fade-in" style={{ animationDelay: '250ms' }}>
              <button
                onClick={() => document.getElementById('get-involved')?.scrollIntoView({ behavior: 'smooth' })}
                className="px-7 py-3 bg-red hover:bg-red/85 text-cream font-semibold rounded-lg transition-all shadow-lg shadow-red/20 text-sm active:scale-95 hover:shadow-xl hover:shadow-red/30">
                Get Involved →
              </button>
              <button
                onClick={() => document.getElementById('meet-the-board')?.scrollIntoView({ behavior: 'smooth' })}
                className="px-7 py-3 border border-gold/50 text-gold hover:bg-gold/10 rounded-lg transition-all text-sm font-medium active:scale-95">
                Meet the Board
              </button>
              {home.instagramUrl && <InstagramLink url={home.instagramUrl} />}
            </div>
          </div>
        </section>
      </div>
      {home.homeAnnouncementEnabled && home.homeAnnouncement && (
        <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-6">
          <HomeAnnouncementBanner home={home} />
        </div>
      )}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 pb-20 space-y-8 mt-8">
        <AboutSection home={home} />
        <ValuesSection />
        {cards}
        <div id="meet-the-board"><MeetTheBoard /></div>
        <div id="get-involved"><GetInvolved /></div>
      </main>
      <footer className="border-t border-cream/10 py-10">
        <div className="max-w-5xl mx-auto px-4 sm:px-6">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-6 text-sm">
            <div className="flex flex-col sm:flex-row items-center gap-3 text-cream/40">
              <span className="font-display text-base tracking-widest text-cream/30">CLUB AMERICA</span>
              <span className="hidden sm:inline text-cream/20">·</span>
              <span>Park City High School · Powered by TPUSA</span>
            </div>
            <div className="flex items-center gap-5 text-cream/40">
              {home.instagramUrl && (
                <a href={ensureHttps(home.instagramUrl)} target="_blank" rel="noopener"
                  className="inline-flex items-center gap-2 hover:text-gold transition-colors">
                  <InstagramIcon className="w-4 h-4" /> Instagram
                </a>
              )}
              <button onClick={onEnterPortal} className="hover:text-gold transition-colors">Board Portal</button>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bio section (displayed on My Page when bioEnabled)
// ---------------------------------------------------------------------------
function BioSection({ text }) {
  if (!text) return null;
  return (
    <div className="bg-navy2 border border-cream/10 rounded-xl p-5 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-lg">👤</span>
        <div className="font-display text-2xl text-gold">About</div>
      </div>
      <div className="text-cream/80 whitespace-pre-wrap leading-relaxed">{text}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public Interest Survey (shown at /survey path, no auth)
// ---------------------------------------------------------------------------
function InterestSurvey({ onBack }) {
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', email: '', gender: '' });
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      await fetch('/api/roster/survey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }).then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Failed');
      });
      setSubmitted(true);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="w-full max-w-md text-center">
          <div className="text-5xl mb-4">🎉</div>
          <div className="font-display text-4xl text-gold mb-3">Thanks for your interest!</div>
          <p className="text-cream/70 mb-6">
            We've received your information. A Club America representative will be in touch soon.
          </p>
          <Button variant="gold" onClick={onBack}>← Back to Homepage</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-6">
          <Logo size="login" />
        </div>
        <div className="font-display text-3xl text-gold mb-1">Interest Survey</div>
        <p className="text-cream/60 text-sm mb-6">
          Interested in Club America at Park City High School? Fill out this short form and we'll reach out.
        </p>
        <form onSubmit={submit} className="bg-navy2 border border-cream/10 rounded-xl p-6 space-y-4 ca-slide-up" style={{ animationDelay: '80ms' }}>
          <div className="grid grid-cols-2 gap-4">
            <Field label="First Name *">
              <input className={inputCls} value={form.firstName} onChange={set('firstName')} required autoFocus />
            </Field>
            <Field label="Last Name">
              <input className={inputCls} value={form.lastName} onChange={set('lastName')} />
            </Field>
          </div>
          <Field label="Phone Number">
            <input className={inputCls} type="tel" value={form.phone} onChange={set('phone')} placeholder="(435) 555-0100" />
          </Field>
          <Field label="Email">
            <input className={inputCls} type="email" value={form.email} onChange={set('email')} placeholder="you@example.com" />
          </Field>
          <Field label="Gender">
            <select className={inputCls} value={form.gender} onChange={set('gender')}>
              <option value="">Prefer not to say</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
            </select>
          </Field>
          {error && <div className="text-red text-sm">{error}</div>}
          <Button type="submit" variant="gold" className="w-full" disabled={busy}>
            {busy ? <span className="flex items-center gap-2"><Spinner /> Submitting…</span> : 'Submit'}
          </Button>
          <button type="button" onClick={onBack} className="block mx-auto text-xs text-cream/50 hover:text-gold">
            ← Back to homepage
          </button>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Roster Page
// ---------------------------------------------------------------------------
const ROSTER_STATUSES = ['Prospect', 'Contacted', 'Onboarded', 'Declined'];
// Mirror of the server's roster pipeline rules (server/index.js ROSTER_TRANSITIONS).
const ROSTER_TRANSITIONS = {
  Prospect:  ['Contacted', 'Declined'],
  Contacted: ['Onboarded', 'Declined', 'Prospect'],
  Onboarded: ['Contacted', 'Declined'],
  Declined:  ['Prospect', 'Contacted'],
};
// The current status plus any status it may legally move to.
function validNextStatuses(current) {
  return [current, ...((ROSTER_TRANSITIONS[current] || []).filter((s) => s !== current))];
}

function RosterMemberRow({ member, me, onAction, onEdit, canDelete }) {
  const [busyAction, setBusyAction] = useState('');
  const [converting, setConverting] = useState(false);
  const [convertForm, setConvertForm] = useState({ grade: member.grade || '', roleDescription: member.roleDescription || '' });

  const busy = !!busyAction;

  async function act(action, body) {
    setBusyAction(action);
    try { await onAction(member.id, action, body); }
    finally { setBusyAction(''); }
  }

  const statusColors = {
    Prospect: 'slate', Contacted: 'blue', Onboarded: 'green', Declined: 'red',
  };

  return (
    <div className="bg-navy2 border border-cream/10 rounded-lg p-4 hover:border-cream/20 transition-all duration-200">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="font-medium text-cream">{member.firstName} {member.lastName}</div>
          <div className="text-sm text-cream/50 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
            {member.grade && <span>Grade {member.grade}</span>}
            {member.gender && <span>{member.gender}</span>}
            {member.phone && <span>{member.phone}</span>}
            {member.email && <span>{member.email}</span>}
          </div>
          {member.roleDescription && <div className="text-xs text-cream/40 mt-1">{member.roleDescription}</div>}
          {member.notes && <div className="text-xs text-gold/60 mt-1 italic">{member.notes}</div>}
          {member.claimedByName && (
            <div className="text-xs text-cream/40 mt-1">Managed by {member.claimedByName}</div>
          )}
        </div>
        <Badge tone={statusColors[member.status] || 'slate'}>{member.status}</Badge>
      </div>

      <div className="flex items-center gap-2 mt-3 flex-wrap">
        {member.status === 'Prospect' && (
          <>
            {!member.claimedByUserId && (
              <Button variant="gold" className="text-xs px-3 py-1" onClick={() => act('claim')} disabled={busy}>
                {busyAction === 'claim' ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Saving…</span> : 'Manage This'}
              </Button>
            )}
            {(member.claimedByUserId === me.id || me.role === 'admin' || me.role === 'manager') && (
              <Button variant="ghost" className="text-xs px-3 py-1" onClick={() => act('contacted')} disabled={busy}>
                {busyAction === 'contacted' ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Saving…</span> : 'Mark Contacted'}
              </Button>
            )}
          </>
        )}
        {member.status === 'Contacted' && (member.claimedByUserId === me.id || me.role === 'admin' || me.role === 'manager') && (
          <>
            {!converting ? (
              <>
                <Button variant="gold" className="text-xs px-3 py-1" onClick={() => setConverting(true)} disabled={busy}>
                  They Joined ✓
                </Button>
                <Button variant="danger" className="text-xs px-3 py-1" onClick={() => act('decline')} disabled={busy}>
                  {busyAction === 'decline' ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Saving…</span> : 'Not Joining'}
                </Button>
              </>
            ) : (
              <div className="w-full mt-2 bg-navy border border-gold/30 rounded-lg p-3 space-y-2">
                <div className="text-sm text-gold font-medium">Confirm Onboarding</div>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Grade">
                    <input className={inputCls} type="number" min="9" max="12"
                      value={convertForm.grade} onChange={(e) => setConvertForm((f) => ({ ...f, grade: e.target.value }))} />
                  </Field>
                  <Field label="Role / Position">
                    <input className={inputCls} value={convertForm.roleDescription}
                      onChange={(e) => setConvertForm((f) => ({ ...f, roleDescription: e.target.value }))}
                      placeholder="e.g. Grade Rep" />
                  </Field>
                </div>
                <div className="flex gap-2">
                  <Button variant="gold" className="text-xs px-3 py-1" onClick={() => act('convert', convertForm)} disabled={busy}>
                    {busyAction === 'convert' ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Saving…</span> : 'Confirm'}
                  </Button>
                  <Button variant="ghost" className="text-xs px-3 py-1" onClick={() => setConverting(false)}>Cancel</Button>
                </div>
              </div>
            )}
          </>
        )}
        {onEdit && (me.role === 'admin' || me.role === 'manager') && (
          <button onClick={() => onEdit(member)} className="text-xs text-gold/60 hover:text-gold ml-auto">Edit</button>
        )}
        {canDelete && (
          <button onClick={() => onAction(member.id, 'delete')} className="text-xs text-red/60 hover:text-red">Delete</button>
        )}
      </div>
      {(me.role === 'admin' || me.role === 'manager') && member.status === 'Onboarded' && (
        <div className="mt-2 flex items-center gap-2">
          <label className="flex items-center gap-2 cursor-pointer group">
            <input type="checkbox" checked={!!member.parentFormCollected}
              onChange={async (e) => {
                try { await onAction(member.id, 'patch', { parentFormCollected: e.target.checked ? 1 : 0 }); }
                catch (_) {}
              }}
              className="w-3.5 h-3.5 accent-gold" />
            <span className={`text-xs ${member.parentFormCollected ? 'text-emerald-400/70' : 'text-cream/40'}`}>
              {member.parentFormCollected ? '✓ Parent form collected' : 'Parent form missing'}
            </span>
          </label>
        </div>
      )}
    </div>
  );
}

function AddRosterMemberForm({ me, onCreated }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', email: '', grade: '', gender: '', status: 'Prospect', notes: '' });
  const { loading, error, setError, run } = useAction();

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (!form.firstName.trim()) { setError('First name is required.'); return; }
    if (form.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) { setError('Please enter a valid email.'); return; }
    try {
      await run(() => api('/roster', { method: 'POST', body: { ...form, firstName: form.firstName.trim(), grade: form.grade ? Number(form.grade) : null } }));
      setForm({ firstName: '', lastName: '', phone: '', email: '', grade: '', gender: '', status: 'Prospect', notes: '' });
      setOpen(false); onCreated();
    } catch (_) {}
  }

  if (!open) return <Button variant="ghost" onClick={() => setOpen(true)}>+ Add Member</Button>;
  return (
    <form onSubmit={submit} className="bg-navy2 border border-gold/30 rounded-xl p-5 space-y-3 ca-slide-up">
      <div className="font-display text-xl text-gold">Add Roster Member</div>
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="First Name *"><input className={inputCls} value={form.firstName} onChange={set('firstName')} required autoFocus /></Field>
        <Field label="Last Name"><input className={inputCls} value={form.lastName} onChange={set('lastName')} /></Field>
        <Field label="Phone"><input className={inputCls} value={form.phone} onChange={set('phone')} /></Field>
        <Field label="Email"><input className={inputCls} type="email" value={form.email} onChange={set('email')} /></Field>
        <Field label="Grade">
          <select className={inputCls} value={form.grade} onChange={set('grade')}>
            <option value="">—</option>
            {[9,10,11,12].map((g) => <option key={g} value={g}>{g}th</option>)}
          </select>
        </Field>
        <Field label="Gender">
          <select className={inputCls} value={form.gender} onChange={set('gender')}>
            <option value="">—</option>
            <option value="Male">Male</option>
            <option value="Female">Female</option>
          </select>
        </Field>
        <Field label="Status">
          <select className={inputCls} value={form.status} onChange={set('status')}>
            {ROSTER_STATUSES.map((s) => <option key={s}>{s}</option>)}
          </select>
        </Field>
        <div className="sm:col-span-2"><Field label="Notes"><textarea className={inputCls} rows="2" value={form.notes} onChange={set('notes')} /></Field></div>
      </div>
      {error && <div className="text-red text-sm">{error}</div>}
      <div className="flex gap-2">
        <Button type="submit" variant="gold" disabled={loading}>{loading ? <span className="flex items-center gap-2"><Spinner /> Adding…</span> : 'Add'}</Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={loading}>Cancel</Button>
      </div>
    </form>
  );
}

function EditRosterMemberModal({ member, onSaved, onClose }) {
  const [form, setForm] = useState({
    firstName: member.firstName || '',
    lastName: member.lastName || '',
    phone: member.phone || '',
    email: member.email || '',
    grade: member.grade || '',
    gender: member.gender || '',
    roleDescription: member.roleDescription || '',
    status: member.status || 'Prospect',
    notes: member.notes || '',
  });
  const { loading, error, setError, run } = useAction();

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (!form.firstName.trim()) { setError('First name is required.'); return; }
    if (form.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) { setError('Please enter a valid email.'); return; }
    try {
      await run(() => api(`/roster/${member.id}`, { method: 'PATCH', body: { ...form, firstName: form.firstName.trim(), grade: form.grade ? Number(form.grade) : null } }));
      onSaved(); onClose();
    } catch (_) {}
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-lg bg-navy2 border border-cream/10 rounded-xl p-5 space-y-3 max-h-screen overflow-y-auto ca-scale-in">
        <div className="flex items-center justify-between">
          <div className="font-display text-xl text-gold">Edit Member</div>
          <button type="button" onClick={onClose} className="text-cream/50 hover:text-cream text-2xl leading-none">×</button>
        </div>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="First Name *"><input className={inputCls} value={form.firstName} onChange={set('firstName')} required /></Field>
          <Field label="Last Name"><input className={inputCls} value={form.lastName} onChange={set('lastName')} /></Field>
          <Field label="Phone"><input className={inputCls} value={form.phone} onChange={set('phone')} /></Field>
          <Field label="Email"><input className={inputCls} type="email" value={form.email} onChange={set('email')} /></Field>
          <Field label="Grade">
            <select className={inputCls} value={form.grade} onChange={set('grade')}>
              <option value="">—</option>
              {[9,10,11,12].map((g) => <option key={g} value={g}>{g}th</option>)}
            </select>
          </Field>
          <Field label="Gender">
            <select className={inputCls} value={form.gender} onChange={set('gender')}>
              <option value="">—</option>
              <option value="Male">Male</option>
              <option value="Female">Female</option>
            </select>
          </Field>
          <Field label="Role Description"><input className={inputCls} value={form.roleDescription} onChange={set('roleDescription')} /></Field>
          <Field label="Status">
            <select className={inputCls} value={form.status} onChange={set('status')}>
              {validNextStatuses(member.status).map((s) => <option key={s}>{s}</option>)}
            </select>
            <span className="block text-[11px] text-cream/40 mt-1">Members follow the pipeline: Prospect → Contacted → Onboarded / Declined.</span>
          </Field>
          <div className="sm:col-span-2"><Field label="Notes"><textarea className={inputCls} rows="2" value={form.notes} onChange={set('notes')} /></Field></div>
        </div>
        {error && <div className="text-red text-sm">{error}</div>}
        <div className="flex gap-2">
          <Button type="submit" variant="gold" disabled={loading}>{loading ? <span className="flex items-center gap-2"><Spinner /> Saving…</span> : 'Save'}</Button>
          <Button variant="ghost" onClick={onClose} type="button" disabled={loading}>Cancel</Button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grade Rep Recruitment Leaderboard
// ---------------------------------------------------------------------------
function GradeRepLeaderboard({ me }) {
  const [board, setBoard] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/roster/leaderboard')
      .then((d) => { setBoard(d.leaderboard || []); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading || board.length === 0) return null;

  const leader = board[0];
  const myEntry = board.find((r) => r.id === me.id);

  const medals = ['🥇', '🥈', '🥉'];

  return (
    <div className="bg-navy2 border-2 border-gold/60 rounded-2xl p-5 mb-8">
      {/* Prize banner */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="text-3xl">🏆</div>
        <div className="flex-1 min-w-0">
          <div className="font-display text-2xl text-gold leading-tight">Grade Rep Recruitment Challenge</div>
          <div className="text-cream/70 text-sm mt-0.5">
            The rep who brings in the most new members by year-end wins a{' '}
            <span className="text-gold font-semibold">$50 Amazon gift card</span>. Keep recruiting!
          </div>
        </div>
        {leader.count > 0 && (
          <div className="bg-gold/15 border border-gold/40 rounded-xl px-4 py-2 text-center shrink-0">
            <div className="text-xs text-gold/70 uppercase tracking-wider">Current Leader</div>
            <div className="font-display text-xl text-gold leading-tight">{leader.displayName}</div>
            <div className="text-xs text-cream/60">{leader.count} onboarded</div>
          </div>
        )}
      </div>

      {/* Ranked list */}
      <div className="space-y-2">
        {board.map((rep, i) => {
          const isMe = rep.id === me.id;
          const isLeader = i === 0 && rep.count > 0;
          return (
            <div key={rep.id}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-xl transition-all duration-200 ${
                isLeader ? 'bg-gold/15 border border-gold/40 hover:border-gold/60' :
                isMe ? 'bg-navy border border-cream/20 hover:border-cream/30' : 'bg-navy/40 hover:bg-navy/60'
              }`}>
              <div className={`font-display text-xl w-8 text-center shrink-0 ${isLeader ? 'text-gold' : 'text-cream/40'}`}>
                {medals[i] || `${i + 1}`}
              </div>
              <div className="flex-1 min-w-0">
                <span className={`font-medium ${isMe ? 'text-gold' : 'text-cream'}`}>
                  {rep.displayName}
                  {isMe && <span className="text-xs text-cream/50 ml-1">(you)</span>}
                </span>
                {rep.managedGrade && (
                  <span className="text-xs text-cream/40 ml-2">Grade {rep.managedGrade}</span>
                )}
              </div>
              <div className={`font-display text-2xl shrink-0 ${isLeader ? 'text-gold' : 'text-cream/60'}`}>
                {rep.count}
              </div>
              <div className="text-xs text-cream/40 shrink-0">onboarded</div>
            </div>
          );
        })}
      </div>

      {myEntry && (
        <div className="mt-3 text-xs text-cream/40 text-center">
          You've onboarded {myEntry.count} member{myEntry.count !== 1 ? 's' : ''} this year.
          {myEntry.count < leader.count && leader.id !== me.id && (
            <> You're {leader.count - myEntry.count} behind the leader — keep going!</>
          )}
        </div>
      )}
    </div>
  );
}

function RosterPage({ me }) {
  const [members, setMembers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [myGrade, setMyGrade] = useState(null);
  const isPrivileged = me.role === 'admin' || me.role === 'manager';
  const PAGE = 25;

  const [gradeFilter, setGradeFilter] = useState(!isPrivileged && me.managedGrade ? String(me.managedGrade) : '');
  const [statusFilter, setStatusFilter] = useState('');
  const [tab, setTab] = useState('all');
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const [visible, setVisible] = useState(25);
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    setError('');
    try {
      const params = new URLSearchParams();
      if (gradeFilter) params.set('grade', gradeFilter);
      if (statusFilter) params.set('status', statusFilter);
      const d = await api('/roster' + (params.toString() ? '?' + params : ''));
      setMembers(d.members || []);
      if (d.myGrade && !gradeFilter) setMyGrade(d.myGrade);
    } catch (err) { setError(err.message); }
    finally { setLoaded(true); }
  }, [gradeFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);

  async function handleAction(memberId, action, body) {
    try {
      if (action === 'delete') {
        if (!(await confirm({ title: 'Remove from roster?', message: 'This member will be permanently deleted from the roster.', confirmLabel: 'Delete', danger: true }))) return;
        await api(`/roster/${memberId}`, { method: 'DELETE' });
      } else if (action === 'patch') {
        await api(`/roster/${memberId}`, { method: 'PATCH', body });
      } else {
        await api(`/roster/${memberId}/${action}`, { method: 'POST', body: body || undefined });
      }
      load();
    } catch (err) { setError(err.message); }
  }

  function exportCSV() {
    downloadCSV('roster.csv', members.map((m) => ({
      firstName: m.firstName, lastName: m.lastName, grade: m.grade || '', gender: m.gender || '',
      phone: m.phone || '', email: m.email || '', status: m.status,
      role: m.roleDescription || '', managedBy: m.claimedByName || '', notes: m.notes || '',
    })));
  }

  const tabFilteredMembers = useMemo(() => {
    if (tab === 'pipeline') return members.filter((m) => m.status === 'Prospect' || m.status === 'Contacted');
    if (tab === 'members') return members.filter((m) => m.status === 'Onboarded');
    if (tab === 'declined') return members.filter((m) => m.status === 'Declined');
    return members;
  }, [members, tab]);

  // Reset visible count when the view changes.
  useEffect(() => { setVisible(PAGE); }, [tab, gradeFilter, statusFilter]);

  const counts = useMemo(() => ({
    all: members.length,
    pipeline: members.filter((m) => m.status === 'Prospect' || m.status === 'Contacted').length,
    members: members.filter((m) => m.status === 'Onboarded').length,
    declined: members.filter((m) => m.status === 'Declined').length,
  }), [members]);

  const tabs = [
    { key: 'all', label: 'All' },
    { key: 'pipeline', label: 'Leads Pipeline' },
    { key: 'members', label: 'Members' },
    { key: 'declined', label: 'Declined' },
  ];

  return (
    <div className="max-w-4xl">
      {confirmEl}
      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <h1 className="font-display text-4xl sm:text-5xl text-cream">Roster</h1>
        {isPrivileged && members.length > 0 && (
          <Button variant="ghost" className="text-xs px-3 py-1.5" onClick={exportCSV}>⬇ Export CSV</Button>
        )}
      </div>
      <p className="text-cream/50 mb-6">Club America recruitment pipeline and member directory.</p>

      <GradeRepLeaderboard me={me} />

      {error && <div className="mb-4"><ErrorState message={error} onRetry={load} /></div>}

      <div className="flex flex-wrap gap-3 mb-4">
        {isPrivileged ? (
          <Field label="Filter by Grade">
            <select className="bg-navy border border-cream/20 rounded-md px-3 py-2 text-sm text-cream"
              value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value)}>
              <option value="">All Grades</option>
              {[9,10,11,12].map((g) => <option key={g} value={g}>{g}th Grade</option>)}
            </select>
          </Field>
        ) : (
          <Field label="Grade">
            <select className="bg-navy border border-cream/20 rounded-md px-3 py-2 text-sm text-cream"
              value={gradeFilter} onChange={(e) => setGradeFilter(e.target.value)}>
              {[9,10,11,12].map((g) => <option key={g} value={g}>{g}th Grade</option>)}
            </select>
          </Field>
        )}
      </div>

      <div className="flex gap-1 mb-5 flex-wrap">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-all duration-150 active:scale-95 ${tab === t.key ? 'bg-red text-cream shadow-md shadow-red/20' : 'bg-navy2 border border-cream/15 text-cream/70 hover:border-cream/30'}`}>
            {t.label} <span className="text-xs opacity-60">({counts[t.key]})</span>
          </button>
        ))}
      </div>

      <div className="space-y-3 mb-6">
        {!loaded && <Loading label="Loading roster…" />}
        {loaded && tabFilteredMembers.length === 0 && (
          <EmptyState
            icon="🧑‍🤝‍🧑"
            title={tab === 'all' ? 'No one on the roster yet' : 'Nothing in this view'}
            hint={(isPrivileged || !!me.canManageRoster)
              ? 'Add a prospect with “+ Add Member” below to start building the pipeline.'
              : 'Prospects you add or claim will show up here.'}
          />
        )}
        {tabFilteredMembers.slice(0, visible).map((m) => (
          <RosterMemberRow key={m.id} member={m} me={me}
            onAction={handleAction}
            onEdit={isPrivileged ? (m) => setEditing(m) : null}
            canDelete={isPrivileged} />
        ))}
        {tabFilteredMembers.length > visible && (
          <div className="text-center pt-2">
            <Button variant="ghost" onClick={() => setVisible((v) => v + PAGE)}>
              Show more ({tabFilteredMembers.length - visible} remaining)
            </Button>
          </div>
        )}
      </div>

      {(isPrivileged || !!me.canManageRoster) && (
        <AddRosterMemberForm me={me} onCreated={load} />
      )}

      {editing && (
        <EditRosterMemberModal member={editing} onSaved={load} onClose={() => setEditing(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Weekly Check-In Page
// ---------------------------------------------------------------------------
function WeeklyCheckinPage({ me }) {
  const [enabled, setEnabled] = useState(null);
  const [weekOf, setWeekOf] = useState('');
  const [content, setContent] = useState('');
  const [existing, setExisting] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const isManager = me.role === 'admin' || me.role === 'manager';

  const load = useCallback(async () => {
    setError('');
    try {
      const d = await api('/checkins/my');
      setEnabled(d.enabled);
      setWeekOf(d.weekOf);
      if (d.checkin) { setExisting(d.checkin); setContent(d.checkin.content); }
      else { setExisting(null); setContent(''); }
    } catch (err) { setError(err.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggleEnabled() {
    setBusy(true);
    try {
      const d = await api('/checkins/settings', { method: 'PUT', body: { enabled: !enabled } });
      setEnabled(d.enabled);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function submit(e) {
    e.preventDefault(); setError(''); setSaved(false); setBusy(true);
    try {
      await api('/checkins', { method: 'POST', body: { content } });
      setSaved(true); load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  function fmtWeek(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T12:00:00');
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  // Days remaining until this Friday's deadline (weekOf is that Friday).
  const daysLeft = useMemo(() => {
    if (!weekOf) return null;
    const due = new Date(weekOf + 'T23:59:59');
    return Math.ceil((due - new Date()) / (24 * 60 * 60 * 1000));
  }, [weekOf]);

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-2">Weekly Check-In</h1>
      <p className="text-cream/50 mb-6">
        Every board member submits a check-in by <span className="text-gold/80">Friday</span> each week. You can edit yours any time before the deadline.
      </p>

      {isManager && enabled !== null && (
        <div className="bg-navy2 border border-cream/10 rounded-xl p-4 mb-6 flex items-center justify-between gap-4">
          <div>
            <div className="text-cream font-medium">Check-Ins Enabled</div>
            <div className="text-cream/50 text-sm">{enabled ? 'Members can currently submit check-ins.' : 'Check-ins are currently disabled.'}</div>
          </div>
          <Toggle enabled={enabled} onChange={toggleEnabled} disabled={busy} />
        </div>
      )}

      {enabled === null && !error && <Loading label="Loading check-in settings…" />}

      {error && <div className="text-red text-sm mb-4">{error}</div>}

      {enabled === false && !isManager && (
        <div className="text-cream/50 bg-navy2 border border-cream/10 rounded-xl p-6 text-center">
          Weekly check-ins are currently disabled. Check back later.
        </div>
      )}

      {(enabled || isManager) && enabled !== null && (
        <div className="bg-navy2 border border-cream/10 rounded-xl p-5">
          <div className="text-sm text-cream/50 mb-3 flex flex-wrap items-center gap-x-2">
            <span>Due {fmtWeek(weekOf)}</span>
            {existing
              ? <Badge tone="green">Submitted ✓</Badge>
              : daysLeft !== null && <Badge tone={daysLeft <= 1 ? 'red' : 'gold'}>{daysLeft <= 0 ? 'Due today' : daysLeft === 1 ? 'Due tomorrow' : `${daysLeft} days left`}</Badge>}
          </div>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Your update this week">
              <textarea className={inputCls} rows="6" value={content}
                onChange={(e) => { setContent(e.target.value); setSaved(false); }}
                placeholder="What did you accomplish this week? Any blockers? Wins to share?" />
            </Field>
            {saved && <div className="text-emerald-300 text-sm">✓ {existing ? 'Updated' : 'Submitted'} successfully.</div>}
            <Button type="submit" variant="gold" disabled={busy || !content.trim()}>
              {busy ? 'Saving…' : existing ? 'Update Check-In' : 'Submit Check-In'}
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Funding Request Page
// ---------------------------------------------------------------------------
function FundingRequestPage({ me }) {
  const [requests, setRequests] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', amount: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [confirmEl, confirm] = useConfirm();
  const isPrivileged = me.role === 'admin' || me.role === 'manager';

  const load = useCallback(async () => {
    setError('');
    try { const d = await api('/funding'); setRequests(d.requests || []); }
    catch (err) { setError(err.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault(); setNotice('');
    if (!form.title.trim()) { setError('Please enter a title.'); return; }
    if (form.amount && Number(form.amount) < 0) { setError("Amount can't be negative."); return; }
    setError(''); setBusy('submit');
    try {
      await api('/funding', { method: 'POST', body: { ...form, title: form.title.trim(), amount: Number(form.amount) || 0 } });
      setForm({ title: '', description: '', amount: '' });
      setOpen(false); setNotice('Funding request submitted!'); load();
    } catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  async function reviewAction(id, action, reviewNotes) {
    if (action === 'deny' && !(await confirm({ title: 'Deny request?', message: 'The submitter will be notified that this request was denied.', confirmLabel: 'Deny', danger: true }))) return;
    setBusy(`${id}:${action}`);
    try { await api(`/funding/${id}`, { method: 'PATCH', body: { action, reviewNotes } }); load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  function exportCSV() {
    downloadCSV('funding-requests.csv', (requests || []).map((r) => ({
      title: r.title, amount: r.amount, status: r.status, submittedBy: r.submitterName,
      reviewedBy: r.reviewerName || '', reviewNotes: r.reviewNotes || '',
      description: r.description || '', createdAt: r.createdAt,
    })));
  }

  const statusColors = { pending: 'slate', approved: 'green', denied: 'red', purchased: 'blue' };

  return (
    <div className="max-w-4xl">
      {confirmEl}
      <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
        <h1 className="font-display text-4xl sm:text-5xl text-cream">Funding Requests</h1>
        {isPrivileged && (requests || []).length > 0 && (
          <Button variant="ghost" className="text-xs px-3 py-1.5" onClick={exportCSV}>⬇ Export CSV</Button>
        )}
      </div>
      <p className="text-cream/50 mb-6">
        {isPrivileged ? 'Review and manage all funding requests.' : 'Submit a request and track its status.'}
      </p>

      {error && <div className="text-red text-sm mb-4">{error}</div>}
      {notice && <div className="text-emerald-300 text-sm mb-4">{notice}</div>}

      <div className="mb-6">
        {!open ? (
          <Button variant="gold" onClick={() => setOpen(true)}>+ New Funding Request</Button>
        ) : (
          <form onSubmit={submit} className="bg-navy2 border border-gold/30 rounded-xl p-5 space-y-3 ca-slide-up">
            <div className="font-display text-xl text-gold">New Funding Request</div>
            <Field label="Title *"><input className={inputCls} value={form.title} onChange={set('title')} autoFocus placeholder="e.g. Flyers for fall recruitment" /></Field>
            <Field label="Description"><textarea className={inputCls} rows="3" value={form.description} onChange={set('description')} placeholder="What is this for? Why is it needed?" /></Field>
            <Field label="Amount ($)"><input className={inputCls} type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} placeholder="0.00" /></Field>
            <div className="flex gap-2">
              <Button type="submit" variant="gold" disabled={!!busy || !form.title.trim()}>{busy === 'submit' ? <span className="flex items-center gap-2"><Spinner /> Submitting…</span> : 'Submit'}</Button>
              <Button variant="ghost" onClick={() => setOpen(false)} type="button" disabled={!!busy}>Cancel</Button>
            </div>
          </form>
        )}
      </div>

      {requests === null && !error && <Loading label="Loading requests…" />}
      {requests !== null && requests.length === 0 && (
        <EmptyState icon="💰" title="No funding requests yet" hint={isPrivileged ? 'Requests submitted by the board will appear here for review.' : 'Use “+ New Funding Request” above to submit your first one.'} />
      )}
      <div className="space-y-3">
        {(requests || []).map((r) => (
          <div key={r.id} className="bg-navy2 border border-cream/10 rounded-xl p-4 hover:border-cream/20 transition-all duration-200">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="font-medium text-cream">{r.title}</div>
                {r.description && <div className="text-sm text-cream/60 mt-1">{r.description}</div>}
                <div className="text-xs text-cream/40 mt-2">
                  By {r.submitterName}{r.amount > 0 ? ` · $${Number(r.amount).toFixed(2)}` : ''}
                  {r.reviewerName && <> · Reviewed by {r.reviewerName}</>}
                  {r.reviewNotes && <> · "{r.reviewNotes}"</>}
                </div>
              </div>
              <Badge tone={statusColors[r.status] || 'slate'}>{r.status}</Badge>
            </div>
            {isPrivileged && r.status === 'pending' && (
              <div className="flex gap-2 mt-3">
                <Button variant="gold" className="text-xs px-3 py-1" onClick={() => reviewAction(r.id, 'approve')} disabled={!!busy}>
                  {busy === `${r.id}:approve` ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Approving…</span> : 'Approve'}
                </Button>
                <Button variant="danger" className="text-xs px-3 py-1" onClick={() => reviewAction(r.id, 'deny')} disabled={!!busy}>
                  {busy === `${r.id}:deny` ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Denying…</span> : 'Deny'}
                </Button>
              </div>
            )}
            {isPrivileged && r.status === 'approved' && (
              <div className="flex gap-2 mt-3">
                <Button variant="ghost" className="text-xs px-3 py-1" onClick={() => reviewAction(r.id, 'purchased')} disabled={!!busy}>
                  {busy === `${r.id}:purchased` ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Saving…</span> : 'Mark Purchased'}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board Applications Page
// ---------------------------------------------------------------------------
function BoardApplicationsPage({ me }) {
  const [apps, setApps] = useState(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ positionTitle: '', statement: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [confirmEl, confirm] = useConfirm();
  const isPrivileged = me.role === 'admin' || me.role === 'manager';

  const load = useCallback(async () => {
    setError('');
    try { const d = await api('/board-apps'); setApps(d.applications || []); }
    catch (err) { setError(err.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault(); setNotice('');
    if (!form.positionTitle.trim()) { setError('Please enter a position title.'); return; }
    setError(''); setBusy('submit');
    try {
      await api('/board-apps', { method: 'POST', body: { ...form, positionTitle: form.positionTitle.trim() } });
      setForm({ positionTitle: '', statement: '' });
      setOpen(false); setNotice('Application submitted!'); load();
    } catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  async function reviewAction(id, action) {
    if (action === 'decline' && !(await confirm({ title: 'Decline application?', message: 'The applicant will be notified that their application was declined.', confirmLabel: 'Decline', danger: true }))) return;
    setBusy(`${id}:${action}`);
    try { await api(`/board-apps/${id}`, { method: 'PATCH', body: { action } }); load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  const statusColors = { pending: 'slate', accepted: 'green', declined: 'red' };

  return (
    <div className="max-w-3xl">
      {confirmEl}
      <div className="flex items-end justify-between flex-wrap gap-3 mb-2">
        <h1 className="font-display text-4xl sm:text-5xl text-cream">Board Applications</h1>
        {isPrivileged && apps?.length > 0 && (
          <Button variant="ghost" onClick={() => downloadCSV('board-apps.csv', apps.map((a) => ({
            Name: a.submitterName, Position: a.positionTitle, Statement: a.statement,
            Status: a.status, Submitted: a.createdAt, Reviewer: a.reviewerName || '',
          })))}>Export CSV</Button>
        )}
      </div>
      <p className="text-cream/50 mb-6">
        Apply for a leadership position. {isPrivileged ? 'Review incoming applications below.' : ''}
      </p>

      {error && <div className="text-red text-sm mb-4">{error}</div>}
      {notice && <div className="text-emerald-300 text-sm mb-4">{notice}</div>}

      <div className="mb-6">
        {!open ? (
          <Button variant="gold" onClick={() => setOpen(true)}>+ Apply for a Position</Button>
        ) : (
          <form onSubmit={submit} className="bg-navy2 border border-gold/30 rounded-xl p-5 space-y-3 ca-slide-up">
            <div className="font-display text-xl text-gold">New Application</div>
            <Field label="Position Title *">
              <input className={inputCls} value={form.positionTitle} onChange={set('positionTitle')} autoFocus
                placeholder="e.g. Vice President, CFO, Grade Rep" />
            </Field>
            <Field label="Personal Statement">
              <textarea className={inputCls} rows="4" value={form.statement} onChange={set('statement')}
                placeholder="Why do you want this position? What makes you a strong candidate?" />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="gold" disabled={!!busy || !form.positionTitle.trim()}>{busy === 'submit' ? <span className="flex items-center gap-2"><Spinner /> Submitting…</span> : 'Submit'}</Button>
              <Button variant="ghost" onClick={() => setOpen(false)} type="button" disabled={!!busy}>Cancel</Button>
            </div>
          </form>
        )}
      </div>

      {apps === null && !error && <Loading label="Loading applications…" />}
      {apps !== null && apps.length === 0 && (
        <EmptyState icon="📝" title="No applications yet" hint={isPrivileged ? 'Leadership applications from the board will appear here.' : 'Use “+ Apply for a Position” above to submit yours.'} />
      )}
      <div className="space-y-3">
        {(apps || []).map((a) => (
          <div key={a.id} className="bg-navy2 border border-cream/10 rounded-xl p-4 hover:border-cream/20 transition-all duration-200">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="font-medium text-cream">{a.positionTitle}</div>
                {isPrivileged && (
                  <div className="text-sm text-gold/80 mt-0.5">{a.applicantName}{a.applicantTitle ? ` · ${a.applicantTitle}` : ''}</div>
                )}
                {a.statement && <div className="text-sm text-cream/60 mt-1 whitespace-pre-wrap">{a.statement}</div>}
                <div className="text-xs text-cream/40 mt-2">{new Date(a.createdAt).toLocaleDateString()}</div>
              </div>
              <Badge tone={statusColors[a.status] || 'slate'}>{a.status}</Badge>
            </div>
            {isPrivileged && a.status === 'pending' && (
              <div className="flex gap-2 mt-3">
                <Button variant="gold" className="text-xs px-3 py-1" onClick={() => reviewAction(a.id, 'accept')} disabled={!!busy}>
                  {busy === `${a.id}:accept` ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Accepting…</span> : 'Accept'}
                </Button>
                <Button variant="danger" className="text-xs px-3 py-1" onClick={() => reviewAction(a.id, 'decline')} disabled={!!busy}>
                  {busy === `${a.id}:decline` ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Declining…</span> : 'Decline'}
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin Dashboard (managers + admins only)
// ---------------------------------------------------------------------------
function AdminDashboardPage({ me }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [checkinEnabled, setCheckinEnabled] = useState(null);
  const [pulse, setPulse] = useState(null);
  const [teamTasks, setTeamTasks] = useState(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [pulseOpen, setPulseOpen] = useState(true);
  const [confirmEl, confirm] = useConfirm();

  const load = useCallback(async () => {
    setError('');
    try {
      const [d, s] = await Promise.all([api('/dashboard'), api('/checkins/settings')]);
      setData(d);
      setCheckinEnabled(s.enabled);
    } catch (err) { setError(err.message); }
  }, []);

  const loadPulse = useCallback(async () => {
    try { const d = await api('/checkins/pulse'); setPulse(d); } catch (_) {}
  }, []);

  const loadTeamTasks = useCallback(async () => {
    try { const d = await api('/team/tasks'); setTeamTasks(d.tasksByUser || []); } catch (_) {}
  }, []);

  useEffect(() => { load(); loadPulse(); }, [load, loadPulse]);

  async function nudge(userId) {
    setBusy(`nudge:${userId}`);
    try { await api(`/checkins/nudge/${userId}`, { method: 'POST' }); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  async function fundingAction(id, action) {
    if (action === 'deny' && !(await confirm({ title: 'Deny request?', message: 'The submitter will be notified.', confirmLabel: 'Deny', danger: true }))) return;
    setBusy(`funding:${id}:${action}`);
    try { await api(`/funding/${id}`, { method: 'PATCH', body: { action } }); load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  async function appAction(id, action) {
    if (action === 'decline' && !(await confirm({ title: 'Decline application?', message: 'The applicant will be notified.', confirmLabel: 'Decline', danger: true }))) return;
    setBusy(`app:${id}:${action}`);
    try { await api(`/board-apps/${id}`, { method: 'PATCH', body: { action } }); load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  async function taskAction(task, action) {
    if (action === 'reject' && !(await confirm({ title: 'Reject task?', message: `”${task.name}” will be rejected and the sender notified.`, confirmLabel: 'Reject', danger: true }))) return;
    setBusy(`task:${task.id}:${action}`);
    try { await api(`/tasks/${task.id}/${action}`, { method: 'POST' }); load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  function exportCheckins() {
    const rows = (data && data.recentCheckins) || [];
    downloadCSV('checkins.csv', rows.map((c) => ({
      member: c.userName, title: c.userTitle || '', weekOf: c.weekOf, submittedAt: c.submittedAt, content: c.content,
    })));
  }

  async function toggleCheckins() {
    setBusy('checkins');
    try {
      const d = await api('/checkins/settings', { method: 'PUT', body: { enabled: !checkinEnabled } });
      setCheckinEnabled(d.enabled);
    } catch (err) { setError(err.message); }
    finally { setBusy(''); }
  }

  function fmtDate(iso) {
    if (!iso) return '';
    // Date-only strings ("YYYY-MM-DD") parse as UTC midnight and show the wrong
    // day in western timezones — anchor to local noon to get the right date.
    const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T12:00:00') : new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  if (error && !data) return <div className="max-w-5xl"><ErrorState message={error} onRetry={load} /></div>;
  if (!data) return <Loading label="Loading dashboard…" />;

  const { pendingFunding, pendingApps, recentCheckins, pendingTasks, counts, missingCheckins = [], checkinWeekOf, recentActivity = [] } = data;

  function fmtActivity(a) {
    const verb = { approved: 'approved', rejected: 'rejected', denied: 'denied', purchased: 'marked purchased', accepted: 'accepted', declined: 'declined' }[a.action] || a.action;
    const kind = { task: 'task', funding: 'funding request', 'board-app': 'application' }[a.entityType] || a.entityType;
    return `${a.actorName || 'Someone'} ${verb} a ${kind}${a.detail ? ` — “${a.detail}”` : ''}`;
  }

  return (
    <div className="max-w-5xl space-y-8">
      {confirmEl}
      <div>
        <h1 className="font-display text-4xl sm:text-5xl text-cream leading-none">Dashboard</h1>
        <p className="text-cream/50 mt-1">Overview for managers and admins.</p>
      </div>

      {error && <div className="text-red text-sm">{error}</div>}

      {/* Tabs */}
      <div className="flex gap-1 bg-navy2 border border-cream/10 rounded-lg p-1 w-fit">
        {[['overview','Overview'],['teamtasks','Team Tasks']].map(([t,label]) => (
          <button key={t} onClick={() => { setActiveTab(t); if (t === 'teamtasks' && !teamTasks) loadTeamTasks(); }}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all duration-150 ${activeTab === t ? 'bg-gold text-navy' : 'text-cream/60 hover:text-cream'}`}>
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'teamtasks' && (
        <div className="space-y-6">
          {teamTasks === null && <Loading label="Loading team tasks…" />}
          {teamTasks !== null && teamTasks.length === 0 && (
            <EmptyState icon="✅" title="No team tasks" hint="Your direct reports have no approved tasks yet." />
          )}
          {(teamTasks || []).map((group) => {
            const today = new Date().toISOString().slice(0, 10);
            return (
              <div key={group.user.id}>
                <div className="font-display text-xl text-gold mb-2">{group.user.displayName}
                  {group.user.title && <span className="text-cream/50 text-sm font-sans ml-2">· {group.user.title}</span>}
                </div>
                <div className="space-y-2">
                  {group.tasks.map((t) => {
                    const overdue = t.status !== 'Complete' && t.dueDate && t.dueDate < today;
                    return (
                      <div key={t.id} className={`bg-navy2 border rounded-xl px-4 py-3 flex items-center justify-between gap-3 ${overdue ? 'border-red/40' : 'border-cream/10'}`}>
                        <div className="min-w-0">
                          <div className={`text-sm font-medium ${overdue ? 'text-red' : 'text-cream'}`}>{t.name}</div>
                          {t.dueDate && <div className={`text-xs mt-0.5 ${overdue ? 'text-red/70' : 'text-cream/40'}`}>Due {t.dueDate}{overdue ? ' · OVERDUE' : ''}</div>}
                        </div>
                        <select value={t.status}
                          onChange={async (e) => {
                            try { await api(`/tasks/${t.id}`, { method: 'PATCH', body: { status: e.target.value } }); loadTeamTasks(); }
                            catch (_) {}
                          }}
                          className="bg-navy border border-cream/20 rounded px-2 py-1 text-xs text-cream focus:outline-none focus:border-gold/60 shrink-0">
                          {['Not Started','In Progress','Complete'].map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {activeTab === 'overview' && <>

      {/* Check-in toggle */}
      {checkinEnabled !== null && (
        <div className="bg-navy2 border border-cream/10 rounded-xl p-5 flex items-center justify-between gap-4">
          <div>
            <div className="text-cream font-medium">Weekly Check-Ins</div>
            <div className="text-cream/50 text-sm">{checkinEnabled ? 'Members can submit check-ins this week.' : 'Check-ins are currently disabled.'}</div>
          </div>
          <Toggle enabled={checkinEnabled} onChange={toggleCheckins} disabled={!!busy} />
        </div>
      )}

      {/* Check-In Pulse card */}
      {checkinEnabled && pulse && (
        <div className="bg-navy2 border border-cream/10 rounded-xl overflow-hidden">
          <button className="w-full px-5 py-4 flex items-center justify-between gap-3 hover:bg-navy3/30 transition-colors"
            onClick={() => setPulseOpen((o) => !o)}>
            <div>
              <div className="text-cream font-medium">Check-In Pulse — Week of {pulse.weekOf}</div>
              <div className="text-xs text-cream/50 mt-0.5">
                {pulse.users.filter((u) => u.submitted).length} / {pulse.users.length} submitted
              </div>
            </div>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
              className={`text-cream/40 transition-transform duration-200 ${pulseOpen ? 'rotate-180' : ''}`}>
              <path d="m6 9 6 6 6-6"/>
            </svg>
          </button>
          {pulseOpen && (
            <div className="border-t border-cream/10 divide-y divide-cream/5">
              {pulse.users.map((u) => (
                <div key={u.id} className="px-5 py-2.5 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${u.submitted ? 'bg-emerald-400' : 'bg-red/70'}`} />
                    <span className="text-cream text-sm">{u.displayName}</span>
                    {u.title && <span className="text-cream/40 text-xs hidden sm:inline">· {u.title}</span>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge tone={u.submitted ? 'green' : 'red'}>{u.submitted ? '✓ Submitted' : '✗ Missing'}</Badge>
                    {!u.submitted && (
                      <button onClick={() => nudge(u.id)} disabled={busy === `nudge:${u.id}`}
                        className="text-xs text-gold/70 hover:text-gold border border-gold/30 hover:border-gold/60 rounded px-2 py-0.5 transition-colors disabled:opacity-40">
                        {busy === `nudge:${u.id}` ? '…' : 'Nudge'}
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Pending Funding', count: counts.funding, color: 'text-gold' },
          { label: 'Board Applications', count: counts.apps, color: 'text-sky-300' },
          { label: 'Pending Task Approvals', count: counts.tasks, color: 'text-red' },
          ...(checkinEnabled ? [{ label: 'Missing Check-Ins', count: counts.missingCheckins || 0, color: 'text-orange-300' }] : []),
        ].map(({ label, count, color }) => (
          <div key={label} className="bg-navy2 border border-cream/10 rounded-xl p-5 text-center hover:border-cream/20 hover:-translate-y-0.5 hover:shadow-md hover:shadow-black/20 transition-all duration-200">
            <div className={`font-display text-4xl ${color}`}>{count}</div>
            <div className="text-cream/60 text-sm mt-1">{label}</div>
          </div>
        ))}
      </div>

      {/* Who still owes this Friday's check-in */}
      {checkinEnabled && (
        <div>
          <div className="font-display text-2xl text-gold mb-3">
            Missing This Week's Check-In ({missingCheckins.length})
            {checkinWeekOf && <span className="text-cream/40 text-base ml-2">· due Friday {fmtDate(checkinWeekOf)}</span>}
          </div>
          {missingCheckins.length === 0
            ? <div className="text-emerald-300 text-sm">🎉 Everyone has checked in this week.</div>
            : (
              <div className="bg-navy2 border border-orange-300/20 rounded-xl p-4 flex flex-wrap gap-2">
                {missingCheckins.map((u) => (
                  <span key={u.id} className="text-sm bg-orange-300/10 border border-orange-300/30 text-orange-200 rounded-full px-3 py-1">
                    {u.displayName}{u.title ? <span className="opacity-60"> · {u.title}</span> : null}
                  </span>
                ))}
              </div>
            )}
        </div>
      )}

      {/* Pending Funding Requests */}
      <div>
        <div className="font-display text-2xl text-gold mb-3">Pending Funding Requests ({pendingFunding.length})</div>
        {pendingFunding.length === 0 && <div className="text-cream/40">None pending.</div>}
        <div className="space-y-3">
          {pendingFunding.map((r) => (
            <div key={r.id} className="bg-navy2 border border-gold/20 rounded-xl p-4 hover:border-gold/35 transition-all duration-200">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-medium text-cream">{r.title}</div>
                  {r.description && <div className="text-sm text-cream/60 mt-1">{r.description}</div>}
                  <div className="text-xs text-cream/40 mt-1">By {r.submitterName}{r.amount > 0 ? ` · $${Number(r.amount).toFixed(2)}` : ''} · {fmtDate(r.createdAt)}</div>
                </div>
                <Badge tone="slate">pending</Badge>
              </div>
              <div className="flex gap-2 mt-3">
                <Button variant="gold" className="text-xs px-3 py-1" onClick={() => fundingAction(r.id, 'approve')} disabled={!!busy}>
                  {busy === `funding:${r.id}:approve` ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Approving…</span> : 'Approve'}
                </Button>
                <Button variant="danger" className="text-xs px-3 py-1" onClick={() => fundingAction(r.id, 'deny')} disabled={!!busy}>
                  {busy === `funding:${r.id}:deny` ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Denying…</span> : 'Deny'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Board Applications */}
      <div>
        <div className="font-display text-2xl text-gold mb-3">Board Applications ({pendingApps.length})</div>
        {pendingApps.length === 0 && <div className="text-cream/40">No pending applications.</div>}
        <div className="space-y-3">
          {pendingApps.map((a) => (
            <div key={a.id} className="bg-navy2 border border-sky-500/20 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-medium text-cream">{a.positionTitle}</div>
                  <div className="text-sm text-sky-300/80">{a.applicantName}{a.applicantTitle ? ` · ${a.applicantTitle}` : ''}</div>
                  {a.statement && <div className="text-sm text-cream/60 mt-1 whitespace-pre-wrap line-clamp-3">{a.statement}</div>}
                  <div className="text-xs text-cream/40 mt-1">{fmtDate(a.createdAt)}</div>
                </div>
              </div>
              <div className="flex gap-2 mt-3">
                <Button variant="gold" className="text-xs px-3 py-1" onClick={() => appAction(a.id, 'accept')} disabled={!!busy}>
                  {busy === `app:${a.id}:accept` ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Accepting…</span> : 'Accept'}
                </Button>
                <Button variant="danger" className="text-xs px-3 py-1" onClick={() => appAction(a.id, 'decline')} disabled={!!busy}>
                  {busy === `app:${a.id}:decline` ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Declining…</span> : 'Decline'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Pending Task Approvals */}
      <div>
        <div className="font-display text-2xl text-gold mb-3">Pending Task Approvals ({pendingTasks.length})</div>
        {pendingTasks.length === 0 && <div className="text-cream/40">Nothing waiting on you.</div>}
        <div className="space-y-3">
          {pendingTasks.map((t) => (
            <div key={t.id} className="bg-navy2 border border-red/20 rounded-xl p-4">
              <div className="font-medium text-cream">{t.name}</div>
              {t.description && <div className="text-sm text-cream/60 mt-1">{t.description}</div>}
              <div className="text-xs text-cream/50 mt-2">
                For <span className="text-gold/80">{t.ownerName}</span> · from <span className="text-gold/80">{t.assignedByName}</span>
                {t.dueDate && <> · due {t.dueDate}</>}
              </div>
              <div className="flex gap-2 mt-3">
                <Button variant="gold" className="text-xs px-3 py-1" onClick={() => taskAction(t, 'approve')} disabled={!!busy}>
                  {busy === `task:${t.id}:approve` ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Approving…</span> : 'Approve'}
                </Button>
                <Button variant="danger" className="text-xs px-3 py-1" onClick={() => taskAction(t, 'reject')} disabled={!!busy}>
                  {busy === `task:${t.id}:reject` ? <span className="flex items-center gap-1.5"><Spinner className="w-3 h-3" /> Rejecting…</span> : 'Reject'}
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Check-Ins */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-3">
          <div className="font-display text-2xl text-gold">Recent Check-Ins ({recentCheckins.length})</div>
          {recentCheckins.length > 0 && <Button variant="ghost" className="text-xs px-3 py-1.5" onClick={exportCheckins}>⬇ Export CSV</Button>}
        </div>
        {recentCheckins.length === 0 && <div className="text-cream/40">No check-ins submitted yet.</div>}
        <div className="space-y-3">
          {recentCheckins.map((c) => (
            <div key={c.id} className="bg-navy2 border border-cream/10 rounded-xl p-4">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div>
                  <span className="font-medium text-cream">{c.userName}</span>
                  {c.userTitle && <span className="text-cream/50 text-sm ml-2">· {c.userTitle}</span>}
                </div>
                <span className="text-xs text-cream/40">Week of {fmtDate(c.weekOf)}</span>
              </div>
              <div className="text-sm text-cream/70 whitespace-pre-wrap">{c.content}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent review activity (audit log) */}
      <div>
        <div className="font-display text-2xl text-gold mb-3">Recent Activity</div>
        {recentActivity.length === 0
          ? <div className="text-cream/40">No approvals or reviews logged yet.</div>
          : (
            <div className="bg-navy2 border border-cream/10 rounded-xl divide-y divide-cream/5">
              {recentActivity.map((a) => (
                <div key={a.id} className="px-4 py-2.5 flex items-center justify-between gap-3 text-sm">
                  <span className="text-cream/80">{fmtActivity(a)}</span>
                  <span className="text-xs text-cream/40 shrink-0">{timeAgo(a.createdAt)}</span>
                </div>
              ))}
            </div>
          )}
      </div>
      </>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sidebar + Layout
// ---------------------------------------------------------------------------
// Logistics login-tracking dashboard (logistics user only)
// ---------------------------------------------------------------------------
function LogisticsPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState('members');
  const [logVisible, setLogVisible] = useState(50);
  const [eventsVisible, setEventsVisible] = useState(50);

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const d = await api('/logistics/stats');
      setData(d);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  function fmtDate(dt) {
    if (!dt) return '—';
    const d = new Date(dt.includes('T') || dt.includes('Z') ? dt : dt + 'Z');
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  if (loading) return <Loading label="Loading login activity…" />;
  if (error) return <div className="p-6 max-w-6xl"><ErrorState message={error} onRetry={load} /></div>;
  if (!data) return null;

  const { stats, perUserDaily = [], teamDaily = [], recentLogins, demographics, engagementSummary = [], recentEvents = [] } = data;

  // Build a map: userId -> { 'YYYY-MM-DD': count }
  const dailyMap = {};
  for (const row of perUserDaily) {
    if (!dailyMap[row.userId]) dailyMap[row.userId] = {};
    dailyMap[row.userId][row.day] = row.count;
  }
  // Last 7 UTC dates as strings (index 0 = oldest, 6 = today)
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (6 - i));
    return d.toISOString().slice(0, 10);
  });
  const DAY_LABELS = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const dayLabel = (iso) => DAY_LABELS[new Date(iso + 'T12:00:00Z').getUTCDay()];

  const allTime = stats.reduce((s, r) => s + Number(r.totalLogins || 0), 0);
  // Today = last entry in last7
  const todayStr = last7[6];
  const totalToday = perUserDaily.filter(r => r.day === todayStr).reduce((s, r) => s + r.count, 0);
  const activeToday = new Set(perUserDaily.filter(r => r.day === todayStr).map(r => r.userId)).size;
  const neverIn = stats.filter(r => !r.lastLogin).length;

  const filtered = filter
    ? stats.filter(r =>
        r.displayName.toLowerCase().includes(filter.toLowerCase()) ||
        r.username.toLowerCase().includes(filter.toLowerCase()))
    : stats;

  const TabBtn = ({ id, label }) => (
    <button
      onClick={() => setTab(id)}
      className={`text-sm px-4 py-2 border-b-2 transition-all duration-150 ${
        tab === id ? 'border-gold text-gold' : 'border-transparent text-cream/50 hover:text-cream/80'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="p-6 max-w-6xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-cream">Login Activity Dashboard</h1>
          <p className="text-cream/45 text-xs mt-0.5">Productivity monitoring — confidential</p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="shrink-0 text-xs text-gold/80 hover:text-gold border border-gold/30 hover:border-gold/60 px-3 py-1.5 rounded transition-colors disabled:opacity-40 flex items-center gap-1.5"
        >
          {loading ? <><Spinner className="w-3 h-3" /> Refreshing…</> : 'Refresh'}
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Logins Today', value: totalToday, color: 'text-gold' },
          { label: 'Active Today', value: activeToday, color: 'text-emerald-400' },
          { label: 'All-Time Logins', value: allTime, color: 'text-sky-400' },
          { label: 'Never Logged In', value: neverIn, color: neverIn > 0 ? 'text-red' : 'text-cream/40' },
        ].map(({ label, value, color }) => (
          <div key={label} className="bg-navy2 rounded-lg p-4 border border-cream/10">
            <div className={`text-2xl font-bold ${color}`}>{value}</div>
            <div className="text-cream/50 text-xs mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="flex gap-0 border-b border-cream/10">
        <TabBtn id="members" label={`Members (${stats.length})`} />
        <TabBtn id="log" label={`Login Log (${recentLogins.length})`} />
        <TabBtn id="demographics" label="Club Breakdown" />
        <TabBtn id="engagement" label="Site Engagement" />
      </div>

      {tab === 'members' && (
        <div className="space-y-4">
          <input
            type="text"
            placeholder="Search by name or username…"
            value={filter}
            onChange={e => setFilter(e.target.value)}
            className="w-full max-w-xs bg-navy2 border border-cream/20 rounded px-3 py-1.5 text-cream text-sm placeholder-cream/30 focus:outline-none focus:border-gold/60"
          />

          {/* 14-day team trend bar chart */}
          {teamDaily.length > 0 && (() => {
            const maxCount = Math.max(...teamDaily.map(d => d.count), 1);
            return (
              <div className="bg-navy2 rounded-lg p-4 border border-cream/10">
                <div className="text-cream/50 text-xs mb-3">Team logins — last 14 days</div>
                <div className="flex items-end gap-1 h-12">
                  {teamDaily.map(d => {
                    const h = Math.max(4, Math.round((d.count / maxCount) * 48));
                    const isToday = d.day === todayStr;
                    return (
                      <div key={d.day} className="flex-1 flex flex-col items-center gap-0.5 group relative">
                        <div
                          className={`w-full rounded-sm ${isToday ? 'bg-gold' : 'bg-cream/25 group-hover:bg-cream/40'} transition-colors`}
                          style={{ height: h }}
                          title={`${d.day}: ${d.count} login${d.count !== 1 ? 's' : ''}`}
                        />
                        {isToday && <div className="absolute -bottom-4 text-gold text-[9px]">today</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-cream/40 text-xs text-left border-b border-cream/10">
                  <th className="pb-2 pr-6 font-medium">Member</th>
                  <th className="pb-2 pr-4 font-medium">Title / Role</th>
                  {/* 7 day columns */}
                  {last7.map(d => (
                    <th key={d} className={`pb-2 px-1 font-medium text-center w-7 ${d === todayStr ? 'text-gold' : ''}`}>
                      {dayLabel(d)}
                    </th>
                  ))}
                  <th className="pb-2 px-3 font-medium text-center">Total</th>
                  <th className="pb-2 pl-3 font-medium">Last Login</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const days = dailyMap[r.userId] || {};
                  return (
                    <tr key={r.userId} className="border-b border-cream/5 hover:bg-cream/3">
                      <td className="py-3 pr-6">
                        <div className="text-cream font-medium text-sm">{r.displayName}</div>
                        <div className="text-cream/35 text-xs">@{r.username}</div>
                      </td>
                      <td className="py-3 pr-4 text-cream/55 text-xs">{r.title || r.role}</td>
                      {last7.map(d => {
                        const cnt = days[d] || 0;
                        const isToday = d === todayStr;
                        return (
                          <td key={d} className="py-3 px-1 text-center">
                            {cnt > 0
                              ? <span className={`text-xs font-semibold ${isToday ? 'text-gold' : 'text-emerald-400'}`}>{cnt}</span>
                              : <span className="text-cream/15 text-xs">·</span>}
                          </td>
                        );
                      })}
                      <td className="py-3 px-3 text-center">
                        <span className={Number(r.totalLogins) > 0 ? 'text-cream/70 font-medium text-xs' : 'text-cream/20 text-xs'}>
                          {r.totalLogins}
                        </span>
                      </td>
                      <td className="py-3 pl-3">
                        {r.lastLogin
                          ? <span className="text-cream/50 text-xs">{fmtDate(r.lastLogin)}</span>
                          : <span className="inline-block text-xs text-red/70 bg-red/10 border border-red/20 rounded px-1.5 py-0.5">Never</span>}
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && (
                  <tr><td colSpan={11} className="py-8 text-center text-cream/25 text-sm">No results.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'log' && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-cream/40 text-xs text-left border-b border-cream/10">
                <th className="pb-2 pr-4 font-medium">Time</th>
                <th className="pb-2 pr-4 font-medium">Member</th>
                <th className="pb-2 pr-4 font-medium">Title</th>
                <th className="pb-2 font-medium">IP Address</th>
              </tr>
            </thead>
            <tbody>
              {recentLogins.slice(0, logVisible).map(l => (
                <tr key={l.id} className="border-b border-cream/5 hover:bg-cream/3">
                  <td className="py-2.5 pr-4 text-cream/55 text-xs whitespace-nowrap">{fmtDate(l.loginAt)}</td>
                  <td className="py-2.5 pr-4">
                    <div className="text-cream font-medium">{l.displayName}</div>
                    <div className="text-cream/35 text-xs">@{l.username}</div>
                  </td>
                  <td className="py-2.5 pr-4 text-cream/55 text-xs">{l.title}</td>
                  <td className="py-2.5 text-cream/35 text-xs font-mono">{l.ipAddress || '—'}</td>
                </tr>
              ))}
              {recentLogins.length === 0 && (
                <tr><td colSpan={4} className="py-8 text-center text-cream/25 text-sm">No logins recorded yet.</td></tr>
              )}
            </tbody>
          </table>
          {recentLogins.length > logVisible && (
            <div className="text-center pt-3">
              <Button variant="ghost" onClick={() => setLogVisible(v => v + 50)}>Show more ({recentLogins.length - logVisible} more)</Button>
            </div>
          )}
        </div>
      )}

      {tab === 'engagement' && (() => {
        const totalClicks = engagementSummary.reduce((s, r) => s + r.count, 0);
        const todayClicks = engagementSummary.reduce((s, r) => s + (r.todayCount || 0), 0);

        const podcastRows = engagementSummary.filter(r => r.event === 'podcast_watch');
        const podcastTotal = podcastRows.reduce((s, r) => s + r.count, 0);

        const boardRows = engagementSummary.filter(r => r.event === 'board_profile')
          .sort((a, b) => b.count - a.count);
        const boardMax = boardRows[0]?.count || 1;

        const eventLabel = (e) => e === 'podcast_watch' ? '▶ Podcast' : e === 'board_profile' ? '👤 Profile' : e;

        return (
          <div className="space-y-8 max-w-2xl">
            {/* Summary */}
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: 'Total Clicks', value: totalClicks, color: 'text-gold' },
                { label: 'Today', value: todayClicks, color: 'text-emerald-400' },
                { label: 'Podcast Clicks', value: podcastTotal, color: 'text-sky-400' },
              ].map(({ label, value, color }) => (
                <div key={label} className="bg-navy2 rounded-lg p-4 border border-cream/10">
                  <div className={`text-2xl font-bold ${color}`}>{value}</div>
                  <div className="text-cream/50 text-xs mt-0.5">{label}</div>
                </div>
              ))}
            </div>

            {/* Board profiles */}
            <div>
              <div className="text-cream/60 text-sm font-medium mb-3">Board Profile Views</div>
              {boardRows.length === 0 ? (
                <div className="text-cream/25 text-sm">No profile clicks recorded yet.</div>
              ) : (
                <div className="space-y-2.5">
                  {boardRows.map(r => {
                    const pct = Math.round((r.count / boardMax) * 100);
                    return (
                      <div key={r.label}>
                        <div className="flex justify-between text-xs mb-1">
                          <span className="text-cream/70">{r.label}</span>
                          <span className="text-cream/50">{r.count} click{r.count !== 1 ? 's' : ''} <span className="text-cream/30">· today: {r.todayCount || 0}</span></span>
                        </div>
                        <div className="h-2 bg-navy rounded-full overflow-hidden">
                          <div className="h-full rounded-full bg-gold transition-all" style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Recent event log */}
            <div>
              <div className="text-cream/60 text-sm font-medium mb-3">Recent Clicks</div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-cream/40 text-xs text-left border-b border-cream/10">
                      <th className="pb-2 pr-4 font-medium">Time</th>
                      <th className="pb-2 pr-4 font-medium">Event</th>
                      <th className="pb-2 font-medium">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentEvents.slice(0, eventsVisible).map(e => (
                      <tr key={e.id} className="border-b border-cream/5 hover:bg-cream/3">
                        <td className="py-2 pr-4 text-cream/45 text-xs whitespace-nowrap">{fmtDate(e.loggedAt)}</td>
                        <td className="py-2 pr-4 text-xs">
                          <span className="inline-block bg-navy2 border border-cream/15 rounded px-1.5 py-0.5 text-cream/70">{eventLabel(e.event)}</span>
                        </td>
                        <td className="py-2 text-cream/55 text-xs max-w-xs truncate">{e.label || '—'}</td>
                      </tr>
                    ))}
                    {recentEvents.length === 0 && (
                      <tr><td colSpan={3} className="py-8 text-center text-cream/25 text-sm">No clicks recorded yet.</td></tr>
                    )}
                  </tbody>
                </table>
                {recentEvents.length > eventsVisible && (
                  <div className="text-center pt-3">
                    <Button variant="ghost" onClick={() => setEventsVisible(v => v + 50)}>Show more ({recentEvents.length - eventsVisible} more)</Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })()}

      {tab === 'demographics' && (() => {
        const { totalMembers, genderBreakdown, gradeBreakdown } = demographics || {};
        const gradeLabel = (g) => {
          if (g === 'Unknown') return 'Unknown';
          const n = Number(g);
          if (n === 9) return '9th Grade';
          if (n === 10) return '10th Grade';
          if (n === 11) return '11th Grade';
          if (n === 12) return '12th Grade';
          return `Grade ${g}`;
        };
        const genderColors = ['bg-sky-400', 'bg-emerald-400', 'bg-gold', 'bg-red/70', 'bg-cream/30'];
        const gradeColors = ['bg-red', 'bg-gold', 'bg-sky-400', 'bg-emerald-400', 'bg-cream/30'];

        const BreakdownSection = ({ title, rows, colors }) => {
          const total = rows.reduce((s, r) => s + r.count, 0);
          if (total === 0) return (
            <div>
              <div className="text-cream/60 text-sm font-medium mb-3">{title}</div>
              <div className="text-cream/25 text-sm">No data yet.</div>
            </div>
          );
          return (
            <div>
              <div className="flex items-baseline gap-2 mb-3">
                <span className="text-cream/60 text-sm font-medium">{title}</span>
                <span className="text-cream/30 text-xs">{total} onboarded members</span>
              </div>
              <div className="space-y-2.5">
                {rows.map((r, i) => {
                  const pct = total > 0 ? Math.round((r.count / total) * 100) : 0;
                  return (
                    <div key={r.label}>
                      <div className="flex justify-between text-xs mb-1">
                        <span className="text-cream/70">{r.label}</span>
                        <span className="text-cream/50">{pct}% <span className="text-cream/30">({r.count})</span></span>
                      </div>
                      <div className="h-2 bg-navy rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${colors[i % colors.length]}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        };

        return (
          <div className="space-y-8 max-w-lg">
            <div className="bg-navy2 rounded-lg p-4 border border-cream/10 inline-block">
              <div className="text-2xl font-bold text-gold">{totalMembers ?? '—'}</div>
              <div className="text-cream/50 text-xs mt-0.5">Total Onboarded Members</div>
            </div>
            <BreakdownSection title="Gender Breakdown" rows={genderBreakdown || []} colors={genderColors} />
            <BreakdownSection title="Grade Breakdown" rows={(gradeBreakdown || []).map(r => ({ ...r, label: gradeLabel(r.label) }))} colors={gradeColors} />
          </div>
        );
      })()}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Notes panel (modal overlay)
// ---------------------------------------------------------------------------
function AINotesPanel({ onClose, onRead }) {
  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api('/ai/notes')
      .then((d) => setNotes(d.notes || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function markRead(id) {
    await api(`/ai/notes/${id}/read`, { method: 'PATCH' }).catch(() => {});
    setNotes((prev) => prev.map((n) => n.id === id ? { ...n, isRead: 1 } : n));
    onRead();
  }

  return (
    <div onClick={onClose} className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div onClick={(e) => e.stopPropagation()} className="bg-navy2 border border-gold/30 rounded-2xl max-w-lg w-full p-6 relative max-h-[80vh] overflow-y-auto ca-scale-in">
        <button onClick={onClose} aria-label="Close" className="absolute top-2 right-4 text-cream/60 hover:text-cream text-3xl leading-none">×</button>
        <div className="font-display text-2xl text-gold mb-1">AI Notes</div>
        <p className="text-cream/40 text-xs mb-4">Private notes left by the AI when it notices something worth your attention.</p>
        {loading && <div className="text-cream/40 text-sm">Loading…</div>}
        {!loading && notes.length === 0 && (
          <div className="text-cream/40 text-sm">No AI notes yet — you're all caught up.</div>
        )}
        <div className="space-y-3">
          {notes.map((n) => (
            <div key={n.id} className={`rounded-lg p-4 border transition-all duration-200 ${n.isRead ? 'border-cream/10 bg-navy hover:border-cream/20' : 'border-gold/40 bg-gold/5 hover:border-gold/60'}`}>
              <div className="text-sm text-cream/85 whitespace-pre-wrap leading-relaxed">{n.content}</div>
              <div className="flex items-center justify-between mt-2">
                <span className="text-xs text-cream/35">{new Date(n.createdAt).toLocaleDateString()}</span>
                {!n.isRead && (
                  <button onClick={() => markRead(n.id)} className="text-xs text-gold/70 hover:text-gold">Mark read</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI Chat page (admin only)
// ---------------------------------------------------------------------------
function AIChatPage({ me }) {
  const [messages, setMessages] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [analyzeStatus, setAnalyzeStatus] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => {
    api('/ai/chat/history')
      .then((d) => {
        if (d.messages && d.messages.length) {
          setMessages(d.messages);
          setSessionId(d.sessionId);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (bottomRef.current) bottomRef.current.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    setBusy(true);
    setError('');
    const tempId = Date.now();
    setMessages((prev) => [...prev, { _tempId: tempId, role: 'user', content: text }]);
    try {
      const d = await api('/ai/chat', { method: 'POST', body: { message: text, sessionId } });
      setSessionId(d.sessionId);
      setMessages((prev) => [
        ...prev.filter((m) => m._tempId !== tempId),
        { role: 'user', content: text },
        { role: 'assistant', content: d.reply },
      ]);
    } catch (err) {
      setError(err.message || 'Request failed');
      setMessages((prev) => prev.filter((m) => m._tempId !== tempId));
    } finally {
      setBusy(false);
    }
  }

  function newChat() {
    setMessages([]);
    setSessionId(`${me.id}-${Date.now()}`);
    setError('');
  }

  async function runAnalysis() {
    setAnalyzeStatus('Running…');
    try {
      const d = await api('/ai/analyze', { method: 'POST' });
      setAnalyzeStatus(d.skipped ? 'AI not configured (no API key).' : 'Analysis complete — check your team members\' AI Notes.');
    } catch (err) {
      setAnalyzeStatus('Analysis failed: ' + (err.message || 'unknown error'));
    }
    setTimeout(() => setAnalyzeStatus(''), 6000);
  }

  return (
    <div className="max-w-3xl mx-auto flex flex-col" style={{ height: 'calc(100vh - 120px)' }}>
      <div className="flex items-end justify-between mb-4 flex-wrap gap-2">
        <div>
          <h1 className="font-display text-4xl text-cream leading-none">AI Assistant</h1>
          <p className="text-cream/50 text-sm mt-1">Ask about team health, tasks, check-ins, login activity, or get a summary.</p>
        </div>
        <div className="flex gap-2 items-center flex-wrap">
          {analyzeStatus && <span className="text-xs text-cream/60">{analyzeStatus}</span>}
          <Button variant="ghost" onClick={runAnalysis} className="text-xs">Run Analysis Now</Button>
          <Button variant="ghost" onClick={newChat} className="text-xs">New Chat</Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-navy2 border border-cream/10 rounded-xl p-4 space-y-4 mb-4">
        {messages.length === 0 && (
          <div className="text-cream/30 text-sm text-center pt-8">
            Ask something — e.g. "Who has the most overdue tasks?" or "Show me login patterns this week."
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ca-slide-up ${m.role === 'user' ? 'justify-end' : 'justify-start'}`} style={{ animationDelay: '0ms' }}>
            <div className={`max-w-[82%] rounded-xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap
              ${m.role === 'user'
                ? 'bg-red/20 text-cream border border-red/30'
                : 'bg-navy3 text-cream/90 border border-cream/10'}`}>
              {m.role === 'assistant' && (
                <div className="text-gold/60 text-xs font-medium mb-1 uppercase tracking-wider">AI</div>
              )}
              {m.content}
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div className="bg-navy3 border border-cream/10 rounded-xl px-4 py-3 text-cream/40 text-sm">Thinking…</div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {error && <div className="text-red text-sm mb-2">{error}</div>}

      <form onSubmit={send} className="flex gap-2">
        <input
          className={inputCls + ' flex-1'}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about the team…"
          disabled={busy}
        />
        <Button type="submit" variant="gold" disabled={busy || !input.trim()}>
          {busy ? <Spinner /> : 'Send'}
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Home Summary Card
// ---------------------------------------------------------------------------
function HomeSummaryCard({ me, onNavigate }) {
  const [summary, setSummary] = useState(null);

  useEffect(() => {
    api('/me/summary').then(setSummary).catch(() => {});
  }, []);

  if (!summary) return null;

  const { tasksDueSoon, checkinSubmitted, nextMeeting, openPolls } = summary;

  const items = [
    {
      label: 'Tasks Due Soon',
      value: tasksDueSoon > 0 ? tasksDueSoon + ' task' + (tasksDueSoon !== 1 ? 's' : '') : 'All clear',
      tone: tasksDueSoon > 0 ? 'gold' : 'green',
      view: { type: 'mytasks' },
    },
    ...(checkinSubmitted !== null ? [{
      label: 'Check-In',
      value: checkinSubmitted ? '✓ Submitted' : '⚠ Not yet',
      tone: checkinSubmitted ? 'green' : 'red',
      view: { type: 'checkin' },
    }] : []),
    {
      label: 'Next Meeting',
      value: nextMeeting ? nextMeeting.title + ' · ' + fmtShortDate(nextMeeting.meetingDate) : 'None scheduled',
      tone: nextMeeting ? 'blue' : 'slate',
      view: { type: 'meetings' },
    },
    {
      label: 'Open Polls',
      value: openPolls > 0 ? openPolls + ' need' + (openPolls === 1 ? 's' : '') + ' your vote' : 'None open',
      tone: openPolls > 0 ? 'gold' : 'slate',
      view: { type: 'polls' },
    },
  ];

  const toneCls = {
    gold: 'border-gold/30 bg-gold/5',
    green: 'border-emerald-500/30 bg-emerald-500/5',
    red: 'border-red/30 bg-red/5',
    blue: 'border-sky-500/30 bg-sky-500/5',
    slate: 'border-cream/10 bg-cream/5',
  };
  const valueCls = {
    gold: 'text-gold', green: 'text-emerald-300', red: 'text-red', blue: 'text-sky-300', slate: 'text-cream/50',
  };

  return (
    <div className="mb-6 grid grid-cols-2 sm:grid-cols-4 gap-2">
      {items.map((item) => (
        <button key={item.label} onClick={() => onNavigate(item.view)}
          className={`border rounded-xl p-3 text-left hover:brightness-110 transition-all active:scale-95 ${toneCls[item.tone]}`}>
          <div className="text-cream/50 text-[10px] uppercase tracking-wide mb-1">{item.label}</div>
          <div className={`text-sm font-medium leading-snug ${valueCls[item.tone]}`}>{item.value}</div>
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shoutouts / Kudos Page
// ---------------------------------------------------------------------------
const SHOUTOUT_TAGS = ['', '🎉 Great Work', '💡 Creative', '🤝 Teamwork', '🏆 Above and Beyond'];

function ShoutoutsPage({ me }) {
  const [shoutouts, setShoutouts] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [users, setUsers] = useState([]);
  const [toId, setToId] = useState('');
  const [message, setMessage] = useState('');
  const [tag, setTag] = useState('');
  const [showForm, setShowForm] = useState(false);
  const { loading, error, setError, run } = useAction();

  const load = useCallback(async () => {
    try {
      const [d, u] = await Promise.all([api('/shoutouts'), api('/users')]);
      setShoutouts(d.shoutouts || []);
      setUsers((u.users || []).filter((u) => u.id !== me.id));
    } catch (e) { setError(e.message); }
    finally { setLoaded(true); }
  }, [me.id, setError]);

  useEffect(() => { load(); }, [load]);

  async function submit(e) {
    e.preventDefault();
    if (!toId || !message.trim()) { setError('Select a recipient and write a message'); return; }
    await run(async () => {
      await api('/shoutouts', { method: 'POST', body: { toId: Number(toId), message: message.trim(), tag } });
      setMessage(''); setToId(''); setTag(''); setShowForm(false);
      load();
    });
  }

  async function del(id) {
    if (!window.confirm('Delete this shoutout?')) return;
    await api('/shoutouts/' + id, { method: 'DELETE' }).catch(() => {});
    load();
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="font-display text-4xl sm:text-5xl text-cream">Shoutouts</h1>
          <p className="text-cream/50 mt-1">Recognize your teammates' work.</p>
        </div>
        {!showForm && <Button variant="gold" onClick={() => setShowForm(true)}>+ Give Kudos</Button>}
      </div>

      {showForm && (
        <form onSubmit={submit} className="bg-navy2 border border-gold/30 rounded-xl p-5 mb-6 space-y-3 ca-slide-up">
          <div className="font-display text-xl text-gold">Give a Shoutout</div>
          <Field label="To">
            <select className={inputCls} value={toId} onChange={(e) => setToId(e.target.value)} required>
              <option value="">Select teammate…</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
            </select>
          </Field>
          <Field label="Tag (optional)">
            <select className={inputCls} value={tag} onChange={(e) => setTag(e.target.value)}>
              {SHOUTOUT_TAGS.map((t) => <option key={t} value={t}>{t || '— None —'}</option>)}
            </select>
          </Field>
          <Field label="Message">
            <textarea className={inputCls} rows="3" value={message} maxLength={280}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Tell everyone what they did…" />
            <div className="text-right text-xs text-cream/30 mt-1">{message.length}/280</div>
          </Field>
          {error && <div className="text-red text-sm">{error}</div>}
          <div className="flex gap-2">
            <Button type="submit" variant="gold" disabled={loading}>{loading ? <span className="flex items-center gap-2"><Spinner />Sending…</span> : 'Send Shoutout'}</Button>
            <Button variant="ghost" onClick={() => { setShowForm(false); setError(''); }}>Cancel</Button>
          </div>
        </form>
      )}

      {!loaded && <Loading label="Loading shoutouts…" />}
      {loaded && shoutouts.length === 0 && (
        <EmptyState icon="🎉" title="No shoutouts yet" hint="Be the first to recognize a teammate's work!" />
      )}
      <div className="space-y-3">
        {shoutouts.map((s) => (
          <div key={s.id} className="bg-navy2 border border-cream/10 rounded-xl p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-cream text-sm">{s.fromName}</span>
                  <span className="text-cream/40 text-xs">→</span>
                  <span className="font-semibold text-gold text-sm">{s.toName}</span>
                  {s.tag && <Badge tone="gold">{s.tag}</Badge>}
                </div>
                <div className="text-sm text-cream/75 mt-1.5 leading-relaxed">"{s.message}"</div>
                <div className="text-xs text-cream/30 mt-1.5">{timeAgo(s.createdAt)}</div>
              </div>
              {(s.fromId === me.id || me.role === 'admin') && (
                <button onClick={() => del(s.id)} className="text-xs text-red/50 hover:text-red shrink-0">✕</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Resource Hub Page
// ---------------------------------------------------------------------------
const RESOURCE_CATEGORIES = ['Forms', 'Templates', 'Policies', 'Social', 'Finance', 'Other'];
const RESOURCE_CATEGORY_TONES = { Forms: 'blue', Templates: 'gold', Policies: 'red', Social: 'green', Finance: 'green', Other: 'slate' };

function ResourceHubPage({ me }) {
  const [resources, setResources] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState('Other');
  const [description, setDescription] = useState('');
  const { loading, error, setError, run } = useAction();
  const isManager = me.role === 'admin' || me.role === 'manager';

  const load = useCallback(async () => {
    try { const d = await api('/resources'); setResources(d.resources || []); }
    catch (e) { setError(e.message); }
    finally { setLoaded(true); }
  }, [setError]);

  useEffect(() => { load(); }, [load]);

  function openCreate() { setEditId(null); setTitle(''); setUrl(''); setCategory('Other'); setDescription(''); setShowForm(true); }
  function openEdit(r) { setEditId(r.id); setTitle(r.title); setUrl(r.url); setCategory(r.category); setDescription(r.description || ''); setShowForm(true); }

  async function save(e) {
    e.preventDefault();
    if (!title.trim() || !url.trim()) { setError('Title and URL are required'); return; }
    await run(async () => {
      if (editId) {
        await api('/resources/' + editId, { method: 'PATCH', body: { title: title.trim(), url: url.trim(), category, description } });
      } else {
        await api('/resources', { method: 'POST', body: { title: title.trim(), url: url.trim(), category, description } });
      }
      setShowForm(false); load();
    });
  }

  async function del(id, resourceTitle) {
    if (!window.confirm('Delete "' + resourceTitle + '"?')) return;
    await api('/resources/' + id, { method: 'DELETE' }).catch(() => {});
    load();
  }

  const safeUrl = (u) => u && (u.startsWith('http://') || u.startsWith('https://')) ? u : 'https://' + u;

  const filtered = resources.filter((r) =>
    !search || r.title.toLowerCase().includes(search.toLowerCase()) || r.category.toLowerCase().includes(search.toLowerCase())
  );

  const byCategory = RESOURCE_CATEGORIES.reduce((acc, cat) => {
    const items = filtered.filter((r) => r.category === cat);
    if (items.length) acc[cat] = items;
    return acc;
  }, {});

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-2">
        <h1 className="font-display text-4xl sm:text-5xl text-cream">Resource Hub</h1>
        {isManager && !showForm && <Button variant="gold" onClick={openCreate}>+ Add Resource</Button>}
      </div>
      <p className="text-cream/50 text-sm mb-5">Shared links, templates, and documents for the board.</p>

      <div className="relative mb-5">
        <input className={inputCls + ' pl-9'} placeholder="Search resources…" value={search}
          onChange={(e) => setSearch(e.target.value)} />
        <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-cream/30" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
      </div>

      {showForm && (
        <form onSubmit={save} className="bg-navy2 border border-gold/30 rounded-xl p-5 mb-6 space-y-3 ca-slide-up">
          <div className="font-display text-xl text-gold">{editId ? 'Edit Resource' : 'Add Resource'}</div>
          <Field label="Title"><input className={inputCls} value={title} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="Budget Template 2025" /></Field>
          <Field label="URL"><input className={inputCls} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://docs.google.com/…" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              <select className={inputCls} value={category} onChange={(e) => setCategory(e.target.value)}>
                {RESOURCE_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Description (optional)">
              <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
          {error && <div className="text-red text-sm">{error}</div>}
          <div className="flex gap-2">
            <Button type="submit" variant="gold" disabled={loading}>{loading ? <span className="flex items-center gap-2"><Spinner />Saving…</span> : 'Save'}</Button>
            <Button variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {!loaded && <Loading label="Loading resources…" />}
      {loaded && filtered.length === 0 && (
        <EmptyState icon="📚" title="No resources yet" hint={isManager ? 'Add links your team uses daily — templates, forms, policies.' : 'Resources shared by your managers will appear here.'} />
      )}

      <div className="space-y-5">
        {Object.entries(byCategory).map(([cat, items]) => (
          <div key={cat}>
            <div className="flex items-center gap-2 mb-2">
              <Badge tone={RESOURCE_CATEGORY_TONES[cat] || 'slate'}>{cat}</Badge>
            </div>
            <div className="space-y-2">
              {items.map((r) => (
                <div key={r.id} className="bg-navy2 border border-cream/10 rounded-xl px-4 py-3 flex items-center gap-3 hover:border-cream/20 transition-colors">
                  <div className="flex-1 min-w-0">
                    <a href={safeUrl(r.url)} target="_blank" rel="noopener noreferrer"
                      className="font-medium text-cream hover:text-gold transition-colors text-sm">{r.title}</a>
                    {r.description && <div className="text-xs text-cream/45 mt-0.5">{r.description}</div>}
                    <div className="text-xs text-cream/30 mt-0.5">Added by {r.createdByName} · {timeAgo(r.createdAt)}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <a href={safeUrl(r.url)} target="_blank" rel="noopener noreferrer"
                      className="text-xs text-gold/60 hover:text-gold border border-gold/30 hover:border-gold/60 rounded px-2 py-1 transition-colors">
                      Open ↗
                    </a>
                    {isManager && <button onClick={() => openEdit(r)} className="text-xs text-cream/40 hover:text-cream">Edit</button>}
                    {(me.role === 'admin' || r.createdById === me.id) && (
                      <button onClick={() => del(r.id, r.title)} className="text-xs text-red/50 hover:text-red">✕</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AppIcon({ name }) {
  const p = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'text-cream/60 group-hover:text-gold transition-colors duration-150' };
  switch (name) {
    case 'person':    return <svg {...p}><circle cx="12" cy="8" r="3.5"/><path d="M4 20c0-3.866 3.582-7 8-7s8 3.134 8 7"/></svg>;
    case 'home':      return <svg {...p}><path d="M3 11.5 12 3l9 8.5"/><path d="M5 10.5v10h5v-5h4v5h5v-10"/></svg>;
    case 'edit':      return <svg {...p}><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z"/></svg>;
    case 'megaphone': return <svg {...p}><path d="M18 4v16c-3-3-9-4.5-13-4.5V8.5C9 8.5 15 7 18 4Z"/><path d="M3 11v2"/><path d="M7 16.5v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-3"/></svg>;
    case 'team':      return <svg {...p}><circle cx="8" cy="7" r="3"/><path d="M2 20c0-3 2.686-5.5 6-5.5s6 2.5 6 5.5"/><circle cx="18" cy="8" r="2.5"/><path d="M15.5 20c0-2.5 2.239-4.5 5-4.5"/></svg>;
    case 'check':     return <svg {...p}><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-5"/></svg>;
    case 'inbox':     return <svg {...p}><path d="M22 12H16l-2 3H10L8 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 17 4H7a2 2 0 0 0-1.55.89Z"/></svg>;
    case 'roster':    return <svg {...p}><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>;
    case 'calendar':  return <svg {...p}><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/><path d="m9 16 2 2 4-4"/></svg>;
    case 'funding':   return <svg {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-1 2-2.5 2.5-1.5.5-2.5 1-2.5 2.5a2.5 2.5 0 0 0 5 0"/></svg>;
    case 'apply':     return <svg {...p}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>;
    case 'dashboard': return <svg {...p}><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/></svg>;
    case 'org':       return <svg {...p}><circle cx="12" cy="4" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M12 6v5M12 11H5v6M12 11h7v6"/></svg>;
    case 'admin':     return <svg {...p}><path d="M12 2 3 7v5c0 5.25 3.75 10.15 9 11.35C17.25 22.15 21 17.25 21 12V7Z"/><path d="m9 12 2 2 4-4"/></svg>;
    case 'activity':  return <svg {...p}><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>;
    case 'ai':        return <svg {...p}><circle cx="12" cy="12" r="9"/><path d="M9 10h.01M15 10h.01M9.5 15a4.5 4.5 0 0 0 5 0"/></svg>;
    case 'bell':      return <svg {...p}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>;
    case 'search':    return <svg {...p}><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>;
    case 'attendance':return <svg {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>;
    case 'poll':      return <svg {...p}><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 16v-4M12 16v-8M17 16v-2"/></svg>;
    case 'budget':    return <svg {...p}><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>;
    case 'meetings':  return <svg {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M8 11v2M12 11v2"/></svg>;
    case 'grants':    return <svg {...p}><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-1 2-2.5 2.5-1.5.5-2.5 1-2.5 2.5a2.5 2.5 0 0 0 5 0"/><path d="m16 5-1.5 1.5"/></svg>;
    case 'speaker':   return <svg {...p}><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/><path d="M3 9l4 4"/></svg>;
    case 'social':    return <svg {...p}><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.59 13.51 6.83 3.98M15.41 6.51l-6.82 3.98"/></svg>;
    case 'grades':    return <svg {...p}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M12 15v4M15 18H9"/></svg>;
    case 'reimbursements': return <svg {...p}><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/><circle cx="12" cy="15" r="2"/><path d="M6 15h1M17 15h1"/></svg>;
    case 'directory': return <svg {...p}><path d="M4 4h16v16H4z" rx="2"/><path d="M8 10a3 3 0 1 0 6 0 3 3 0 0 0-6 0"/><path d="M6 20c.3-2.2 2.5-4 6-4s5.7 1.8 6 4"/><path d="M16 4v4M8 4v4"/></svg>;
    case 'shoutouts': return <svg {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h.01M12 10h.01M16 10h.01"/></svg>;
    case 'resources': return <svg {...p}><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/><path d="M12 7v6M9 10h6"/></svg>;
    default:          return <svg {...p}><circle cx="12" cy="12" r="9"/></svg>;
  }
}

function AppTile({ label, icon, badge, onClick, style }) {
  return (
    <button onClick={onClick} style={style}
      className="ca-fade-in group relative bg-navy2 hover:bg-navy3 border border-cream/10 hover:border-gold/30 rounded-2xl p-5 flex flex-col items-center gap-3 transition-all duration-200 active:scale-95 w-full hover:-translate-y-0.5 hover:shadow-lg hover:shadow-black/30">
      <div className="relative">
        <div className="w-14 h-14 rounded-xl bg-navy/60 flex items-center justify-center group-hover:bg-navy2 transition-colors duration-150">
          <AppIcon name={icon} />
        </div>
        {badge > 0 && (
          <span className="absolute -top-1 -right-1 bg-red text-cream text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 ca-pulse">{badge}</span>
        )}
      </div>
      <span className="text-cream/80 text-xs font-medium text-center leading-tight group-hover:text-cream transition-colors">{label}</span>
    </button>
  );
}

function AppHome({ me, reports, approvalsCount, submissionsCount, checkinEnabled, aiNotesCount, onAiNotes, onNavigate, onLogout, onSearch }) {
  const isManager = me.role === 'manager' || me.role === 'admin';
  const canEditSite = me.role === 'admin' || !!me.canEditHome;
  const canSeeSubmissions = me.role === 'admin' || !!me.grade;
  const canRoster = isManager || !!me.canManageRoster;

  const tiles = [
    { type: 'mytasks',    label: 'My Page',          icon: 'person'     },
    { type: 'home',       label: 'Club Home',         icon: 'home'       },
    ...(canEditSite       ? [{ type: 'website',     label: 'Edit Website',     icon: 'edit'       }] : []),
    ...(isManager         ? [{ type: 'announce',    label: 'Announcement',     icon: 'megaphone'  }] : []),
    ...(isManager         ? [{ type: 'myteam',      label: 'My Team',          icon: 'team'       }] : []),
    ...(isManager         ? [{ type: 'approvals',   label: 'Approvals',        icon: 'check',     badge: approvalsCount   }] : []),
    ...(canSeeSubmissions ? [{ type: 'submissions', label: 'Get Involved',     icon: 'inbox',     badge: submissionsCount }] : []),
    ...(canRoster         ? [{ type: 'roster',      label: 'Roster',           icon: 'roster'     }] : []),
    ...((checkinEnabled || isManager) ? [{ type: 'checkin', label: checkinEnabled ? 'Check-In' : 'Check-In Settings', icon: 'calendar' }] : []),
    { type: 'funding',    label: 'Funding',            icon: 'funding'    },
    { type: 'apply',      label: 'Apply',               icon: 'apply'      },
    ...(isManager         ? [{ type: 'dashboard',   label: 'Dashboard',        icon: 'dashboard'  }] : []),
    { type: 'attendance',   label: 'Attendance',          icon: 'attendance' },
    { type: 'polls',       label: 'Polls & Voting',      icon: 'poll'       },
    { type: 'meetings',    label: 'Meetings',             icon: 'meetings'   },
    ...(isManager ? [{ type: 'speaker',   label: 'Speaker Events',    icon: 'speaker'    }] : []),
    ...(isManager ? [{ type: 'grants',    label: 'Grant Tracker',     icon: 'grants'     }] : []),
    ...(isManager || !!me.canManageSocial ? [{ type: 'social', label: 'Social Media', icon: 'social' }] : []),
    ...(isManager         ? [{ type: 'budget',      label: 'Budget Overview',  icon: 'budget'     }] : []),
    ...(isManager || !!me.managedGrade ? [{ type: 'grades', label: 'Grade Pipeline', icon: 'grades' }] : []),
    { type: 'reimbursements', label: 'Reimbursements', icon: 'reimbursements' },
    { type: 'shoutouts',  label: 'Shoutouts',           icon: 'shoutouts'  },
    { type: 'resources',  label: 'Resources',           icon: 'resources'  },
    { type: 'directory',  label: 'Directory',           icon: 'directory'  },
    { type: 'org',        label: 'Org Chart',           icon: 'org'        },
    ...(me.role === 'admin' ? [{ type: 'admin',     label: 'Admin Panel',      icon: 'admin'      }] : []),
    ...(me.role === 'admin' || !!me.canViewLogistics ? [{ type: 'logistics', label: 'Login Activity', icon: 'activity' }] : []),
    ...(me.role === 'admin' ? [{ type: 'ai',        label: 'AI Assistant',     icon: 'ai'         }] : []),
    { type: 'ainotes',    label: 'Agent Notes',        icon: 'bell',      badge: aiNotesCount || undefined, onClick: onAiNotes },
  ];

  return (
    <div className="min-h-screen flex flex-col ca-fade-in" style={{ background: '#0d1b2e' }}>
      <header className="px-6 py-5 flex items-center justify-between border-b border-cream/10">
        <Logo size="sidebar" />
        <div className="flex items-center gap-4">
          <button onClick={onSearch} aria-label="Search"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-cream/60 hover:text-gold hover:bg-navy3 transition-colors">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
          </button>
          <NotificationBell onNavigate={onNavigate} />
          <div className="flex flex-col items-end gap-1">
            <span className="text-cream text-sm font-medium">{me.displayName}</span>
            <span className="text-cream/40 text-xs">{me.title || roleLabel(me.role)}</span>
            <div className="flex gap-3 mt-0.5">
              <button onClick={() => onNavigate({ type: 'profile' })} className="text-[11px] text-gold/60 hover:text-gold transition-colors">Profile</button>
              <button onClick={() => onNavigate({ type: 'password' })} className="text-[11px] text-gold/60 hover:text-gold transition-colors">Password</button>
              <button onClick={onLogout} className="text-[11px] text-red/60 hover:text-red transition-colors">Log out</button>
            </div>
          </div>
        </div>
      </header>
      <div className="flex-1 px-4 py-8">
        <HomeSummaryCard me={me} onNavigate={onNavigate} />
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {tiles.map((t, i) => (
            <AppTile key={t.type} label={t.label} icon={t.icon} badge={t.badge}
              onClick={t.onClick || (() => onNavigate({ type: t.type }))}
              style={{ animationDelay: `${i * 32}ms` }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MyTeamView({ reports, onNavigate }) {
  return (
    <div className="w-full">
      <h2 className="font-display text-3xl text-cream mb-6">My Team</h2>
      {reports.length === 0 ? (
        <p className="text-cream/40">No direct reports.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 w-full">
          {reports.map(r => (
            <button key={r.id} onClick={() => onNavigate({ type: 'person', userId: r.id })}
              className="group bg-navy2 hover:bg-navy3 border border-cream/10 hover:border-gold/30 rounded-xl p-5 flex items-center gap-4 text-left transition-all duration-200 active:scale-95 w-full hover:-translate-y-0.5 hover:shadow-md hover:shadow-black/25">
              <div className="w-12 h-12 rounded-full bg-navy3 flex items-center justify-center text-cream/70 text-lg font-semibold shrink-0">
                {r.displayName.charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="text-cream text-base font-semibold group-hover:text-gold transition-colors">{r.displayName}</div>
                <div className="text-cream/50 text-sm mt-0.5">{r.title || roleLabel(r.role)}</div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// In-app notification bell with unread badge + dropdown. Polls periodically.
const NOTIF_LINK_VIEWS = {
  tasks: { type: 'mytasks' },
  approvals: { type: 'approvals' },
  submissions: { type: 'submissions' },
  funding: { type: 'funding' },
  'board-apps': { type: 'apply' },
};
function NotificationBell({ onNavigate, refreshSignal }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(async () => {
    try { const d = await api('/notifications'); setItems(d.notifications || []); setUnread(d.unread || 0); }
    catch (_) {}
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60000);
    return () => clearInterval(t);
  }, [load, refreshSignal]);

  async function openItem(n) {
    if (!n.isRead) api('/notifications/read', { method: 'POST', body: { id: n.id } }).catch(() => {});
    setOpen(false);
    const v = NOTIF_LINK_VIEWS[n.link];
    if (v && onNavigate) onNavigate(v);
    setItems((prev) => prev.map((x) => x.id === n.id ? { ...x, isRead: 1 } : x));
    setUnread((u) => (n.isRead ? u : Math.max(0, u - 1)));
  }
  async function markAll() {
    await api('/notifications/read', { method: 'POST', body: {} }).catch(() => {});
    setItems((prev) => prev.map((x) => ({ ...x, isRead: 1 })));
    setUnread(0);
  }

  return (
    <div className="relative">
      <button onClick={() => { setOpen((o) => !o); if (!open) load(); }}
        className="relative flex items-center justify-center w-8 h-8 rounded-lg text-cream/60 hover:text-gold hover:bg-navy3 transition-colors" aria-label="Notifications">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 bg-red text-cream text-[9px] font-bold rounded-full min-w-[15px] h-[15px] flex items-center justify-center px-0.5 ca-pulse">{unread > 9 ? '9+' : unread}</span>
        )}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 max-h-[26rem] overflow-y-auto bg-navy2 border border-cream/15 rounded-xl shadow-2xl z-40 ca-slide-down">
            <div className="sticky top-0 bg-navy2 flex items-center justify-between px-4 py-2.5 border-b border-cream/10">
              <span className="text-cream font-medium text-sm">Notifications</span>
              {unread > 0 && <button onClick={markAll} className="text-xs text-gold/70 hover:text-gold">Mark all read</button>}
            </div>
            {items.length === 0 ? (
              <div className="px-4 py-10 text-center text-cream/40 text-sm">You're all caught up. 🎉</div>
            ) : items.map((n) => (
              <button key={n.id} onClick={() => openItem(n)}
                className={`block w-full text-left px-4 py-3 border-b border-cream/5 hover:bg-navy3 transition-all duration-150 ${n.isRead ? '' : 'bg-gold/5'}`}>
                <div className="flex gap-2">
                  <span className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${n.isRead ? 'bg-transparent' : 'bg-gold'}`} />
                  <div>
                    <div className="text-sm text-cream/85 leading-snug">{n.message}</div>
                    <div className="text-[11px] text-cream/35 mt-1">{timeAgo(n.createdAt)}</div>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function App() {
  const [me, setMe] = useState(null);
  const [booted, setBooted] = useState(false);
  const [view, setView] = useState({ type: 'apphome' });
  const [enterPortal, setEnterPortal] = useState(false);
  const [users, setUsers] = useState([]);
  const [reports, setReports] = useState([]);
  const [approvalsCount, setApprovalsCount] = useState(0);
  const [submissionsCount, setSubmissionsCount] = useState(0);
  const [checkinEnabled, setCheckinEnabled] = useState(false);
  const [refreshSignal, setRefreshSignal] = useState(0);
  const [aiNotesCount, setAiNotesCount] = useState(0);
  const [aiNotesOpen, setAiNotesOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);

  const isSurveyPath = window.location.pathname === '/survey';
  const bump = () => setRefreshSignal((n) => n + 1);

  const loadShared = useCallback(async (user) => {
    if (!user || user.firstLogin) return;
    try {
      const [u, r, ci] = await Promise.all([api('/users'), api('/reports'), api('/checkins/settings').catch(() => ({ enabled: false }))]);
      setUsers(u.users);
      setReports(r.reports);
      setCheckinEnabled(!!ci.enabled);
      if (user.role === 'manager' || user.role === 'admin') {
        const a = await api('/approvals');
        setApprovalsCount(a.approvals.length);
      } else {
        setApprovalsCount(0);
      }
      if (user.role === 'admin' || user.grade) {
        const s = await api('/submissions');
        setSubmissionsCount(s.submissions.filter((x) => !x.handled).length);
      } else {
        setSubmissionsCount(0);
      }
      const noteData = await api('/ai/notes').catch(() => ({ notes: [] }));
      setAiNotesCount((noteData.notes || []).filter((n) => !n.isRead).length);
    } catch (_) {}
  }, []);

  useEffect(() => {
    (async () => {
      const token = localStorage.getItem(TOKEN_KEY);
      if (token) {
        try {
          const d = await api('/me');
          setMe(d.user);
          await loadShared(d.user);
        } catch (_) { localStorage.removeItem(TOKEN_KEY); }
      }
      setBooted(true);
    })();
  }, [loadShared]);

  useEffect(() => { if (me && !me.firstLogin) loadShared(me); }, [me, refreshSignal, loadShared]);

  useEffect(() => {
    const handler = () => {
      setMe(null);
      setView({ type: 'apphome' });
      setEnterPortal(false);
    };
    window.addEventListener('ca:session-expired', handler);
    return () => window.removeEventListener('ca:session-expired', handler);
  }, []);

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    setMe(null);
    setView({ type: 'apphome' });
    setEnterPortal(false);
  }

  if (!booted) return <div className="min-h-screen flex items-center justify-center gap-2 text-cream/40"><Spinner className="w-5 h-5" /> Loading…</div>;
  if (isSurveyPath) return <InterestSurvey onBack={() => { window.history.pushState(null, '', '/'); window.location.reload(); }} />;
  if (!enterPortal) return <Home mode="public" onEnterPortal={() => setEnterPortal(true)} />;
  if (!me) return <Login onLogin={(u) => { setMe(u); loadShared(u); }} onBack={() => setEnterPortal(false)} />;
  if (me.firstLogin) return <ChangePassword user={me} forced onDone={(u) => { setMe(u); loadShared(u); }} />;
  if (!me.profileComplete) return <ProfileSetup me={me} forced
    onDone={(u) => { setMe(u); loadShared(u); }}
    onSkip={() => setMe({ ...me, profileComplete: true })} />;

  const canEditSite = me.role === 'admin' || !!me.canEditHome;
  const navigate = (v) => setView(v);

  if (view.type === 'apphome') return (
    <>
      {aiNotesOpen && <AINotesPanel onClose={() => setAiNotesOpen(false)} onRead={() => { setAiNotesOpen(false); bump(); }} />}
      {searchOpen && <SearchModal me={me} onNavigate={(v) => { setSearchOpen(false); navigate(v); }} onClose={() => setSearchOpen(false)} />}
      <AppHome me={me} reports={reports} approvalsCount={approvalsCount} submissionsCount={submissionsCount}
        checkinEnabled={checkinEnabled} aiNotesCount={aiNotesCount} onAiNotes={() => setAiNotesOpen(true)}
        onNavigate={navigate} onLogout={logout} onSearch={() => setSearchOpen(true)} />
    </>
  );

  const PAGE_TITLES = {
    home: 'Club Home', website: 'Edit Website', mytasks: 'My Page',
    person: (reports.find(r => r.id === view.userId) || {}).displayName || 'Team Member',
    myteam: 'My Team', announce: 'Team Announcement', approvals: 'Pending Approvals',
    submissions: 'Get Involved', roster: 'Roster', checkin: 'Weekly Check-In',
    funding: 'Funding Requests', apply: 'Apply for Position', dashboard: 'Dashboard',
    attendance: 'Attendance', polls: 'Polls & Voting', budget: 'Budget Overview',
    meetings: 'Meetings', speaker: 'Speaker Events', grants: 'Grant Tracker', social: 'Social Media',
    grades: 'Grade Pipeline', reimbursements: 'Reimbursements', directory: 'Board Directory',
    shoutouts: 'Shoutouts', resources: 'Resource Hub',
    org: 'Org Chart', admin: 'Admin Panel', logistics: 'Login Activity',
    ai: 'AI Assistant', password: 'Change Password', profile: 'Edit Profile',
  };

  let content;
  if (view.type === 'home') content = <Home mode="portal" me={me} />;
  else if (view.type === 'website') content = canEditSite ? <Home mode="editor" me={me} editable={true} /> : <Home mode="portal" me={me} />;
  else if (view.type === 'mytasks') content = <TaskPage me={me} userId={me.id} users={users} refreshSignal={refreshSignal} />;
  else if (view.type === 'person') content = <TaskPage me={me} userId={view.userId} users={users} refreshSignal={refreshSignal} />;
  else if (view.type === 'myteam') content = <MyTeamView reports={reports} onNavigate={navigate} />;
  else if (view.type === 'announce') content = (me.role === 'admin' || me.role === 'manager') ? <TeamAnnouncementView me={me} reports={reports} /> : null;
  else if (view.type === 'approvals') content = <Approvals onChanged={bump} refreshSignal={refreshSignal} />;
  else if (view.type === 'submissions') content = <SubmissionsInbox onChanged={bump} refreshSignal={refreshSignal} />;
  else if (view.type === 'roster') content = <RosterPage me={me} />;
  else if (view.type === 'checkin') content = <WeeklyCheckinPage me={me} />;
  else if (view.type === 'funding') content = <FundingRequestPage me={me} />;
  else if (view.type === 'apply') content = <BoardApplicationsPage me={me} />;
  else if (view.type === 'dashboard') content = (me.role === 'admin' || me.role === 'manager') ? <AdminDashboardPage me={me} /> : null;
  else if (view.type === 'org') content = <OrgChart />;
  else if (view.type === 'admin') content = me.role === 'admin' ? <AdminPanel users={users} reload={bump} /> : null;
  else if (view.type === 'logistics') content = (me.role === 'admin' || me.canViewLogistics) ? <LogisticsPage /> : null;
  else if (view.type === 'ai') content = me.role === 'admin' ? <AIChatPage me={me} /> : null;
  else if (view.type === 'password') content = <ChangePassword user={me} onDone={(u) => { setMe(u); navigate({ type: 'apphome' }); }} />;
  else if (view.type === 'profile') content = <ProfileSetup me={me} onDone={(u) => { setMe(u); navigate({ type: 'apphome' }); }} />;
  else if (view.type === 'attendance') content = <AttendancePage me={me} />;
  else if (view.type === 'polls') content = <PollsPage me={me} />;
  else if (view.type === 'budget') content = (me.role === 'admin' || me.role === 'manager') ? <BudgetDashboardPage me={me} /> : null;
  else if (view.type === 'meetings') content = <MeetingsPage me={me} />;
  else if (view.type === 'speaker') content = (me.role === 'admin' || me.role === 'manager') ? <SpeakerEventsPage me={me} /> : null;
  else if (view.type === 'grants') content = (me.role === 'admin' || me.role === 'manager') ? <GrantsPage me={me} /> : null;
  else if (view.type === 'social') content = (me.role === 'admin' || me.role === 'manager' || !!me.canManageSocial) ? <SocialTrackerPage me={me} /> : null;
  else if (view.type === 'grades') content = (me.role === 'admin' || me.role === 'manager' || !!me.managedGrade) ? <GradePipelinePage me={me} /> : null;
  else if (view.type === 'reimbursements') content = <ReimbursementsPage me={me} />;
  else if (view.type === 'directory') content = <DirectoryPage me={me} />;
  else if (view.type === 'shoutouts') content = <ShoutoutsPage me={me} />;
  else if (view.type === 'resources') content = <ResourceHubPage me={me} />;

  return (
    <>
      {aiNotesOpen && <AINotesPanel onClose={() => setAiNotesOpen(false)} onRead={() => { setAiNotesOpen(false); bump(); }} />}
      {searchOpen && <SearchModal me={me} onNavigate={(v) => { setSearchOpen(false); navigate(v); }} onClose={() => setSearchOpen(false)} />}
      <div className="min-h-screen flex flex-col" style={{ background: '#0d1b2e' }}>
        <header className="sticky top-0 z-20 flex items-center gap-3 bg-navy2/95 backdrop-blur border-b border-cream/10 px-4 py-3">
          <button onClick={() => navigate({ type: 'apphome' })} aria-label="Back to home"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-cream/60 hover:text-cream hover:bg-navy3 transition-colors">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 5l-7 7 7 7"/>
            </svg>
          </button>
          <span className="text-cream font-semibold text-base flex-1">{PAGE_TITLES[view.type] || ''}</span>
          <button onClick={() => setSearchOpen(true)} aria-label="Search"
            className="flex items-center justify-center w-8 h-8 rounded-lg text-cream/60 hover:text-gold hover:bg-navy3 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
          </button>
          <NotificationBell onNavigate={navigate} refreshSignal={refreshSignal} />
          <button onClick={() => setAiNotesOpen(true)} className="relative flex items-center gap-1 text-cream/50 hover:text-gold transition-colors text-xs" aria-label="AI Notes">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            {aiNotesCount > 0 && (
              <span className="absolute -top-1 -right-1 bg-gold text-navy text-[9px] font-bold rounded-full min-w-[14px] h-[14px] flex items-center justify-center px-0.5">{aiNotesCount}</span>
            )}
          </button>
        </header>
        <main className={`flex-1 overflow-x-hidden ${view.type === 'home' ? '' : 'p-4 sm:p-6 lg:p-8'}`}>
          <div key={view.type + (view.userId || '')} className="ca-slide-up">{content}</div>
        </main>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Meeting Action Items sub-panel
// ---------------------------------------------------------------------------
function MeetingActionItems({ meetingId, me, allUsers }) {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [newText, setNewText] = useState('');
  const [newAssignee, setNewAssignee] = useState('');
  const [newDue, setNewDue] = useState('');
  const isManager = me.role === 'admin' || me.role === 'manager';

  const load = useCallback(async () => {
    try { const d = await api('/meetings/' + meetingId + '/action-items'); setItems(d.items || []); }
    catch (_) {}
    finally { setLoaded(true); }
  }, [meetingId]);

  useEffect(() => { load(); }, [load]);

  async function addItem(e) {
    e.preventDefault();
    if (!newText.trim()) return;
    await api('/meetings/' + meetingId + '/action-items', {
      method: 'POST',
      body: { text: newText.trim(), assigneeId: newAssignee ? Number(newAssignee) : null, dueDate: newDue },
    }).catch(() => {});
    setNewText(''); setNewAssignee(''); setNewDue('');
    load();
  }

  async function toggleDone(item) {
    await api('/meetings/' + meetingId + '/action-items/' + item.id, {
      method: 'PATCH', body: { done: !item.done },
    }).catch(() => {});
    load();
  }

  async function promote(item) {
    if (!window.confirm('Promote "' + item.text + '" to a task?')) return;
    await api('/meetings/' + meetingId + '/action-items/' + item.id + '/promote', { method: 'POST' }).catch(() => {});
    load();
  }

  async function del(item) {
    await api('/meetings/' + meetingId + '/action-items/' + item.id, { method: 'DELETE' }).catch(() => {});
    load();
  }

  const today = new Date().toISOString().slice(0, 10);
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);

  return (
    <div className="mt-3 pt-3 border-t border-cream/10">
      <div className="text-xs font-semibold text-cream/50 uppercase tracking-wide mb-2">Action Items</div>
      {!loaded && <div className="text-xs text-cream/30">Loading…</div>}
      {loaded && items.length === 0 && <div className="text-xs text-cream/30 italic">No action items yet.</div>}
      <div className="space-y-1.5">
        {open.map((item) => {
          const overdue = item.dueDate && item.dueDate < today;
          const canEdit = isManager || item.assigneeId === me.id || item.createdById === me.id;
          return (
            <div key={item.id} className={`flex items-start gap-2 rounded-lg px-2 py-1.5 ${overdue ? 'bg-red/5 border border-red/15' : 'bg-cream/5'}`}>
              <input type="checkbox" className="mt-0.5 accent-gold shrink-0"
                checked={false} onChange={() => canEdit && toggleDone(item)} disabled={!canEdit} />
              <div className="flex-1 min-w-0">
                <div className={`text-sm ${overdue ? 'text-red/80' : 'text-cream/85'}`}>{item.text}</div>
                <div className="flex items-center gap-2 text-xs text-cream/40 flex-wrap mt-0.5">
                  {item.assigneeName && <span>→ {item.assigneeName}</span>}
                  {item.dueDate && <span className={overdue ? 'text-red/60' : ''}>{overdue ? 'Overdue: ' : 'Due: '}{fmtShortDate(item.dueDate)}</span>}
                  {item.taskId && <Badge tone="green">Task created</Badge>}
                </div>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {isManager && !item.taskId && item.assigneeId && (
                  <button onClick={() => promote(item)} className="text-[10px] text-gold/60 hover:text-gold border border-gold/20 rounded px-1.5 py-0.5">→ Task</button>
                )}
                {canEdit && (
                  <button onClick={() => del(item)} className="text-[10px] text-red/40 hover:text-red">✕</button>
                )}
              </div>
            </div>
          );
        })}
        {done.length > 0 && (
          <div className="text-xs text-cream/25 mt-1">{done.length} completed item{done.length !== 1 ? 's' : ''}</div>
        )}
      </div>
      <form onSubmit={addItem} className="mt-2 flex gap-2 flex-wrap items-end">
        <div className="flex-1 min-w-[140px]">
          <input className={inputCls + ' text-xs py-1.5'} value={newText} onChange={(e) => setNewText(e.target.value)} placeholder="New action item…" />
        </div>
        <select className={inputCls + ' text-xs py-1.5 w-32'} value={newAssignee} onChange={(e) => setNewAssignee(e.target.value)}>
          <option value="">Assign to…</option>
          {allUsers.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
        </select>
        <input type="date" className={inputCls + ' text-xs py-1.5 w-32'} value={newDue} onChange={(e) => setNewDue(e.target.value)} />
        <button type="submit" className="text-xs bg-gold/20 hover:bg-gold/30 text-gold border border-gold/30 rounded px-3 py-1.5 transition-colors">Add</button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meetings Page
// ---------------------------------------------------------------------------
function MeetingsPage({ me }) {
  const [meetings, setMeetings] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [title, setTitle] = useState('');
  const [meetingDate, setMeetingDate] = useState('');
  const [agendaUrl, setAgendaUrl] = useState('');
  const [minutesUrl, setMinutesUrl] = useState('');
  const [notes, setNotes] = useState('');
  const [expandedId, setExpandedId] = useState(null);
  const [allUsers, setAllUsers] = useState([]);
  const { loading, error, setError, run } = useAction();
  const isManager = me.role === 'admin' || me.role === 'manager';

  const load = useCallback(async () => {
    try {
      const [d, u] = await Promise.all([api('/meetings'), api('/users').catch(() => ({ users: [] }))]);
      setMeetings(d.meetings || []);
      setAllUsers(u.users || []);
    } catch (e) { setError(e.message); }
    finally { setLoaded(true); }
  }, [setError]);

  useEffect(() => { load(); }, [load]);

  function openCreate() { setEditId(null); setTitle(''); setMeetingDate(''); setAgendaUrl(''); setMinutesUrl(''); setNotes(''); setShowForm(true); }
  function openEdit(m) { setEditId(m.id); setTitle(m.title); setMeetingDate(m.meetingDate); setAgendaUrl(m.agendaUrl||''); setMinutesUrl(m.minutesUrl||''); setNotes(m.notes||''); setShowForm(true); }

  async function save(e) {
    e.preventDefault();
    if (!title.trim()) { setError('Title is required'); return; }
    if (!meetingDate) { setError('Date is required'); return; }
    try {
      await run(() => editId
        ? api(`/meetings/${editId}`, { method: 'PATCH', body: { title: title.trim(), meetingDate, agendaUrl, minutesUrl, notes } })
        : api('/meetings', { method: 'POST', body: { title: title.trim(), meetingDate, agendaUrl, minutesUrl, notes } })
      );
      setShowForm(false); load();
    } catch (_) {}
  }

  async function deleteMeeting(m) {
    if (!window.confirm(`Delete "${m.title}"?`)) return;
    try { await api(`/meetings/${m.id}`, { method: 'DELETE' }); load(); } catch (_) {}
  }

  const safeLink = (url) => url && (url.startsWith('http://') || url.startsWith('https://')) ? url : url ? 'https://' + url : '';

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-4xl sm:text-5xl text-cream">Meetings</h1>
        {isManager && !showForm && <Button variant="gold" onClick={openCreate}>+ New Meeting</Button>}
      </div>

      {showForm && (
        <form onSubmit={save} className="bg-navy2 border border-gold/30 rounded-xl p-5 mb-6 space-y-3 ca-slide-up">
          <div className="font-display text-xl text-gold">{editId ? 'Edit Meeting' : 'New Meeting'}</div>
          <Field label="Title"><input className={inputCls} value={title} autoFocus onChange={(e) => setTitle(e.target.value)} /></Field>
          <Field label="Date"><input type="date" className={inputCls} value={meetingDate} onChange={(e) => setMeetingDate(e.target.value)} /></Field>
          <Field label="Agenda (Google Doc URL)"><input className={inputCls} value={agendaUrl} placeholder="https://docs.google.com/…" onChange={(e) => setAgendaUrl(e.target.value)} /></Field>
          <Field label="Minutes (Google Doc URL)"><input className={inputCls} value={minutesUrl} placeholder="https://docs.google.com/…" onChange={(e) => setMinutesUrl(e.target.value)} /></Field>
          <Field label="Notes"><textarea className={inputCls} rows="2" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          {error && <div className="text-red text-sm">{error}</div>}
          <div className="flex gap-2">
            <Button type="submit" variant="gold" disabled={loading}>{loading ? <span className="flex items-center gap-2"><Spinner />Saving…</span> : 'Save'}</Button>
            <Button variant="ghost" onClick={() => setShowForm(false)} disabled={loading}>Cancel</Button>
          </div>
        </form>
      )}

      {!loaded && <Loading label="Loading meetings…" />}
      {loaded && meetings.length === 0 && (
        <EmptyState icon="📋" title="No meetings yet" hint={isManager ? 'Create the first meeting record above.' : 'Meeting records will appear here once added.'} />
      )}
      <div className="space-y-3">
        {meetings.map((m) => (
          <div key={m.id} className="bg-navy2 border border-cream/10 rounded-xl p-4 hover:border-cream/20 transition-colors">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium text-cream">{m.title}</div>
                <div className="text-xs text-cream/50 mt-0.5">{fmtShortDate(m.meetingDate)} · Added by {m.createdByName}</div>
                {m.notes && <div className="text-sm text-cream/60 mt-1">{m.notes}</div>}
                <div className="flex gap-3 mt-2 flex-wrap">
                  {safeLink(m.agendaUrl) && (
                    <a href={safeLink(m.agendaUrl)} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-gold/80 hover:text-gold transition-colors">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/></svg>
                      Agenda
                    </a>
                  )}
                  {safeLink(m.minutesUrl) && (
                    <a href={safeLink(m.minutesUrl)} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-emerald-400/80 hover:text-emerald-300 transition-colors">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h4"/></svg>
                      Minutes
                    </a>
                  )}
                  {!safeLink(m.agendaUrl) && isManager && <span className="text-xs text-cream/25 italic">No agenda link yet</span>}
                  {!safeLink(m.minutesUrl) && isManager && <span className="text-xs text-cream/25 italic">No minutes link yet</span>}
                </div>
              </div>
              {isManager && (
                <div className="flex gap-2 shrink-0">
                  <button onClick={() => openEdit(m)} className="text-xs text-gold/60 hover:text-gold">Edit</button>
                  {me.role === 'admin' && <button onClick={() => deleteMeeting(m)} className="text-xs text-red/60 hover:text-red">Delete</button>}
                </div>
              )}
            </div>
            <button
              onClick={() => setExpandedId(expandedId === m.id ? null : m.id)}
              className="mt-2 text-xs text-cream/40 hover:text-gold transition-colors flex items-center gap-1">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                {expandedId === m.id ? <path d="M18 15l-6-6-6 6"/> : <path d="M6 9l6 6 6-6"/>}
              </svg>
              Action Items
            </button>
            {expandedId === m.id && (
              <MeetingActionItems meetingId={m.id} me={me} allUsers={allUsers} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grant Application Tracker
// ---------------------------------------------------------------------------
const GRANT_STATUSES = ['Draft','Submitted','Under Review','Approved','Denied'];
const GRANT_STATUS_TONES = { Draft: 'slate', Submitted: 'blue', 'Under Review': 'gold', Approved: 'green', Denied: 'red' };

function GrantsPage({ me }) {
  const [grants, setGrants] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [title, setTitle] = useState('');
  const [purpose, setPurpose] = useState('');
  const [amountRequested, setAmountRequested] = useState('');
  const [submissionDate, setSubmissionDate] = useState('');
  const [notes, setNotes] = useState('');
  const { loading, error, setError, run } = useAction();
  const isManager = me.role === 'admin' || me.role === 'manager';

  const load = useCallback(async () => {
    try { const d = await api('/grants'); setGrants(d.grants || []); }
    catch (e) { setError(e.message); }
    finally { setLoaded(true); }
  }, [setError]);

  useEffect(() => { load(); }, [load]);

  function openCreate() { setEditId(null); setTitle(''); setPurpose(''); setAmountRequested(''); setSubmissionDate(''); setNotes(''); setShowForm(true); }
  function openEdit(g) { setEditId(g.id); setTitle(g.title); setPurpose(g.purpose||''); setAmountRequested(String(g.amountRequested||'')); setSubmissionDate(g.submissionDate||''); setNotes(g.notes||''); setShowForm(true); }

  async function save(e) {
    e.preventDefault();
    if (!title.trim()) { setError('Title is required'); return; }
    try {
      await run(() => editId
        ? api(`/grants/${editId}`, { method: 'PATCH', body: { title: title.trim(), purpose, amountRequested: Number(amountRequested)||0, submissionDate: submissionDate||null, notes } })
        : api('/grants', { method: 'POST', body: { title: title.trim(), purpose, amountRequested: Number(amountRequested)||0, submissionDate: submissionDate||null, notes } })
      );
      setShowForm(false); load();
    } catch (_) {}
  }

  async function updateStatus(g, status) {
    try { await api(`/grants/${g.id}`, { method: 'PATCH', body: { status } }); load(); } catch (_) {}
  }

  async function updateAwarded(g, val) {
    try { await api(`/grants/${g.id}`, { method: 'PATCH', body: { amountAwarded: Number(val) } }); load(); } catch (_) {}
  }

  async function deleteGrant(g) {
    if (!window.confirm(`Delete "${g.title}"?`)) return;
    try { await api(`/grants/${g.id}`, { method: 'DELETE' }); load(); } catch (_) {}
  }

  const total = { requested: grants.reduce((s, g) => s + (g.amountRequested || 0), 0), awarded: grants.filter(g => g.status === 'Approved').reduce((s, g) => s + (g.amountAwarded || 0), 0) };

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-2">
        <h1 className="font-display text-4xl sm:text-5xl text-cream">Grant Applications</h1>
        {isManager && !showForm && <Button variant="gold" onClick={openCreate}>+ New Application</Button>}
      </div>
      <p className="text-cream/50 text-sm mb-6">Track grant requests submitted to TPUSA national and other sources.</p>

      {grants.length > 0 && (
        <div className="grid grid-cols-2 gap-3 mb-6">
          <div className="bg-navy2 border border-cream/10 rounded-xl p-4">
            <div className="text-cream/50 text-xs uppercase tracking-wider mb-1">Total Requested</div>
            <div className="text-2xl font-display text-cream">${total.requested.toLocaleString()}</div>
          </div>
          <div className="bg-navy2 border border-emerald-500/20 rounded-xl p-4">
            <div className="text-cream/50 text-xs uppercase tracking-wider mb-1">Total Awarded</div>
            <div className="text-2xl font-display text-emerald-300">${total.awarded.toLocaleString()}</div>
          </div>
        </div>
      )}

      {showForm && (
        <form onSubmit={save} className="bg-navy2 border border-gold/30 rounded-xl p-5 mb-6 space-y-3 ca-slide-up">
          <div className="font-display text-xl text-gold">{editId ? 'Edit Application' : 'New Grant Application'}</div>
          <Field label="Grant Title / Purpose"><input className={inputCls} value={title} autoFocus onChange={(e) => setTitle(e.target.value)} placeholder="e.g. TPUSA Activism Grant — Spring Speaker Event" /></Field>
          <Field label="Description"><textarea className={inputCls} rows="2" value={purpose} onChange={(e) => setPurpose(e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount Requested ($)"><input type="number" min="0" className={inputCls} value={amountRequested} onChange={(e) => setAmountRequested(e.target.value)} /></Field>
            <Field label="Submission Date"><input type="date" className={inputCls} value={submissionDate} onChange={(e) => setSubmissionDate(e.target.value)} /></Field>
          </div>
          <Field label="Notes"><textarea className={inputCls} rows="2" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          {error && <div className="text-red text-sm">{error}</div>}
          <div className="flex gap-2">
            <Button type="submit" variant="gold" disabled={loading}>{loading ? <span className="flex items-center gap-2"><Spinner />Saving…</span> : 'Save'}</Button>
            <Button variant="ghost" onClick={() => setShowForm(false)} disabled={loading}>Cancel</Button>
          </div>
        </form>
      )}

      {!loaded && <Loading label="Loading grants…" />}
      {loaded && grants.length === 0 && <EmptyState icon="💰" title="No grant applications yet" hint="Track grants submitted to TPUSA national or other funders." />}
      <div className="space-y-3">
        {grants.map((g) => (
          <div key={g.id} className="bg-navy2 border border-cream/10 rounded-xl p-4 hover:border-cream/20 transition-colors">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-cream">{g.title}</div>
                {g.purpose && <div className="text-sm text-cream/60 mt-0.5">{g.purpose}</div>}
                <div className="text-xs text-cream/40 mt-1">
                  Requested: <span className="text-cream/70">${(g.amountRequested||0).toLocaleString()}</span>
                  {g.submissionDate && <> · Submitted {fmtShortDate(g.submissionDate)}</>}
                  {g.notes && <> · <span className="italic">{g.notes}</span></>}
                </div>
                {g.status === 'Approved' && (
                  <div className="flex items-center gap-2 mt-2">
                    <span className="text-xs text-emerald-300">Awarded: $</span>
                    <input type="number" min="0" className="bg-navy border border-cream/20 rounded px-2 py-0.5 text-xs text-emerald-300 w-24"
                      defaultValue={g.amountAwarded || ''}
                      onBlur={(e) => updateAwarded(g, e.target.value)} />
                  </div>
                )}
              </div>
              <div className="flex flex-col items-end gap-2 shrink-0">
                <Badge tone={GRANT_STATUS_TONES[g.status] || 'slate'}>{g.status}</Badge>
                {isManager && (
                  <select className="bg-navy border border-cream/20 rounded px-2 py-1 text-xs text-cream/70"
                    value={g.status} onChange={(e) => updateStatus(g, e.target.value)}>
                    {GRANT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                )}
              </div>
            </div>
            {isManager && (
              <div className="flex gap-3 mt-2">
                <button onClick={() => openEdit(g)} className="text-xs text-gold/60 hover:text-gold">Edit</button>
                {me.role === 'admin' && <button onClick={() => deleteGrant(g)} className="text-xs text-red/60 hover:text-red">Delete</button>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Speaker Event Workflow
// ---------------------------------------------------------------------------
const SPEAKER_STATUSES = ['Planning','Confirmed','Completed','Cancelled'];
const SPEAKER_STATUS_TONES = { Planning: 'slate', Confirmed: 'blue', Completed: 'green', Cancelled: 'red' };

function SpeakerEventsPage({ me }) {
  const [events, setEvents] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [form, setForm] = useState({ title:'', speakerName:'', speakerOrg:'', topic:'', eventDate:'', location:'', expectedAttendance:'', avNeeds:'', materialsRequested:'', budgetEstimate:'' });
  const { loading, error, setError, run } = useAction();
  const isManager = me.role === 'admin' || me.role === 'manager';

  const load = useCallback(async () => {
    try { const d = await api('/speaker-events'); setEvents(d.events || []); }
    catch (e) { setError(e.message); }
    finally { setLoaded(true); }
  }, [setError]);

  useEffect(() => { load(); }, [load]);

  function setField(k, v) { setForm((f) => ({ ...f, [k]: v })); }

  function openCreate() {
    setEditId(null);
    setForm({ title:'', speakerName:'', speakerOrg:'', topic:'', eventDate:'', location:'', expectedAttendance:'', avNeeds:'', materialsRequested:'', budgetEstimate:'' });
    setShowForm(true);
  }
  function openEdit(ev) {
    setEditId(ev.id);
    setForm({ title: ev.title, speakerName: ev.speakerName||'', speakerOrg: ev.speakerOrg||'', topic: ev.topic||'', eventDate: ev.eventDate||'', location: ev.location||'', expectedAttendance: String(ev.expectedAttendance||''), avNeeds: ev.avNeeds||'', materialsRequested: ev.materialsRequested||'', budgetEstimate: String(ev.budgetEstimate||'') });
    setShowForm(true);
  }

  async function save(e) {
    e.preventDefault();
    if (!form.title.trim()) { setError('Title is required'); return; }
    const body = { ...form, expectedAttendance: Number(form.expectedAttendance)||0, budgetEstimate: Number(form.budgetEstimate)||0, eventDate: form.eventDate||null };
    try {
      await run(() => editId ? api(`/speaker-events/${editId}`, { method: 'PATCH', body }) : api('/speaker-events', { method: 'POST', body }));
      setShowForm(false); load();
    } catch (_) {}
  }

  async function toggleChecklist(ev, key, val) {
    try { await api(`/speaker-events/${ev.id}`, { method: 'PATCH', body: { [key]: val ? 1 : 0 } }); load(); } catch (_) {}
  }

  async function updateStatus(ev, status) {
    try { await api(`/speaker-events/${ev.id}`, { method: 'PATCH', body: { status } }); load(); } catch (_) {}
  }

  async function deleteEvent(ev) {
    if (!window.confirm(`Delete "${ev.title}"?`)) return;
    try { await api(`/speaker-events/${ev.id}`, { method: 'DELETE' }); load(); } catch (_) {}
  }

  const CHECKLIST = [
    { key: 'roomConfirmed',  label: 'Room / venue confirmed' },
    { key: 'promotionDone',  label: 'Promotion & social posts done' },
    { key: 'logisticsSent',  label: 'Logistics email sent to speaker' },
    { key: 'tpusaNotified',  label: 'TPUSA national notified' },
  ];

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-4xl sm:text-5xl text-cream">Speaker Events</h1>
        {isManager && !showForm && <Button variant="gold" onClick={openCreate}>+ New Event</Button>}
      </div>

      {showForm && (
        <form onSubmit={save} className="bg-navy2 border border-gold/30 rounded-xl p-5 mb-6 space-y-3 ca-slide-up">
          <div className="font-display text-xl text-gold">{editId ? 'Edit Speaker Event' : 'New Speaker Event'}</div>
          <Field label="Event Title"><input className={inputCls} value={form.title} autoFocus onChange={(e) => setField('title', e.target.value)} /></Field>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Speaker Name"><input className={inputCls} value={form.speakerName} onChange={(e) => setField('speakerName', e.target.value)} /></Field>
            <Field label="Speaker Organization"><input className={inputCls} value={form.speakerOrg} onChange={(e) => setField('speakerOrg', e.target.value)} /></Field>
          </div>
          <Field label="Topic / Title of Talk"><input className={inputCls} value={form.topic} onChange={(e) => setField('topic', e.target.value)} /></Field>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Event Date"><input type="date" className={inputCls} value={form.eventDate} onChange={(e) => setField('eventDate', e.target.value)} /></Field>
            <Field label="Location / Room"><input className={inputCls} value={form.location} onChange={(e) => setField('location', e.target.value)} /></Field>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Expected Attendance"><input type="number" min="0" className={inputCls} value={form.expectedAttendance} onChange={(e) => setField('expectedAttendance', e.target.value)} /></Field>
            <Field label="Budget Estimate ($)"><input type="number" min="0" className={inputCls} value={form.budgetEstimate} onChange={(e) => setField('budgetEstimate', e.target.value)} /></Field>
          </div>
          <Field label="AV / Tech Needs"><input className={inputCls} value={form.avNeeds} placeholder="e.g. Projector, lapel mic" onChange={(e) => setField('avNeeds', e.target.value)} /></Field>
          <Field label="TPUSA Materials Requested"><input className={inputCls} value={form.materialsRequested} placeholder="e.g. 4×2 banner, flyers" onChange={(e) => setField('materialsRequested', e.target.value)} /></Field>
          {error && <div className="text-red text-sm">{error}</div>}
          <div className="flex gap-2">
            <Button type="submit" variant="gold" disabled={loading}>{loading ? <span className="flex items-center gap-2"><Spinner />Saving…</span> : 'Save'}</Button>
            <Button variant="ghost" onClick={() => setShowForm(false)} disabled={loading}>Cancel</Button>
          </div>
        </form>
      )}

      {!loaded && <Loading label="Loading speaker events…" />}
      {loaded && events.length === 0 && <EmptyState icon="🎤" title="No speaker events yet" hint={isManager ? 'Plan your first speaker event above.' : 'Speaker events will appear here once planned.'} />}
      <div className="space-y-3">
        {events.map((ev) => {
          const done = CHECKLIST.filter((c) => ev[c.key]).length;
          const isExpanded = expanded === ev.id;
          return (
            <div key={ev.id} className="bg-navy2 border border-cream/10 rounded-xl overflow-hidden hover:border-cream/20 transition-colors">
              <div className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-cream">{ev.title}</div>
                    <div className="text-sm text-cream/60 mt-0.5">
                      {ev.speakerName && <span>{ev.speakerName}{ev.speakerOrg ? ` — ${ev.speakerOrg}` : ''}</span>}
                    </div>
                    <div className="text-xs text-cream/40 mt-1 flex flex-wrap gap-x-3">
                      {ev.eventDate && <span>{fmtShortDate(ev.eventDate)}</span>}
                      {ev.location && <span>📍 {ev.location}</span>}
                      {ev.expectedAttendance > 0 && <span>~{ev.expectedAttendance} expected</span>}
                      {ev.budgetEstimate > 0 && <span>${ev.budgetEstimate.toLocaleString()} budget</span>}
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <div className="flex-1 bg-navy rounded-full h-1.5">
                        <div className="bg-gold h-1.5 rounded-full transition-all" style={{ width: `${(done/CHECKLIST.length)*100}%` }} />
                      </div>
                      <span className="text-xs text-cream/40">{done}/{CHECKLIST.length} checklist</span>
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <Badge tone={SPEAKER_STATUS_TONES[ev.status] || 'slate'}>{ev.status}</Badge>
                    <button onClick={() => setExpanded(isExpanded ? null : ev.id)}
                      className="text-xs text-cream/50 hover:text-cream flex items-center gap-1">
                      {isExpanded ? 'Close' : 'Details'}
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        {isExpanded ? <path d="M18 15l-6-6-6 6"/> : <path d="M6 9l6 6 6-6"/>}
                      </svg>
                    </button>
                  </div>
                </div>
              </div>

              {isExpanded && (
                <div className="border-t border-cream/10 p-4 space-y-4 bg-navy/30">
                  {ev.topic && <div className="text-sm"><span className="text-cream/40">Topic: </span><span className="text-cream/80">{ev.topic}</span></div>}
                  {ev.avNeeds && <div className="text-sm"><span className="text-cream/40">AV Needs: </span><span className="text-cream/80">{ev.avNeeds}</span></div>}
                  {ev.materialsRequested && <div className="text-sm"><span className="text-cream/40">Materials Requested: </span><span className="text-cream/80">{ev.materialsRequested}</span></div>}

                  {isManager && (
                    <>
                      <div>
                        <div className="text-xs uppercase tracking-wider text-cream/50 mb-2">Pre-Event Checklist</div>
                        <div className="space-y-2">
                          {CHECKLIST.map((item) => (
                            <label key={item.key} className="flex items-center gap-2.5 cursor-pointer group">
                              <input type="checkbox" checked={!!ev[item.key]} onChange={(e) => toggleChecklist(ev, item.key, e.target.checked)}
                                className="w-4 h-4 accent-gold" />
                              <span className={`text-sm ${ev[item.key] ? 'text-cream/50 line-through' : 'text-cream/80'}`}>{item.label}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center gap-3 flex-wrap">
                        <Field label="Status">
                          <select className="bg-navy border border-cream/20 rounded px-2 py-1 text-sm text-cream/70"
                            value={ev.status} onChange={(e) => updateStatus(ev, e.target.value)}>
                            {SPEAKER_STATUSES.map((s) => <option key={s}>{s}</option>)}
                          </select>
                        </Field>
                      </div>
                      <div className="flex gap-3">
                        <button onClick={() => { openEdit(ev); setExpanded(null); }} className="text-xs text-gold/60 hover:text-gold">Edit Details</button>
                        {me.role === 'admin' && <button onClick={() => deleteEvent(ev)} className="text-xs text-red/60 hover:text-red">Delete</button>}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Social Media Post Tracker
// ---------------------------------------------------------------------------
const SOCIAL_PLATFORMS = ['Instagram','Twitter/X','TikTok','Facebook','Other'];
const PLATFORM_COLORS = { Instagram: 'text-pink-300', 'Twitter/X': 'text-sky-300', TikTok: 'text-red', Facebook: 'text-blue-400', Other: 'text-cream/70' };

function SocialTrackerPage({ me }) {
  const [posts, setPosts] = useState([]);
  const [daysSince, setDaysSince] = useState(null);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [users, setUsers] = useState([]);
  const [platform, setPlatform] = useState('Instagram');
  const [captionDraft, setCaptionDraft] = useState('');
  const [imageDescription, setImageDescription] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [assignedToId, setAssignedToId] = useState('');
  const { loading, error, setError, run } = useAction();
  const canPost = me.role === 'admin' || me.role === 'manager' || !!me.canManageSocial;

  const load = useCallback(async () => {
    try {
      const [d, u] = await Promise.all([api('/social-posts'), api('/users')]);
      setPosts(d.posts || []);
      setDaysSince(d.daysSinceLastPost);
      setUsers(u.users || []);
    } catch (e) { setError(e.message); }
    finally { setLoaded(true); }
  }, [setError]);

  useEffect(() => { load(); }, [load]);

  async function save(e) {
    e.preventDefault();
    try {
      await run(() => api('/social-posts', { method: 'POST', body: {
        platform, captionDraft, imageDescription, scheduledDate: scheduledDate||null,
        assignedToId: assignedToId ? Number(assignedToId) : null,
      }}));
      setPlatform('Instagram'); setCaptionDraft(''); setImageDescription(''); setScheduledDate(''); setAssignedToId('');
      setShowForm(false); load();
    } catch (_) {}
  }

  async function markPosted(post) {
    try { await api(`/social-posts/${post.id}`, { method: 'PATCH', body: { status: 'Posted' } }); load(); } catch (_) {}
  }

  async function markCancelled(post) {
    try { await api(`/social-posts/${post.id}`, { method: 'PATCH', body: { status: 'Cancelled' } }); load(); } catch (_) {}
  }

  async function deletePost(post) {
    if (!window.confirm('Delete this post?')) return;
    try { await api(`/social-posts/${post.id}`, { method: 'DELETE' }); load(); } catch (_) {}
  }

  const planned = posts.filter((p) => p.status === 'Planned');
  const posted  = posts.filter((p) => p.status === 'Posted');

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-2">
        <h1 className="font-display text-4xl sm:text-5xl text-cream">Social Media</h1>
        {canPost && !showForm && <Button variant="gold" onClick={() => setShowForm(true)}>+ Add Post</Button>}
      </div>
      <p className="text-cream/50 text-sm mb-4">Plan and track the chapter's social media content.</p>

      {daysSince !== null && daysSince >= 3 && (
        <div className="mb-4 bg-red/10 border border-red/30 rounded-xl px-4 py-3 flex items-start gap-3">
          <span className="text-xl shrink-0">⚠️</span>
          <div>
            <div className="text-cream font-medium text-sm">No posts logged in {daysSince === 999 ? 'a while' : `${daysSince} day${daysSince === 1 ? '' : 's'}`}</div>
            <div className="text-cream/60 text-xs mt-0.5">The socials manager should log or schedule a new post soon to keep the chapter visible.</div>
          </div>
        </div>
      )}

      {showForm && (
        <form onSubmit={save} className="bg-navy2 border border-gold/30 rounded-xl p-5 mb-6 space-y-3 ca-slide-up">
          <div className="font-display text-xl text-gold">Plan a Post</div>
          <Field label="Platform">
            <div className="flex gap-2 flex-wrap">
              {SOCIAL_PLATFORMS.map((p) => (
                <button key={p} type="button" onClick={() => setPlatform(p)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all ${platform === p ? 'bg-gold text-navy' : 'bg-navy border border-cream/20 text-cream/60 hover:border-gold/50'}`}>
                  {p}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Caption Draft"><textarea className={inputCls} rows="3" value={captionDraft} placeholder="Write the caption here…" onChange={(e) => setCaptionDraft(e.target.value)} /></Field>
          <Field label="Image / Video Description"><input className={inputCls} value={imageDescription} placeholder="e.g. Photo of the tabling table with sign" onChange={(e) => setImageDescription(e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Scheduled Date (optional)"><input type="date" className={inputCls} value={scheduledDate} onChange={(e) => setScheduledDate(e.target.value)} /></Field>
            <Field label="Assign To">
              <select className={inputCls} value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)}>
                <option value="">— anyone —</option>
                {users.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
              </select>
            </Field>
          </div>
          {error && <div className="text-red text-sm">{error}</div>}
          <div className="flex gap-2">
            <Button type="submit" variant="gold" disabled={loading}>{loading ? <span className="flex items-center gap-2"><Spinner />Saving…</span> : 'Add Post'}</Button>
            <Button variant="ghost" onClick={() => setShowForm(false)} disabled={loading}>Cancel</Button>
          </div>
        </form>
      )}

      {!loaded && <Loading label="Loading posts…" />}

      {loaded && posts.length === 0 && (
        <EmptyState icon="📱" title="No posts tracked yet" hint={canPost ? 'Plan your first post with "+ Add Post" above.' : 'Planned posts will show up here.'} />
      )}

      {planned.length > 0 && (
        <div className="mb-6">
          <div className="font-display text-xl text-gold mb-3">Planned ({planned.length})</div>
          <div className="space-y-3">
            {planned.map((p) => (
              <div key={p.id} className="bg-navy2 border border-cream/10 rounded-xl p-4 hover:border-cream/20 transition-colors">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className={`text-xs font-bold uppercase tracking-wider mb-1 ${PLATFORM_COLORS[p.platform] || 'text-cream/60'}`}>{p.platform}</div>
                    {p.captionDraft && <div className="text-sm text-cream/80 whitespace-pre-wrap">{p.captionDraft}</div>}
                    {p.imageDescription && <div className="text-xs text-cream/40 mt-1 italic">Visual: {p.imageDescription}</div>}
                    <div className="text-xs text-cream/40 mt-1 flex gap-3 flex-wrap">
                      {p.scheduledDate && <span>📅 {fmtShortDate(p.scheduledDate)}</span>}
                      {p.assignedToName && <span>👤 {p.assignedToName}</span>}
                    </div>
                  </div>
                  {canPost && (
                    <div className="flex flex-col gap-1.5 shrink-0">
                      <Button variant="gold" className="text-xs px-3 py-1" onClick={() => markPosted(p)}>✓ Posted</Button>
                      <button onClick={() => markCancelled(p)} className="text-xs text-cream/40 hover:text-cream/70 text-center">Cancel</button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {posted.length > 0 && (
        <div>
          <div className="font-display text-xl text-emerald-300 mb-3">Posted ({posted.length})</div>
          <div className="space-y-2">
            {posted.slice(0, 10).map((p) => (
              <div key={p.id} className="bg-navy2/60 border border-cream/5 rounded-xl p-3 flex items-center gap-3 opacity-75">
                <div className={`text-xs font-bold uppercase tracking-wider shrink-0 ${PLATFORM_COLORS[p.platform] || 'text-cream/60'}`}>{p.platform}</div>
                <div className="flex-1 min-w-0">
                  {p.captionDraft && <div className="text-xs text-cream/50 truncate">{p.captionDraft}</div>}
                </div>
                {p.postedDate && <div className="text-xs text-cream/30 shrink-0">{fmtShortDate(p.postedDate)}</div>}
                {me.role === 'admin' && <button onClick={() => deletePost(p)} className="text-xs text-red/40 hover:text-red shrink-0">✕</button>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Task Comments
// ---------------------------------------------------------------------------
function TaskComments({ taskId, me }) {
  const [open, setOpen] = useState(false);
  const [comments, setComments] = useState([]);
  const [count, setCount] = useState(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api(`/tasks/${taskId}/comments`);
      setComments(d.comments || []);
      setCount(d.comments.length);
    } catch (_) {}
  }, [taskId]);

  // Fetch count even when closed so the badge shows
  useEffect(() => {
    api(`/tasks/${taskId}/comments`).then((d) => setCount(d.comments.length)).catch(() => {});
  }, [taskId]);

  useEffect(() => { if (open) load(); }, [open, load]);

  async function submit(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setBusy(true); setError('');
    try {
      await api(`/tasks/${taskId}/comments`, { method: 'POST', body: { content: text } });
      setInput('');
      load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function del(commentId) {
    await api(`/tasks/${taskId}/comments/${commentId}`, { method: 'DELETE' }).catch(() => {});
    load();
  }

  return (
    <div className="mt-3 border-t border-cream/10 pt-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-xs text-cream/50 hover:text-gold transition-colors flex items-center gap-1"
      >
        💬 {count !== null ? count : '…'} comment{count !== 1 ? 's' : ''} {open ? '▲' : '▼'}
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          {comments.map((c) => (
            <div key={c.id} className="bg-navy rounded-lg px-3 py-2 flex gap-2 items-start">
              <div className="flex-1 min-w-0">
                <span className="text-gold/80 text-xs font-medium">{c.authorName}</span>
                <span className="text-cream/40 text-xs ml-2">{timeAgo(c.createdAt)}</span>
                <div className="text-cream/80 text-sm mt-0.5 whitespace-pre-wrap">{c.content}</div>
              </div>
              {(c.userId === me.id || me.role === 'admin') && (
                <button onClick={() => del(c.id)} className="text-red/50 hover:text-red text-xs shrink-0">✕</button>
              )}
            </div>
          ))}
          {comments.length === 0 && <div className="text-cream/30 text-xs">No comments yet.</div>}
          <form onSubmit={submit} className="flex gap-2 mt-1">
            <input
              className={inputCls + ' text-sm flex-1 py-1.5'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Add a comment…"
              disabled={busy}
            />
            <button type="submit" disabled={busy || !input.trim()}
              className="text-xs bg-gold/20 hover:bg-gold/30 text-gold px-3 py-1.5 rounded-md disabled:opacity-40">
              Send
            </button>
          </form>
          {error && <div className="text-red text-xs">{error}</div>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search Modal
// ---------------------------------------------------------------------------
function SearchModal({ me, onNavigate, onClose }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => { if (inputRef.current) inputRef.current.focus(); }, []);

  useEffect(() => {
    if (q.length < 2) { setResults(null); return; }
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const d = await api(`/search?q=${encodeURIComponent(q)}`);
        setResults(d.results);
      } catch (_) {}
      finally { setLoading(false); }
    }, 280);
    return () => clearTimeout(t);
  }, [q]);

  const total = results ? (results.tasks.length + results.members.length + results.funding.length + results.announcements.length) : 0;

  function go(view) { onClose(); onNavigate(view); }

  return (
    <div className="fixed inset-0 bg-black/75 z-50 flex items-start justify-center pt-16 px-4" onClick={onClose}>
      <div className="bg-navy2 border border-cream/15 rounded-2xl w-full max-w-2xl shadow-2xl ca-scale-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 px-4 py-3 border-b border-cream/10">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-cream/40 shrink-0"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)}
            className="flex-1 bg-transparent text-cream placeholder-cream/30 focus:outline-none text-base"
            placeholder="Search tasks, members, funding…" />
          {loading && <Spinner className="w-4 h-4 text-cream/40 shrink-0" />}
          <button onClick={onClose} className="text-cream/40 hover:text-cream text-xl leading-none shrink-0">×</button>
        </div>

        {q.length >= 2 && results && (
          <div className="max-h-[60vh] overflow-y-auto divide-y divide-cream/8">
            {total === 0 && (
              <div className="px-5 py-8 text-center text-cream/40 text-sm">No results for "{q}"</div>
            )}

            {results.tasks.length > 0 && (
              <div className="py-2">
                <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-cream/40 font-semibold">Tasks</div>
                {results.tasks.map((t) => (
                  <button key={t.id} onClick={() => go({ type: t.userId === me.id ? 'mytasks' : 'person', userId: t.userId })}
                    className="w-full text-left px-4 py-2.5 hover:bg-navy3 transition-colors flex items-start gap-3">
                    <span className="mt-0.5 text-cream/40 text-xs shrink-0">✓</span>
                    <div className="min-w-0">
                      <div className="text-cream text-sm font-medium truncate">{t.name}</div>
                      <div className="text-cream/45 text-xs truncate">{t.ownerName} · {t.status}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {results.members.length > 0 && (
              <div className="py-2">
                <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-cream/40 font-semibold">Members</div>
                {results.members.map((u) => (
                  <button key={u.id} onClick={() => go({ type: u.id === me.id ? 'mytasks' : 'person', userId: u.id })}
                    className="w-full text-left px-4 py-2.5 hover:bg-navy3 transition-colors flex items-center gap-3">
                    <div className="w-7 h-7 rounded-full bg-navy border border-gold/30 flex items-center justify-center text-gold text-xs font-display shrink-0">
                      {(u.displayName || '?').charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="text-cream text-sm font-medium">{u.displayName}</div>
                      {u.title && <div className="text-cream/45 text-xs">{u.title}</div>}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {results.funding.length > 0 && (
              <div className="py-2">
                <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-cream/40 font-semibold">Funding Requests</div>
                {results.funding.map((f) => (
                  <button key={f.id} onClick={() => go({ type: 'funding' })}
                    className="w-full text-left px-4 py-2.5 hover:bg-navy3 transition-colors flex items-start gap-3">
                    <span className="mt-0.5 text-cream/40 text-xs shrink-0">$</span>
                    <div className="min-w-0">
                      <div className="text-cream text-sm font-medium truncate">{f.title}</div>
                      <div className="text-cream/45 text-xs">{f.submitterName} · ${Number(f.amount).toFixed(2)} · {f.status}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {results.announcements.length > 0 && (
              <div className="py-2">
                <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-cream/40 font-semibold">Announcements</div>
                {results.announcements.map((a) => (
                  <div key={a.id} className="px-4 py-2.5 flex items-start gap-3">
                    <span className="mt-0.5 text-gold/60 text-xs shrink-0">📢</span>
                    <div className="min-w-0">
                      <div className="text-cream/45 text-xs">{a.authorName}</div>
                      <div className="text-cream text-sm truncate">{a.text}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {q.length < 2 && (
          <div className="px-5 py-6 text-center text-cream/30 text-sm">Type at least 2 characters to search…</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grade Rep Pipeline Dashboard
// ---------------------------------------------------------------------------
function GradePipelinePage({ me }) {
  const [data, setData] = useState(null);
  const [goals, setGoals] = useState({});
  const [editingGoal, setEditingGoal] = useState(null);
  const [goalInput, setGoalInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const isManager = me.role === 'admin' || me.role === 'manager';
  const grade = me.managedGrade || (isManager ? (data && data.grade) : null);

  const load = useCallback(async () => {
    setError('');
    try {
      const params = isManager && !me.managedGrade ? '' : `?grade=${me.managedGrade || ''}`;
      const [d, g] = await Promise.all([
        api(`/roster/grade-pipeline${params}`),
        isManager ? api('/grade-goals') : Promise.resolve({ goals: [] }),
      ]);
      setData(d);
      const gmap = {};
      (g.goals || []).forEach((r) => { gmap[r.grade] = r.goal; });
      setGoals(gmap);
    } catch (e) { setError(e.message); }
  }, [isManager, me.managedGrade]);

  useEffect(() => { load(); }, [load]);

  async function doAction(memberId, action) {
    setBusy(`${memberId}:${action}`);
    try {
      await api(`/roster/${memberId}/${action}`, { method: 'POST' });
      load();
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  async function saveGoal(g) {
    try {
      await api(`/grade-goals/${g}`, { method: 'PUT', body: { goal: Number(goalInput) } });
      setGoals((prev) => ({ ...prev, [g]: Number(goalInput) }));
      setEditingGoal(null);
    } catch (e) { setError(e.message); }
  }

  function daysSince(iso) {
    const d = new Date(iso);
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  if (error && !data) return <ErrorState message={error} onRetry={load} />;
  if (!data) return <Loading label="Loading pipeline…" />;

  const { counts, prospects } = data;
  const currentGrade = data.grade;
  const goalForGrade = goals[currentGrade] || data.goal || 0;
  const pct = goalForGrade > 0 ? Math.min(100, Math.round((counts.onboarded / goalForGrade) * 100)) : 0;

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="font-display text-4xl sm:text-5xl text-cream leading-none">Grade {currentGrade} Pipeline</h1>
        <p className="text-cream/50 mt-1">Recruitment funnel and prospect status.</p>
      </div>
      {error && <div className="text-red text-sm">{error}</div>}

      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Prospects', count: counts.prospects, tone: 'slate' },
          { label: 'Contacted', count: counts.contacted, tone: 'blue' },
          { label: 'Onboarded', count: counts.onboarded, tone: 'green' },
        ].map(({ label, count, tone }) => (
          <div key={label} className="bg-navy2 border border-cream/10 rounded-xl p-4 text-center">
            <div className="font-display text-3xl text-cream">{count}</div>
            <div className="mt-1"><Badge tone={tone}>{label}</Badge></div>
          </div>
        ))}
      </div>

      {goalForGrade > 0 && (
        <div className="bg-navy2 border border-cream/10 rounded-xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-cream/70 text-sm">Onboarding Goal</span>
            <span className="text-cream text-sm font-medium">{counts.onboarded} / {goalForGrade}</span>
          </div>
          <div className="h-2.5 bg-navy rounded-full overflow-hidden">
            <div className="h-full bg-gold rounded-full transition-all duration-500" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-xs text-cream/40 mt-1">{pct}% of goal reached</div>
        </div>
      )}

      {me.role === 'admin' && (
        <div className="bg-navy2 border border-cream/10 rounded-xl p-4">
          <div className="text-cream/70 text-sm font-medium mb-3">Grade Goals (Admin)</div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[9, 10, 11, 12].map((g) => (
              <div key={g} className="bg-navy border border-cream/10 rounded-lg p-3">
                <div className="text-cream/60 text-xs mb-1">Grade {g}</div>
                {editingGoal === g ? (
                  <div className="flex gap-1">
                    <input type="number" min="0" className="w-full bg-navy2 border border-cream/20 rounded px-2 py-1 text-cream text-xs"
                      value={goalInput} onChange={(e) => setGoalInput(e.target.value)} autoFocus />
                    <button onClick={() => saveGoal(g)} className="text-gold text-xs hover:text-gold/80">✓</button>
                    <button onClick={() => setEditingGoal(null)} className="text-cream/40 text-xs hover:text-cream/60">✕</button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <span className="text-cream text-sm font-medium">{goals[g] || 0}</span>
                    <button onClick={() => { setEditingGoal(g); setGoalInput(String(goals[g] || 0)); }}
                      className="text-xs text-gold/60 hover:text-gold">Edit</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="font-display text-2xl text-gold mb-3">Active Prospects & Contacted ({prospects.length})</div>
        {prospects.length === 0
          ? <EmptyState icon="🎯" title="No active prospects" hint="Add prospects to the roster to start tracking." />
          : (
            <div className="space-y-2">
              {prospects.map((p) => {
                const days = daysSince(p.createdAt);
                const stale = days > 14;
                return (
                  <div key={p.id} className={`bg-navy2 border rounded-xl p-4 transition-all duration-150 ${stale ? 'border-red/30' : 'border-cream/10'}`}>
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div>
                        <div className="font-medium text-cream">{p.firstName} {p.lastName}</div>
                        <div className="text-xs text-cream/50 mt-0.5 flex items-center gap-2 flex-wrap">
                          {p.email && <span>{p.email}</span>}
                          {p.phone && <span>{p.phone}</span>}
                          <Badge tone={p.status === 'Contacted' ? 'blue' : 'slate'}>{p.status}</Badge>
                          <span className={stale ? 'text-red font-medium' : 'text-cream/40'}>{days} day{days !== 1 ? 's' : ''} in pipeline{stale ? ' ⚠' : ''}</span>
                        </div>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        {p.status === 'Prospect' && (
                          <Button variant="ghost" className="text-xs px-3 py-1"
                            disabled={!!busy} onClick={() => doAction(p.id, 'contacted')}>
                            {busy === `${p.id}:contacted` ? 'Saving…' : 'Mark Contacted'}
                          </Button>
                        )}
                        <Button variant="danger" className="text-xs px-3 py-1"
                          disabled={!!busy} onClick={() => doAction(p.id, 'decline')}>
                          {busy === `${p.id}:decline` ? 'Saving…' : 'Declined'}
                        </Button>
                      </div>
                    </div>
                    {p.notes && <div className="text-xs text-cream/40 mt-2 line-clamp-2">{p.notes}</div>}
                  </div>
                );
              })}
            </div>
          )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Expense Reimbursements
// ---------------------------------------------------------------------------
const REIMBURSEMENT_CATEGORIES = ['Supplies', 'Food', 'Printing', 'Travel', 'Other'];
const REIMBURSEMENT_CATEGORY_ICONS = { Supplies: '📦', Food: '🍕', Printing: '🖨', Travel: '🚗', Other: '📎' };

function ReimbursementsPage({ me }) {
  const [items, setItems] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ amount: '', category: 'Supplies', description: '', purchaseDate: '' });
  const [reviewNotes, setReviewNotes] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const isManager = me.role === 'admin' || me.role === 'manager';

  const load = useCallback(async () => {
    try { const d = await api('/reimbursements'); setItems(d.reimbursements || []); }
    catch (e) { setError(e.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    if (!form.amount || Number(form.amount) <= 0) { setError('Amount must be positive'); return; }
    if (!form.purchaseDate) { setError('Purchase date required'); return; }
    setBusy('submit'); setError('');
    try {
      await api('/reimbursements', { method: 'POST', body: { ...form, amount: Number(form.amount) } });
      setShowForm(false);
      setForm({ amount: '', category: 'Supplies', description: '', purchaseDate: '' });
      load();
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  async function review(id, action) {
    setBusy(`${id}:${action}`); setError('');
    try {
      await api(`/reimbursements/${id}`, { method: 'PATCH', body: { action, reviewNotes: reviewNotes[id] || '' } });
      load();
    } catch (e) { setError(e.message); }
    finally { setBusy(''); }
  }

  const pending = (items || []).filter((r) => r.status === 'pending');
  const mine = (items || []).filter((r) => r.submittedById === me.id);
  const fmt = (n) => `$${Number(n || 0).toFixed(2)}`;

  function statusToneR(s) {
    if (s === 'approved') return 'green';
    if (s === 'denied') return 'red';
    return 'slate';
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-display text-4xl sm:text-5xl text-cream leading-none">Reimbursements</h1>
          <p className="text-cream/50 mt-1">Submit receipts for club purchases you've already made.</p>
        </div>
        <Button variant="ghost" onClick={() => setShowForm(true)}>+ New Request</Button>
      </div>
      {error && <div className="text-red text-sm bg-red/10 border border-red/30 rounded-md px-3 py-2">{error}</div>}

      {showForm && (
        <form onSubmit={submit} className="bg-navy2 border border-gold/30 rounded-xl p-5 space-y-3 ca-slide-up">
          <div className="font-display text-xl text-gold">New Reimbursement Request</div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Amount ($) *">
              <input type="number" step="0.01" min="0.01" className={inputCls} value={form.amount} onChange={setF('amount')} required placeholder="0.00" />
            </Field>
            <Field label="Purchase Date *">
              <input type="date" className={inputCls} value={form.purchaseDate} onChange={setF('purchaseDate')} required />
            </Field>
            <Field label="Category">
              <select className={inputCls} value={form.category} onChange={setF('category')}>
                {REIMBURSEMENT_CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </select>
            </Field>
            <Field label="Description">
              <input className={inputCls} value={form.description} onChange={setF('description')} placeholder="What did you buy?" />
            </Field>
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="gold" disabled={busy === 'submit'}>{busy === 'submit' ? 'Submitting…' : 'Submit Request'}</Button>
            <Button variant="ghost" onClick={() => setShowForm(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {isManager && pending.length > 0 && (
        <div>
          <div className="font-display text-2xl text-gold mb-3">Pending Review ({pending.length})</div>
          <div className="space-y-3">
            {pending.map((r) => (
              <div key={r.id} className="bg-navy2 border border-gold/20 rounded-xl p-4">
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div>
                    <div className="font-medium text-cream">{fmt(r.amount)} · {REIMBURSEMENT_CATEGORY_ICONS[r.category] || ''} {r.category}</div>
                    {r.description && <div className="text-sm text-cream/60 mt-0.5">{r.description}</div>}
                    <div className="text-xs text-cream/40 mt-1">By {r.submitterName}{r.submitterTitle ? ` · ${r.submitterTitle}` : ''} · purchased {r.purchaseDate}</div>
                  </div>
                  <Badge tone="slate">pending</Badge>
                </div>
                <div className="mt-3 space-y-2">
                  <Field label="Review note (optional)">
                    <input className={inputCls + ' text-sm'} placeholder="Add a note…"
                      value={reviewNotes[r.id] || ''} onChange={(e) => setReviewNotes((prev) => ({ ...prev, [r.id]: e.target.value }))} />
                  </Field>
                  <div className="flex gap-2">
                    <Button variant="gold" className="text-xs px-3 py-1" disabled={!!busy} onClick={() => review(r.id, 'approve')}>
                      {busy === `${r.id}:approve` ? 'Approving…' : 'Approve'}
                    </Button>
                    <Button variant="danger" className="text-xs px-3 py-1" disabled={!!busy} onClick={() => review(r.id, 'deny')}>
                      {busy === `${r.id}:deny` ? 'Denying…' : 'Deny'}
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="font-display text-2xl text-gold mb-3">{isManager ? 'All Requests' : 'My Requests'}</div>
        {items === null && <Loading label="Loading…" />}
        {items !== null && (isManager ? items : mine).length === 0
          ? <EmptyState icon="💳" title="No reimbursements yet" hint="Submit a request when you make a purchase for the club." />
          : (
            <div className="space-y-2">
              {(isManager ? items : mine).map((r) => (
                <div key={r.id} className="bg-navy2 border border-cream/10 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="text-cream text-sm font-medium">{fmt(r.amount)} · {REIMBURSEMENT_CATEGORY_ICONS[r.category] || ''} {r.category}</div>
                    {r.description && <div className="text-xs text-cream/50 truncate">{r.description}</div>}
                    <div className="text-xs text-cream/40 mt-0.5">
                      {isManager && r.submitterName ? `${r.submitterName} · ` : ''}purchased {r.purchaseDate}
                      {r.reviewNotes ? ` · Note: ${r.reviewNotes}` : ''}
                    </div>
                  </div>
                  <Badge tone={statusToneR(r.status)}>{r.status}</Badge>
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Board Contact Directory
// ---------------------------------------------------------------------------
function DirectoryPage({ me }) {
  const [users, setUsers] = useState(null);
  const [query, setQuery] = useState('');
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api('/directory').then((d) => setUsers(d.users || [])).catch((e) => setError(e.message));
  }, []);

  function copyEmail(email) {
    if (!email) return;
    navigator.clipboard.writeText(email).then(() => {
      setCopied(email);
      setTimeout(() => setCopied(''), 2000);
    }).catch(() => {});
  }

  const filtered = (users || []).filter((u) => {
    if (!query) return true;
    const q = query.toLowerCase();
    return (u.displayName || '').toLowerCase().includes(q) || (u.title || '').toLowerCase().includes(q);
  });

  return (
    <div className="max-w-4xl">
      <div className="mb-6">
        <h1 className="font-display text-4xl sm:text-5xl text-cream leading-none">Board Directory</h1>
        <p className="text-cream/50 mt-1">Contact information for all board members.</p>
      </div>
      {error && <div className="text-red text-sm mb-4">{error}</div>}

      <div className="mb-4">
        <input className={inputCls + ' max-w-sm'} placeholder="Search by name or title…"
          value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {users === null && <Loading label="Loading directory…" />}
      {users !== null && filtered.length === 0 && (
        <EmptyState icon="👥" title="No members found" hint="Try a different search term." />
      )}

      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map((u) => {
          const initials = (u.displayName || '?').split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
          return (
            <div key={u.id} className="bg-navy2 border border-cream/10 rounded-xl p-4 flex items-start gap-3 hover:border-cream/20 transition-colors">
              <div className="w-12 h-12 rounded-full bg-navy3 border border-gold/20 overflow-hidden flex items-center justify-center shrink-0">
                {u.photo
                  ? <img src={u.photo} alt={u.displayName} className="w-full h-full object-cover" />
                  : <span className="text-gold font-display text-lg">{initials}</span>}
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-cream font-medium text-sm truncate">{u.displayName}</div>
                {u.title && <div className="text-cream/50 text-xs">{u.title}</div>}
                {u.email && (
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <span className="text-cream/60 text-xs truncate">{u.email}</span>
                    <button onClick={() => copyEmail(u.email)} className="shrink-0 text-cream/40 hover:text-gold transition-colors" title="Copy email">
                      {copied === u.email
                        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-emerald-400"><path d="M20 6L9 17l-5-5"/></svg>
                        : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>}
                    </button>
                  </div>
                )}
                {u.phone && <div className="text-cream/50 text-xs mt-0.5">{u.phone}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attendance Tracker
// ---------------------------------------------------------------------------
const ATTENDANCE_STATUSES = ['present', 'absent', 'excused'];
const ATTENDANCE_COLORS = { present: 'green', absent: 'red', excused: 'blue' };
const ATTENDANCE_LABELS = { present: 'Present', absent: 'Absent', excused: 'Excused' };

function RollCallModal({ eventId, onClose, onDone }) {
  const [allUsers, setAllUsers] = useState([]);
  const [statuses, setStatuses] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/users').then((d) => {
      const sorted = [...(d.users || [])].sort((a, b) => (a.displayName || '').localeCompare(b.displayName));
      setAllUsers(sorted);
    }).catch(() => {});
  }, []);

  function toggle(userId, status) {
    setStatuses((prev) => ({ ...prev, [userId]: prev[userId] === status ? undefined : status }));
  }

  async function submit() {
    const records = allUsers
      .filter((u) => statuses[u.id])
      .map((u) => ({ userId: u.id, status: statuses[u.id] }));
    if (records.length === 0) { setError('Mark at least one member before submitting.'); return; }
    setBusy(true); setError('');
    try {
      await api(`/attendance/${eventId}/roll-call`, { method: 'POST', body: { records } });
      onDone();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  const presentCount  = allUsers.filter((u) => statuses[u.id] === 'present').length;
  const absentCount   = allUsers.filter((u) => statuses[u.id] === 'absent').length;
  const excusedCount  = allUsers.filter((u) => statuses[u.id] === 'excused').length;
  const unmarkedCount = allUsers.filter((u) => !statuses[u.id]).length;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-navy" style={{ background: '#0d1b2e' }}>
      <div className="sticky top-0 bg-navy2/95 backdrop-blur border-b border-cream/10 px-4 py-3 flex items-center justify-between gap-3">
        <div className="font-display text-xl text-cream">Roll Call</div>
        <div className="flex items-center gap-3 text-xs">
          <span className="text-emerald-400">P: {presentCount}</span>
          <span className="text-red">A: {absentCount}</span>
          <span className="text-sky-300">E: {excusedCount}</span>
          <span className="text-cream/40">–: {unmarkedCount}</span>
        </div>
        <button onClick={onClose} className="text-cream/50 hover:text-cream transition-colors text-lg">✕</button>
      </div>
      {error && <div className="mx-4 mt-3 text-red text-sm bg-red/10 border border-red/30 rounded px-3 py-2">{error}</div>}
      <div className="flex-1 overflow-y-auto divide-y divide-cream/5">
        {allUsers.map((u) => {
          const s = statuses[u.id];
          return (
            <div key={u.id} className="px-4 py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-cream text-sm font-medium">{u.displayName}</div>
                {u.title && <div className="text-cream/40 text-xs">{u.title}</div>}
              </div>
              <div className="flex gap-2 shrink-0">
                {[['present','P','bg-emerald-500/80'],['absent','A','bg-red/80'],['excused','E','bg-sky-500/80']].map(([val, label, activeClass]) => (
                  <button key={val} onClick={() => toggle(u.id, val)}
                    className={`w-9 h-9 rounded-lg text-sm font-bold transition-all duration-150 ${
                      s === val ? `${activeClass} text-white` : 'bg-navy border border-cream/15 text-cream/50 hover:border-cream/30'
                    }`}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="sticky bottom-0 bg-navy2/95 backdrop-blur border-t border-cream/10 px-4 py-3 flex items-center justify-between gap-3">
        <span className="text-cream/50 text-sm">{allUsers.length - unmarkedCount} of {allUsers.length} marked</span>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="gold" onClick={submit} disabled={busy}>{busy ? 'Submitting…' : 'Submit Roll Call'}</Button>
        </div>
      </div>
    </div>
  );
}

function AttendancePage({ me }) {
  const [activeTab, setActiveTab] = useState('attendance');
  const [events, setEvents] = useState(null);
  const [activeEvent, setActiveEvent] = useState(null);
  const [eventData, setEventData] = useState(null);
  const [creating, setCreating] = useState(false);
  const [rollCallEvent, setRollCallEvent] = useState(null);
  const [form, setForm] = useState({ title: '', eventDate: '', location: '', notes: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmEl, confirm] = useConfirm();
  const [upcomingEvents, setUpcomingEvents] = useState(null);
  const [rsvpDetails, setRsvpDetails] = useState({});
  const isManager = me.role === 'admin' || me.role === 'manager';

  const setF = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const loadEvents = useCallback(async () => {
    try { const d = await api('/attendance'); setEvents(d.events || []); } catch (err) { setError(err.message); }
  }, []);

  const loadEvent = useCallback(async (id) => {
    try { const d = await api(`/attendance/${id}`); setEventData(d); } catch (err) { setError(err.message); }
  }, []);

  const loadUpcoming = useCallback(async () => {
    try { const d = await api('/attendance/upcoming'); setUpcomingEvents(d.events || []); }
    catch (err) { setError(err.message); }
  }, []);

  async function rsvp(eventId, response) {
    await api('/attendance/' + eventId + '/rsvp', { method: 'POST', body: { response } }).catch(() => {});
    loadUpcoming();
  }

  async function loadRsvpDetails(eventId) {
    if (rsvpDetails[eventId]) { setRsvpDetails((p) => ({ ...p, [eventId]: null })); return; }
    try {
      const d = await api('/attendance/' + eventId + '/rsvps');
      setRsvpDetails((p) => ({ ...p, [eventId]: d.rsvps || [] }));
    } catch (_) {}
  }

  useEffect(() => { loadEvents(); }, [loadEvents]);
  useEffect(() => { if (activeTab === 'upcoming') loadUpcoming(); }, [activeTab, loadUpcoming]);
  useEffect(() => { if (activeEvent) loadEvent(activeEvent); }, [activeEvent, loadEvent]);

  async function createEvent(e) {
    e.preventDefault();
    if (!form.title.trim() || !form.eventDate) { setError('Title and date are required.'); return; }
    setBusy(true); setError('');
    try {
      const d = await api('/attendance', { method: 'POST', body: form });
      await loadEvents();
      setCreating(false);
      setForm({ title: '', eventDate: '', location: '', notes: '' });
      setActiveEvent(d.event.id);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function markAttendance(userId, status) {
    if (!activeEvent) return;
    try {
      await api(`/attendance/${activeEvent}/mark`, { method: 'POST', body: { userId, status } });
      loadEvent(activeEvent);
    } catch (err) { setError(err.message); }
  }

  async function deleteEvent(id) {
    if (!(await confirm({ title: 'Delete event?', message: 'Attendance records will be permanently deleted.', confirmLabel: 'Delete', danger: true }))) return;
    await api(`/attendance/${id}`, { method: 'DELETE' }).catch((err) => setError(err.message));
    await loadEvents();
    if (activeEvent === id) { setActiveEvent(null); setEventData(null); }
  }

  const presentCount = eventData ? Object.values(eventData.records).filter((r) => r.status === 'present').length : 0;
  const markedCount = eventData ? Object.values(eventData.records).length : 0;
  const totalMembers = eventData ? eventData.members.length : 0;

  return (
    <div className="max-w-5xl">
      {confirmEl}
      {rollCallEvent && (
        <RollCallModal
          eventId={rollCallEvent}
          onClose={() => setRollCallEvent(null)}
          onDone={() => { setRollCallEvent(null); loadEvents(); if (activeEvent === rollCallEvent) loadEvent(rollCallEvent); }}
        />
      )}
      <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="font-display text-4xl sm:text-5xl text-cream">Attendance</h1>
          <p className="text-cream/50 mt-1">Track who shows up to meetings and events.</p>
        </div>
        {me.role === 'admin' && activeTab === 'attendance' && (
          <Button variant="ghost" onClick={() => setCreating(true)}>+ New Event</Button>
        )}
      </div>

      <div className="flex gap-1 mb-5 bg-navy2 rounded-lg p-1 w-fit">
        {['upcoming', 'attendance'].map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeTab === tab ? 'bg-gold text-navy' : 'text-cream/60 hover:text-cream'}`}>
            {tab === 'upcoming' ? 'Upcoming RSVPs' : 'Attendance Records'}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 text-red text-sm bg-red/10 border border-red/30 rounded-md px-3 py-2">{error}</div>}

      {activeTab === 'upcoming' && (
        <div className="max-w-2xl">
          {upcomingEvents === null && <Loading label="Loading upcoming events…" />}
          {upcomingEvents !== null && upcomingEvents.length === 0 && (
            <EmptyState icon="📅" title="No upcoming events" hint="Upcoming events will appear here once scheduled." />
          )}
          <div className="space-y-3">
            {(upcomingEvents || []).map((ev) => {
              const dateStr = new Date(ev.eventDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
              return (
                <div key={ev.id} className="bg-navy2 border border-cream/10 rounded-xl p-4">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div>
                      <div className="font-medium text-cream">{ev.title}</div>
                      <div className="text-xs text-cream/50 mt-0.5">{dateStr}{ev.location ? ' · ' + ev.location : ''}</div>
                      <div className="flex gap-3 mt-2 text-xs text-cream/40">
                        <span className="text-emerald-400">{ev.rsvpCounts.yes} going</span>
                        <span className="text-gold">{ev.rsvpCounts.maybe} maybe</span>
                        <span className="text-red/70">{ev.rsvpCounts.no} can't make it</span>
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      {[['yes','✓ Going','emerald'], ['maybe','? Maybe','gold'], ['no','✗ Can\'t','red']].map(([val, label, color]) => (
                        <button key={val} onClick={() => rsvp(ev.id, ev.myRsvp === val ? null : val)}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all border ${
                            ev.myRsvp === val
                              ? color === 'emerald' ? 'bg-emerald-500/30 border-emerald-500/60 text-emerald-300'
                                : color === 'gold' ? 'bg-gold/30 border-gold/60 text-gold'
                                : 'bg-red/30 border-red/60 text-red'
                              : 'border-cream/15 text-cream/50 hover:border-cream/30 bg-navy'
                          }`}>
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>
                  {isManager && (
                    <button onClick={() => loadRsvpDetails(ev.id)}
                      className="mt-2 text-xs text-cream/35 hover:text-gold transition-colors flex items-center gap-1">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        {rsvpDetails[ev.id] ? <path d="M18 15l-6-6-6 6"/> : <path d="M6 9l6 6 6-6"/>}
                      </svg>
                      {rsvpDetails[ev.id] ? 'Hide' : 'View'} RSVP list
                    </button>
                  )}
                  {isManager && rsvpDetails[ev.id] && (
                    <div className="mt-2 pt-2 border-t border-cream/10 space-y-0.5">
                      {rsvpDetails[ev.id].length === 0 && <div className="text-xs text-cream/30 italic">No RSVPs yet.</div>}
                      {rsvpDetails[ev.id].map((r) => (
                        <div key={r.userId} className="flex items-center gap-2 text-xs">
                          <span className={r.response === 'yes' ? 'text-emerald-400' : r.response === 'maybe' ? 'text-gold' : 'text-red/70'}>
                            {r.response === 'yes' ? '✓' : r.response === 'maybe' ? '?' : '✗'}
                          </span>
                          <span className="text-cream/70">{r.displayName}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {activeTab === 'attendance' && creating && (
        <form onSubmit={createEvent} className="bg-navy2 border border-gold/30 rounded-xl p-5 mb-6 space-y-3 ca-slide-up">
          <div className="font-display text-xl text-gold">New Event</div>
          <div className="grid sm:grid-cols-2 gap-3">
            <Field label="Title *"><input className={inputCls} value={form.title} onChange={setF('title')} required autoFocus /></Field>
            <Field label="Date *"><input type="date" className={inputCls} value={form.eventDate} onChange={setF('eventDate')} required /></Field>
            <Field label="Location"><input className={inputCls} value={form.location} onChange={setF('location')} /></Field>
            <Field label="Notes"><input className={inputCls} value={form.notes} onChange={setF('notes')} /></Field>
          </div>
          <div className="flex gap-2">
            <Button type="submit" variant="gold" disabled={busy}>{busy ? 'Creating…' : 'Create Event'}</Button>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
          </div>
        </form>
      )}

      {activeTab === 'attendance' && <div className="grid md:grid-cols-5 gap-4">
        {/* Event list */}
        <div className="md:col-span-2 space-y-2">
          {events === null && <Loading label="Loading events…" />}
          {events !== null && events.length === 0 && (
            <EmptyState icon="📅" title="No events yet" hint="Create an event to start tracking attendance." />
          )}
          {(events || []).map((ev) => (
            <div key={ev.id} className={`bg-navy2 border rounded-xl transition-all duration-150 ${activeEvent === ev.id ? 'border-gold/60 bg-navy3' : 'border-cream/10'}`}>
              <button
                onClick={() => setActiveEvent(ev.id === activeEvent ? null : ev.id)}
                className="w-full text-left px-4 py-3 hover:bg-navy3/50 transition-colors rounded-t-xl">
                <div className="font-medium text-cream truncate">{ev.title}</div>
                <div className="text-xs text-cream/50 mt-0.5">{new Date(ev.eventDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</div>
                {ev.location && <div className="text-xs text-cream/40 truncate">{ev.location}</div>}
                <div className="flex items-center gap-3 mt-1.5">
                  <Badge tone="green">{ev.presentCount} present</Badge>
                  <span className="text-xs text-cream/30">{ev.markedCount} marked</span>
                </div>
              </button>
              {(me.role === 'admin' || me.role === 'manager') && (
                <div className="px-4 pb-3">
                  <button onClick={() => setRollCallEvent(ev.id)}
                    className="text-xs text-gold/70 hover:text-gold border border-gold/30 hover:border-gold/60 rounded px-2.5 py-1 transition-colors">
                    📋 Roll Call
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Attendance sheet */}
        <div className="md:col-span-3">
          {!activeEvent && (
            <div className="border border-dashed border-cream/15 rounded-xl p-8 text-center text-cream/40 text-sm">
              Select an event to take attendance
            </div>
          )}
          {activeEvent && !eventData && <Loading label="Loading attendance…" />}
          {activeEvent && eventData && (
            <div className="bg-navy2 border border-cream/10 rounded-xl overflow-hidden">
              <div className="px-5 py-4 border-b border-cream/10 flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-display text-xl text-cream">{eventData.event.title}</div>
                  <div className="text-xs text-cream/50 mt-0.5">
                    {new Date(eventData.event.eventDate + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
                    {eventData.event.location && ` · ${eventData.event.location}`}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="green">{presentCount}/{totalMembers}</Badge>
                  {me.role === 'admin' && (
                    <button onClick={() => deleteEvent(activeEvent)} className="text-xs text-red/60 hover:text-red">Delete</button>
                  )}
                </div>
              </div>
              {eventData.event.notes && (
                <div className="px-5 py-2 text-xs text-cream/50 border-b border-cream/5">{eventData.event.notes}</div>
              )}
              <div className="divide-y divide-cream/5">
                {eventData.members.map((member) => {
                  const rec = eventData.records[member.id];
                  const status = rec ? rec.status : null;
                  return (
                    <div key={member.id} className="px-5 py-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-cream text-sm font-medium">{member.displayName}</div>
                        {member.title && <div className="text-cream/40 text-xs">{member.title}</div>}
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        {ATTENDANCE_STATUSES.map((s) => (
                          <button key={s} onClick={() => markAttendance(member.id, s)}
                            className={`px-2.5 py-1 rounded-md text-xs font-medium transition-all duration-150 ${
                              status === s
                                ? s === 'present' ? 'bg-emerald-500/80 text-white' : s === 'absent' ? 'bg-red/80 text-white' : 'bg-sky-500/80 text-white'
                                : 'bg-navy border border-cream/15 text-cream/50 hover:border-cream/30'
                            }`}>
                            {ATTENDANCE_LABELS[s]}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Budget Dashboard
// ---------------------------------------------------------------------------
function BudgetDashboardPage({ me }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/budget/overview').then(setData).catch((err) => setError(err.message));
  }, []);

  if (error) return <ErrorState message={error} />;
  if (!data) return <Loading label="Loading budget overview…" />;

  const { totals, bySubmitter, recent, reimbursedTotal = 0 } = data;
  const fmt = (n) => `$${Number(n || 0).toFixed(2)}`;
  const spent = Number(totals.approvedAmount) + Number(totals.purchasedAmount);

  const StatCard = ({ label, value, tone = 'slate' }) => {
    const tones = { gold: 'border-gold/40 text-gold', green: 'border-emerald-500/40 text-emerald-300', red: 'border-red/40 text-red', slate: 'border-cream/15 text-cream' };
    return (
      <div className={`bg-navy2 border rounded-xl p-4 ${tones[tone]}`}>
        <div className="text-2xl font-display">{value}</div>
        <div className="text-cream/50 text-xs mt-1">{label}</div>
      </div>
    );
  };

  return (
    <div className="max-w-4xl">
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-2">Budget Overview</h1>
      <p className="text-cream/50 mb-6">Financial summary for all funding requests.</p>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        <StatCard label="Total Requested" value={fmt(totals.totalAmount)} tone="gold" />
        <StatCard label="Approved / Spent" value={fmt(spent)} tone="green" />
        <StatCard label="Reimbursed" value={fmt(reimbursedTotal)} tone="blue" />
        <StatCard label="Pending Review" value={fmt(totals.pendingAmount)} tone="slate" />
      </div>

      <div className="grid sm:grid-cols-2 gap-3 mb-8">
        {[
          { label: 'Pending', count: totals.pendingCount, tone: 'slate' },
          { label: 'Approved', count: totals.approvedCount, tone: 'green' },
          { label: 'Purchased', count: totals.purchasedCount, tone: 'blue' },
          { label: 'Denied', count: totals.deniedCount, tone: 'red' },
        ].map(({ label, count, tone }) => (
          <div key={label} className="flex items-center justify-between bg-navy2 border border-cream/10 rounded-xl px-4 py-3">
            <span className="text-cream/70 text-sm">{label} Requests</span>
            <Badge tone={tone}>{count}</Badge>
          </div>
        ))}
      </div>

      {bySubmitter.length > 0 && (
        <div className="bg-navy2 border border-cream/10 rounded-xl p-5 mb-6">
          <div className="font-display text-xl text-gold mb-4">By Submitter</div>
          <div className="space-y-2">
            {bySubmitter.map((row) => (
              <div key={row.displayName} className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-cream text-sm">{row.displayName}{row.title ? <span className="text-cream/40 text-xs ml-1">· {row.title}</span> : ''}</span>
                    <span className="text-cream/60 text-xs">{fmt(row.approvedAmount)} approved / {fmt(row.totalAmount)} requested</span>
                  </div>
                  <div className="h-2 bg-navy rounded-full overflow-hidden">
                    <div className="h-full bg-gold/60 rounded-full transition-all"
                      style={{ width: `${totals.totalAmount > 0 ? Math.min(100, (row.totalAmount / totals.totalAmount) * 100) : 0}%` }} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {recent.length > 0 && (
        <div className="bg-navy2 border border-cream/10 rounded-xl p-5">
          <div className="font-display text-xl text-gold mb-4">Recent Requests</div>
          <div className="space-y-2">
            {recent.map((r) => (
              <div key={r.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-cream text-sm truncate">{r.title}</div>
                  <div className="text-cream/40 text-xs">{r.submitterName} · {timeAgo(r.createdAt)}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-gold text-sm">{fmt(r.amount)}</span>
                  <Badge tone={r.status === 'approved' || r.status === 'purchased' ? 'green' : r.status === 'denied' ? 'red' : 'slate'}>{r.status}</Badge>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Polls & Voting
// ---------------------------------------------------------------------------
function PollsPage({ me }) {
  const [polls, setPolls] = useState(null);
  const [creating, setCreating] = useState(false);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmEl, confirm] = useConfirm();
  const canCreate = me.role === 'admin';

  const load = useCallback(async () => {
    try { const d = await api('/polls'); setPolls(d.polls || []); } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function createPoll(e) {
    e.preventDefault();
    const opts = options.filter((o) => o.trim());
    if (!question.trim() || opts.length < 2) { setError('Need a question and at least 2 options.'); return; }
    setBusy(true); setError('');
    try {
      await api('/polls', { method: 'POST', body: { question: question.trim(), options: opts } });
      setCreating(false); setQuestion(''); setOptions(['', '']);
      load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function vote(pollId, optionIndex) {
    setBusy(true); setError('');
    try {
      await api(`/polls/${pollId}/vote`, { method: 'POST', body: { optionIndex } });
      load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function closePoll(id) {
    if (!(await confirm({ title: 'Close poll?', message: 'No more votes can be cast once closed.', confirmLabel: 'Close' }))) return;
    await api(`/polls/${id}/close`, { method: 'POST' }).catch((err) => setError(err.message));
    load();
  }

  async function deletePoll(id) {
    if (!(await confirm({ title: 'Delete poll?', message: 'All votes will be lost.', confirmLabel: 'Delete', danger: true }))) return;
    await api(`/polls/${id}`, { method: 'DELETE' }).catch((err) => setError(err.message));
    load();
  }

  function setOption(i, val) { setOptions((prev) => { const n = [...prev]; n[i] = val; return n; }); }

  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="max-w-3xl">
      {confirmEl}
      <div className="flex items-start justify-between gap-3 mb-6 flex-wrap">
        <div>
          <h1 className="font-display text-4xl sm:text-5xl text-cream">Polls</h1>
          <p className="text-cream/50 mt-1">Vote on questions from the President.</p>
        </div>
        {canCreate && <Button variant="ghost" onClick={() => setCreating(true)}>+ New Poll</Button>}
      </div>

      {error && <div className="mb-4 text-red text-sm">{error}</div>}

      {creating && (
        <form onSubmit={createPoll} className="bg-navy2 border border-gold/30 rounded-xl p-5 mb-6 space-y-3 ca-slide-up">
          <div className="font-display text-xl text-gold">Create Poll</div>
          <Field label="Question">
            <input className={inputCls} value={question} onChange={(e) => setQuestion(e.target.value)} required autoFocus placeholder="e.g. What theme should our next event be?" />
          </Field>
          <div>
            <div className="text-xs uppercase tracking-wider text-cream/60 mb-2">Options</div>
            {options.map((opt, i) => (
              <div key={i} className="flex gap-2 mb-2">
                <input className={inputCls} value={opt} onChange={(e) => setOption(i, e.target.value)} placeholder={`Option ${i + 1}`} />
                {options.length > 2 && (
                  <button type="button" onClick={() => setOptions((prev) => prev.filter((_, j) => j !== i))} className="text-red/60 hover:text-red text-xl leading-none px-2">×</button>
                )}
              </div>
            ))}
            {options.length < 6 && (
              <button type="button" onClick={() => setOptions((prev) => [...prev, ''])} className="text-xs text-gold/60 hover:text-gold">+ Add option</button>
            )}
          </div>
          {error && <div className="text-red text-sm">{error}</div>}
          <div className="flex gap-2">
            <Button type="submit" variant="gold" disabled={busy}>{busy ? 'Creating…' : 'Publish Poll'}</Button>
            <Button variant="ghost" onClick={() => { setCreating(false); setQuestion(''); setOptions(['', '']); setError(''); }}>Cancel</Button>
          </div>
        </form>
      )}

      {polls === null && <Loading label="Loading polls…" />}
      {polls !== null && polls.length === 0 && <EmptyState icon="🗳️" title="No polls yet" hint={canCreate ? 'Create a poll to get the board\'s opinion on something.' : 'No active polls from the President.'} />}

      <div className="space-y-4">
        {(polls || []).map((poll) => {
          const totalVotes = poll.voteCount || 0;
          const hasVoted = poll.myVote !== null;
          const isClosed = poll.status === 'closed';
          const showResults = hasVoted || isClosed || canCreate;
          return (
            <div key={poll.id} className={`bg-navy2 border rounded-xl p-5 ${isClosed ? 'border-cream/10' : 'border-gold/20 hover:border-gold/40'} transition-all duration-200`}>
              <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
                <div className="min-w-0">
                  <div className="text-cream font-medium">{poll.question}</div>
                  <div className="text-xs text-cream/40 mt-0.5">{poll.createdByName} · {timeAgo(poll.createdAt)} · {totalVotes} vote{totalVotes !== 1 ? 's' : ''}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {isClosed ? <Badge tone="slate">Closed</Badge> : <Badge tone="green">Open</Badge>}
                  {canCreate && !isClosed && <button onClick={() => closePoll(poll.id)} className="text-xs text-cream/50 hover:text-cream">Close</button>}
                  {canCreate && <button onClick={() => deletePoll(poll.id)} className="text-xs text-red/60 hover:text-red">Delete</button>}
                </div>
              </div>

              <div className="space-y-2">
                {poll.options.map((opt, i) => {
                  const count = showResults ? (totalVotes > 0 ? (/* we need real counts */ 0) : 0) : 0;
                  const isMyVote = poll.myVote === i;
                  return (
                    <button key={i}
                      disabled={hasVoted || isClosed || busy}
                      onClick={() => vote(poll.id, i)}
                      className={`w-full text-left rounded-lg px-4 py-2.5 border transition-all duration-150 ${
                        isMyVote
                          ? 'border-gold/60 bg-gold/10 text-cream'
                          : hasVoted || isClosed
                            ? 'border-cream/10 text-cream/60 cursor-default'
                            : 'border-cream/15 text-cream hover:border-gold/40 hover:bg-navy3 active:scale-[0.99]'
                      }`}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm">{opt}</span>
                        {isMyVote && <span className="text-gold text-xs shrink-0">✓ Your vote</span>}
                      </div>
                    </button>
                  );
                })}
              </div>

              {!hasVoted && !isClosed && (
                <div className="mt-2 text-xs text-cream/40">Click an option to cast your vote · anonymous until closed</div>
              )}
              {(hasVoted || isClosed) && (
                <PollResults pollId={poll.id} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function PollResults({ pollId }) {
  const [results, setResults] = useState(null);
  useEffect(() => {
    api(`/polls/${pollId}/results`).then(setResults).catch(() => {});
  }, [pollId]);
  if (!results) return null;
  const { results: opts, total } = results;
  return (
    <div className="mt-3 space-y-1.5 pt-3 border-t border-cream/10">
      <div className="text-xs text-cream/40 mb-2">{total} vote{total !== 1 ? 's' : ''} total</div>
      {opts.map((o, i) => {
        const pct = total > 0 ? Math.round((o.count / total) * 100) : 0;
        return (
          <div key={i}>
            <div className="flex justify-between text-xs mb-1">
              <span className="text-cream/70">{o.option}</span>
              <span className="text-cream/50">{pct}% ({o.count})</span>
            </div>
            <div className="h-1.5 bg-navy rounded-full overflow-hidden">
              <div className="h-full bg-gold/70 rounded-full transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Catches render-time errors so the page shows a readable message, never blank.
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error('App error:', err, info); }
  render() {
    if (this.state.err) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center text-center gap-3 p-6">
          <div className="text-4xl">⚠️</div>
          <div className="font-display text-2xl text-gold">Something went wrong</div>
          <div className="text-cream/70 max-w-md text-sm">{String((this.state.err && this.state.err.message) || this.state.err)}</div>
          <button onClick={() => location.reload()} className="mt-2 bg-red text-cream px-4 py-2 rounded-md text-sm">Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}

(function mount() {
  const rootEl = document.getElementById('root');
  try {
    ReactDOM.createRoot(rootEl).render(<ErrorBoundary><App /></ErrorBoundary>);
    rootEl.setAttribute('data-mounted', '1');
  } catch (e) {
    rootEl.setAttribute('data-mounted', '1');
    rootEl.innerHTML =
      '<div class="ca-center" style="font-family:sans-serif;color:#F5F0E8">' +
      '<div style="font-size:42px">⚠️</div>' +
      '<div style="font-size:20px;color:#C9A84C">Club America couldn\'t start</div>' +
      '<div style="max-width:480px;color:#cbd5e1">' + ((e && e.message) || e) + '</div>' +
      '<button onclick="location.reload()" style="margin-top:8px;background:#CC1C2E;color:#F5F0E8;border:none;border-radius:8px;padding:10px 18px;cursor:pointer">Reload</button>' +
      '</div>';
  }
})();
