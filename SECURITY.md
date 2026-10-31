# Security Policy

**English** | [中文](SECURITY.zh-CN.md)

## Reporting a vulnerability

- **Preferred:** open a private report through GitHub **Security → Advisories →
  "Report a vulnerability"** on this repository. That keeps the details private until a fix
  ships.
- **Please do not** open a public issue with reproduction steps for something that can be
  exploited (credential theft, remote code execution, arbitrary file read, data exfiltration).
- A plain description of the impact, the version/commit you tested, and the smallest
  reproduction is enough. No proof-of-concept exploit is required.

## Supported versions

Only the `main` branch and the newest release tag are supported. This is an early
experimental project (0.x); there are no long-term support branches and no security
backports.

## Known limitations — by design, not vulnerabilities

These are documented boundaries. Reports that only confirm one of them are not actionable;
please do not file them.

1. **The compute backend has NO authentication.** Protocol v1 is a single-user,
   local-machine design (`docs/architecture/backend-protocol-v1.md`, §13: "无鉴权…跨机部署前必须
   先补 token"). Any local process — or anyone who can reach the port — has full access to the
   matrix / node API.
2. **The backend listens on 127.0.0.1 only.** It is not reachable from the network unless
   something else forwards it. Cross-machine deployment is explicitly unsupported until a
   token is added.
3. **No HTTPS.** The transport is plain HTTP on loopback.
4. **The dev server binds loopback by default.** `VITE_HOST=0.0.0.0 ./scripts/dev.sh` opts
   into LAN exposure; that proxies `/api/*` to the unauthenticated backend, so only do it on
   a network you trust.
5. **Uploaded data stays local.** Files are parsed in the browser and uploaded only to the
   local backend (the packaged desktop build serves UI + API from the same loopback origin).
   There is no telemetry and no outbound network access.
6. **Size caps are the contract, not a bug:** request header ≤ 128 KiB, request body
   ≤ 32 MiB, dense-matrix window ≤ 5000 rows per request.
7. **The Windows/desktop package** (when published) is local-only, unsigned, and has no
   auto-update. SmartScreen will warn about an unknown publisher.

Anything outside this list — for example a path traversal in the static file server once one
exists, a way to make the backend read arbitrary files, a crash that takes the whole process
down from a malformed request, or XSS in the UI — is a real finding and worth reporting.

## What to expect

This is a personal project without a security team: best effort, usually an initial reply
within a couple of weeks when the report is specific. Fixes ship on `main` and in the next
0.x tag; advisories are published for issues that affect users.

## Scope

In scope: this repository's code (frontend, backend, packaging scripts).
Out of scope: third-party dependencies (report those upstream), and the general risk of
running a local tool on a machine you do not trust.
