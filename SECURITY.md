# Security and publication hygiene

Deploy VoDog only on infrastructure you control. Keep database ports and internal
media/AI endpoints private; expose only the documented HTTPS and TURN services.
Generate fresh credentials for every installation, keep `.env` and signing files
outside Git, and grant gateway administration only to trusted operators.

Call recordings, transcripts, SMS, contacts and diagnostic logs contain sensitive
information. Configure retention and filesystem access before inviting users.
Do not put real account data in screenshots, bug reports or test fixtures.

Before publishing changes:

```sh
python3 tools/check-publication.py --self-test
python3 tools/check-publication.py
```

Also run a dedicated secret scanner against the exact staged content and review
images, archives and dependency attribution manually. Pattern scans cannot prove
that a tree contains no private information.

For vulnerabilities, use GitHub's private vulnerability reporting feature when
available. Do not post working credentials, customer records or exploit details in
a public issue. For ordinary reproducible bugs, use fictional fixtures.
