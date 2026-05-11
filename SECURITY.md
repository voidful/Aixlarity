# Security Policy

## Supported Versions

Aixlarity is pre-1.0 while the IDE and Rust runtime harden toward a production-ready open-source release. Security fixes target the `main` branch first.

## Reporting a Vulnerability

Do not publish API keys, exploit details, browser recordings with private data, or terminal transcripts with secrets in a public issue.

Preferred reporting path:

1. Use GitHub private vulnerability reporting if it is enabled for the repository.
2. If private reporting is unavailable, open a minimal public issue asking for a secure contact path. Do not include exploit details.

Please include:

- affected commit or release,
- operating system and architecture,
- product surface involved: IDE, CLI, daemon, provider config, browser evidence, terminal replay, artifacts, or docs,
- impact and reproduction steps,
- whether secrets, filesystem writes, shell execution, browser recording, or provider credentials are involved.

## Security Boundaries

Aixlarity treats these as security-sensitive surfaces:

- provider API keys and provider bundles,
- terminal command approval and replay,
- browser DOM, console, network, screenshot, and video evidence,
- artifact exports and review comments,
- workspace trust, sandbox policy, and persona tool restrictions,
- MCP/plugin/tool definitions loaded from a workspace.

Security fixes should include an executable validation path, such as a Rust test, `npm run test-aixlarity-quality`, `npm run test-aixlarity-submission`, or an IDE smoke scenario.
