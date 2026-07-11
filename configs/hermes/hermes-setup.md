# Hermes Setup

Add a stdio MCP server named `denaria` with command:

```bash
npx -y @denaria/agent-pack mcp
```

Then install the Denaria skills:

```bash
npx skills@latest add denaria-finance/denaria-skills
```

Use `/denaria-action-handoff` to verify configuration with a Denaria handoff request.
