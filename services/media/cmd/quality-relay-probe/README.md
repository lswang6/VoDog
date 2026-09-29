# Quality relay probe verifier

This verifier consumes a freshly issued Control quality-options document without creating a call. It runs every listed node concurrently using relay-only UDP ICE, the `media-quality-v1` unreliable unordered data channel, and the exact 32-byte `CCQ1` echo frame.

Store the options in a regular file readable only by its owner, then run:

```sh
chmod 600 ./quality-options.json
quality-relay-probe \
  --input ./quality-options.json \
  --output ./quality-report.json
```

Use `--input -` for stdin and `--output -` for stdout. The saved report is created with mode `0600`. It contains node IDs, bounded numeric measurements, candidate types and protocols, relay proof, cleanup status, and stable error codes. It never contains grants, TURN credentials, SDP, candidate addresses, or endpoint URLs.

The report is synthetic client self-report and is not trusted SLA evidence. Its selected-pair proof establishes this probe's UDP relay path only; it does not prove the separate TURN-over-TLS call path. Options expire after 30 seconds, so dual-node verification must start immediately and the command runs nodes concurrently.
