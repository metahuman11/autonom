# Autonom

Every coin can run its own AI. A token launched through Autonom gets an AI agent ("Kurt") on a rented GPU desktop that is live-streamed to the community; holders chat with it, give it orders and vote; the project's own treasury pays for the machine, the model and the project's social presence.

Live: https://autonom.fun

## How it works

1. **Launch** — a creator launches a coin on pump.fun (Solana) or Pons (Robinhood Chain) from their own wallet. The coin's on-chain creator is the project's treasury wallet, so creator fees on every trade fund the project.
2. **Startup stages** — once the treasury holds the first usable funds the gateway rents a GPU machine from the provider pool (hourly cap), boots the desktop and the agent, and starts the live stream. Later stage: DEX listing. Every stage is paid from the treasury and shown on the project page.
3. **Community** — holders chat with Kurt from the project room. Holders above the order threshold (1 % of supply) direct it straight from chat: show a page or video on the live screen, build the project website. Money movements, secrets and mission changes always go through a community vote.
4. **Transparency** — the treasury, every charge, the machine and the model are public on the project page; the agent runs on an isolated machine and never holds keys.

## Layout

```
control-room/src      Node 20 backend: public site API, holder/agent APIs, billing, launches, machine lifecycle, X posting, AI proxy
control-room/public   the site (home, launch, project room, docs, legal)
control-room/boot     what a rented machine runs: bootstrap, the Kurt agent loop, the native desktop app, local relay
control-room/test     tests (run from a source-only staging copy with no .env or data)
control-room/deploy   install script, systemd units, nginx and MediaMTX configuration
agent/                Kurt's system prompt
branding/autonom      logo kit and site artwork
```

## Running

```
cd control-room && npm install && npm start      # http://127.0.0.1:4747
cp .env.example .env                              # provider keys stay in .env, never in the repo
```

Real machine rental, launches and payments are off until the corresponding keys and switches are set in `.env`. Nothing in this repository contains credentials, wallet keys or account sessions.
