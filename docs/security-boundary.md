# Security Boundary

Denaria Skills and `@denaria/agent-pack` are prepare-only.

Allowed:

- parse Denaria action intent;
- call the official Denaria MCP endpoint;
- prepare an unsigned handoff;
- download the QR image for display;
- show QR fallback URLs.

Forbidden:

- signing;
- transaction submission or broadcasting;
- wallet custody;
- private key or passkey handling;
- autonomous trading;
- treating x402/payment as trade consent.
