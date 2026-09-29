# VoDog recording archive validator

This Go standard-library helper validates a single gzip member, decompressed size, WAV and JSONL timeline formats. It does not listen on a port or provide downloads.

```sh
go test -race ./...
go build -trimpath -o /tmp/vodog-recording-archive-validator .
/tmp/vodog-recording-archive-validator --help
```

Control provides a fixed archive root, input/output paths, artifact type and decompressed byte limit. Configure its `PIXEL_ARCHIVE_VALIDATOR_PATH` and `PIXEL_ARCHIVE_ROOT` with your own absolute paths. The service user needs read/execute permission on the executable and appropriate access to the archive directory. No credentials are required.

Control remains responsible for ownership, limits, subprocess timeout, hashes, fsync and atomic publication. Successful format validation alone is not publication or real-device acceptance. Tests generate synthetic WAV/timeline data; no recordings ship in this package.
