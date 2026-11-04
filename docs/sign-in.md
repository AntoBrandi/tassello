# Sign-in and roles

How Tassello's sign-in works, and what changes for those who upgrade to the version that brings
it. For using it, see the README's **Security** section.

## What it does

Everyone signs in with a username and a password, and has one of three roles. Each can do what
the roles before it can:

| Role | Can |
|---|---|
| **viewer** | Watch: cameras, maps, the robot model, logs, diagnostics, plots, the ROS graph, parameters, rosbags, the system monitor |
| **operator** | Also operate the robot: drive, send goals, press buttons, publish, call services, set parameters, record and play rosbags, start and stop services, plugins' requests; read the robot's files and networks |
| **admin** | Also the robot's system: edit panels, terminals, change files and networks, save behavior tree files, delete rosbags, manage users |

**The server decides; the page only hides.** Every REST request and every WebSocket message is
checked against the user's role on the server. The page hides or disables what a role cannot
use, so that nobody presses a button that will be refused.

## How it is built

```
 browser ── POST /api/auth/login ──────────────► auth.ts: verify (passwords.ts),
         ◄─ Set-Cookie: tassello_session_<port>    open a session
         │
         ├─ GET/PUT /api/... (cookie) ─────────► http.ts: auth.require(req, apiRole(route))
         │
         └─ WebSocket /ws (cookie) ────────────► server.ts: auth.verifyUpgrade(req)
                                                    own page? signed in? else 403/401
                                                 session.ts: requiredRole(message) per message
```

| File | What it holds |
|---|---|
| `src/shared/auth.ts` | The roles, the password rules (shared by the page and the server), and `MESSAGE_ROLES`: the role of each WebSocket message. A `Record` over every message type, so a new message does not compile until it is given a role; an unknown one needs an admin |
| `src/server/passwords.ts` | scrypt hashing (`scrypt$N$r$p$salt$hash`), constant-time checks, rehashing at a new cost on the next sign-in |
| `src/server/users.ts` | `UserStore`: `users.json`, written whole by a rename, re-read when another process (the CLI) changes it. Refuses to leave no admin who can sign in |
| `src/server/auth.ts` | Sessions, the cookie, slowing down failed sign-ins, the default administrator and its first password, the `/api/auth/*` endpoints, `verifyUpgrade` for WebSockets |
| `src/server/http.ts` | `apiRole`: the role of each REST route; security headers on every response; files never read for a page (below) |
| `src/server/session.ts` | Refuses a message below its role, answering it as its kind expects (a request's error, a stream's status) |
| `src/server/users_cli.ts` | `tassello users ...` |
| `src/client/auth.ts`, `src/client/account/` | Who is signed in, the sign-in page, the account menu, the users dialog |

**Widgets declare who they are for.** `role` hides a widget from lower roles (Teleop, Arm Teleop
and Button are for operators, Terminal for admins). `changeRole` forces a widget's `readOnly`
property for lower roles (File Manager and Networking below admin, Parameters and Rosbags below
operator). Plugins use the same fields.

**Sessions.** Signing in sets a cookie holding 32 random bytes: `HttpOnly`, `SameSite=Strict`,
`Secure` over HTTPS, named after the port, since robots on one host share cookies. The server
keeps only the SHA-256 of each token, in `sessions.json`, so a restart signs nobody out. A
session ends:

- on sign-out;
- after 12 hours unused (`--session-idle`) or 7 days in all;
- when the user's password changes (except the session that changed its own);
- when the user is disabled or removed.

When a user's role changes, or their session ends, their open pages are disconnected and load
again, as who they are now or at the sign-in.

**Passwords made for someone** must be changed before anything else: the default
administrator's first one, and those an administrator sets (a new user, a reset). Such a session
can read `/api/auth/session`, change its password and sign out; every other request gets 403
*Choose a new password first*, and its WebSocket does not open. The page shows *Choose your
password* instead of the dashboard. Passwords set on the robot (`tassello users add`, `passwd`)
are the user's own, not to be changed.

**Failed sign-ins** are free 5 times per username and 20 per address. After that, each attempt
waits twice as long as the one before, up to 15 minutes (HTTP 429 with `Retry-After`). An unknown
username takes as long as a known one and gets the same answer.

**Other sites' pages.** A browser lets any website open a WebSocket to the robot, and a
`SameSite=Strict` cookie stops the session going with it. On top of that:

- the WebSocket opens only from the dashboard's own pages (`Origin` matching `Host` or
  `X-Forwarded-Host`);
