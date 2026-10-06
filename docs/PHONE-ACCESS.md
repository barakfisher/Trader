# Opening Traders on your phone

The app runs on the Mac, and every port it opens listens on `127.0.0.1` only: no other device,
not even one on the same Wi-Fi, can connect. A phone reaches it through **Tailscale**, a private
network between your own devices. Nothing is exposed to the internet, and the phone works the same
at home and away.

What the phone opens is the **kind cluster** (`http://traders.localhost` on the Mac), not the
compose stack. The cluster serves the page and the API from one address (nginx forwards `/api/*`),
so the phone needs one https address and nothing else.

```
phone -> https://<mac>.<tailnet>.ts.net         (Tailscale: only your signed-in devices)
  -> tailscale serve on the Mac -> http://127.0.0.1:80, Host kept as <mac>.<tailnet>.ts.net
  -> kind -> Traefik -> the Ingress rule for that host -> web (nginx) -> page, or /api/* to the orchestrator
```

## One-time setup

1. **Mac:** install Tailscale from <https://tailscale.com/download> (the standalone download, not the
   App Store build: it carries the `tailscale` command; if `tailscale` is not found afterwards, use
   the app's menu, Settings, "Install CLI"). Sign in.
2. **Phone:** install Tailscale from the app store and sign in with **the same account**.
3. **Admin console** (<https://login.tailscale.com/admin/dns>): turn on **MagicDNS** and
   **HTTPS Certificates**. These give the Mac a stable name and a real certificate for it.
4. **Mac, once:** `tailscale serve --bg http://127.0.0.1:80`. Tailscale keeps this across restarts;
   `tailscale serve status` shows it, `tailscale serve reset` removes it.
5. **Deploy:** `bash scripts/k8s-up.sh`. It reads the Mac's name from `tailscale status`, adds an
   Ingress rule for it and adds `https://<name>` to `ALLOWED_ORIGINS` - in the git-ignored
   per-deploy file, because the name belongs to this machine. It prints the phone's address at the
   end.

Open that address on the phone (Tailscale connected) and sign in with the cluster's passphrase:
`grep APP_PASSPHRASE infra/k8s/overlays/kind/secrets.env`.

## Why it is built this way

- **Not the Wi-Fi address.** Opening the ports to the local network would reach the app only at
  home, break whenever the router hands the Mac a new address, and expose Postgres and Redis to
  every device on the network - which compose did, until every port was bound to `127.0.0.1`.
- **The name is never committed.** `k8s-up.sh` adds it per deploy. Set `TAILNET_HOST=<name>` to
  choose it by hand, or `TAILNET_HOST=none` to deploy without it.
- **If the app moves to a server with a public address**, a domain name takes Tailscale's place and
  this page is the only thing to retire: the Ingress host and `ALLOWED_ORIGINS` are the same two
  settings a real deployment sets.

## If the phone does not load it

- **The page does not open at all:** is Tailscale connected on the phone? Does
  `tailscale serve status` on the Mac show `http://127.0.0.1:80`? Does `http://traders.localhost`
  open on the Mac?
- **404 from Traefik:** the Ingress has no rule for the name - run `bash scripts/k8s-up.sh` again
  with Tailscale signed in, and check `kubectl --context kind-traders -n traders get ingress traders`.
- **The page opens but sign-in fails:** the Origin is not allowed - check that the deploy printed
  "phone access", or see the orchestrator's log.
