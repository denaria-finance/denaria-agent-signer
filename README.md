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
agent**: it pins the version. For this release, 0.2.0:

```bash
# Claude Code
claude mcp add --scope user denaria-agent-signer -- npx -y @denaria/agent-signer@0.2.0 --env mainnet

# Codex
codex mcp add denaria-agent-signer -- npx -y @denaria/agent-signer@0.2.0 --env mainnet
```

Any other MCP client: a stdio server with command `npx` and arguments
`["-y", "@denaria/agent-signer@0.2.0", "--env", "mainnet"]`.

`--env mainnet` trades real funds on Arbitrum One; `--env testnet` is Denaria's test network
on Arbitrum Sepolia (test funds, by invitation). The Signer refuses to start without one: real
or test funds are always your choice.

One install serves every agent of your client on this computer: several strategies need no
second install ([below](#several-strategies)).

Requires Node.js 22 or later. The package is one file with no dependencies and no install
scripts: `npx` downloads it and runs it, nothing else.

Problems installing, or a Signer that does not answer: follow the guide in the Denaria app,
Settings → Access & security → Connect an agent, on your client's tab
([https://denaria.app/portfolio?settings=connect-agent](https://denaria.app/portfolio?settings=connect-agent)
opens it once you are logged in).

## Connect

Ask your agent to connect to Denaria. The first time, it asks you the agent's name (it proposes
its own, "Claude Code" or "Codex"), or which key already on this computer to reuse: every
agent has its own key, Grant and limits. Reusing a key asks you to approve that agent in the app with
your Passkey; until then it reads and trades nothing. Then it shows a link, a QR code and a short
connection code, new with every link (the QR is an image made on your computer, and also text; if
you cannot see it, ask the agent to open it in a window). Open the link on your phone, check that
the connection code is the same,
choose the limits and confirm with your Passkey. Ask the agent to connect again: it restates
what it can do ("Connected. I can trade BTC and ETH, up to $50 per operation, max 3x, until
11 Nov.").

A day before the Grant expires Denaria sends you a push: one tap renews it, with the same or
new limits, and the agent keeps the same key. You rename an agent in the app; the Signer
follows.

## Several strategies

Testing several trading strategies? Ask your agent: each one gets its own agent and its own
account, so its capital, limits, positions and results stay apart and you can see which one
makes money.

1. Tell your agent about the new strategy in your own words ("make a folder in my finance
   area, we start trading with part of my gamble money"). It proposes a dedicated agent ("I'll
   give it its own agent and account. Shall I call it Gamble?") and connects it with that
   name: a new key next to your other agents, with no change to your MCP configuration.
2. Open the link on your phone and choose **New account**, titled after the agent (it may be
   already selected), and if you want an initial capital. Choose the limits and confirm with
   your Passkey. Each agent has its own Grant: a risky strategy can get smaller limits than a
   careful one.
3. The agent writes the agent's name and key id in the strategy's notes. Later, in any
   session, "let's pick up the gamble strategy" is enough: the agent names that agent on every
   call, and every answer says which agent and which account it is about.

With two or more agents, a call that names no agent, or an unknown or ambiguous one, is refused
with the list of your agents, reads included, so nothing ever acts on a guessed strategy.
`denaria_list_agents` lists them (name, key id, account, Grant state and expiry).

Another client on the same computer (Claude Code and Codex threads on the same project, say)
can use an existing strategy: it reuses that agent's key, whose key id is in the notes, and you
approve it in the app with your Passkey. Both then trade the same strategy, with one key, one
Grant and one account.

With one agent nothing changes: there is no agent to name.

## Strict isolation with --name

On the normal path one session can reach every agent of its client, each bounded by its own
Grant. For unattended loops or large Grants you may want a session that can reach one strategy
and no other. Start a Signer with `--name "<Agent name>"`: it acts for that one agent only, and
refuses a tool call for any other agent, a `connect` with another name and any reuse of a key.
Run one per strategy, under its own MCP server name, and start that strategy's sessions with
only that server.

A Signer started with `--name` is an agent of its own, with its own key: it does not take over
an agent made on the normal path, even one with the same name. Connect it once, as a new agent
(choose **New account** on the phone). The same `--name` on this computer is the same agent in
every client, and a rename in the app does not change it.

**Claude Code.** One MCP config file per strategy, for example `~/.denaria/gamble.mcp.json`:

```json
{
  "mcpServers": {
    "denaria-gamble": {
      "command": "npx",
      "args": ["-y", "@denaria/agent-signer@0.2.0", "--env", "mainnet", "--name", "Gamble"]
    }
  }
}
```

Start the strategy's sessions with it alone:

```bash
claude --strict-mcp-config --mcp-config ~/.denaria/gamble.mcp.json
```

`--strict-mcp-config` makes Claude Code ignore every other MCP configuration, the
`denaria-agent-signer` of your user scope included: add to the file any other server the
session needs.

**Codex.** An entry per strategy in `~/.codex/config.toml`, off by default so that no other
session starts it:

```toml
[mcp_servers.denaria-gamble]
command = "npx"
args = ["-y", "@denaria/agent-signer@0.2.0", "--env", "mainnet", "--name", "Gamble"]
enabled = false
```

and a profile, `~/.codex/gamble.config.toml`, that turns it on and the shared Signer off:

```toml
[mcp_servers.denaria-agent-signer]
enabled = false

[mcp_servers.denaria-gamble]
enabled = true
```

Start the strategy's sessions with `codex -p gamble` (or `codex exec -p gamble "…"` for an
unattended run). Without a profile, the same with overrides:
`codex -c mcp_servers.denaria-gamble.enabled=true -c mcp_servers.denaria-agent-signer.enabled=false`.
(Checked on Codex CLI 0.171.0, where `-p <name>` layers `~/.codex/<name>.config.toml` on top of
`config.toml`.)

**Why not an environment variable.** Codex starts MCP servers with a filtered environment:
only `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TMPDIR` and `USER` reach them (verified on Codex CLI
0.171.0). A variable set in the shell that starts the session would never reach the Signer, and
a forgotten one would mean trading as another agent. So the choice lives in the server entry,
as `--name`.

**What it protects against.** Strict isolation protects against mistakes: a confused or misled
session cannot act for another strategy through its Signer. It is not a wall against an agent
that has a shell as your OS user: every Signer of that user shares the same keyring (or key
folder), and such an agent can start a Signer of its own. The only security boundary is each
agent's Grant, enforced on chain by your smart account: give each strategy only the limits you
accept.

## Where the key lives

| Option | Where |
|---|---|
| `--store keychain` (default) | The system's keyring: the macOS Keychain; on Linux the Secret Service (GNOME Keyring, KWallet…) through `secret-tool` (Debian and Ubuntu: `apt install libsecret-tools`); on Windows a file protected by DPAPI for your Windows user. |
| `--store file` | For servers, containers and cloud sandboxes with no keyring: one file per key in `~/.denaria-agent-signer/`, AES-256-GCM under a key derived with scrypt from `DENARIA_SIGNER_PASSPHRASE` (12+ characters, required). Keep the passphrase: it is the only way to open the key. |

With the file store, put the passphrase in the server entry, for example
`claude mcp add --scope user -e DENARIA_SIGNER_PASSPHRASE=… denaria-agent-signer -- npx -y @denaria/agent-signer@0.2.0 --env mainnet --store file`.

The key never appears in a tool answer, an error, a log or a process argument, and never
leaves this computer: a new computer is a new key and a new Grant. The Signer keeps a small
index without secrets in `~/.denaria-agent-signer/agents/` (which agent uses which key).

## Tools

| Tool | What it does |
|---|---|
| `connect` | Asks the agent's name on first use (or which key on this computer to reuse), creates its key and connects it to your account (link, QR, connection code), or restates the Grant once it is live. With a new `name` it makes one more agent of the client; with `agent` it checks or links that one. |
| `denaria_list_agents` | The client's agents on this computer: name, key id, fingerprint, account, Grant state and expiry. |
| `denaria_get_grant`, `denaria_get_positions`, `denaria_get_open_orders`, `denaria_get_balances` | Read the Grant, the positions with their take profit and stop loss, the open orders, the USDC. |
| `denaria_create_position`, `denaria_close_position` | Open or add to a position with USDC collateral; close a position. |
| `denaria_adjust_margin`, `denaria_set_tpsl`, `denaria_cancel_order`, `denaria_claim_funding` | Add or remove collateral; set or move the take profit and stop loss; cancel an order; claim the funding fees in USDC. |
| `denaria_get_operation_status` | Where an operation stands, by its `dop_…` reference. |

On the test network the tools are named `denaria_testnet_…`, and every answer states the
network, when the Grant expires, and which agent and account it is about. Every tool but the
list takes `agent`, the key id or the name of the agent that acts: required once the client
has two or more agents. Denaria prepares each operation within your Grant, the
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
