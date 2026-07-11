# Claude

Add this MCP server to Claude Desktop config:

```json
{
  "mcpServers": {
    "denaria": {
      "command": "npx",
      "args": ["-y", "@denaria/agent-pack", "mcp"]
    }
  }
}
```

Install the Denaria skills with your supported skills installer, then use `/denaria-action-handoff`.
