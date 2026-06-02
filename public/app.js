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
    <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium border ${tones[tone] || tones.slate}`}>
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
    primary: 'bg-red hover:bg-red/85 text-cream',
    gold: 'bg-gold hover:bg-gold/85 text-navy font-semibold',
    ghost: 'bg-transparent border border-cream/25 hover:border-gold text-cream',
    danger: 'bg-transparent border border-red/60 text-red hover:bg-red hover:text-cream',
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 rounded-md text-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
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
  'w-full bg-navy border border-cream/20 rounded-md px-3 py-2 text-cream placeholder-cream/30 focus:outline-none focus:border-gold';

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
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="mb-8">
          <Logo size="login" />
        </div>
        <form onSubmit={submit} className="bg-navy2 border border-cream/10 rounded-xl p-6 space-y-4">
          <Field label="Username">
            <input className={inputCls} value={username} autoFocus
              onChange={(e) => setUsername(e.target.value)} placeholder="e.g. fthomas" />
          </Field>
          <Field label="Password">
            <input className={inputCls} type="password" value={password}
              onChange={(e) => setPassword(e.target.value)} placeholder="Default = your username" />
          </Field>
          {error && <div className="text-red text-sm">{error}</div>}
          <Button type="submit" variant="gold" className="w-full" disabled={loading}>
            {loading ? 'Signing in…' : 'Sign In'}
          </Button>
          <p className="text-center text-xs text-cream/40">
            First time? Your password is your username. You'll set a new one.
          </p>
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
    if (pw !== confirm) return setError('Passwords do not match');
    setLoading(true);
    try {
      const data = await api('/auth/change-password', { method: 'POST', body: { newPassword: pw } });
      onDone(data.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-md bg-navy2 border border-cream/10 rounded-xl p-6 space-y-4">
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
      <div className="bg-navy2 border border-cream/10 rounded-xl p-5 max-w-2xl w-full">
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
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [cropping, setCropping] = useState(false);

  useEffect(() => {
    api('/me/profile').then((d) => { setPhoto(d.photo || ''); setBio(d.bio || ''); setEmail(d.email || ''); }).catch(() => {});
  }, []);

  function onFile(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (!f.type.startsWith('image/')) { setError('Please choose an image file.'); return; }
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
      const d = await api('/me/profile', { method: 'PUT', body: { photo, bio, email } });
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
    return <>{cropModal}<form onSubmit={submit} className="min-h-screen flex items-center justify-center p-4">{card}</form></>;
  }
  return <>{cropModal}<form onSubmit={submit} className="max-w-lg">{card}</form></>;
}

// ---------------------------------------------------------------------------
// Task page (used for self and for managed reports)
// ---------------------------------------------------------------------------
function TaskCard({ task, canEdit, onChange, onDelete }) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="bg-navy2 border border-cream/10 rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium text-cream truncate">{task.name}</div>
          {task.description && <div className="text-sm text-cream/60 mt-1 whitespace-pre-wrap">{task.description}</div>}
        </div>
        <Badge tone={statusTone(task.status)}>{task.status}</Badge>
      </div>
      <div className="flex items-center flex-wrap gap-x-4 gap-y-1 mt-3 text-xs text-cream/50">
        {task.dueDate && <span>Due {task.dueDate}</span>}
        <span>Assigned by <span className="text-gold/80">{task.assignedByName}</span></span>
        {task.approvalStatus === 'pending' && <Badge tone="red">Pending approval</Badge>}
      </div>
      {canEdit && task.approvalStatus === 'approved' && (
        <div className="flex items-center gap-2 mt-3">
          <select
            className="bg-navy border border-cream/20 rounded px-2 py-1 text-sm"
            value={task.status}
            onChange={(e) => onChange(task, { status: e.target.value })}
          >
            <option>Not Started</option>
            <option>In Progress</option>
            <option>Complete</option>
          </select>
          {onDelete && (
            <button onClick={() => onDelete(task)} className="text-xs text-red/80 hover:text-red ml-auto">
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NewTaskForm({ targetUserId, onCreated }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await api('/tasks', { method: 'POST', body: { name, description, dueDate: dueDate || null, targetUserId } });
      setName(''); setDescription(''); setDueDate(''); setOpen(false);
      onCreated();
    } catch (err) { setError(err.message); }
  }

  if (!open) return <Button variant="ghost" onClick={() => setOpen(true)}>+ New Task</Button>;
  return (
    <form onSubmit={submit} className="bg-navy2 border border-gold/30 rounded-lg p-4 space-y-3">
      <Field label="Task Name"><input className={inputCls} value={name} autoFocus onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Description"><textarea className={inputCls} rows="2" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="Due Date"><input type="date" className={inputCls} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
      {error && <div className="text-red text-sm">{error}</div>}
      <div className="flex gap-2">
        <Button type="submit" variant="gold">Create</Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
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
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const others = users.filter((u) => u.id !== me.id);

  async function submit(e) {
    e.preventDefault();
    setError(''); setMsg('');
    try {
      const data = await api('/tasks', { method: 'POST', body: { name, description, dueDate: dueDate || null, targetUserId: Number(targetUserId) } });
      setName(''); setDescription(''); setDueDate(''); setTargetUserId('');
      setMsg(data.task.approvalStatus === 'pending'
        ? 'Sent — awaiting manager approval.'
        : 'Task assigned.');
      onCreated();
    } catch (err) { setError(err.message); }
  }

  if (!open) return <Button variant="ghost" onClick={() => setOpen(true)}>↗ Send Task to Someone</Button>;
  return (
    <form onSubmit={submit} className="bg-navy2 border border-cream/15 rounded-lg p-4 space-y-3">
      <div className="font-display text-xl text-gold">Send a Task</div>
      <Field label="To">
        <select className={inputCls} value={targetUserId} onChange={(e) => setTargetUserId(e.target.value)} required>
          <option value="">Select a board member…</option>
          {others.map((u) => <option key={u.id} value={u.id}>{u.displayName} — {u.title || roleLabel(u.role)}</option>)}
        </select>
      </Field>
      <Field label="Task Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required /></Field>
      <Field label="Description"><textarea className={inputCls} rows="2" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <Field label="Due Date"><input type="date" className={inputCls} value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
      {me.role !== 'admin' && <p className="text-xs text-cream/40">Tasks you send are held until the recipient's manager approves them.</p>}
      {error && <div className="text-red text-sm">{error}</div>}
      {msg && <div className="text-emerald-300 text-sm">{msg}</div>}
      <div className="flex gap-2">
        <Button type="submit" variant="gold">Send</Button>
        <Button variant="ghost" onClick={() => { setOpen(false); setMsg(''); }}>Close</Button>
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
      className={`relative w-12 h-7 rounded-full transition-colors disabled:opacity-50 shrink-0 ${enabled ? 'bg-emerald-500' : 'bg-cream/20'}`}
    >
      <span className={`absolute top-0.5 left-0.5 w-6 h-6 rounded-full bg-white transition-transform ${enabled ? 'translate-x-5' : ''}`} />
    </button>
  );
}

function BannerSection({ title, url }) {
  return (
    <a
      href={url || '#'}
      target={url ? '_blank' : undefined}
      rel="noopener"
      className="block w-full bg-gold/15 border border-gold/40 rounded-xl px-6 py-5 text-center font-display text-2xl text-gold hover:bg-gold/25 transition-colors mb-6"
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

function PersonalCalendarSection({ userId }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [calError, setCalError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setCalError('');
    api(`/users/${userId}/calendar`)
      .then((d) => { if (!cancelled) { setEvents(d.events || []); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setCalError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [userId]);

  return (
    <div className="bg-navy2 border border-cream/10 rounded-xl p-5 mb-6">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-lg">📅</span>
        <div className="font-display text-2xl text-gold">My Calendar</div>
      </div>
      {loading && <div className="text-cream/40 text-sm">Loading events…</div>}
      {calError && <div className="text-red text-sm">{calError}</div>}
      {!loading && !calError && events.length === 0 && (
        <div className="text-cream/40 text-sm">No upcoming events.</div>
      )}
      {!loading && events.length > 0 && (
        <ul className="space-y-3">
          {events.map((e, i) => (
            <li key={i} className="border-l-2 border-gold/50 pl-3">
              <div className="text-cream font-medium leading-tight">{e.title}</div>
              <div className="text-sm text-gold/80">{fmtEvent(e.start)}</div>
              {e.location && <div className="text-sm text-cream/50">{e.location}</div>}
            </li>
          ))}
        </ul>
      )}
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
      setTimeout(() => setCopied(false), 2000);
    } catch (_) {}
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
      <p className="text-xs text-cream/40 mt-2">Fill in the fields above, then copy and paste anywhere.</p>
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
        className="text-sm text-gold/60 hover:text-gold flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-gold/20 hover:border-gold/50 transition-colors"
      >
        ⚙ Page Settings
      </button>
    </div>
  );

  return (
    <div className="bg-navy2 border border-gold/30 rounded-xl p-5 mb-6">
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
                <div className="text-cream font-medium">Personal Calendar</div>
                <div className="text-cream/50 text-sm">Shows upcoming events from an iCal / .ics feed.</div>
              </div>
              <Toggle enabled={settings.calendarEnabled} onChange={() => toggle('calendarEnabled')} disabled={busy} />
            </div>
            {settings.calendarEnabled && (
              <div className="mt-3">
                <Field label="iCal URL (.ics address)">
                  <input className={inputCls} defaultValue={settings.calendarUrl}
                    onBlur={(e) => e.target.value !== settings.calendarUrl && save({ calendarUrl: e.target.value })}
                    placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" />
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

  async function remove() {
    if (!confirm("Remove the team announcement? It will disappear from your reports' pages.")) return;
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
  const isSelf = userId === me.id;
  const canManagePage = !isSelf && (me.role === 'admin' || me.role === 'manager');

  const load = useCallback(async () => {
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
    await api(`/tasks/${task.id}`, { method: 'PATCH', body: patch });
    load();
  }
  async function deleteTask(task) {
    if (!confirm('Delete this task?')) return;
    await api(`/tasks/${task.id}`, { method: 'DELETE' });
    load();
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

  if (error) return <div className="text-red">{error}</div>;
  if (!data) return <div className="text-cream/50">Loading…</div>;

  const { user, tasks } = data;
  const ps = pageSettings || {};
  const grouped = {
    'Not Started': tasks.filter((t) => t.status === 'Not Started'),
    'In Progress': tasks.filter((t) => t.status === 'In Progress'),
    'Complete': tasks.filter((t) => t.status === 'Complete'),
  };

  return (
    <div className="max-w-5xl">
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
      {ps.calendarEnabled && <PersonalCalendarSection userId={userId} />}
      {ps.formEnabled && <CopyableFormSection title={ps.formTitle} fields={ps.formFields} />}

      <div className="space-y-3 mb-6">
        <NewTaskForm targetUserId={isSelf ? undefined : userId} onCreated={load} />
        {isSelf && <AssignTaskForm me={me} users={users} onCreated={load} />}
      </div>

      {tasks.length === 0 && <div className="text-cream/40">No tasks yet.</div>}

      <div className="grid md:grid-cols-3 gap-4">
        {['Not Started', 'In Progress', 'Complete'].map((col) => (
          <div key={col}>
            <div className="font-display text-xl text-gold mb-2">{col} <span className="text-cream/30 text-base">({grouped[col].length})</span></div>
            <div className="space-y-3">
              {grouped[col].map((t) => (
                <TaskCard key={t.id} task={t} canEdit={true} onChange={changeTask} onDelete={deleteTask} />
              ))}
            </div>
          </div>
        ))}
      </div>

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
  const [items, setItems] = useState([]);
  const load = useCallback(async () => {
    const d = await api('/approvals');
    setItems(d.approvals);
  }, []);
  useEffect(() => { load(); }, [load, refreshSignal]);

  async function act(task, action) {
    await api(`/tasks/${task.id}/${action}`, { method: 'POST' });
    await load();
    onChanged && onChanged();
  }

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-6">Pending Approvals</h1>
      {items.length === 0 && <div className="text-cream/40">Nothing waiting on you. 🎉</div>}
      <div className="space-y-3">
        {items.map((t) => (
          <div key={t.id} className="bg-navy2 border border-gold/30 rounded-lg p-4">
            <div className="font-medium text-cream">{t.name}</div>
            {t.description && <div className="text-sm text-cream/60 mt-1">{t.description}</div>}
            <div className="text-xs text-cream/50 mt-2">
              For <span className="text-gold/80">{t.ownerName}</span> · from <span className="text-gold/80">{t.assignedByName}</span>
              {t.dueDate && <> · due {t.dueDate}</>}
            </div>
            <div className="flex gap-2 mt-3">
              <Button variant="gold" onClick={() => act(t, 'approve')}>Approve</Button>
              <Button variant="danger" onClick={() => act(t, 'reject')}>Reject</Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// "Get Involved" inbox — club-join + board-application submissions routed here.
function SubmissionsInbox({ onChanged, refreshSignal }) {
  const [items, setItems] = useState([]);
  const load = useCallback(async () => {
    const d = await api('/submissions');
    setItems(d.submissions);
  }, []);
  useEffect(() => { load(); }, [load, refreshSignal]);

  async function toggle(s) {
    await api(`/submissions/${s.id}/handled`, { method: 'POST' });
    await load();
    onChanged && onChanged();
  }
  async function remove(s) {
    if (!confirm('Delete this submission?')) return;
    await api(`/submissions/${s.id}`, { method: 'DELETE' });
    await load();
    onChanged && onChanged();
  }

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-2">Get Involved</h1>
      <p className="text-cream/50 mb-6">Club-join and board applications submitted from the public homepage.</p>
      {items.length === 0 && <div className="text-cream/40">No submissions yet.</div>}
      <div className="space-y-3">
        {items.map((s) => (
          <div key={s.id} className={`bg-navy2 border rounded-lg p-4 ${s.handled ? 'border-cream/10 opacity-70' : 'border-gold/30'}`}>
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="font-medium text-cream">{s.name} <span className="text-cream/40 text-sm">· {s.email}</span></div>
              <div className="flex gap-2 flex-wrap">
                <Badge tone={s.type === 'board' ? 'red' : 'blue'}>{s.type === 'board' ? 'Board Application' : 'Join the Club'}</Badge>
                {s.grade && <Badge tone="gold">Grade {s.grade}</Badge>}
                {s.handled ? <Badge tone="green">Handled</Badge> : <Badge tone="slate">New</Badge>}
              </div>
            </div>
            {s.message && <div className="text-sm text-cream/70 mt-2 whitespace-pre-line">{s.message}</div>}
            <div className="text-xs text-cream/40 mt-2">{(s.createdAt || '').replace('T', ' ').slice(0, 16)}</div>
            <div className="flex gap-2 mt-3 items-center">
              <a href={`mailto:${s.email}`} className="text-xs text-gold/80 hover:text-gold mr-auto">Email {s.name.split(' ')[0]}</a>
              <Button variant={s.handled ? 'ghost' : 'gold'} onClick={() => toggle(s)}>{s.handled ? 'Reopen' : 'Mark handled'}</Button>
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
  return (
    <div className="flex flex-col items-center">
      <div className={`bg-navy2 border-2 ${ring} rounded-lg px-3 sm:px-4 py-2 text-center min-w-[120px] sm:min-w-[160px] shadow-lg`}>
        <div className="font-display text-base sm:text-lg text-gold leading-tight">{title}</div>
        {name && <div className="text-xs sm:text-sm text-cream/80">{name}</div>}
      </div>
      {children && <div className="w-px h-5 bg-cream/20" />}
      {children && <div className="flex flex-wrap justify-center gap-3 sm:gap-4">{children}</div>}
    </div>
  );
}

function OrgChart() {
  const [users, setUsers] = useState(null);

  useEffect(() => {
    api('/orgchart').then((d) => setUsers(d.users)).catch(() => setUsers([]));
  }, []);

  if (!users) return <div className="text-cream/50 py-10 text-center">Loading…</div>;

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

  function renderNode(node) {
    const tone = node.bigBoard ? 'red' : 'slate';
    const childNodes = node.children.length > 0 ? node.children.map(renderNode) : null;
    return (
      <OrgNode key={node.id} title={node.title || roleLabel(node.role)} name={node.displayName} tone={tone}>
        {childNodes}
      </OrgNode>
    );
  }

  return (
    <div>
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-2">Org Chart</h1>
      <p className="text-cream/50 mb-8">Club America — 2025–26 Board</p>

      <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      <div className="flex flex-col items-center gap-5 pb-10 min-w-max sm:min-w-0 mx-auto">
        {roots.map((r, i) => (
          <React.Fragment key={r.id}>
            {i > 0 && <div className="w-px h-5 bg-cream/20" />}
            {renderNode(r)}
          </React.Fragment>
        ))}

        {gradeReps.length > 0 && (
          <div className="w-full mt-6">
            <div className="font-display text-2xl text-gold text-center mb-1">Grade Representatives</div>
            <div className="text-center text-cream/40 text-xs mb-3 tracking-wide uppercase">On the Board · Grade Reps</div>
            <div className="flex flex-wrap justify-center gap-3">
              {gradeReps.map((u) => (
                <div key={u.id} className="bg-navy2 border-2 border-gold/60 rounded-lg px-4 py-2 text-center min-w-[140px]">
                  <div className="text-xs uppercase tracking-wider text-gold/70 mb-0.5">Grade Rep</div>
                  <div className="text-sm text-cream/90 font-medium">{u.displayName}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap justify-center gap-6 text-xs text-cream/40 mt-6 pt-4 border-t border-cream/10">
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm border-2 border-red" /> Big Board</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm border-2 border-gold/60" /> Grade Representative</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-3 rounded-sm border-2 border-cream/30" /> Board Member</span>
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
  const [firstName, setFirstName] = useState(user.displayName.split(' ')[0] || '');
  const [lastName, setLastName] = useState(user.displayName.split(' ').slice(1).join(' ') || '');
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
        className="bg-navy2 border border-gold/30 rounded-xl p-6 max-w-md w-full space-y-4">
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

  async function addUser(e) {
    e.preventDefault();
    setError(''); setNotice('');
    try {
      const d = await api('/admin/users', { method: 'POST', body: {
        firstName: first, lastName: last, title, role, managerId: managerId ? Number(managerId) : null, grade, email,
      }});
      setNotice(`Added ${d.user.displayName} — username "${d.user.username}", default password "${d.defaultPassword}".`);
      setFirst(''); setLast(''); setTitle(''); setRole('member'); setManagerId(''); setGrade(''); setEmail('');
      reload();
    } catch (err) { setError(err.message); }
  }

  async function updateUser(u, patch) {
    await api(`/admin/users/${u.id}`, { method: 'PATCH', body: patch });
    reload();
  }
  async function removeUser(u) {
    if (!confirm(`Remove ${u.displayName}? Their reports roll up to their manager.`)) return;
    await api(`/admin/users/${u.id}`, { method: 'DELETE' });
    reload();
  }
  async function resetPw(u) {
    const d = await api(`/admin/users/${u.id}/reset-password`, { method: 'POST' });
    setNotice(`${u.displayName}'s password reset to default "${d.defaultPassword}". They'll set a new one at next login.`);
  }

  const byId = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u])), [users]);

  return (
    <div className="max-w-5xl">
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
          <Button type="submit" variant="gold">Add Member</Button>
          <span className="text-xs text-cream/40">Username & default password are generated as first-initial + last name.</span>
        </div>
        {notice && <div className="sm:col-span-2 text-emerald-300 text-sm">{notice}</div>}
        {error && <div className="sm:col-span-2 text-red text-sm">{error}</div>}
      </form>

      <div className="font-display text-2xl text-gold mb-3">All Members ({users.length})</div>
      <div className="space-y-3">
        {users.map((u) => (
          <div key={u.id} className="bg-navy2 border border-cream/10 rounded-xl p-4">
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
                <select className="bg-navy border border-cream/20 rounded px-2 py-1 text-xs w-full"
                  value={u.role} onChange={(e) => updateUser(u, { role: e.target.value })}>
                  <option value="member">Member</option>
                  <option value="manager">Manager</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <div className="text-cream/50 uppercase tracking-wider mb-1">Reports To</div>
                <select className="bg-navy border border-cream/20 rounded px-2 py-1 text-xs w-full"
                  value={u.managerId || ''} onChange={(e) => updateUser(u, { managerId: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">— none —</option>
                  {users.filter((x) => x.id !== u.id).map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}
                </select>
              </div>
              <div>
                <div className="text-cream/50 uppercase tracking-wider mb-1">Grade</div>
                <select className="bg-navy border border-cream/20 rounded px-2 py-1 text-xs w-full"
                  value={u.grade || ''} onChange={(e) => updateUser(u, { grade: e.target.value })}>
                  <option value="">—</option>
                  {GRADES.map((g) => <option key={g} value={g}>{gradeOption(g)}</option>)}
                </select>
              </div>
              <div>
                <div className="text-cream/50 uppercase tracking-wider mb-1">Managed Grade</div>
                <select className="bg-navy border border-cream/20 rounded px-2 py-1 text-xs w-full"
                  value={u.managedGrade || ''} onChange={(e) => updateUser(u, { managedGrade: e.target.value ? Number(e.target.value) : null })}>
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
                ].map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 cursor-pointer">
                    <input type="checkbox" checked={!!u[key]}
                      onChange={(e) => updateUser(u, { [key]: e.target.checked })}
                      className="accent-gold" />
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

// A "Follow on Instagram" button, only rendered when a link is configured.
function InstagramLink({ url, className = '' }) {
  if (!url) return null;
  return (
    <a href={url} target="_blank" rel="noopener"
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
  // If the time is exactly midnight local, treat it as an all-day event.
  const allDay = d.getHours() === 0 && d.getMinutes() === 0;
  const date = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (allDay) return date;
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${date} · ${time}`;
}

