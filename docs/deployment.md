# Deploying Supa Visa

This guide runs Supa Visa with Docker next to `cloudflared`, on any machine that already serves your services
through a Cloudflare Tunnel. A Raspberry Pi is enough.

## Before you start

- **Every protected service is reachable only through the tunnel.** If a service also listens on a public port,
  anyone can skip Cloudflare and Supa Visa cannot protect it.
- **A hostname for Supa Visa itself**, for example `visa.example.com`. Do not register it as a protected service;
  you need to reach it before you have a visa.
- **One IP list that only Supa Visa uses.** The free plan allows one custom list per account. Supa Visa removes
  any item it did not add, so do not reuse a list you already maintain.

## 1. Cloudflare

1. **IP list.** In the dashboard, under *Manage Account → Configurations → Lists*, create a list of type IP, for
   example `supa_visa`. Note its ID from the URL. The name may contain only lowercase letters, digits and `_`.
2. **API token.** Under *My Profile → API Tokens*, create a custom token with:

   | Permission | Why |
   | --- | --- |
   | Account → Account Filter Lists → Edit | Add and remove IPs on the list |
   | Zone → Zone → Read | Find the zone a hostname belongs to |
   | Zone → Zone WAF → Edit | Create and update the block rule |
   | Zone → Analytics → Read | Only with `AUTO_RENEW=true`: see whether a visa is still in use |

   Limit *Account Resources* to your account and *Zone Resources* to the zones you will protect. The token lives
   on your server; a narrow token limits what a leak can do.
3. **Tunnel.** In *Zero Trust → Networks → Tunnels*, create a tunnel (or use your existing one) and copy its
   token. Add a public hostname for Supa Visa that points to `http://supa-visa:8787`.

You do not create any WAF rule by hand. When you register a service, Supa Visa adds one rule per zone, first in
the zone's custom rules:

```
(http.host in {"nas.example.com" "git.example.com"} and not ip.src in $supa_visa) → Block
```

Supa Visa owns this rule and the list: hand edits are put back within an hour.

## 2. Settings

Create a directory with [`deploy/compose.yaml`](../deploy/compose.yaml) and two files next to it. Each container
only sees its own file, so the tunnel never sees the API token and Supa Visa never sees the tunnel token.

`tunnel.env`:

```sh
TUNNEL_TOKEN=...
```

`supa-visa.env`:

```sh
CF_API_TOKEN=...
CF_ACCOUNT_ID=...
CF_LIST_ID=...
RP_ID=visa.example.com
ORIGIN=https://visa.example.com

# Optional
TZ=Asia/Taipei
DURATIONS=1h,4h,12h
MAX_LIFETIME=24h
BARK_DEVICE_KEYS=...
```

[`.env.example`](../.env.example) lists every setting with its default. Supa Visa checks all of them at startup
and refuses to start if any is invalid, listing every problem in its log.

Keep both files readable only by you (`chmod 600 tunnel.env supa-visa.env`).

## 3. Start

```sh
docker compose up -d
docker compose logs supa-visa
```

The log is one JSON object per line. On the first start, look for `setup.code`:

```json
{"level":"warn","event":"setup.code","code":"4F7K-92QX","expiresAt":"..."}
```

## 4. First passkey

Open `https://visa.example.com` on your phone, enter the setup code, and create a passkey with Face ID or a
fingerprint. The code is valid for 10 minutes and works once; if it has expired, the page asks for a new one and
the log shows it.

Then add a second passkey on another device as a backup (*Manage → Add a passkey*). There is no recovery page: a
lost passkey can only be reset from the server.

## 5. Protect services

In *Manage → Protected services*, add the hostnames to protect. From then on, Cloudflare blocks every IP without a
visa on those hostnames. Hostnames you do not add are not affected.

To let yourself in, press *Issue* on the device you want to use. Each issue, revoke and expiry reaches Cloudflare
within seconds.

## Notifications

