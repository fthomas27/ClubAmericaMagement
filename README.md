# Club America — Board Management Portal

A full-stack web app for the **Club America** high-school club board: task
management, a role-based permission hierarchy, manager approvals, an org chart,
and an admin panel — all running locally from a single repo.

| | |
|---|---|
| **Frontend** | React 18 + Tailwind CSS (served directly, no build step) |
| **Backend** | Node.js + Express |
| **Database** | SQLite (`better-sqlite3`) — file-based, auto-created & seeded |
| **Auth** | JWT sessions + bcrypt password hashing |

---

## Quick Start

```bash
npm install && npm start
```

Then open **http://localhost:3000**.

On first run the database is created and seeded with every board account below.
To change the port: `PORT=4000 npm start`.

> The SQLite file lives at `server/clubamerica.db` and is git-ignored. Delete it
> to wipe all data and re-seed from scratch on the next start.

---

## How Login Works

- **Username** = first initial + last name, all lowercase (Finley Thomas → `fthomas`).
- **Default password** = the username itself.
- On **first login** the app forces a mandatory password change before anything
  else is accessible. A `firstLogin` flag flips to `false` once it's done.
- Sessions use JWT tokens; passwords are stored as bcrypt hashes.

---

## Default Login Credentials

> **For the President to distribute.** Every account's starting password equals
> its username. Each person is required to set a new password the first time
> they log in.

### Admins — President & VP
| Name | Title | Username | Default Password |
|---|---|---|---|
| Finley Thomas | President | `fthomas` | `fthomas` |
| Derek Eddy | Vice President | `deddy` | `deddy` |

### Managers (have direct reports)
| Name | Title | Username | Default Password | Manages |
|---|---|---|---|---|
| Max Flachsmann | Chair Public Engagement | `mflachsmann` | `mflachsmann` | Ledger Moffat |
| Hudson Fossey | CFO | `hfossey` | `hfossey` | Will Haladin |
| Dane Hays | Digital Presence Manager | `dhays` | `dhays` | Jacob Kindt, Sosie Gavin |

### Members
| Name | Title | Username | Default Password |
|---|---|---|---|
| Campbell | Secretary | `campbell` | `campbell` |
| Andrew Perillo | Hospitality | `aperillo` | `aperillo` |
| Audrey Fox | Swag Manager | `afox` | `afox` |
| Ledger Moffat | Public Engagement | `lmoffat` | `lmoffat` |
| Will Haladin | Fundraising & Volunteer | `whaladin` | `whaladin` |
| Jacob Kindt | Content Editor | `jkindt` | `jkindt` |
| Sosie Gavin | Historian | `sgavin` | `sgavin` |
| Sosie | Historian | `ssosie` | `ssosie` |
| Davis Hughes | Grade Rep | `dhuges` | `dhuges` |
| Liam McNalley | Grade Rep | `lmcnalley` | `lmcnalley` |
| Thomas Summers | Grade Rep | `tsummers` | `tsummers` |
| Ben Anderson | Grade Rep | `banderson` | `banderson` |
| Nola Neath | Grade Rep | `nneath` | `nneath` |
| Ben Hastings | Grade Rep | `bhastings` | `bhastings` |

> **Placeholder notes:** `sgavin` (Sosie Gavin) and `ssosie` (Sosie) are best-guess
> accounts for the Historian role — update the last names in the Admin Panel once
> they're confirmed. `campbell` (Secretary) uses a single name pending a last name.

---

## Roles & Permissions

