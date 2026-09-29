# Deploy QuestRelay

QuestRelay runs as one self-hosted Rust relay and one web server. The web server uses Caddy for HTTPS; browsers receive WebRTC media directly from the relay on port 44444

> [!IMPORTANT]
> A reachable web page does not prove the stream can play. Viewers must also reach the relay's announced address on UDP or TCP 44444. TURN is not integrated yet, so restrictive networks may fail

## Prepare a host

Use a Linux VM with a public IP and a domain you control, preferably near the people who will watch. An [OCI Always Free A1 VM](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm) is one possible starting point, subject to capacity and free-tier limits. [Install Docker Engine and the Compose plugin](https://docs.docker.com/engine/install/ubuntu/) on the VM

Point the domain's DNS record at the VM. In both your cloud network rules and the VM firewall, allow TCP 80 and 443, plus UDP and TCP 44444. Restrict SSH to your own IP. Caddy obtains its TLS certificate after the domain resolves and port 80 is reachable

## Set the server keys

On the machine you deploy from, copy the template and replace its two example domain values:

```bash
cp tools/config/.env.example .env
chmod 600 .env
```

Set **different** values for `QUESTRELAY_PUBLISH_KEY`, `QUESTRELAY_VIEW_KEY` and `QUESTRELAY_ADMIN_KEY`, each at least 32 characters long. `openssl rand -hex 32` generates a suitable value. Keep `.env` private and out of Git. The publisher key goes into the Quest app; the admin key signs in to `/admin`; the viewer key stays on the server

The template's headset and viewer limits are admission limits, not a tested capacity guarantee. Raise them only after measuring CPU, network egress and playback on real devices

## Ship a release

Commit the source you want to deploy, then package it and copy it to the VM:

```bash
archive=$(tools/scripts/distribute.sh)
tools/scripts/deploy.sh ubuntu@PUBLIC_IP "$archive" .env
curl https://your-domain.example/health
```

Use your VM's SSH user and public address instead of `ubuntu@PUBLIC_IP`. On later deployments, omit the `.env` argument to keep the server's existing keys. The script verifies the archive checksum when present, builds on the VM, waits for relay health and retains earlier release directories. It keeps the Compose project name fixed so room data and Caddy certificates stay in their named volumes

Open `https://your-domain.example/admin` and sign in with the admin key. Make the room public by link or set a private access code, then give each Quest the publisher key and `wss://your-domain.example/ws/relay`. The wearer starts sharing and approves the capture prompts

<details>
<summary>Run directly from a checkout</summary>

With a valid `.env` in the repository root, run:

```bash
docker compose -f tools/config/compose.yaml --project-directory . up -d --build --wait
```

For a non-Docker installation, build the web app with Node.js and the relay with Rust, serve `frontend/dist` using [`tools/config/Caddyfile`](../tools/config/Caddyfile), and run the relay under an unprivileged account with a writable state directory

</details>

## Before relying on it

Back up the `relay_data` volume before moving hosts or changing storage. It holds room settings and admin passkeys. The current service has one mediasoup worker and local JSON state; adding another VM behind a load balancer will not create a shared room. Multi-headset load, internet playback and end-to-end latency still need field testing. See [how the relay works](ARCHITECTURE.md#latency-and-scale) for the media path and current limits
