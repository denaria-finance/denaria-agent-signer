# Denaria Agent Signer

Denaria's official signing module for your own AI agent (Claude Code, Codex, any MCP client
that runs local servers). It lets the agent trade GMX perpetuals on your
[Denaria](https://denaria.finance) account **within limits you approve with your Passkey**,
and nothing else.

- It runs where your agent runs, as a local MCP server, and keeps the agent's key in your
  system's keyring. Denaria's servers only ever see the public key.
- You choose the limits on your phone: markets, largest order, leverage, how often, for how
  long. They are enforced on chain by your smart account, not by this program.
- It can never withdraw, send funds or touch your account's security. You can revoke it at
  any time in the Denaria app: **Settings → Access & security → Agents**.

This repository also holds the **`denaria-trading` skill** for agents (`skills/`).

## Install

Copy the command from the Denaria app, **Settings → Access & security → Agents → Connect an
agent**: it pins the version. For this release, 0.1.2:

```bash
# Claude Code
claude mcp add --scope user denaria-agent-signer -- npx -y @denaria/agent-signer@0.1.2 --env mainnet

# Codex
codex mcp add denaria-agent-signer -- npx -y @denaria/agent-signer@0.1.2 --env mainnet
```

Any other MCP client: a stdio server with command `npx` and arguments
`["-y", "@denaria/agent-signer@0.1.2", "--env", "mainnet"]`.

`--env mainnet` trades real funds on Arbitrum One; `--env testnet` is Denaria's test network
on Arbitrum Sepolia (test funds, by invitation). The Signer refuses to start without one: real
or test funds are always your choice.

Two agents of the same client on one computer (two Codex, say): give each its own name with
`--name "<Agent name>"` at the end of its command, so each has its own key and Grant.

Requires Node.js 22 or later. The package is one file with no dependencies and no install
scripts: `npx` downloads it and runs it, nothing else.

Problems installing, or a Signer that does not answer: follow the guide in the Denaria app,
Settings → Access & security → Connect an agent, on your client's tab
([https://denaria.app/portfolio?settings=connect-agent](https://denaria.app/portfolio?settings=connect-agent)
opens it once you are logged in).

## Connect

Ask your agent to connect to Denaria. The first time, it asks you the agent's name (it proposes
its own, "Claude Code" or "Codex"), or which key already on this computer to reuse: every
agent has its own key, Grant and limits. Then it shows a link, a QR code and a short
fingerprint. Open the link on your phone, check that the fingerprint is the same,
choose the limits and confirm with your Passkey. Ask the agent to connect again: it restates
what it can do ("Connected. I can trade BTC and ETH, up to $50 per order, max 3x, until
11 Nov.").

A day before the Grant expires Denaria sends you a push: one tap renews it, with the same or
new limits, and the agent keeps the same key. You rename an agent in the app; the Signer
follows.

## Where the key lives

| Option | Where |
|---|---|
| `--store keychain` (default) | The system's keyring: the macOS Keychain; on Linux the Secret Service (GNOME Keyring, KWallet…) through `secret-tool` (Debian and Ubuntu: `apt install libsecret-tools`); on Windows a file protected by DPAPI for your Windows user. |
| `--store file` | For servers, containers and cloud sandboxes with no keyring: one file per key in `~/.denaria-agent-signer/`, AES-256-GCM under a key derived with scrypt from `DENARIA_SIGNER_PASSPHRASE` (12+ characters, required). Keep the passphrase: it is the only way to open the key. |

With the file store, put the passphrase in the server entry, for example
`claude mcp add --scope user -e DENARIA_SIGNER_PASSPHRASE=… denaria-agent-signer -- npx -y @denaria/agent-signer@0.1.2 --env mainnet --store file`.

The key never appears in a tool answer, an error, a log or a process argument, and never
leaves this computer: a new computer is a new key and a new Grant. The Signer keeps a small
index without secrets in `~/.denaria-agent-signer/agents/` (which agent uses which key).

## Tools

| Tool | What it does |
|---|---|
| `connect` | Asks the agent's name on first use (or which key on this computer to reuse), creates its key and connects it to your account (link, QR, fingerprint), or restates the Grant once it is live. |
| `denaria_get_grant`, `denaria_get_positions`, `denaria_get_open_orders`, `denaria_get_balances` | Read the Grant, the positions with their take profit and stop loss, the open orders, the USDC. |
| `denaria_create_position`, `denaria_close_position` | Open or add to a position with USDC collateral; close a position. |
| `denaria_adjust_margin`, `denaria_set_tpsl`, `denaria_cancel_order`, `denaria_claim_funding` | Add or remove collateral; set or move the take profit and stop loss; cancel an order; claim the funding fees in USDC. |
| `denaria_get_operation_status` | Where an operation stands, by its `dop_…` reference. |

On the test network the tools are named `denaria_testnet_…`, and every answer states the
network and when the Grant expires. Denaria prepares each operation within your Grant, the
Signer signs it, Denaria submits it; the limits are checked again on chain.

## The skill

Agents that support skills can install `denaria-trading`, which tells them how to trade on
Denaria with or without the Signer, and to be prudent (start small, explain your limits, ask
before touching positions they did not open, report every operation):

```bash
npx skills@latest add denaria-finance/denaria-agent-signer
```

## Verify a release

Every release is built and published by this repository's GitHub Actions, with npm provenance
and a GitHub attestation, and must be byte-for-byte the file Denaria built. How to check it
yourself: [SECURITY.md](SECURITY.md).

## Licence

MIT. The source here is exported from Denaria's monorepo at every release (see
`RELEASE.json`): changes go there, not in pull requests here.
