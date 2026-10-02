package main

import (
	"bytes"
	"compress/gzip"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func isInvalidArchive(err error) bool {
	var validation validationError
	return errors.As(err, &validation)
}

func gz(data []byte) []byte {
	var b bytes.Buffer
	w := gzip.NewWriter(&b)
	_, _ = w.Write(data)
	_ = w.Close()
	return b.Bytes()
}
func wav(pcm int) []byte {
	b := make([]byte, 44+pcm)
	copy(b, "RIFF")
	binary.LittleEndian.PutUint32(b[4:8], uint32(len(b)-8))
	copy(b[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(b[16:20], 16)
	binary.LittleEndian.PutUint16(b[20:22], 1)
	binary.LittleEndian.PutUint16(b[22:24], 1)
	binary.LittleEndian.PutUint32(b[24:28], 16000)
	binary.LittleEndian.PutUint32(b[28:32], 32000)
	binary.LittleEndian.PutUint16(b[32:34], 2)
	binary.LittleEndian.PutUint16(b[34:36], 16)
	copy(b[36:], "data")
	binary.LittleEndian.PutUint32(b[40:44], uint32(pcm))
	return b
}

func TestVerifySingleMemberAndRejectAdditionalInput(t *testing.T) {
	d := t.TempDir()
	valid := wav(640)
	for _, tc := range []struct {
		name string
		data []byte
		ok   bool
	}{{"single", gz(valid), true}, {"two-members", append(gz(valid), gz([]byte("x"))...), false}, {"zero-tail", append(gz(valid), 0), false}, {"junk-tail", append(gz(valid), 1, 2), false}, {"truncated", gz(valid)[:len(gz(valid))-2], false}} {
		t.Run(tc.name, func(t *testing.T) {
			in := filepath.Join(d, tc.name+".gz")
			out := filepath.Join(d, tc.name+".wav")
			if err := os.WriteFile(in, tc.data, 0600); err != nil {
				t.Fatal(err)
			}
			got, err := verify(in, out, "wav", 4096)
			if tc.ok {
				if err != nil || got.OriginalBytes != int64(len(valid)) {
					t.Fatalf("got=%+v err=%v", got, err)
				}
			} else if err == nil {
				t.Fatal("invalid gzip accepted")
			}
		})
	}
}

func TestVerifyRejectsLimitFormatAndBadChecksum(t *testing.T) {
	d := t.TempDir()
	good := gz(wav(640))
	badCRC := append([]byte(nil), good...)
	badCRC[len(badCRC)-8] ^= 1
	for _, tc := range []struct {
		name  string
		data  []byte
		limit int64
	}{{"limit", good, 100}, {"format", gz([]byte("not wav")), 4096}, {"odd-pcm", gz(wav(1)), 4096}, {"checksum", badCRC, 4096}} {
		t.Run(tc.name, func(t *testing.T) {
			in := filepath.Join(d, tc.name+".gz")
			out := filepath.Join(d, tc.name)
			_ = os.WriteFile(in, tc.data, 0600)
			if _, err := verify(in, out, "wav", tc.limit); err == nil {
				t.Fatal("invalid archive accepted")
			}
		})
	}
}

func TestVerifyTimeline(t *testing.T) {
	d := t.TempDir()
	in := filepath.Join(d, "timeline.gz")
	out := filepath.Join(d, "timeline")
	valid := "{\"event\":\"start\",\"timestampUs\":0}\n" +
		"{\"event\":\"frame\",\"track\":\"remote_original\",\"timestampUs\":0,\"sourceTimestampUs\":null,\"fileOffset\":44,\"sampleCount\":320}\n" +
		"{\"event\":\"gap\",\"track\":\"remote_original\",\"timestampUs\":20000,\"durationUs\":20000}\n" +
		"{\"event\":\"gap\",\"track\":\"caller_original\",\"timestampUs\":40000,\"reason\":\"local_queue_drop\",\"frames\":1}\n" +
		"{\"event\":\"stop\",\"state\":\"ended\"}\n"
	_ = os.WriteFile(in, gz([]byte(valid)), 0600)
	if _, err := verify(in, out, "timeline", 1024, timelineBounds{"remote_original": 684, "caller_original": 684}); err != nil {
		t.Fatal(err)
	}
}

func TestVerifyTimelineAcceptsCurrentRecorderMediaDiscardMarker(t *testing.T) {
	d := t.TempDir()
	in := filepath.Join(d, "timeline.gz")
	out := filepath.Join(d, "timeline")
	currentRecorder := "{\"event\":\"start\",\"timestampUs\":0}\n" +
		"{\"event\":\"gap\",\"track\":\"caller_original\",\"timestampUs\":40000,\"reason\":\"media_buffer_discard\"}\n" +
		"{\"event\":\"stop\",\"state\":\"ended\"}\n"
	if err := os.WriteFile(in, gz([]byte(currentRecorder)), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := verify(in, out, "timeline", 1024, timelineBounds{"remote_original": 44, "caller_original": 44}); err != nil {
		t.Fatal(err)
	}

	for _, invalid := range []string{
		strings.Replace(currentRecorder, "caller_original", "caller_playout", 1),
		strings.Replace(currentRecorder, "}\n{\"event\":\"stop\"", ",\"frames\":1}\n{\"event\":\"stop\"", 1),
		strings.Replace(currentRecorder, "media_buffer_discard", "unknown_discard", 1),
	} {
		path := filepath.Join(d, strings.Repeat("x", len(invalid)%7+1)+".jsonl")
		if err := os.WriteFile(path, []byte(invalid), 0600); err != nil {
			t.Fatal(err)
		}
		if err := validateJSONL(path, timelineBounds{"remote_original": 44, "caller_original": 44, "caller_playout": 44}); err == nil || !isInvalidArchive(err) {
			t.Fatalf("invalid media discard marker accepted: %v", err)
		}
	}
}

func TestVerifyTimelineRejectsMissingAndOutOfBoundsFields(t *testing.T) {
	for _, tc := range []struct {
		name string
		line string
	}{
		{"start-time", "{\"event\":\"start\"}\n"},
		{"empty-frame", "{\"event\":\"frame\",\"track\":\"remote_original\",\"timestampUs\":0,\"sourceTimestampUs\":null,\"fileOffset\":44,\"sampleCount\":0}\n"},
		{"unaligned-frame", "{\"event\":\"frame\",\"track\":\"remote_original\",\"timestampUs\":0,\"sourceTimestampUs\":null,\"fileOffset\":45,\"sampleCount\":1}\n"},
		{"outside-wav", "{\"event\":\"frame\",\"track\":\"remote_original\",\"timestampUs\":0,\"sourceTimestampUs\":null,\"fileOffset\":684,\"sampleCount\":1}\n"},
		{"invalid-utf8", string([]byte{'{', 0xff, '}', '\n'})},
		{"gap-detail", "{\"event\":\"gap\",\"track\":\"remote_original\",\"timestampUs\":0}\n"},
		{"stop-state", "{\"event\":\"stop\",\"state\":\"active\"}\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			d := t.TempDir()
			in, out := filepath.Join(d, "timeline.gz"), filepath.Join(d, "timeline")
			_ = os.WriteFile(in, gz([]byte(tc.line)), 0600)
			if _, err := verify(in, out, "timeline", 4096, timelineBounds{"remote_original": 684, "caller_original": 684}); err == nil {
				t.Fatal("invalid timeline accepted")
			}
		})
	}
}

func TestVerifyV3TimelineKeepsDerivedPlayoutSeparateAndExact(t *testing.T) {
	d := t.TempDir()
	valid := "{\"event\":\"start\",\"timestampUs\":0}\n" +
		"{\"event\":\"frame\",\"track\":\"caller_original\",\"timestampUs\":9000,\"sourceTimestampUs\":11000,\"fileOffset\":44,\"sampleCount\":320}\n" +
		"{\"event\":\"playout_frame\",\"track\":\"caller_playout\",\"timestampUs\":29000,\"sourceTimestampUs\":31000,\"fileOffset\":44,\"sampleCount\":320,\"recoveryKind\":\"fec_attempt\"}\n" +
		"{\"event\":\"playout_frame\",\"track\":\"caller_playout\",\"timestampUs\":49000,\"sourceTimestampUs\":null,\"fileOffset\":684,\"sampleCount\":320,\"recoveryKind\":\"plc\"}\n" +
		"{\"event\":\"stop\",\"state\":\"ended\"}\n"
	path := filepath.Join(d, "timeline.jsonl")
	if err := os.WriteFile(path, []byte(valid), 0600); err != nil {
		t.Fatal(err)
	}
	bounds := timelineBounds{"remote_original": 44, "caller_original": 684, "caller_playout": 1324}
	if err := validateJSONL(path, bounds); err != nil {
		t.Fatal(err)
	}
	compressed := filepath.Join(d, "timeline.jsonl.gz")
	verified := filepath.Join(d, "timeline.verified.jsonl")
	if err := os.WriteFile(compressed, gz([]byte(valid)), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := verify(compressed, verified, "timeline", int64(len(valid)), bounds)
	if err != nil || result.OriginalBytes != int64(len(valid)) || result.OriginalSHA256 == "" {
		t.Fatalf("v3 compressed timeline result=%+v err=%v", result, err)
	}
	if _, err := verify(compressed, filepath.Join(d, "v2-must-reject"), "timeline", int64(len(valid)), timelineBounds{
		"remote_original": 44,
		"caller_original": 684,
	}); err == nil || !isInvalidArchive(err) {
		t.Fatalf("v2 bounds accepted a derived playout event: %v", err)
	}

	invalid := []string{
		strings.Replace(valid, "\"fileOffset\":684", "\"fileOffset\":686", 1),
		strings.Replace(valid, "\"recoveryKind\":\"fec_attempt\"", "\"recoveryKind\":\"recovered\"", 1),
		strings.Replace(valid, "\"event\":\"frame\",\"track\":\"caller_original\"", "\"event\":\"frame\",\"track\":\"caller_original\",\"recoveryKind\":\"plc\"", 1),
	}
	for i, body := range invalid {
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if err := validateJSONL(path, bounds); err == nil || !isInvalidArchive(err) {
			t.Fatalf("invalid v3 timeline %d accepted: %v", i, err)
		}
	}
}

func TestValidatePathsRejectsSymlinkAndEscape(t *testing.T) {
	root := t.TempDir()
	in := filepath.Join(root, "a.gz")
	_ = os.WriteFile(in, gz([]byte("x")), 0600)
	if err := validatePaths(root, in, filepath.Join(root, "out")); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "out")
	if err := validatePaths(root, in, outside); err == nil || !isInvalidArchive(err) {
		t.Fatal("escape accepted")
	}
	link := filepath.Join(root, "link")
	_ = os.Symlink(in, link)
	if err := validatePaths(root, link, filepath.Join(root, "out")); err == nil || !isInvalidArchive(err) {
		t.Fatal("symlink accepted")
	}
	missing := filepath.Join(root, "missing.gz")
	if err := validatePaths(root, missing, filepath.Join(root, "out")); err == nil || isInvalidArchive(err) {
		t.Fatalf("missing input must remain an I/O error, got %v", err)
	}
	existingOutput := filepath.Join(root, "existing")
	if err := os.WriteFile(existingOutput, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validatePaths(root, in, existingOutput); err == nil || !isInvalidArchive(err) {
		t.Fatalf("existing output must remain an invalid path, got %v", err)
	}
}

func TestValidatorsKeepFilesystemErrorsDistinctFromInvalidFormats(t *testing.T) {
	d := t.TempDir()
	if err := validateWAV(d, 44); err == nil || isInvalidArchive(err) {
		t.Fatalf("directory WAV read must remain an I/O error, got %v", err)
	}
	if err := validateJSONL(d, timelineBounds{}); err == nil || isInvalidArchive(err) {
		t.Fatalf("directory JSONL read must remain an I/O error, got %v", err)
	}

	short := filepath.Join(d, "short.wav")
	if err := os.WriteFile(short, []byte("RIFF"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateWAV(short, 44); err == nil || !isInvalidArchive(err) {
		t.Fatalf("truncated WAV must remain a format error, got %v", err)
	}

	badJSONL := filepath.Join(d, "bad.jsonl")
	if err := os.WriteFile(badJSONL, []byte("not-json\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateJSONL(badJSONL, timelineBounds{}); err == nil || !isInvalidArchive(err) {
		t.Fatalf("malformed JSONL must remain a format error, got %v", err)
	}
}

func TestClassifyGzipErrorKeepsIOSeparate(t *testing.T) {
	ioFailure := &os.PathError{Op: "read", Path: "archive.gz", Err: errors.New("temporary I/O failure")}
	if got := classifyGzipError(ioFailure); got != ioFailure || isInvalidArchive(got) {
		t.Fatalf("filesystem error was classified as invalid archive: %v", got)
	}
	for _, formatFailure := range []error{gzip.ErrHeader, gzip.ErrChecksum, io.ErrUnexpectedEOF} {
		if got := classifyGzipError(formatFailure); !isInvalidArchive(got) {
			t.Fatalf("format error %v was not classified as invalid archive", formatFailure)
		}
	}
}

func TestClassifyEndReadRejectsNilAndPreservesIO(t *testing.T) {
	if err := classifyEndRead(0, nil); err == nil || !isInvalidArchive(err) {
		t.Fatalf("zero-byte read without EOF must be invalid, got %v", err)
	}
	ioFailure := &os.PathError{Op: "read", Path: "archive.gz", Err: errors.New("temporary I/O failure")}
	if err := classifyEndRead(0, ioFailure); err != ioFailure || isInvalidArchive(err) {
		t.Fatalf("terminal filesystem error was misclassified: %v", err)
	}
	if err := classifyEndRead(0, io.EOF); err != nil {
		t.Fatalf("clean EOF rejected: %v", err)
	}
}

func TestValidateTimelineRejectsOverlongLineAsFormatError(t *testing.T) {
	d := t.TempDir()
	path := filepath.Join(d, "long.jsonl")
	line := bytes.Repeat([]byte{'x'}, 64*1024+1)
	if err := os.WriteFile(path, line, 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateJSONL(path, timelineBounds{}); err == nil || !isInvalidArchive(err) {
		t.Fatalf("overlong line must be an invalid archive, got %v", err)
	}
}

func TestVerifyV4TimelineAcceptsUplinkOnlyWithItsBound(t *testing.T) {
	d := t.TempDir()
	valid := "{\"event\":\"start\",\"timestampUs\":0}\n" +
		"{\"event\":\"frame\",\"track\":\"caller_uplink\",\"timestampUs\":0,\"sourceTimestampUs\":5000,\"fileOffset\":44,\"sampleCount\":320}\n" +
		"{\"event\":\"gap\",\"track\":\"caller_uplink\",\"timestampUs\":20000,\"durationUs\":20000}\n" +
		"{\"event\":\"gap\",\"track\":\"caller_uplink\",\"timestampUs\":40000,\"reason\":\"local_queue_drop\",\"frames\":1}\n" +
		"{\"event\":\"stop\",\"state\":\"ended\"}\n"
	path := filepath.Join(d, "timeline.jsonl")
	if err := os.WriteFile(path, []byte(valid), 0600); err != nil {
		t.Fatal(err)
	}
	v4 := timelineBounds{"remote_original": 44, "caller_original": 44, "caller_uplink": 684}
	if err := validateJSONL(path, v4); err != nil {
		t.Fatal(err)
	}
	for _, bounds := range []timelineBounds{
		{"remote_original": 44, "caller_original": 44},
		{"remote_original": 44, "caller_original": 44, "caller_playout": 684},
	} {
		if err := validateJSONL(path, bounds); err == nil || !isInvalidArchive(err) {
			t.Fatalf("uplink frame accepted without its bound %v: %v", bounds, err)
		}
	}
	for i, body := range []string{
		strings.Replace(valid, "\"sampleCount\":320}", "\"sampleCount\":320,\"recoveryKind\":\"plc\"}", 1),
		strings.Replace(valid, "\"sampleCount\":320", "\"sampleCount\":321", 1),
		strings.Replace(valid, "\"event\":\"frame\",\"track\":\"caller_uplink\"", "\"event\":\"playout_frame\",\"track\":\"caller_uplink\"", 1),
		"{\"event\":\"gap\",\"track\":\"caller_uplink\",\"timestampUs\":0,\"reason\":\"media_buffer_discard\"}\n",
	} {
		if err := os.WriteFile(path, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if err := validateJSONL(path, v4); err == nil || !isInvalidArchive(err) {
			t.Fatalf("invalid v4 timeline %d accepted: %v", i, err)
		}
	}
}
