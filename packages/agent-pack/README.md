# @denaria/agent-pack

Local wrapper for deterministic Denaria Action Handoff usage.

It exposes a stdio MCP server that calls the official Denaria MCP endpoint:

```text
https://mcp.denaria.finance/mcp
```

The wrapper prepares unsigned Denaria App/PWA handoffs and downloads the QR PNG to the user device so agent clients can render it in chat.

## Commands

```bash
npx -y @denaria/agent-pack mcp
npx -y @denaria/agent-pack prepare --side long --market BTC --collateral 50 --leverage 3
npx -y @denaria/agent-pack capabilities
```

The wrapper does not sign, submit, broadcast, or execute transactions.
