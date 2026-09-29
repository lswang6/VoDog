package main

import (
	"bufio"
	"compress/flate"
	"compress/gzip"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

type result struct {
	OriginalBytes  int64  `json:"originalBytes"`
	OriginalSHA256 string `json:"originalSha256"`
}
type validationError struct{ error }

func invalid(err error) error { return validationError{err} }

func classifyGzipError(err error) error {
	if err == nil {
		return nil
	}
	var corrupt flate.CorruptInputError
	if errors.Is(err, gzip.ErrChecksum) || errors.Is(err, gzip.ErrHeader) ||
		errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.As(err, &corrupt) {
		return invalid(err)
	}
	return err
}

func classifyEndRead(count int, err error) error {
	if count != 0 || err == nil {
		return invalid(errors.New("gzip did not end cleanly"))
	}
	if errors.Is(err, io.EOF) {
		return nil
	}
	return classifyGzipError(err)
}

func main() {
	input := flag.String("input", "", "fixed gzip input path")
	output := flag.String("output", "", "fixed verified output path")
	root := flag.String("root", "", "trusted archive root")
	kind := flag.String("kind", "", "wav or timeline")
	maxOutput := flag.Int64("max-output", 0, "maximum decompressed bytes")
	remoteBytes := flag.Int64("remote-bytes", 0, "verified remote WAV bytes (timeline only)")
	callerBytes := flag.Int64("caller-bytes", 0, "verified caller WAV bytes (timeline only)")
	playoutBytes := flag.Int64("playout-bytes", 0, "verified derived playout WAV bytes (v3 timeline only)")
	flag.Parse()
	if *root == "" || *input == "" || *output == "" || (*kind != "wav" && *kind != "timeline") || *maxOutput <= 0 ||
		(*kind == "timeline" && (*remoteBytes < 44 || *callerBytes < 44)) {
		fatal("invalid_arguments")
	}
	if err := validatePaths(*root, *input, *output); err != nil {
		var validation validationError
		if errors.As(err, &validation) {
			fatal("invalid_path")
		}
		fatalCode("validator_io_failed", 3)
	}
	bounds := timelineBounds{
		"remote_original": *remoteBytes,
		"caller_original": *callerBytes,
	}
	if *playoutBytes != 0 {
		if *playoutBytes < 44 {
			fatal("invalid_arguments")
		}
		bounds["caller_playout"] = *playoutBytes
	}
	value, err := verify(*input, *output, *kind, *maxOutput, bounds)
	if err != nil {
		_ = os.Remove(*output)
		var validation validationError
		if errors.As(err, &validation) {
			fatal("invalid_archive")
		}
		fatalCode("validator_io_failed", 3)
	}
	if err := json.NewEncoder(os.Stdout).Encode(value); err != nil {
		fatal("result_write_failed")
	}
}

func validatePaths(root, input, output string) error {
	realRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return err
	}
	realRoot, err = filepath.Abs(realRoot)
	if err != nil {
		return err
	}
	info, err := os.Lstat(input)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return invalid(errors.New("invalid input"))
	}
	realInput, err := filepath.EvalSymlinks(input)
	if err != nil {
		return err
	}
	realParent, err := filepath.EvalSymlinks(filepath.Dir(output))
	if err != nil {
		return err
	}
	for _, path := range []string{realInput, realParent} {
		rel, e := filepath.Rel(realRoot, path)
		if e != nil {
			return e
		}
		if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return invalid(errors.New("outside root"))
		}
	}
	if _, err := os.Lstat(output); err == nil {
		return invalid(errors.New("output already exists"))
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func fatal(code string) {
	fatalCode(code, 2)
}
func fatalCode(code string, exit int) {
	fmt.Fprintln(os.Stderr, code)
	os.Exit(exit)
}

type timelineBounds map[string]int64

func verify(input, output, kind string, maxOutput int64, bounds ...timelineBounds) (result, error) {
	in, err := os.Open(input)
	if err != nil {
		return result{}, err
	}
	defer in.Close()
	buffered := bufio.NewReaderSize(in, 64*1024)
	z, err := gzip.NewReader(buffered)
	if err != nil {
		return result{}, classifyGzipError(err)
	}
	z.Multistream(false)
	out, err := os.OpenFile(output, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		_ = z.Close()
		return result{}, err
	}
	remove := true
	defer func() {
		_ = out.Close()
		if remove {
			_ = os.Remove(output)
		}
	}()
	hash := sha256.New()
	limited := &io.LimitedReader{R: z, N: maxOutput + 1}
	n, err := io.Copy(io.MultiWriter(out, hash), limited)
	if err != nil {
		return result{}, classifyGzipError(err)
	}
	if n > maxOutput {
		return result{}, invalid(errors.New("output limit exceeded"))
	}
	// EOF is required: gzip verifies the member trailer checksum while reaching EOF.
	var one [1]byte
	count, readErr := z.Read(one[:])
	if endErr := classifyEndRead(count, readErr); endErr != nil {
		return result{}, endErr
	}
	if err := z.Close(); err != nil {
		return result{}, err
	}
	if _, err := buffered.Peek(1); err == nil {
		return result{}, invalid(errors.New("second member or trailing byte"))
	} else if err != io.EOF {
		return result{}, err
	}
	if kind == "wav" {
		if err := validateWAV(output, n); err != nil {
			return result{}, err
		}
	} else if len(bounds) != 1 {
		return result{}, invalid(errors.New("timeline bounds required"))
	} else if err := validateJSONL(output, bounds[0]); err != nil {
		return result{}, err
	}
	if err := out.Sync(); err != nil {
		return result{}, err
	}
	if err := out.Close(); err != nil {
		return result{}, err
	}
	remove = false
	return result{OriginalBytes: n, OriginalSHA256: hex.EncodeToString(hash.Sum(nil))}, nil
}

func validateWAV(path string, size int64) error {
	if size < 44 || size > int64(^uint32(0)) || (size-44)%2 != 0 {
		return invalid(errors.New("invalid wav size"))
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := make([]byte, 44)
	if _, err = io.ReadFull(f, h); err != nil {
		if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
			return invalid(err)
		}
		return err
	}
	if string(h[0:4]) != "RIFF" || string(h[8:16]) != "WAVEfmt " || string(h[36:40]) != "data" {
		return invalid(errors.New("invalid wav header"))
	}
	if binary.LittleEndian.Uint32(h[4:8]) != uint32(size-8) || binary.LittleEndian.Uint32(h[16:20]) != 16 ||
		binary.LittleEndian.Uint16(h[20:22]) != 1 || binary.LittleEndian.Uint16(h[22:24]) != 1 ||
		binary.LittleEndian.Uint32(h[24:28]) != 16000 || binary.LittleEndian.Uint32(h[28:32]) != 32000 ||
		binary.LittleEndian.Uint16(h[32:34]) != 2 || binary.LittleEndian.Uint16(h[34:36]) != 16 ||
		binary.LittleEndian.Uint32(h[40:44]) != uint32(size-44) {
		return invalid(errors.New("unexpected wav format"))
	}
	return nil
}

func validateJSONL(path string, bounds timelineBounds) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	const maxLineBytes = 64 * 1024
	r := bufio.NewReaderSize(f, maxLineBytes+1)
	lines := 0
	nextOffsets := make(map[string]int64, len(bounds))
	for track := range bounds {
		nextOffsets[track] = 44
	}
	for {
		line, readErr := r.ReadSlice('\n')
		if errors.Is(readErr, bufio.ErrBufferFull) || len(line) > maxLineBytes {
			return invalid(errors.New("jsonl line too long"))
		}
		if readErr != nil && !errors.Is(readErr, io.EOF) {
			return readErr
		}
		if len(line) == 0 && errors.Is(readErr, io.EOF) {
			break
		}
		lines++
		var value map[string]any
		if len(line) == 0 || !utf8.Valid(line) || json.Unmarshal(line, &value) != nil || len(value) == 0 {
			return invalid(errors.New("invalid jsonl"))
		}
		event, ok := value["event"].(string)
		if !ok || (event != "start" && event != "stop" && event != "frame" && event != "playout_frame" && event != "gap" && event != "recovered_incomplete") {
			return invalid(errors.New("invalid timeline event"))
		}
		switch event {
		case "start":
			if !jsonInteger(value["timestampUs"], 0, 0) {
				return invalid(errors.New("invalid start event"))
			}
		case "frame", "playout_frame":
			track, trackOK := value["track"].(string)
			if !trackOK || (event == "frame" && !originalTimelineTrack(track)) ||
				(event == "playout_frame" && track != "caller_playout") || !jsonInteger(value["timestampUs"], 0, maxSafeInteger) ||
				!jsonInteger(value["fileOffset"], 44, maxSafeInteger) || !jsonInteger(value["sampleCount"], 1, 256*1024*1024) {
				return invalid(errors.New("invalid frame event"))
			}
			offset := int64(value["fileOffset"].(float64))
			samples := int64(value["sampleCount"].(float64))
			trackBytes, present := bounds[track]
			if !present || offset != nextOffsets[track] || samples > (trackBytes-offset)/2 || offset > trackBytes {
				return invalid(errors.New("frame outside wav"))
			}
			nextOffsets[track] = offset + samples*2
			if source, exists := value["sourceTimestampUs"]; !exists || (source != nil && !jsonInteger(source, 0, maxSafeInteger)) {
				return invalid(errors.New("invalid source timestamp"))
			}
			if event == "playout_frame" {
				if recovery, exists := value["recoveryKind"]; exists {
					kind, ok := recovery.(string)
					if !ok || (kind != "plc" && kind != "fec_attempt" && kind != "mixed_recovery") {
						return invalid(errors.New("invalid playout recovery kind"))
					}
				}
			} else if _, exists := value["recoveryKind"]; exists {
				return invalid(errors.New("original frame cannot claim recovery"))
			}
		case "gap":
			track, ok := value["track"].(string)
			if !ok || !timelineTrack(track, bounds) || !jsonInteger(value["timestampUs"], 0, maxSafeInteger) {
				return invalid(errors.New("invalid gap event"))
			}
			_, duration := value["durationUs"]
			reason, hasReason := value["reason"].(string)
			_, frames := value["frames"]
			validDuration := duration && !hasReason && !frames && jsonInteger(value["durationUs"], 1, maxSafeInteger)
			validQueueDrop := !duration && hasReason && reason == "local_queue_drop" && frames &&
				jsonInteger(value["frames"], 1, maxSafeInteger)
			// LocalCallRecorder emits this marker when received media is deliberately
			// discarded during teardown. It carries no invented duration or frame count.
			validMediaDiscard := !duration && hasReason && reason == "media_buffer_discard" && !frames &&
				originalTimelineTrack(track)
			if !validDuration && !validQueueDrop && !validMediaDiscard {
				return invalid(errors.New("invalid gap detail"))
			}
		case "stop":
			state, ok := value["state"].(string)
			if !ok || (state != "completed" && state != "ended" && state != "failed" && state != "incomplete" && state != "recovered_incomplete") {
				return invalid(errors.New("invalid stop event"))
			}
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
	}
	if lines == 0 {
		return invalid(errors.New("empty jsonl"))
	}
	return nil
}

const maxSafeInteger = int64(9007199254740991)

func jsonInteger(value any, min, max int64) bool {
	number, ok := value.(float64)
	return ok && !math.IsNaN(number) && !math.IsInf(number, 0) && number == math.Trunc(number) && number >= float64(min) && number <= float64(max)
}

func originalTimelineTrack(track string) bool {
	return track == "remote_original" || track == "caller_original"
}

func timelineTrack(track string, bounds timelineBounds) bool {
	_, ok := bounds[track]
	return ok && (originalTimelineTrack(track) || track == "caller_playout")
}
