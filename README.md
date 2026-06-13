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

## Deploying & Keeping Your Data (important)

The app stores **everything** — accounts, password changes, tasks, and homepage
settings — in a single SQLite file. By default that's `server/clubamerica.db`.

Most hosting services use an **ephemeral disk**: the files are wiped on every
restart or redeploy. If the database file is wiped, the app re-seeds and
**every account is forced to reset its password again** (and tasks reset too).
To avoid that, put the database on a **persistent volume** and point the app at
it with the `DB_PATH` environment variable:

```
DB_PATH=/var/data/clubamerica.db
```

Host-specific setup:

- **Render:** add a **Disk** (Settings → Disks), mount path e.g. `/var/data`,
  then set the env var `DB_PATH=/var/data/clubamerica.db`.
- **Railway:** just add a **Volume** to the service (any mount path) — the app
  detects Railway's volume automatically and stores the database there. No env
  var needed. (You can still set `DB_PATH` to override.)
- **Fly.io:** `fly volumes create data`, mount at `/data` in `fly.toml`, set
  `DB_PATH=/data/clubamerica.db`.
- **Heroku / Vercel / Netlify:** these have **no persistent disk** for SQLite —
  use a host that supports a volume (above), or switch to a hosted database.

The app auto-creates the `DB_PATH` directory on startup, so you only need the
volume mounted and the env var set.

### Install command on hosts

Use the modern install flag for production builds:

```
npm install --omit=dev
```

Older guides (and some hosts) use `npm install --production` or set
`NODE_ENV=production`, which makes npm print:

```
npm warn config production Use `--omit=dev` instead.
```

That message is a harmless deprecation warning — it does **not** crash the app.
This repo ships an `.npmrc` with `omit=dev`, so a plain `npm install` already
does the right thing without the warning.

---

## Environment Variables

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | **Set this in production.** A strong random string that signs login sessions. Without it the app warns and uses an insecure default (sessions could be forged). |
| `DB_PATH` | Where the SQLite file lives (see above). Auto-detected on Railway via its volume. |
| `RESEND_API_KEY` | Enables **email notifications** via [Resend](https://resend.com). Without it, emails are skipped — but **in-app notifications still work** (the app shows them in the bell menu). |
| `MAIL_FROM` | The sender address for emails, e.g. `Club America <noreply@yourdomain.org>`. Defaults to Resend's test sender. |
| `APP_URL` | Public URL of the app (used for the "Open Club America" button in emails). |
| `PORT` | Port to listen on (Railway sets this automatically). |
| `IG_ACCESS_TOKEN` | Optional. A long-lived Instagram Graph API token for the tagged-post **auto-import**. Can also be set in-app (Instagram Feed tab); the env var takes precedence when present. |
| `IG_USER_ID` | Optional. The Instagram **Business account id** to import tagged posts for. Can be discovered/set in-app, or pinned here. |
| `IG_API_VERSION` | Optional. Graph API version (default `v21.0`). |

### Notifications
Every board member has an **in-app notification bell** (top-right) that works
whether or not email is configured. Notifications are created when:
- a task is **assigned** to you (or your assignment is approved/rejected),
- a task needs **your approval**,
- a **funding request** is submitted (CFO + admins) or reviewed (the submitter),
- a **board application** is submitted (admins) or reviewed (the applicant),
- a **Get Involved** form is submitted (that grade's reps + President/VP).

When `RESEND_API_KEY` is set, those same events are **also** emailed. Board
members add their notification email on the profile setup screen (right after
first login) or under **Edit profile**; admins can also set it in the Admin
Panel.

### Weekly check-ins
Check-ins are due every **Friday**. Each member submits one update per week, and
the Dashboard shows who still owes the current week's check-in. Managers/admins
can review all check-ins and export them to CSV.

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
- **Event Photos:** anyone can share photos they took at an event right from the
  homepage. Submissions are held for review and only appear in the public gallery
  once a board member approves them (no unvetted images ever go live). Board
  members with the **Photo Approvals** tab — admins, the Digital Presence
  Manager, and the Social Media manager — approve or remove photos.
- **From Our Instagram:** a continuously rotating, looping marquee of Instagram
  posts (pauses on hover). Posts come from two sources, both curated:
  - **Manual:** paste any public post/reel link in **Edit Website**.
  - **Auto-import (tagged posts):** when the club's Instagram is a **Business or
    Creator** account connected to a Facebook Page, the app pulls the posts the
    account is **@-tagged** in via the Instagram Graph API into a **pending
    queue**. The board approves which tagged posts go live from the **Instagram
    Feed** tab; approved ones join the marquee. Connect the account once (an
    admin pastes a long-lived token and picks the IG account in that tab), and
    new tags import automatically every ~30 minutes. Access tokens expire about
    every 60 days — re-paste a fresh one when prompted. See the env vars below
    to configure credentials via the environment instead of in-app.
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
