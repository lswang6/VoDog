# Security and privacy

[Documentation](README.md) · [简体中文](security.zh-CN.md)

Self-hosting gives you control over storage and configuration; it does not make all data local or all recordings end-to-end encrypted. The media bridge can process and record audio. Enabled AI/transcription/report services can send audio or text to the configured external provider. Mobile push providers also receive the configured notification payloads, which can include caller information.

## Protect the boundaries

- Give Control, media, TURN, voice, and database services only the credentials and filesystem access each needs. Use separate high-entropy secrets, restrictive file permissions, authenticated private service routes, and verified TLS.
- Keep database/admin infrastructure and internal worker APIs off public ingress. Do not expose a credential-bearing debug endpoint as a troubleshooting shortcut.
- Use actual user ownership, gateway epoch, SIM assignment and command-generation checks. Pairing codes are short lived; device tokens and module credential copies are long-lived secrets until revoked or replaced.
- Native signing identities, associated domains, Android certificate origins and push topics must match the installed build. Never ship signing keys, Apple private keys, Firebase service accounts, real device tokens, or populated local configuration.
- Rooted Pixel and module helper access are privileged. Review the exact binary, module permissions, signature, and supported OS/firmware before installation.

## Data lifecycle

Inventory contacts, phone numbers, SMS bodies, recordings, transcripts, AI prompts, credentials, device metadata, diagnostics, exports, and backups. Choose access controls and retention for each. Keep operator reports, physical-device evidence, and raw logs outside the public repository.

VoDog call deletion coordinates supported server records and archive paths. It does not automatically erase every downloaded MP3, independent BCR recording, local macOS recording, log, or backup. Verify what is removed, what is retained, and when retention jobs run. Never purge command journals or identity fences as part of content cleanup.

Before enabling recording or external AI processing, arrange appropriate notice and consent for your use, and review applicable requirements and provider policies. This documentation makes no jurisdiction-specific legal claim. Give operators an accurate description of where data is processed.

## Reporting problems

Public issues should contain a minimal synthetic reproduction, relevant source paths, sanitized error codes, and the validation layer affected. Do not attach real recordings, full logs, tokens, pairing codes, phone numbers, SIM/modem identifiers, or private infrastructure details. For a sensitive vulnerability, use a private reporting channel designated by the repository maintainers; no dedicated contact address is asserted here.
