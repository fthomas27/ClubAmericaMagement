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
// Logo — drop your image at public/logo.png (or .svg) and it shows automatically.
// If the file is missing, it falls back to the styled CLUB AMERICA wordmark.
// ---------------------------------------------------------------------------
const LOGO_SRC = '/logo.png';

function Logo({ size = 'sidebar' }) {
  const [failed, setFailed] = useState(false);
  const big = size === 'login';

  if (failed) {
    return (
      <div className={big ? 'text-center' : ''}>
        <div className={`font-display text-red leading-none ${big ? 'text-6xl' : 'text-3xl'}`}>CLUB AMERICA</div>
        <div className={`font-display text-gold ${big ? 'text-2xl tracking-[0.3em] mt-1' : 'text-sm tracking-[0.25em]'}`}>BOARD PORTAL</div>
      </div>
    );
  }
  return (
    <img
      src={LOGO_SRC}
      alt="Club America"
      onError={() => setFailed(true)}
      className={`object-contain ${big ? 'mx-auto max-h-40 w-auto' : 'max-h-16 w-auto'}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Login + forced password change
// ---------------------------------------------------------------------------
function Login({ onLogin }) {
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
          <h1 className="font-display text-5xl text-cream leading-none">
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
      <h1 className="font-display text-5xl text-cream mb-6">Pending Approvals</h1>
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

// ---------------------------------------------------------------------------
// Org Chart
// ---------------------------------------------------------------------------
function OrgNode({ title, name, tone = 'gold', children }) {
  const ring = tone === 'red' ? 'border-red' : tone === 'gold' ? 'border-gold' : 'border-cream/30';
  return (
    <div className="flex flex-col items-center">
      <div className={`bg-navy2 border-2 ${ring} rounded-lg px-4 py-2 text-center min-w-[160px] shadow-lg`}>
        <div className="font-display text-lg text-gold leading-tight">{title}</div>
        {name && <div className="text-sm text-cream/80">{name}</div>}
      </div>
      {children && <div className="w-px h-5 bg-cream/20" />}
      {children && <div className="flex flex-wrap justify-center gap-4">{children}</div>}
    </div>
  );
}

function OrgChart() {
  return (
    <div>
      <h1 className="font-display text-5xl text-cream mb-2">Org Chart</h1>
      <p className="text-cream/50 mb-8">Club America — 2025–26 Board</p>

      <div className="flex flex-col items-center gap-5 pb-10">
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
  );
}

// ---------------------------------------------------------------------------
// Admin Panel
// ---------------------------------------------------------------------------
function AdminPanel({ users, reload }) {
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [title, setTitle] = useState('');
  const [role, setRole] = useState('member');
  const [managerId, setManagerId] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  async function addUser(e) {
    e.preventDefault();
    setError(''); setNotice('');
    try {
      const d = await api('/admin/users', { method: 'POST', body: {
        firstName: first, lastName: last, title, role, managerId: managerId ? Number(managerId) : null,
      }});
      setNotice(`Added ${d.user.displayName} — username "${d.user.username}", default password "${d.defaultPassword}".`);
      setFirst(''); setLast(''); setTitle(''); setRole('member'); setManagerId('');
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
      <h1 className="font-display text-5xl text-cream mb-6">Admin Panel</h1>

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
              <th className="pr-3">Reports To</th><th className="pr-3">First login?</th><th></th>
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
// Sidebar + Layout
// ---------------------------------------------------------------------------
function Sidebar({ me, reports, approvalsCount, view, setView, onLogout }) {
  const [reportsOpen, setReportsOpen] = useState(true);
  const isManager = me.role === 'manager' || me.role === 'admin';

  const NavItem = ({ active, onClick, children, badge }) => (
    <button onClick={onClick}
      className={`w-full text-left px-3 py-2 rounded-md flex items-center justify-between transition-colors ${
        active ? 'bg-red text-cream' : 'text-cream/80 hover:bg-navy3'}`}>
      <span>{children}</span>
      {badge != null && badge > 0 && <span className="bg-gold text-navy text-xs font-semibold rounded-full px-2 py-0.5">{badge}</span>}
    </button>
  );

  return (
    <aside className="w-64 shrink-0 bg-navy2 border-r border-cream/10 flex flex-col h-screen sticky top-0">
      <div className="p-4 border-b border-cream/10">
        <Logo size="sidebar" />
      </div>

      <nav className="flex-1 overflow-y-auto p-3 space-y-1">
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

        <NavItem active={view.type === 'org'} onClick={() => setView({ type: 'org' })}>Org Chart</NavItem>

        {me.role === 'admin' && (
          <NavItem active={view.type === 'admin'} onClick={() => setView({ type: 'admin' })}>Admin Panel</NavItem>
        )}
      </nav>

      <div className="p-3 border-t border-cream/10">
        <div className="text-sm text-cream">{me.displayName}</div>
        <div className="text-xs text-cream/40 mb-2">{me.title || roleLabel(me.role)} · {roleLabel(me.role)}</div>
        <div className="flex gap-2">
          <button onClick={() => setView({ type: 'password' })} className="text-xs text-gold/80 hover:text-gold">Change password</button>
          <button onClick={onLogout} className="text-xs text-red/80 hover:text-red ml-auto">Log out</button>
        </div>
      </div>
    </aside>
  );
}

function App() {
  const [me, setMe] = useState(null);
  const [booted, setBooted] = useState(false);
  const [view, setView] = useState({ type: 'mytasks' });
  const [users, setUsers] = useState([]);
  const [reports, setReports] = useState([]);
  const [approvalsCount, setApprovalsCount] = useState(0);
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
  }

  if (!booted) return <div className="min-h-screen flex items-center justify-center text-cream/40">Loading…</div>;
  if (!me) return <Login onLogin={(u) => { setMe(u); loadShared(u); }} />;
  if (me.firstLogin) return <ChangePassword user={me} forced onDone={(u) => { setMe(u); loadShared(u); }} />;

  let content;
  if (view.type === 'mytasks') content = <TaskPage me={me} userId={me.id} users={users} refreshSignal={refreshSignal} />;
  else if (view.type === 'person') content = <TaskPage me={me} userId={view.userId} users={users} refreshSignal={refreshSignal} />;
  else if (view.type === 'approvals') content = <Approvals onChanged={bump} refreshSignal={refreshSignal} />;
  else if (view.type === 'org') content = <OrgChart />;
  else if (view.type === 'admin') content = <AdminPanel users={users} reload={bump} />;
  else if (view.type === 'password') content = <ChangePassword user={me} onDone={(u) => { setMe(u); setView({ type: 'mytasks' }); }} />;

  return (
    <div className="flex">
      <Sidebar me={me} reports={reports} approvalsCount={approvalsCount}
        view={view} setView={setView} onLogout={logout} />
      <main className="flex-1 p-8 overflow-x-hidden">{content}</main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