- REST changes need the `X-Dashboard-Client` header, which another site's page cannot send;
- the page cannot be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`).

**Files never read for a page.** The sign-in folder is never read for a page, whatever the
role: not by the File Manager, its downloads (folders are archived without it), or the behavior
tree readers. A symbolic link to it counts as the folder itself. An operator can read the robot's
files but not the password hashes, which could be cracked offline into an admin password.

### On disk

```
~/.local/share/tassello/auth/      0700, or --auth-dir
├── users.json                     0600: users, roles, scrypt hashes, last sign-in
├── sessions.json                  0600: SHA-256 of the session tokens, who, when, from where
└── initial-admin-password         0600: admin's first password, until it is changed
```

Back up `users.json` with the robot's configuration. Deleting `sessions.json` signs everybody
out. Deleting `users.json` makes a new `admin` at the next start.

### Adding identity providers

LDAP, Active Directory and OIDC/SAML come next. `AuthUser.provider` (`'local'` today, `'none'`
with `--no-auth`) says where an account comes from. A provider only has to produce an
`AuthUser`, with a role mapped from its groups; sessions, roles, the WebSocket checks and the page
stay as they are.

## What happens when it ships

This is a **breaking change**: anyone who upgrades must sign in from then on.

**On the first start after upgrading**, the robot has no users, so the server creates `admin`,
an administrator, with a random password, and logs where it is (e.g. `journalctl -u tassello`):

```
No users yet: created the user admin, an administrator. Its password is in
/home/robot/.local/share/tassello/auth/initial-admin-password (cat it as the server's user);
signed in, it is changed at once.
```

The page shows the sign-in. Signed in as `admin` with that password, it asks for a new one
before anything else, then deletes the file. Until then nobody can use the dashboard: there is
no default password anyone could guess, so the robot is safe, not open.

Not wanted? Create users before the first start (`tassello users add`), and no `admin` is made.
Or give `TASSELLO_ADMIN_PASSWORD` to the first start, and `admin` gets that password, with no
change asked: for fleets provisioned by script.

**For those who upgrade:**

| Who | What changes | What to do |
|---|---|---|
| A robot run as a systemd service | Signing in as `admin` needs the password from the robot | As the service's user: `cat ~/.local/share/tassello/auth/initial-admin-password`, sign in, choose a password |
| A fleet of robots | Each has its own users | `Environment=TASSELLO_ADMIN_PASSWORD=...` in the unit for the first start, or `echo "$PASSWORD" \| tassello users add ops --role admin` in the provisioning |
| Phones and tablets on the home screen, wall displays | They sign in once, then again after 12 hours unused or after 7 days | Raise `--session-idle` for displays; give them a viewer account |
| Anyone not an admin | No edit mode; some widgets say they are not for them, others are read-only | Give each person the role they need |
| Robots on a trusted network that want things as before | Nothing, with `--no-auth` | Add `--no-auth` to the command; the server warns at every start |
| Behind a reverse proxy | Works as before. The proxy's own login may now be redundant | Forward `X-Forwarded-Proto` and `X-Forwarded-Host`; note that failed sign-ins slow down by the proxy's address |
| Served over plain HTTP | Works, but passwords cross the network readable; the server warns | `--tls-cert` and `--tls-key`, or HTTPS at the proxy |
| Pages open on a robot while it upgrades | They reconnect, are refused, and go to the sign-in | Nothing |

**For plugins** (`tassello/sdk` and `tassello/server` change, as a new minor version may):

- their requests (`plugin.request`) need an operator, their streams a viewer;
- the server side gets `session.user` (`username`, `displayName`, `role`) to refuse more;
- widgets may set `role` and `changeRole`; the page side gets `currentUser()` and `may(role)`;
- a plugin's REST calls or `fetch` from its widgets need the session cookie, which the browser
  sends by itself, and the `X-Dashboard-Client` header for changes.

Plugins that only use the SDK keep working for operators and admins. A plugin whose widgets
change things for viewers will see those requests refused.

**Rolling back** to the previous version needs nothing: it ignores the `auth` folder, which stays
for the next upgrade.

### Before releasing

- [ ] `npm run typecheck`, `npm test`, `npm run build`, on Humble and Jazzy
- [ ] On a robot: `admin` with the password of `initial-admin-password`, the forced change, the
      file gone after it; signing in and out; a
      viewer, an operator and an admin each see and can do what the table says
- [ ] A role changed in *Users…* reaches that user's open page at once
- [ ] HTTPS with `--tls-cert`, and behind a proxy (nginx, Caddy): cookie `Secure`, WebSocket upgrades
- [ ] Phones: the sign-in page, password managers filling it, the account menu
- [ ] The CHANGELOG's breaking change is at the top of the release notes, with the one-line
      `tassello users add` for those who upgrade