// Shows the next few calendar events when a calendar is connected; otherwise
// falls back to the manually-entered "Next Meeting" details.
function MeetingCard({ home, events }) {
  const hasEvents = events && events.length > 0;
  return (
    <section className="bg-navy2 border border-gold/30 rounded-2xl p-6">
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
    <section className="bg-navy2 border border-red/30 rounded-2xl p-6">
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
            <a href={home.podcastUrl} target="_blank" rel="noopener"
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
    setError('');
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
            <Button type="submit" variant="gold">Save</Button>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
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
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!form.grade) { setError('Please select your grade.'); return; }
    try {
      await api('/submissions', { method: 'POST', body: { ...form, type: tab } });
      setDone(true);
    } catch (err) { setError(err.message); }
  }

  const TabBtn = ({ id, children }) => (
    <button type="button" onClick={() => { setTab(id); setDone(false); setError(''); }}
      className={`px-4 py-2 rounded-md text-sm transition-colors ${tab === id ? 'bg-red text-cream' : 'bg-navy border border-cream/20 text-cream/70 hover:border-gold'}`}>
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
        <div className="text-center py-6">
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
            <Button type="submit" variant="gold">{tab === 'board' ? 'Submit Application' : 'Join the Club'}</Button>
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
        <button onClick={() => setOpen(false)} className="text-cream/50 hover:text-cream text-2xl leading-none">×</button>
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
  if (member.photo) {
    return <img src={member.photo} alt={member.displayName}
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
  return (
    <div onClick={onClose} className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div onClick={(e) => e.stopPropagation()} className="bg-navy2 border border-gold/30 rounded-2xl max-w-md w-full p-6 relative">
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

  useEffect(() => { api('/board').then((d) => setMembers(d.members)).catch(() => setMembers([])); }, []);
  if (!members || members.length === 0) return null;

  const tree = buildBoardTree(members);
  const renderNode = (node) => (
    <div key={node.id} className="flex flex-col items-center">
      <button onClick={() => { setSel(node); track('board_profile', node.displayName); }}
        className="bg-navy2 border border-cream/15 rounded-xl px-4 py-3 flex flex-col items-center gap-2 w-36 hover:border-gold transition-colors">
        <Avatar member={node} size={56} />
        <div className="text-cream text-sm font-medium text-center leading-tight">{node.displayName}</div>
        <div className="text-gold/80 text-xs text-center leading-tight">{node.title || roleLabel(node.role)}</div>
      </button>
      {node.children.length > 0 && <div className="w-px h-4 bg-cream/20" />}
      {node.children.length > 0 && (
        <div className="flex flex-wrap justify-center gap-4">{node.children.map(renderNode)}</div>
      )}
    </div>
  );

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

function Home({ mode = 'public', me = null, editable = false, onEnterPortal, onBack }) {
  const [home, setHome] = useState(null);
  const [events, setEvents] = useState([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { const d = await api('/home'); setHome(d.home); setEvents(d.events || []); }
    catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <div className="text-red p-8">{error}</div>;
  if (!home) return <div className="text-cream/50 p-8">Loading…</div>;

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

  // In-portal "Home" view.
  if (mode === 'portal') {
    return (
      <div className="max-w-5xl space-y-8">
        <div>
          <h1 className="font-display text-4xl sm:text-5xl text-cream leading-none">Home</h1>
          <p className="text-cream/50 mt-1">This is the public-facing page at <span className="text-gold/80">/home</span>.</p>
        </div>
        <HomeAnnouncementBanner home={home} />
        <AboutSection home={home} />
        {cards}
        {home.instagramUrl && <InstagramLink url={home.instagramUrl} />}
        {canAnnounce && <HomeAnnouncementEditor home={home} onSaved={(h) => setHome(h)} />}
        {editable && <HomeEditor onSaved={load} />}
      </div>
    );
  }

  // Public landing page (full screen).
  return (
    <div className="min-h-screen">
      <div style={{ background: 'radial-gradient(900px 400px at 50% -10%, rgba(204,28,46,0.25), transparent 60%)' }}>
        <header className="max-w-5xl mx-auto px-4 sm:px-6 pt-6 flex items-center justify-between gap-3">
          <Logo size="sidebar" />
          <Button variant="primary" onClick={onEnterPortal}>Board Portal Login →</Button>
        </header>
        <section className="max-w-5xl mx-auto px-4 sm:px-6 pt-10 pb-8 text-center">
          <h1 className="font-display text-6xl sm:text-8xl text-cream leading-none">CLUB AMERICA</h1>
          <p className="text-gold font-display text-2xl sm:text-3xl tracking-[0.25em] mt-1">PARK CITY HIGH SCHOOL</p>
          <p className="text-cream/70 max-w-2xl mx-auto mt-4">
            Faith, freedom, and community. Join us at our next meeting and tune into the Club America podcast.
          </p>
          {home.instagramUrl && (
            <div className="mt-6 flex justify-center">
              <InstagramLink url={home.instagramUrl} />
            </div>
          )}
        </section>
      </div>
      {home.homeAnnouncementEnabled && home.homeAnnouncement && (
        <div className="max-w-5xl mx-auto px-4 sm:px-6 pt-6">
          <HomeAnnouncementBanner home={home} />
        </div>
      )}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 pb-16 space-y-6">
        <AboutSection home={home} />
        {cards}
        <MeetTheBoard />
        <GetInvolved />
      </main>
      <footer className="border-t border-cream/10 py-6 text-center text-cream/40 text-sm space-y-3">
        {home.instagramUrl && (
          <div className="flex justify-center">
            <a href={home.instagramUrl} target="_blank" rel="noopener"
              className="inline-flex items-center gap-2 text-cream/60 hover:text-gold transition-colors">
              <InstagramIcon className="w-5 h-5" /> @ our Instagram
            </a>
          </div>
        )}
        <div>Club America at Park City High School · Powered by TPUSA</div>
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
        <form onSubmit={submit} className="bg-navy2 border border-cream/10 rounded-xl p-6 space-y-4">
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
            {busy ? 'Submitting…' : 'Submit'}
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

function RosterMemberRow({ member, me, onAction, onEdit, canDelete }) {
  const [busy, setBusy] = useState(false);
  const [converting, setConverting] = useState(false);
  const [convertForm, setConvertForm] = useState({ grade: member.grade || '', roleDescription: member.roleDescription || '' });

  async function act(action, body) {
    setBusy(true);
    try { await onAction(member.id, action, body); }
    finally { setBusy(false); }
  }

  const statusColors = {
    Prospect: 'slate', Contacted: 'blue', Onboarded: 'green', Declined: 'red',
  };

  return (
    <div className="bg-navy2 border border-cream/10 rounded-lg p-4">
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
                Manage This
              </Button>
            )}
            {(member.claimedByUserId === me.id || me.role === 'admin' || me.role === 'manager') && (
              <Button variant="ghost" className="text-xs px-3 py-1" onClick={() => act('contacted')} disabled={busy}>
                Mark Contacted
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
                  Not Joining
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
                  <Button variant="gold" className="text-xs px-3 py-1" onClick={() => act('convert', convertForm)} disabled={busy}>Confirm</Button>
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
    </div>
  );
}

function AddRosterMemberForm({ me, onCreated }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', email: '', grade: '', gender: '', status: 'Prospect', notes: '' });
  const [error, setError] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault(); setError('');
    try {
      await api('/roster', { method: 'POST', body: { ...form, grade: form.grade ? Number(form.grade) : null } });
      setForm({ firstName: '', lastName: '', phone: '', email: '', grade: '', gender: '', status: 'Prospect', notes: '' });
      setOpen(false); onCreated();
    } catch (err) { setError(err.message); }
  }

  if (!open) return <Button variant="ghost" onClick={() => setOpen(true)}>+ Add Member</Button>;
  return (
    <form onSubmit={submit} className="bg-navy2 border border-gold/30 rounded-xl p-5 space-y-3">
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
        <Button type="submit" variant="gold">Add</Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

function EditRosterMemberModal({ member, onSaved, onClose }) {
  const [form, setForm] = useState({
    firstName: member.firstName, lastName: member.lastName,
    phone: member.phone, email: member.email,
    grade: member.grade || '', gender: member.gender,
    roleDescription: member.roleDescription, status: member.status, notes: member.notes,
  });
  const [error, setError] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault(); setError('');
    try {
      await api(`/roster/${member.id}`, { method: 'PATCH', body: { ...form, grade: form.grade ? Number(form.grade) : null } });
      onSaved(); onClose();
    } catch (err) { setError(err.message); }
  }

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-lg bg-navy2 border border-cream/10 rounded-xl p-5 space-y-3 max-h-screen overflow-y-auto">
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
              {ROSTER_STATUSES.map((s) => <option key={s}>{s}</option>)}
            </select>
          </Field>
          <div className="sm:col-span-2"><Field label="Notes"><textarea className={inputCls} rows="2" value={form.notes} onChange={set('notes')} /></Field></div>
        </div>
        {error && <div className="text-red text-sm">{error}</div>}
        <div className="flex gap-2">
          <Button type="submit" variant="gold">Save</Button>
          <Button variant="ghost" onClick={onClose} type="button">Cancel</Button>
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
              className={`flex items-center gap-3 px-4 py-2.5 rounded-xl transition-colors ${
                isLeader ? 'bg-gold/15 border border-gold/40' :
                isMe ? 'bg-navy border border-cream/20' : 'bg-navy/40'
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
  const [myGrade, setMyGrade] = useState(null);
  const [gradeFilter, setGradeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [tab, setTab] = useState('all');
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');

  const isPrivileged = me.role === 'admin' || me.role === 'manager';

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
  }, [gradeFilter, statusFilter]);

  useEffect(() => { load(); }, [load]);

  // Grade reps default to their assigned grade filter
  useEffect(() => {
    if (me.managedGrade && !isPrivileged) setGradeFilter(String(me.managedGrade));
  }, [me.managedGrade, isPrivileged]);

  async function handleAction(memberId, action, body) {
    if (action === 'delete') {
      if (!confirm('Delete this member from the roster?')) return;
      await api(`/roster/${memberId}`, { method: 'DELETE' });
    } else {
      await api(`/roster/${memberId}/${action}`, { method: 'POST', body: body || undefined });
    }
    load();
  }

  const tabFilteredMembers = useMemo(() => {
    if (tab === 'pipeline') return members.filter((m) => m.status === 'Prospect' || m.status === 'Contacted');
    if (tab === 'members') return members.filter((m) => m.status === 'Onboarded');
    if (tab === 'declined') return members.filter((m) => m.status === 'Declined');
    return members;
  }, [members, tab]);

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
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-2">Roster</h1>
      <p className="text-cream/50 mb-6">Club America recruitment pipeline and member directory.</p>

      <GradeRepLeaderboard me={me} />

      {error && <div className="text-red text-sm mb-4">{error}</div>}

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
            className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors ${tab === t.key ? 'bg-red text-cream' : 'bg-navy2 border border-cream/15 text-cream/70 hover:border-cream/30'}`}>
            {t.label} <span className="text-xs opacity-60">({counts[t.key]})</span>
          </button>
        ))}
      </div>

      <div className="space-y-3 mb-6">
        {tabFilteredMembers.length === 0 && (
          <div className="text-cream/40 py-8 text-center">No entries here.</div>
        )}
        {tabFilteredMembers.map((m) => (
          <RosterMemberRow key={m.id} member={m} me={me}
            onAction={handleAction}
            onEdit={isPrivileged ? (m) => setEditing(m) : null}
            canDelete={isPrivileged} />
        ))}
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
    return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  }

  return (
    <div className="max-w-2xl">
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-2">Weekly Check-In</h1>
      <p className="text-cream/50 mb-6">
        Submit your weekly update. You can edit it any time before the week ends.
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

      {error && <div className="text-red text-sm mb-4">{error}</div>}

      {enabled === false && !isManager && (
        <div className="text-cream/50 bg-navy2 border border-cream/10 rounded-xl p-6 text-center">
          Weekly check-ins are currently disabled. Check back later.
        </div>
      )}

      {(enabled || isManager) && enabled !== null && (
        <div className="bg-navy2 border border-cream/10 rounded-xl p-5">
          <div className="text-sm text-cream/50 mb-3">
            Week of {fmtWeek(weekOf)}
            {existing && <span className="ml-2 text-emerald-300">· Submitted</span>}
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
  const [requests, setRequests] = useState([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', amount: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const isPrivileged = me.role === 'admin' || me.role === 'manager';

  const load = useCallback(async () => {
    try { const d = await api('/funding'); setRequests(d.requests || []); }
    catch (err) { setError(err.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault(); setError(''); setNotice(''); setBusy(true);
    try {
      await api('/funding', { method: 'POST', body: { ...form, amount: Number(form.amount) || 0 } });
      setForm({ title: '', description: '', amount: '' });
      setOpen(false); setNotice('Funding request submitted!'); load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function reviewAction(id, action, reviewNotes) {
    setBusy(true);
    try { await api(`/funding/${id}`, { method: 'PATCH', body: { action, reviewNotes } }); load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const statusColors = { pending: 'slate', approved: 'green', denied: 'red', purchased: 'blue' };

  return (
    <div className="max-w-4xl">
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-2">Funding Requests</h1>
      <p className="text-cream/50 mb-6">
        {isPrivileged ? 'Review and manage all funding requests.' : 'Submit a request and track its status.'}
      </p>

      {error && <div className="text-red text-sm mb-4">{error}</div>}
      {notice && <div className="text-emerald-300 text-sm mb-4">{notice}</div>}

      <div className="mb-6">
        {!open ? (
          <Button variant="gold" onClick={() => setOpen(true)}>+ New Funding Request</Button>
        ) : (
          <form onSubmit={submit} className="bg-navy2 border border-gold/30 rounded-xl p-5 space-y-3">
            <div className="font-display text-xl text-gold">New Funding Request</div>
            <Field label="Title *"><input className={inputCls} value={form.title} onChange={set('title')} required autoFocus placeholder="e.g. Flyers for fall recruitment" /></Field>
            <Field label="Description"><textarea className={inputCls} rows="3" value={form.description} onChange={set('description')} placeholder="What is this for? Why is it needed?" /></Field>
            <Field label="Amount ($)"><input className={inputCls} type="number" min="0" step="0.01" value={form.amount} onChange={set('amount')} placeholder="0.00" /></Field>
            <div className="flex gap-2">
              <Button type="submit" variant="gold" disabled={busy}>Submit</Button>
              <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
            </div>
          </form>
        )}
      </div>

      {requests.length === 0 && <div className="text-cream/40">No funding requests yet.</div>}
      <div className="space-y-3">
        {requests.map((r) => (
          <div key={r.id} className="bg-navy2 border border-cream/10 rounded-xl p-4">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div>
                <div className="font-medium text-cream">{r.title}</div>
                {r.description && <div className="text-sm text-cream/60 mt-1">{r.description}</div>}
                <div className="text-xs text-cream/40 mt-2">
                  By {r.submitterName} · ${Number(r.amount).toFixed(2)}
                  {r.reviewerName && <> · Reviewed by {r.reviewerName}</>}
                  {r.reviewNotes && <> · "{r.reviewNotes}"</>}
                </div>
              </div>
              <Badge tone={statusColors[r.status] || 'slate'}>{r.status}</Badge>
            </div>
            {isPrivileged && r.status === 'pending' && (
              <div className="flex gap-2 mt-3">
                <Button variant="gold" className="text-xs px-3 py-1" onClick={() => reviewAction(r.id, 'approve')} disabled={busy}>Approve</Button>
                <Button variant="danger" className="text-xs px-3 py-1" onClick={() => reviewAction(r.id, 'deny')} disabled={busy}>Deny</Button>
              </div>
            )}
            {isPrivileged && r.status === 'approved' && (
              <div className="flex gap-2 mt-3">
                <Button variant="ghost" className="text-xs px-3 py-1" onClick={() => reviewAction(r.id, 'purchased')} disabled={busy}>Mark Purchased</Button>
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
  const [apps, setApps] = useState([]);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ positionTitle: '', statement: '' });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const isPrivileged = me.role === 'admin' || me.role === 'manager';

  const load = useCallback(async () => {
    try { const d = await api('/board-apps'); setApps(d.applications || []); }
    catch (err) { setError(err.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function submit(e) {
    e.preventDefault(); setError(''); setNotice(''); setBusy(true);
    try {
      await api('/board-apps', { method: 'POST', body: form });
      setForm({ positionTitle: '', statement: '' });
      setOpen(false); setNotice('Application submitted!'); load();
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function reviewAction(id, action) {
    setBusy(true);
    try { await api(`/board-apps/${id}`, { method: 'PATCH', body: { action } }); load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const statusColors = { pending: 'slate', accepted: 'green', declined: 'red' };

  return (
    <div className="max-w-3xl">
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-2">Board Applications</h1>
      <p className="text-cream/50 mb-6">
        Apply for a leadership position. {isPrivileged ? 'Review incoming applications below.' : ''}
      </p>

      {error && <div className="text-red text-sm mb-4">{error}</div>}
      {notice && <div className="text-emerald-300 text-sm mb-4">{notice}</div>}

      <div className="mb-6">
        {!open ? (
          <Button variant="gold" onClick={() => setOpen(true)}>+ Apply for a Position</Button>
        ) : (
          <form onSubmit={submit} className="bg-navy2 border border-gold/30 rounded-xl p-5 space-y-3">
            <div className="font-display text-xl text-gold">New Application</div>
            <Field label="Position Title *">
              <input className={inputCls} value={form.positionTitle} onChange={set('positionTitle')} required autoFocus
                placeholder="e.g. Vice President, CFO, Grade Rep" />
            </Field>
            <Field label="Personal Statement">
              <textarea className={inputCls} rows="4" value={form.statement} onChange={set('statement')}
                placeholder="Why do you want this position? What makes you a strong candidate?" />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="gold" disabled={busy}>Submit</Button>
              <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
            </div>
          </form>
        )}
      </div>

      {apps.length === 0 && <div className="text-cream/40">No applications yet.</div>}
      <div className="space-y-3">
        {apps.map((a) => (
          <div key={a.id} className="bg-navy2 border border-cream/10 rounded-xl p-4">
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
                <Button variant="gold" className="text-xs px-3 py-1" onClick={() => reviewAction(a.id, 'accept')} disabled={busy}>Accept</Button>
                <Button variant="danger" className="text-xs px-3 py-1" onClick={() => reviewAction(a.id, 'decline')} disabled={busy}>Decline</Button>
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
  const [busy, setBusy] = useState(false);
  const [checkinEnabled, setCheckinEnabled] = useState(null);

  const load = useCallback(async () => {
    setError('');
    try {
      const [d, s] = await Promise.all([api('/dashboard'), api('/checkins/settings')]);
      setData(d);
      setCheckinEnabled(s.enabled);
    } catch (err) { setError(err.message); }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function fundingAction(id, action) {
    setBusy(true);
    try { await api(`/funding/${id}`, { method: 'PATCH', body: { action } }); load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function appAction(id, action) {
    setBusy(true);
    try { await api(`/board-apps/${id}`, { method: 'PATCH', body: { action } }); load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function taskAction(task, action) {
    setBusy(true);
    try { await api(`/tasks/${task.id}/${action}`, { method: 'POST' }); load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  async function toggleCheckins() {
    setBusy(true);
    try {
      const d = await api('/checkins/settings', { method: 'PUT', body: { enabled: !checkinEnabled } });
      setCheckinEnabled(d.enabled);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  if (!data) return <div className="text-cream/50">Loading dashboard…</div>;

  const { pendingFunding, pendingApps, recentCheckins, pendingTasks, counts } = data;

  return (
    <div className="max-w-5xl space-y-8">
      <div>
        <h1 className="font-display text-4xl sm:text-5xl text-cream leading-none">Dashboard</h1>
        <p className="text-cream/50 mt-1">Overview for managers and admins.</p>
      </div>

      {error && <div className="text-red text-sm">{error}</div>}

      {/* Check-in toggle */}
      {checkinEnabled !== null && (
        <div className="bg-navy2 border border-cream/10 rounded-xl p-5 flex items-center justify-between gap-4">
          <div>
            <div className="text-cream font-medium">Weekly Check-Ins</div>
            <div className="text-cream/50 text-sm">{checkinEnabled ? 'Members can submit check-ins this week.' : 'Check-ins are currently disabled.'}</div>
          </div>
          <Toggle enabled={checkinEnabled} onChange={toggleCheckins} disabled={busy} />
        </div>
      )}

      {/* Summary cards */}
      <div className="grid sm:grid-cols-3 gap-4">
        {[
          { label: 'Pending Funding', count: counts.funding, color: 'text-gold' },
          { label: 'Board Applications', count: counts.apps, color: 'text-sky-300' },
          { label: 'Pending Task Approvals', count: counts.tasks, color: 'text-red' },
        ].map(({ label, count, color }) => (
          <div key={label} className="bg-navy2 border border-cream/10 rounded-xl p-5 text-center">
            <div className={`font-display text-4xl ${color}`}>{count}</div>
            <div className="text-cream/60 text-sm mt-1">{label}</div>
          </div>
        ))}
      </div>

      {/* Pending Funding Requests */}
      <div>
        <div className="font-display text-2xl text-gold mb-3">Pending Funding Requests ({pendingFunding.length})</div>
        {pendingFunding.length === 0 && <div className="text-cream/40">None pending.</div>}
        <div className="space-y-3">
          {pendingFunding.map((r) => (
            <div key={r.id} className="bg-navy2 border border-gold/20 rounded-xl p-4">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div>
                  <div className="font-medium text-cream">{r.title}</div>
                  {r.description && <div className="text-sm text-cream/60 mt-1">{r.description}</div>}
                  <div className="text-xs text-cream/40 mt-1">By {r.submitterName} · ${Number(r.amount).toFixed(2)} · {fmtDate(r.createdAt)}</div>
                </div>
                <Badge tone="slate">pending</Badge>
              </div>
              <div className="flex gap-2 mt-3">
                <Button variant="gold" className="text-xs px-3 py-1" onClick={() => fundingAction(r.id, 'approve')} disabled={busy}>Approve</Button>
                <Button variant="danger" className="text-xs px-3 py-1" onClick={() => fundingAction(r.id, 'deny')} disabled={busy}>Deny</Button>
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
                <Button variant="gold" className="text-xs px-3 py-1" onClick={() => appAction(a.id, 'accept')} disabled={busy}>Accept</Button>
                <Button variant="danger" className="text-xs px-3 py-1" onClick={() => appAction(a.id, 'decline')} disabled={busy}>Decline</Button>
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
                <Button variant="gold" className="text-xs px-3 py-1" onClick={() => taskAction(t, 'approve')} disabled={busy}>Approve</Button>
                <Button variant="danger" className="text-xs px-3 py-1" onClick={() => taskAction(t, 'reject')} disabled={busy}>Reject</Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Check-Ins */}
      <div>
        <div className="font-display text-2xl text-gold mb-3">Recent Check-Ins ({recentCheckins.length})</div>
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

  if (loading) return <div className="p-8 text-cream/40 text-sm">Loading…</div>;
  if (error) return <div className="p-8 text-red text-sm">{error}</div>;
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
      className={`text-sm px-4 py-2 border-b-2 transition-colors ${
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
          className="shrink-0 text-xs text-gold/80 hover:text-gold border border-gold/30 hover:border-gold/60 px-3 py-1.5 rounded transition-colors"
        >
          Refresh
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
              {recentLogins.map(l => (
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
                    {recentEvents.map(e => (
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
// AI Notes page (full page — visible to all non-logistics users)
// ---------------------------------------------------------------------------
function AINotesPage({ onRead }) {
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
    <div className="max-w-lg">
      <p className="text-cream/40 text-sm mb-4">Private notes left by the AI when it notices something worth your attention.</p>
      {loading && <div className="text-cream/40 text-sm">Loading…</div>}
      {!loading && notes.length === 0 && (
        <div className="text-cream/40 text-sm">No AI notes yet — you're all caught up.</div>
      )}
      <div className="space-y-3">
        {notes.map((n) => (
          <div key={n.id} className={`rounded-lg p-4 border ${n.isRead ? 'border-cream/10 bg-navy2' : 'border-gold/40 bg-gold/5'}`}>
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
      setAnalyzeStatus(d.skipped ? 'AI not configured (no API key).' : 'Analysis complete — check AI Notes.');
    } catch (err) {
      setAnalyzeStatus('Failed: ' + (err.message || 'unknown error'));
    }
    setTimeout(() => setAnalyzeStatus(''), 6000);
  }

  return (
    <div className="max-w-3xl mx-auto flex flex-col" style={{ height: 'calc(100vh - 120px)' }}>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <p className="text-cream/50 text-sm">Ask about team health, tasks, check-ins, or get a summary.</p>
        <div className="flex gap-2 items-center flex-wrap">
          {analyzeStatus && <span className="text-xs text-cream/60">{analyzeStatus}</span>}
          <Button variant="ghost" onClick={runAnalysis} className="text-xs">Run Analysis Now</Button>
          <Button variant="ghost" onClick={newChat} className="text-xs">New Chat</Button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-navy2 border border-cream/10 rounded-xl p-4 space-y-4 mb-4">
        {messages.length === 0 && (
          <div className="text-cream/30 text-sm text-center pt-8">
            Ask something — e.g. "Who has the most overdue tasks?" or "Summarize this week's check-ins."
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
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
          {busy ? '…' : 'Send'}
        </Button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
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
    case 'ai':        return <svg {...p}><circle cx="12" cy="12" r="9"/><path d="M9 9h.01M15 9h.01M9.5 14a3.5 3.5 0 0 0 5 0"/></svg>;
    case 'ainotes':   return <svg {...p}><path d="M18 8h1a4 4 0 0 1 0 8h-1"/><path d="M2 8h16v9a4 4 0 0 1-4 4H6a4 4 0 0 1-4-4V8Z"/><line x1="6" y1="1" x2="6" y2="4"/><line x1="10" y1="1" x2="10" y2="4"/><line x1="14" y1="1" x2="14" y2="4"/></svg>;
    default:          return <svg {...p}><circle cx="12" cy="12" r="9"/></svg>;
  }
}

function AppTile({ label, icon, badge, onClick }) {
  return (
    <button onClick={onClick}
      className="group relative bg-navy2 hover:bg-navy3 border border-cream/10 hover:border-gold/30 rounded-2xl p-5 flex flex-col items-center gap-3 transition-all duration-150 active:scale-95 w-full">
      <div className="relative">
        <div className="w-14 h-14 rounded-xl bg-navy/60 flex items-center justify-center group-hover:bg-navy2 transition-colors duration-150">
          <AppIcon name={icon} />
        </div>
        {badge > 0 && (
          <span className="absolute -top-1 -right-1 bg-red text-cream text-[10px] font-bold rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">{badge}</span>
        )}
      </div>
      <span className="text-cream/80 text-xs font-medium text-center leading-tight group-hover:text-cream transition-colors">{label}</span>
    </button>
  );
}

function AppHome({ me, reports, approvalsCount, submissionsCount, checkinEnabled, aiNotesCount, onNavigate, onLogout }) {
  const isManager = me.role === 'manager' || me.role === 'admin';
  const canEditSite = me.role === 'admin' || !!me.canEditHome;
  const canSeeSubmissions = me.role === 'admin' || !!me.grade;
  const canRoster = isManager || !!me.canManageRoster;

  const tiles = me.username === 'logistics'
    ? [{ type: 'logistics', label: 'Login Activity', icon: 'activity' }]
    : [
        { type: 'mytasks',  label: 'My Page',        icon: 'person'    },
        { type: 'home',     label: 'Club Home',       icon: 'home'      },
        ...(canEditSite       ? [{ type: 'website',     label: 'Edit Website',     icon: 'edit'      }] : []),
        ...(isManager         ? [{ type: 'announce',    label: 'Announcement',     icon: 'megaphone' }] : []),
        ...(isManager         ? [{ type: 'myteam',      label: 'My Team',          icon: 'team'      }] : []),
        ...(isManager         ? [{ type: 'approvals',   label: 'Approvals',        icon: 'check',    badge: approvalsCount   }] : []),
        ...(canSeeSubmissions ? [{ type: 'submissions', label: 'Get Involved',     icon: 'inbox',    badge: submissionsCount }] : []),
        ...(canRoster         ? [{ type: 'roster',      label: 'Roster',           icon: 'roster'    }] : []),
        ...((checkinEnabled || isManager) ? [{ type: 'checkin', label: checkinEnabled ? 'Check-In' : 'Check-In Settings', icon: 'calendar' }] : []),
        { type: 'funding',  label: 'Funding',          icon: 'funding'   },
        { type: 'apply',    label: 'Apply',             icon: 'apply'     },
        ...(isManager         ? [{ type: 'dashboard',   label: 'Dashboard',        icon: 'dashboard' }] : []),
        { type: 'org',      label: 'Org Chart',         icon: 'org'       },
        ...(me.role === 'admin' ? [{ type: 'admin',     label: 'Admin Panel',      icon: 'admin'     }] : []),
        ...(me.role === 'admin' ? [{ type: 'ai',        label: 'AI Assistant',     icon: 'ai'        }] : []),
        { type: 'ainotes',  label: 'AI Notes',          icon: 'ainotes',  badge: aiNotesCount },
      ];

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#0d1b2e' }}>
      <header className="px-6 py-5 flex items-center justify-between border-b border-cream/10">
        <Logo size="sidebar" />
        <div className="flex flex-col items-end gap-1">
          <span className="text-cream text-sm font-medium">{me.displayName}</span>
          <span className="text-cream/40 text-xs">{me.title || roleLabel(me.role)}</span>
          <div className="flex gap-3 mt-0.5">
            <button onClick={() => onNavigate({ type: 'profile' })} className="text-[11px] text-gold/60 hover:text-gold transition-colors">Profile</button>
            <button onClick={() => onNavigate({ type: 'password' })} className="text-[11px] text-gold/60 hover:text-gold transition-colors">Password</button>
            <button onClick={onLogout} className="text-[11px] text-red/60 hover:text-red transition-colors">Log out</button>
          </div>
        </div>
      </header>
      <div className="flex-1 px-4 py-8">
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
          {tiles.map(t => (
            <AppTile key={t.type} label={t.label} icon={t.icon} badge={t.badge} onClick={() => onNavigate({ type: t.type })} />
          ))}
        </div>
      </div>
    </div>
  );
}

function MyTeamView({ reports, onNavigate }) {
  return (
    <div>
      <h2 className="text-xl font-semibold text-cream mb-6">My Team</h2>
      {reports.length === 0 ? (
        <p className="text-cream/40">No direct reports.</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-w-2xl">
          {reports.map(r => (
            <button key={r.id} onClick={() => onNavigate({ type: 'person', userId: r.id })}
              className="group bg-navy2 hover:bg-navy3 border border-cream/10 hover:border-gold/30 rounded-xl p-4 flex items-center gap-3 text-left transition-all duration-150 active:scale-95">
              <div className="w-10 h-10 rounded-full bg-navy3 flex items-center justify-center text-cream/60 text-sm font-semibold shrink-0">
                {r.displayName.charAt(0).toUpperCase()}
              </div>
              <div>
                <div className="text-cream text-sm font-medium group-hover:text-gold transition-colors">{r.displayName}</div>
                <div className="text-cream/40 text-xs">{r.title || roleLabel(r.role)}</div>
              </div>
            </button>
          ))}
        </div>
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

  const isSurveyPath = window.location.pathname === '/survey';
  const bump = () => setRefreshSignal((n) => n + 1);

  const loadShared = useCallback(async (user) => {
    if (!user || user.firstLogin || user.username === 'logistics') return;
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
          if (d.user.username === 'logistics') setView({ type: 'logistics' });
        } catch (_) { localStorage.removeItem(TOKEN_KEY); }
      }
      setBooted(true);
    })();
  }, [loadShared]);

  useEffect(() => { if (me && !me.firstLogin) loadShared(me); }, [me, refreshSignal, loadShared]);

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    setMe(null);
    setView({ type: 'apphome' });
    setEnterPortal(false);
  }

  if (!booted) return <div className="min-h-screen flex items-center justify-center text-cream/40">Loading…</div>;
  if (isSurveyPath) return <InterestSurvey onBack={() => { window.history.pushState(null, '', '/'); window.location.reload(); }} />;
  if (!enterPortal) return <Home mode="public" onEnterPortal={() => setEnterPortal(true)} />;
  if (!me) return <Login onLogin={(u) => { setMe(u); loadShared(u); if (u.username === 'logistics') setView({ type: 'logistics' }); }} onBack={() => setEnterPortal(false)} />;
  if (me.firstLogin) return <ChangePassword user={me} forced onDone={(u) => { setMe(u); loadShared(u); }} />;
  if (!me.profileComplete && me.username !== 'logistics') return <ProfileSetup me={me} forced
    onDone={(u) => { setMe(u); loadShared(u); }}
    onSkip={() => setMe({ ...me, profileComplete: true })} />;

  const canEditSite = me.role === 'admin' || !!me.canEditHome;
  const navigate = (v) => setView(v);

  if (view.type === 'apphome') return (
    <AppHome me={me} reports={reports} approvalsCount={approvalsCount} submissionsCount={submissionsCount}
      checkinEnabled={checkinEnabled} aiNotesCount={aiNotesCount} onNavigate={navigate} onLogout={logout} />
  );

  const PAGE_TITLES = {
    home: 'Club Home', website: 'Edit Website', mytasks: 'My Page',
    person: (reports.find(r => r.id === view.userId) || {}).displayName || 'Team Member',
    myteam: 'My Team', announce: 'Team Announcement', approvals: 'Pending Approvals',
    submissions: 'Get Involved', roster: 'Roster', checkin: 'Weekly Check-In',
    funding: 'Funding Requests', apply: 'Apply for Position', dashboard: 'Dashboard',
    org: 'Org Chart', admin: 'Admin Panel', logistics: 'Login Activity',
    password: 'Change Password', profile: 'Edit Profile',
    ai: 'AI Assistant', ainotes: 'AI Notes',
  };

  let content;
  if (view.type === 'home') content = <Home mode="portal" me={me} />;
  else if (view.type === 'website') content = canEditSite ? <Home mode="editor" me={me} editable={true} /> : <Home mode="portal" me={me} />;
  else if (view.type === 'mytasks') content = <TaskPage me={me} userId={me.id} users={users} refreshSignal={refreshSignal} />;
  else if (view.type === 'person') content = <TaskPage me={me} userId={view.userId} users={users} refreshSignal={refreshSignal} />;
  else if (view.type === 'myteam') content = <MyTeamView reports={reports} onNavigate={navigate} />;
  else if (view.type === 'announce') content = <TeamAnnouncementView me={me} reports={reports} />;
  else if (view.type === 'approvals') content = <Approvals onChanged={bump} refreshSignal={refreshSignal} />;
  else if (view.type === 'submissions') content = <SubmissionsInbox onChanged={bump} refreshSignal={refreshSignal} />;
  else if (view.type === 'roster') content = <RosterPage me={me} />;
  else if (view.type === 'checkin') content = <WeeklyCheckinPage me={me} />;
  else if (view.type === 'funding') content = <FundingRequestPage me={me} />;
  else if (view.type === 'apply') content = <BoardApplicationsPage me={me} />;
  else if (view.type === 'dashboard') content = <AdminDashboardPage me={me} />;
  else if (view.type === 'org') content = <OrgChart />;
  else if (view.type === 'admin') content = <AdminPanel users={users} reload={bump} />;
  else if (view.type === 'logistics') content = <LogisticsPage />;
  else if (view.type === 'password') content = <ChangePassword user={me} onDone={(u) => { setMe(u); navigate({ type: 'apphome' }); }} />;
  else if (view.type === 'profile') content = <ProfileSetup me={me} onDone={(u) => { setMe(u); navigate({ type: 'apphome' }); }} />;
  else if (view.type === 'ai') content = me.role === 'admin' ? <AIChatPage me={me} /> : null;
  else if (view.type === 'ainotes') content = <AINotesPage onRead={bump} />;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#0d1b2e' }}>
      <header className="sticky top-0 z-20 flex items-center gap-3 bg-navy2/95 backdrop-blur border-b border-cream/10 px-4 py-3">
        <button onClick={() => navigate({ type: 'apphome' })} aria-label="Back to home"
          className="flex items-center justify-center w-8 h-8 rounded-lg text-cream/60 hover:text-cream hover:bg-navy3 transition-colors">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7"/>
          </svg>
        </button>
        <span className="text-cream font-semibold text-base">{PAGE_TITLES[view.type] || ''}</span>
      </header>
      <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-x-hidden">{content}</main>
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
