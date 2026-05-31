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

// Profile setup — runs right after the password step on first login, and is
// reachable later via "Edit profile". Collects a photo and an intro bio.
function ProfileSetup({ me, forced, onDone, onSkip }) {
  const [photo, setPhoto] = useState('');
  const [bio, setBio] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api('/me/profile').then((d) => { setPhoto(d.photo || ''); setBio(d.bio || ''); setEmail(d.email || ''); }).catch(() => {});
  }, []);

  function onFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (!f.type.startsWith('image/')) { setError('Please choose an image file.'); return; }
    setError('');
    resizeImage(f, 512, (dataUrl) => {
      if (dataUrl) setPhoto(dataUrl);
      else setError("Couldn't read that image — try another.");
    });
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
        <label className="cursor-pointer">
          <span className="inline-block bg-transparent border border-cream/25 hover:border-gold text-cream text-sm px-4 py-2 rounded-md">Choose photo…</span>
          <input type="file" accept="image/*" className="hidden" onChange={onFile} />
          <div className="text-xs text-cream/40 mt-1">A clear, professional headshot.</div>
        </label>
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

  if (forced) {
    return <form onSubmit={submit} className="min-h-screen flex items-center justify-center p-4">{card}</form>;
  }
  return <form onSubmit={submit} className="max-w-lg">{card}</form>;
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

