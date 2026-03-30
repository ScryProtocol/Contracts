# Pogchamp Deployment Wiring

Templates in this directory wire:

- `pogchamp.tv` reverse proxy
- `/hub/sepolia/*` -> local hub on `127.0.0.1:4021`
- `/handle/*` -> local hub on `127.0.0.1:4021` (native handle API)
- Nginx forwards `X-Forwarded-Prefix: /hub/sepolia` so handle offers advertise the right hub endpoint

## Files

- `nginx.pogchamp.conf`: nginx site config
- `scp-hub-sepolia.env.example`: hub env template
- `handle-api.env.example`: legacy standalone handle API template (optional fallback)

## Apply on host

```bash
# 1) Install env files (fill secrets first)
cp x402s/deploy/pogchamp/scp-hub-sepolia.env.example /etc/scp-hub.env

# 2) Install nginx site
cp x402s/deploy/pogchamp/nginx.pogchamp.conf /etc/nginx/sites-available/pogchamp
ln -sfn /etc/nginx/sites-available/pogchamp /etc/nginx/sites-enabled/000-pogchamp
nginx -t && systemctl reload nginx

# 3) Restart app processes with env
set -a; . /etc/scp-hub.env; set +a
pm2 restart scp-hub --update-env

pm2 save
```

## Smoke test

```bash
curl -sS https://pogchamp.tv/hub/sepolia/.well-known/x402 | jq '.hubName,.chainId'
curl -sS https://pogchamp.tv/handle/pr0 | jq '.accepts[0].network,.accepts[0].extensions["statechannel-hub-v1"].hubEndpoint'
```
