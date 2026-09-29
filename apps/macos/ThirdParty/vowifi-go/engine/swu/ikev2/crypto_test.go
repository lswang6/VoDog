package ikev2

import (
	"crypto"
	"encoding/hex"
	"testing"
)

func TestPRFPlusSHA256(t *testing.T) {
	out, err := PRFPlus(crypto.SHA256, []byte("key"), []byte("seed"), 48)
	if err != nil {
		t.Fatalf("PRFPlus() error = %v", err)
	}
	want := "a2392e429a99b173341b368bb5ce320bfd483d89567c14ec187c2d77e3c0a208ba45d21d42611712996c0cd4b329ac86"
	if hex.EncodeToString(out) != want {
		t.Fatalf("PRFPlus()=%x, want %s", out, want)
	}
}

func TestDeriveIKESAKeyMaterial(t *testing.T) {
	nonceI := mustHex("0102030405060708")
	nonceR := mustHex("1112131415161718")
	shared := mustHex("a0a1a2a3a4a5a6a7")
	skeyseed, err := SKEYSEED(crypto.SHA256, nonceI, nonceR, shared)
	if err != nil {
		t.Fatalf("SKEYSEED() error = %v", err)
	}
	wantSeed := "574e6d49bbd677904dce7ca8571eed521e256658ac145dbdae3ce33c003b01b2"
	if hex.EncodeToString(skeyseed) != wantSeed {
		t.Fatalf("SKEYSEED()=%x, want %s", skeyseed, wantSeed)
	}
	keys, err := DeriveIKESAKeyMaterial(crypto.SHA256, skeyseed, nonceI, nonceR, 0x0102030405060708, 0x1112131415161718, 64)
	if err != nil {
		t.Fatalf("DeriveIKESAKeyMaterial() error = %v", err)
	}
	wantKeys := "a6bc3840a9d3ed9c034297b916c3a5123777d0d7eecf9c05efe0d9d80a6433db58cc25d73cb129fa3e4df79188289f64d5e00f4a7d71ec9e8de08b5b7c154bbd"
	if hex.EncodeToString(keys) != wantKeys {
		t.Fatalf("keys=%x, want %s", keys, wantKeys)
	}
}
