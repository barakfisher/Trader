# Opening Traders on your phone

**Open <https://app.tiklens.com>** - production (docs/RUNBOOK.md section 8) - and sign in with your
email and password. It works on any network, with nothing installed on the phone and with the Mac
off. The short commit hash in the header (D351) says which build it is; the Mac's compose stack
shows its own, so a difference between the two is visible at a glance.

## The local stacks are not reachable from the phone

Every port the Mac opens listens on `127.0.0.1` only: no other device, not even one on the same
Wi-Fi, can connect. That is deliberate - opening the ports to the local network would reach the app
only at home, break whenever the router hands the Mac a new address, and expose Postgres and Redis
to every device on the network, which compose did until every port was bound to `127.0.0.1`.

## Before production: Tailscale to kind (retired 2026-10-31)

From 2026-10-06 (#171) the phone opened the **kind cluster** through **Tailscale**, a private
network between your own devices:

```
phone -> https://<mac>.<tailnet>.ts.net         (Tailscale: only your signed-in devices)
  -> tailscale serve on the Mac -> http://127.0.0.1:80, Host kept as <mac>.<tailnet>.ts.net
  -> kind -> Traefik -> the Ingress rule for that host -> web (nginx) -> page, or /api/* to the orchestrator
```

Production took over its one remaining job, so on 2026-10-31 the local cluster was deleted
(`scripts/k8s-down.sh`, after a backup in `~/Backups/traders/kind/`) and `tailscale serve reset`
removed the forwarding. Measured that day, the idle cluster held about 2 GB of Docker's memory and a
quarter of a CPU core, ran code several commits old, and had no model provider and no Telegram.

`infra/k8s/` and CI's `kubernetes (kind)` job stay: CI builds its own cluster for every pull
request. To bring the phone path back:

1. `tailscale serve --bg http://127.0.0.1:80` on the Mac, signed in to Tailscale (MagicDNS and HTTPS
   Certificates on in the admin console), with the phone signed in to the same account.
2. `bash scripts/k8s-up.sh`. It reads the Mac's name from `tailscale status`, adds an Ingress rule
   for it and adds `https://<name>` to `ALLOWED_ORIGINS` in the git-ignored per-deploy file, and
   prints the phone's address. `TAILNET_HOST=<name>` chooses the name by hand; `TAILNET_HOST=none`
   deploys without it.
3. The data comes back with `bash scripts/db-restore.sh --target kind <dump>`.
