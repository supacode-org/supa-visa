# Supa Visa

Open a page on your phone, confirm with a passkey, and your current IP can reach your self-hosted services for
the next few hours. When the time is up, the IP is removed again on its own.

You register the hostnames you want to protect. Supa Visa adds a WAF rule in front of them that only lets
through the IPs on a Cloudflare IP list, and keeps that list in step with the visas you issue. The services
themselves need no changes: no login page, no SDK, no extra proxy that apps have to understand. That makes it
useful for admin panels, NAS dashboards and app API endpoints that cannot handle a login redirect. Hostnames you
do not register are left alone.

> **Status:** early development. Nothing is released yet.

## How it works

- **A visa is an IP and an expiry time.** Issuing one adds the IP to the Cloudflare list; when it expires or you
  revoke it, the IP is removed within a minute.
- **Passkeys only.** Every write — issuing, revoking, managing passkeys — needs a fresh passkey check. There are
  no passwords and no recovery page; a lost passkey is reset from the server's shell.
- **Optional renewal.** Ten, five, three and one minute before a visa expires, Supa Visa asks Cloudflare's
  analytics whether the address is still in use and extends it if so, up to a hard limit that always requires a
  new passkey check.
- **Notifications.** Every visa issued sends a push notification through [Bark](https://github.com/Finb/Bark),
  so a visa you did not issue yourself is noticed right away.
- **Small.** One Node process and one JSON file. It runs on a Raspberry Pi and uses only the free Cloudflare
  features.

## Requirements

- Services exposed only through a Cloudflare Tunnel, so the WAF rule cannot be bypassed.
- A Cloudflare account with one IP list for Supa Visa, and an API token that can edit that list, read your zones
  and edit WAF rules in the zones you protect. The free plan is enough.
- Docker.

Supa Visa is a coarse, IP-based gate. It is not a replacement for Cloudflare Access or a VPN, and everyone
sharing your public IP (carrier-grade NAT, public Wi-Fi) is let in together with you while the visa lasts.

## Quick start

```sh
mkdir supa-visa && cd supa-visa
curl -O https://raw.githubusercontent.com/supacode-org/supa-visa/main/deploy/compose.yaml
curl -o supa-visa.env https://raw.githubusercontent.com/supacode-org/supa-visa/main/.env.example
echo "TUNNEL_TOKEN=<your tunnel token>" > tunnel.env
# fill in supa-visa.env, then:
docker compose up -d
docker compose logs supa-visa   # the first-time setup code is here
```

The [deployment guide](docs/deployment.md) covers the Cloudflare settings, the first passkey, notifications and
resetting lost passkeys.

## Development

Supa Visa runs on Node 24 directly from TypeScript, with no build step.

```sh
npm install
scripts/test.sh
```

## License

[MIT](LICENSE)
