# Codex

Add this to Codex config:

```toml
[mcp_servers.denaria]
command = "npx"
args = ["-y", "@denaria/agent-pack", "mcp"]
startup_timeout_sec = 20
tool_timeout_sec = 60
default_tools_approval_mode = "prompt"
```

Install the skills:

```bash
npx skills@latest add denaria-finance/denaria-skills
```

Use `/denaria-action-handoff` for Denaria position handoff requests.