With `BARK_DEVICE_KEYS` set, Supa Visa sends a [Bark](https://github.com/Finb/Bark) push for every visa issued, renewed,
revoked or expired, for registered and removed services and passkeys, and when syncing with Cloudflare has failed
for 10 minutes. A visa you did not issue yourself means a passkey may be stolen: revoke it and reset the passkeys.

Notification text (IPs and hostnames) passes through the Bark server and Apple's push service. Set `BARK_SERVER`
to use your own bark-server instead.

## Renewal

With `AUTO_RENEW=true`, Supa Visa checks each visa 10, 5, 3 and 1 minutes before it expires. If Cloudflare saw
requests from that address to a registered service in the last `ACTIVE_WINDOW` (15 minutes by default), the visa
is extended to `RENEW_BY` from now (2 hours by default), never past `MAX_LIFETIME` from when it was issued.
Cloudflare's analytics lag by about five minutes, so keep `ACTIVE_WINDOW` well above that. Paths in
`RENEW_IGNORE_PATHS`, such as a health check, do not count as use.

Every renewal sends a notification. A visa that is not renewed is reported once, a minute before it expires; one
that reached its hard limit is reported at the first check. Without the Analytics permission, Supa Visa logs
`renew.unavailable` at startup and leaves renewal off; restart it after adding the permission.

## Resetting passkeys

If a passkey is lost or may be stolen, run on the server:

```sh
docker compose exec supa-visa supa-visa reset-passkeys --revoke-all
```

This removes every passkey, revokes every visa (omit `--revoke-all` to keep them) and returns to setup mode with a
new code in the log. Anyone who can run this already controls the server.

## Blocked addresses

More than three failed sign-ins within a day (a wrong setup code, or a passkey response that does not verify)
from one network block that network for seven days: every POST from it is refused and the page says until when.
A network is an IPv4 /24 or an IPv6 /48, so moving to another address nearby does not help. A lost or expired
challenge does not count, so others cannot get you blocked by interfering with your sign-in, but anyone on the
same /24 or /48 can, including everyone behind the same carrier NAT. Each block sends a notification.

To lift a block early, run on the server:

```sh
docker compose exec supa-visa supa-visa unblock 203.0.113.7
docker compose exec supa-visa supa-visa unblock --all
```

## Backups and upgrades

- Everything Supa Visa knows is in the `supa-visa-data` volume: visas, registered services, passkey public keys,
  blocked addresses and the audit log.
  No private keys are stored. Back it up like any other file.
- To upgrade, change the image version in `compose.yaml` and run `docker compose up -d`. On start, Supa Visa removes
  visas that expired while it was down and brings Cloudflare back in line.

## Keep in mind

- **Shared IPs.** Everyone behind the same public IP (carrier-grade NAT, hotel or café Wi-Fi) gets in with you while
  the visa lasts. Pick short durations on shared networks. With `AUTO_RENEW=true`, their traffic also counts as use
  and renews the visa, up to `MAX_LIFETIME`; revoke it when you leave.
- **What a visa covers.** The page lets in the address the request came from and, unless you untick it, your
  address of the other family (IPv4 or IPv6). The page looks that up with public services, in order until one
  answers: ipify, ip.sb, icanhazip, Cloudflare and ident.me. Whichever answers sees your address and Supa Visa's
  hostname, and could report a wrong address: check the addresses before you confirm with your passkey. IPv6 is let in as a /64 by default. Mobile
  networks often share one IPv4 address among many users, so untick it there if you only need IPv6.
- **Issue on the device you will use.** Your phone on mobile data and your laptop on Wi-Fi are different IPs.
- **Never publish port 8787.** Supa Visa takes the visitor's IP from the `CF-Connecting-IP` header, which only
  Cloudflare can be trusted to set. Reached directly, anyone could claim any IP in it.
- **If Supa Visa is down,** visas stop expiring until it is back. `restart: unless-stopped` and the health check
  cover crashes; an external monitor on `https://visa.example.com/healthz` covers the rest.
- **Not for SSH or databases.** Supa Visa protects HTTP services behind Cloudflare. Use Cloudflare Access or a VPN for
  the rest.
