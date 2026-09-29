# VoDog contributor guide

Read `README.md`, `readme-for-ai.md`, and the relevant component README first.

- Treat this checkout as a standalone project. Never access another installation's credentials, database, devices, or servers to make this project run.
- Use only fictional demo data. Domains use `example.com`; phone examples use reserved fictional ranges.
- Keep operator configuration in ignored files. Never commit signing keys, Firebase credentials, recordings, call logs, personal contacts, or gateway pairing secrets.
- Preserve third-party licenses and attribution. The macOS component has additional licensing restrictions; read its LICENSE before redistribution.
- Run the component's tests after changes, and `python3 tools/check-publication.py` before publishing.
- A successful build is not proof of physical cellular calling, audio quality, background push delivery, or deployment readiness. State verification boundaries explicitly.
- Never initiate real calls, send SMS, flash hardware, or deploy services without operator authorization for that environment.