| Tier | Who | Can do |
|---|---|---|
| **Admin** | President, VP | See everyone's task pages; add/remove users; assign managers & roles; assign tasks to anyone **without approval**; approve any pending task |
| **Manager** | Anyone with direct reports | See their reports' task pages; approve tasks routed to their reports |
| **Member** | Standard board member | See only their own task page; send tasks to others (held for the recipient's manager to approve) |

A user automatically becomes a **Manager** the moment they're given a direct
report in the Admin Panel, and drops back to **Member** when they have none.

---

## Features

### Public Homepage (`/home`)
- The site **lands on a public homepage** at `/home` — no login required — with a
  **Board Portal Login** button for board members. It uses the same Club America
  logo as the rest of the app.
- **Upcoming events:** connect an **iCal/.ics calendar feed** (e.g. a Google
  Calendar public address) and the homepage automatically shows the **next 3
  events** (title, date/time, location). If no calendar is connected, it falls
  back to a manually-entered **next meeting** (date, time, location).
- **Podcast section** embeds a YouTube video inline (or links out to a
  channel/page).
- **Controlled by the Digital Presence Manager** (`dhays`) — they (and the
  President/VP) get an edit panel on the in-portal **Home** view to set the
  calendar feed, meeting fallback, and podcast link. Everyone else sees it
  read-only. (The private calendar URL is never exposed on the public page.)
- **Podcast on/off toggle:** the **Admin Panel** has a switch to hide the podcast
  section — when off, the homepage shows an **"Under Construction"** message in
  its place.

### Sidebar Navigation
- **Home** — the public homepage; Digital Presence Manager / admins can edit it here.
- **My Tasks** — always visible.
- **People I Manage** — managers/admins only; expands to direct reports, click a
  name to open their task page in read **+ assign** mode.
- **Pending Approvals** — managers/admins only; badge shows how many tasks await
  their sign-off.
- **Org Chart** — visible to everyone.
- **Admin Panel** — President & VP only.

### Tasks
- Each task has a name, description, due date, status
  (*Not Started / In Progress / Complete*), and shows **who assigned it**.
- Create tasks for yourself, or **send a task to another member** — which enters a
  **pending** state until that person's manager approves it.
- President & VP can assign to anyone instantly (no approval needed).
- Managers approve/reject from the **Pending Approvals** view.

### Org Chart
An interactive, themed chart of the full board hierarchy (President → VP →
chairs/managers → reports → grade reps), rendered as a React component.

### Admin Panel
Add members (username + default password auto-generated as first-initial +
last name), change roles, reassign reporting relationships, reset a member's
password back to their default, or remove members (their reports roll up to the
removed person's manager).

---

## Project Structure

```
.
├── package.json          # single install/start for the whole app
├── server/
│   ├── index.js          # Express API + static frontend host
│   ├── db.js             # SQLite schema + first-run seed data
│   └── auth.js           # JWT signing, auth middleware, guards
└── public/
    ├── index.html        # Tailwind theme + fonts + React/Babel
    └── app.js            # the entire React single-page app
```

## API Overview

| Method | Endpoint | Notes |
|---|---|---|
| `POST` | `/api/auth/login` | returns JWT + user |
| `POST` | `/api/auth/change-password` | clears `firstLogin` |
| `GET` | `/api/me` | current user |
| `GET` | `/api/users` | directory |
| `GET` | `/api/reports` | direct reports (everyone, for admins) |
| `GET` | `/api/users/:id/tasks` | a user's task page (self / manager / admin) |
| `POST` | `/api/tasks` | create for self or send to another |
| `PATCH` `DELETE` | `/api/tasks/:id` | update status / remove |
| `GET` | `/api/approvals` | pending tasks awaiting you |
| `POST` | `/api/tasks/:id/approve` · `/reject` | manager/admin sign-off |
| `GET` | `/api/orgchart` | org data |
| `POST` `PATCH` `DELETE` | `/api/admin/users…` | admin-only user management |

---

## Design

Dark navy (`#0A1628`) background, red (`#CC1C2E`) and gold (`#C9A84C`) accents,
cream (`#F5F0E8`) text. **Bebas Neue** for headers, **DM Sans** for body —
matching the Club America org-chart aesthetic.

## Security Notes (local dev)

This app is built to run locally for a school club. For any public deployment,
set a strong `JWT_SECRET` environment variable (the default is a dev placeholder)
and serve over HTTPS.