function TaskPage({ me, userId, users, refreshSignal }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const isSelf = userId === me.id;

  const load = useCallback(async () => {
    try {
      const d = await api(`/users/${userId}/tasks`);
      setData(d);
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

  if (error) return <div className="text-red">{error}</div>;
  if (!data) return <div className="text-cream/50">Loading…</div>;

  const { user, tasks } = data;
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
            {isSelf ? 'My Tasks' : user.displayName}
          </h1>
          <div className="text-cream/50 mt-1">{user.title || roleLabel(user.role)} · @{user.username}</div>
        </div>
        <Badge tone="gold">{tasks.length} task{tasks.length === 1 ? '' : 's'}</Badge>
      </div>

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
  return (
    <div>
      <h1 className="font-display text-4xl sm:text-5xl text-cream mb-2">Org Chart</h1>
      <p className="text-cream/50 mb-8">Club America — 2025–26 Board</p>

      <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
      <div className="flex flex-col items-center gap-5 pb-10 min-w-max sm:min-w-0 mx-auto">
        <OrgNode title="President" name="Finley Thomas" tone="red" />
        <div className="w-px h-5 bg-cream/20" />
        <OrgNode title="Vice President" name="Derek Eddy" tone="red" />
        <div className="w-px h-5 bg-cream/20" />

        <div className="flex flex-wrap justify-center gap-6">
          <OrgNode title="Chair Public Eng." name="Max Flachsmann">
            <OrgNode title="Public Engagement" name="Ledger Moffat" tone="slate" />
          </OrgNode>

          <OrgNode title="CFO" name="Hudson Fossey">
            <OrgNode title="Fundraising & Vol." name="Will Haladin" tone="slate" />
          </OrgNode>

          <OrgNode title="Secretary" name="Campbell" tone="slate" />
          <OrgNode title="Hospitality" name="Andrew Perillo" tone="slate" />
          <OrgNode title="Swag Manager" name="Audrey Fox" tone="slate" />

          <OrgNode title="Digital Presence" name="Dane Hays">
            <OrgNode title="Content Editor" name="Jacob Kindt" tone="slate" />
            <OrgNode title="Historian" name="Sosie Gavin" tone="slate" />
          </OrgNode>
        </div>

        <div className="w-full mt-6">
          <div className="font-display text-2xl text-gold text-center mb-3">Grade Representatives</div>
          <div className="flex flex-wrap justify-center gap-3">
            {['Davis Hughes', 'Liam McNalley', 'Thomas Summers', 'Ben Anderson', 'Nola Neath', 'Ben Hastings'].map((n) => (
              <div key={n} className="bg-navy2 border border-cream/20 rounded-md px-3 py-1.5 text-sm text-cream/80">{n}</div>
            ))}
          </div>
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

  useEffect(() => {
    api('/home/settings').then((d) => setEnabled(!!d.home.podcastEnabled)).catch(() => {});
  }, []);

  async function toggle() {
    if (enabled === null || busy) return;
    setBusy(true);
    try {
      const d = await api('/home', { method: 'PUT', body: { podcastEnabled: !enabled } });
      setEnabled(!!d.home.podcastEnabled);
    } catch (_) {} finally { setBusy(false); }
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
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-cream/50 border-b border-cream/10">
              <th className="py-2 pr-3">Name</th><th className="pr-3">Username</th><th className="pr-3">Role</th>
              <th className="pr-3">Reports To</th><th className="pr-3">Grade</th><th className="pr-3">First login?</th><th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-b border-cream/5">
                <td className="py-2 pr-3">
                  <div className="text-cream">{u.displayName}</div>
                  <div className="text-cream/40 text-xs">{u.title}</div>
                </td>
                <td className="pr-3 text-cream/70">@{u.username}</td>
                <td className="pr-3">
                  <select className="bg-navy border border-cream/20 rounded px-2 py-1 text-xs"
                    value={u.role} onChange={(e) => updateUser(u, { role: e.target.value })}>
                    <option value="member">Member</option>
                    <option value="manager">Manager</option>
                    <option value="admin">Admin</option>
                  </select>
                </td>
                <td className="pr-3">
                  <select className="bg-navy border border-cream/20 rounded px-2 py-1 text-xs"
                    value={u.managerId || ''} onChange={(e) => updateUser(u, { managerId: e.target.value ? Number(e.target.value) : null })}>
                    <option value="">— none —</option>
                    {users.filter((x) => x.id !== u.id).map((x) => <option key={x.id} value={x.id}>{x.displayName}</option>)}
                  </select>
                </td>
                <td className="pr-3">
                  <select className="bg-navy border border-cream/20 rounded px-2 py-1 text-xs"
                    value={u.grade || ''} onChange={(e) => updateUser(u, { grade: e.target.value })}>
                    <option value="">—</option>
                    {GRADES.map((g) => <option key={g} value={g}>{g}</option>)}
                  </select>
                </td>
                <td className="pr-3">{u.firstLogin ? <Badge tone="red">Yes</Badge> : <Badge tone="green">No</Badge>}</td>
                <td className="text-right whitespace-nowrap">
                  <button onClick={() => resetPw(u)} className="text-xs text-gold/80 hover:text-gold mr-3">Reset PW</button>
                  <button onClick={() => removeUser(u)} className="text-xs text-red/80 hover:text-red">Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
        meetingDate: form.meetingDate, meetingTime: form.meetingTime,
        meetingLocation: form.meetingLocation, podcastUrl: form.podcastUrl,
        calendarUrl: form.calendarUrl, instagramUrl: form.instagramUrl,
        aboutText: form.aboutText,
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
            <p className="text-xs text-cream/40 mt-1">When set, the homepage shows the next 3 events from this calendar automatically. Leave blank to use the manual meeting fields below.</p>
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
      <button onClick={() => setSel(node)}
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

function Home({ mode = 'public', editable = false, onEnterPortal, onBack }) {
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
          <AboutSection home={home} />
          {cards}
          {home.instagramUrl && <InstagramLink url={home.instagramUrl} />}
        </div>
      </div>
    );
  }

  // In-portal "Home" view: read-only look at the public page.
  if (mode === 'portal') {
    return (
      <div className="max-w-5xl space-y-8">
        <div>
          <h1 className="font-display text-4xl sm:text-5xl text-cream leading-none">Home</h1>
          <p className="text-cream/50 mt-1">This is the public-facing page at <span className="text-gold/80">/home</span>.</p>
        </div>
        <AboutSection home={home} />
        {cards}
        {home.instagramUrl && <InstagramLink url={home.instagramUrl} />}
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
// Sidebar + Layout
// ---------------------------------------------------------------------------
function Sidebar({ me, reports, approvalsCount, submissionsCount, view, setView, onLogout, open, onClose }) {
  const [reportsOpen, setReportsOpen] = useState(true);
  const isManager = me.role === 'manager' || me.role === 'admin';
  const canEditSite = me.role === 'admin' || !!me.canEditHome;
  const canSeeSubmissions = me.role === 'admin' || !!me.grade;

  const NavItem = ({ active, onClick, children, badge }) => (
    <button onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors ${
        active ? 'bg-red text-cream' : 'text-cream/80 hover:bg-navy3'}`}>
      <span>{children}</span>
      {badge != null && badge > 0 && <span className="bg-gold text-navy text-xs font-semibold rounded-full px-2 py-0.5">{badge}</span>}
    </button>
  );

  return (
    <React.Fragment>
      {/* Dim overlay behind the drawer on small screens */}
      <div
        onClick={onClose}
        className={`fixed inset-0 bg-black/60 z-30 lg:hidden transition-opacity ${open ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      />
      <aside
        className={`w-72 max-w-[85vw] lg:w-64 shrink-0 bg-navy2 border-r border-cream/10 flex flex-col h-screen fixed lg:sticky top-0 left-0 z-40 transform transition-transform duration-200 ${
          open ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0`}
      >
      <div className="p-4 border-b border-cream/10 flex items-start justify-between gap-2">
        <Logo size="sidebar" />
        <button onClick={onClose} aria-label="Close menu" className="lg:hidden text-cream/60 hover:text-cream text-3xl leading-none -mt-1">×</button>
      </div>

      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
        <NavItem active={view.type === 'home'} onClick={() => setView({ type: 'home' })}>Home</NavItem>
        {canEditSite && (
          <NavItem active={view.type === 'website'} onClick={() => setView({ type: 'website' })}>Edit Website</NavItem>
        )}
        <NavItem active={view.type === 'mytasks'} onClick={() => setView({ type: 'mytasks' })}>My Tasks</NavItem>

        {isManager && (
          <div>
            <button onClick={() => setReportsOpen((o) => !o)}
              className="w-full text-left px-3 py-2 rounded-md text-cream/80 hover:bg-navy3 flex items-center justify-between">
              <span>People I Manage</span>
              <span className="text-cream/40">{reportsOpen ? '▾' : '▸'}</span>
            </button>
            {reportsOpen && (
              <div className="ml-3 border-l border-cream/10 pl-2 space-y-1">
                {reports.length === 0 && <div className="text-cream/30 text-sm px-2 py-1">No direct reports</div>}
                {reports.map((r) => (
                  <button key={r.id} onClick={() => setView({ type: 'person', userId: r.id })}
                    className={`w-full text-left px-2 py-1.5 rounded text-sm transition-colors ${
                      view.type === 'person' && view.userId === r.id ? 'bg-navy3 text-gold' : 'text-cream/70 hover:bg-navy3'}`}>
                    {r.displayName}
                    <span className="block text-[11px] text-cream/35">{r.title || roleLabel(r.role)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {isManager && (
          <NavItem active={view.type === 'approvals'} onClick={() => setView({ type: 'approvals' })} badge={approvalsCount}>
            Pending Approvals
          </NavItem>
        )}

        {canSeeSubmissions && (
          <NavItem active={view.type === 'submissions'} onClick={() => setView({ type: 'submissions' })} badge={submissionsCount}>
            Get Involved
          </NavItem>
        )}

        <NavItem active={view.type === 'org'} onClick={() => setView({ type: 'org' })}>Org Chart</NavItem>

        {me.role === 'admin' && (
          <NavItem active={view.type === 'admin'} onClick={() => setView({ type: 'admin' })}>Admin Panel</NavItem>
        )}
      </nav>

      <div className="p-3 border-t border-cream/10">
        <div className="text-sm text-cream">{me.displayName}</div>
        <div className="text-xs text-cream/40 mb-2">{me.title || roleLabel(me.role)} · {roleLabel(me.role)}</div>
        <div className="flex gap-x-3 gap-y-1 flex-wrap">
          <button onClick={() => setView({ type: 'profile' })} className="text-xs text-gold/80 hover:text-gold">Edit profile</button>
          <button onClick={() => setView({ type: 'password' })} className="text-xs text-gold/80 hover:text-gold">Change password</button>
          <button onClick={onLogout} className="text-xs text-red/80 hover:text-red ml-auto">Log out</button>
        </div>
      </div>
      </aside>
    </React.Fragment>
  );
}

function App() {
  const [me, setMe] = useState(null);
  const [booted, setBooted] = useState(false);
  const [view, setView] = useState({ type: 'mytasks' });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The site lands on the public homepage; the portal opens on demand.
  const [enterPortal, setEnterPortal] = useState(false);
  const [users, setUsers] = useState([]);
  const [reports, setReports] = useState([]);
  const [approvalsCount, setApprovalsCount] = useState(0);
  const [submissionsCount, setSubmissionsCount] = useState(0);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const bump = () => setRefreshSignal((n) => n + 1);

  const loadShared = useCallback(async (user) => {
    if (!user || user.firstLogin) return;
    try {
      const [u, r] = await Promise.all([api('/users'), api('/reports')]);
      setUsers(u.users);
      setReports(r.reports);
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
    } catch (_) {}
  }, []);

  // Boot: restore session from token.
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

  function logout() {
    localStorage.removeItem(TOKEN_KEY);
    setMe(null);
    setView({ type: 'mytasks' });
    setEnterPortal(false);
  }

  if (!booted) return <div className="min-h-screen flex items-center justify-center text-cream/40">Loading…</div>;

  // Default landing: the public homepage. The portal opens via the login button.
  if (!enterPortal) return <Home mode="public" onEnterPortal={() => setEnterPortal(true)} />;

  if (!me) return <Login onLogin={(u) => { setMe(u); loadShared(u); }} onBack={() => setEnterPortal(false)} />;
  if (me.firstLogin) return <ChangePassword user={me} forced onDone={(u) => { setMe(u); loadShared(u); }} />;
  // Right after the password step: prompt for a profile photo + intro bio.
  if (!me.profileComplete) return <ProfileSetup me={me} forced
    onDone={(u) => { setMe(u); loadShared(u); }}
    onSkip={() => setMe({ ...me, profileComplete: true })} />;

  const canEditSite = me.role === 'admin' || !!me.canEditHome;

  let content;
  if (view.type === 'home') content = <Home mode="portal" editable={false} />;
  else if (view.type === 'website') content = canEditSite
    ? <Home mode="editor" editable={true} />
    : <Home mode="portal" editable={false} />;
  else if (view.type === 'mytasks') content = <TaskPage me={me} userId={me.id} users={users} refreshSignal={refreshSignal} />;
  else if (view.type === 'person') content = <TaskPage me={me} userId={view.userId} users={users} refreshSignal={refreshSignal} />;
  else if (view.type === 'approvals') content = <Approvals onChanged={bump} refreshSignal={refreshSignal} />;
  else if (view.type === 'submissions') content = <SubmissionsInbox onChanged={bump} refreshSignal={refreshSignal} />;
  else if (view.type === 'org') content = <OrgChart />;
  else if (view.type === 'admin') content = <AdminPanel users={users} reload={bump} />;
  else if (view.type === 'password') content = <ChangePassword user={me} onDone={(u) => { setMe(u); setView({ type: 'mytasks' }); }} />;
  else if (view.type === 'profile') content = <ProfileSetup me={me} onDone={(u) => { setMe(u); setView({ type: 'mytasks' }); }} />;

  // Navigating from the sidebar also closes the mobile drawer.
  const navigate = (v) => { setView(v); setSidebarOpen(false); };

  return (
    <div className="lg:flex">
      <Sidebar me={me} reports={reports} approvalsCount={approvalsCount} submissionsCount={submissionsCount}
        view={view} setView={navigate} onLogout={logout}
        open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex-1 min-w-0">
        {/* Mobile top bar with hamburger — hidden on desktop */}
        <header className="lg:hidden sticky top-0 z-20 flex items-center gap-3 bg-navy2/95 backdrop-blur border-b border-cream/10 px-4 py-3">
          <button onClick={() => setSidebarOpen(true)} aria-label="Open menu"
            className="text-cream text-2xl leading-none w-8 h-8 flex items-center justify-center rounded hover:bg-navy3">☰</button>
          <span className="font-display text-2xl text-red leading-none">CLUB AMERICA</span>
        </header>
        <main className="p-4 sm:p-6 lg:p-8 overflow-x-hidden">{content}</main>
      </div>
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
    rootEl.setAttribute('data-mounted', '1'); // tells the index.html watchdog we started
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
