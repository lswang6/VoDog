package ikev2

import (
	"encoding/binary"
	"errors"
	"fmt"
)

const encryptedFragmentBodyHeaderLength = 4

var ErrInvalidEncryptedFragment = errors.New("invalid ikev2 encrypted fragment payload")

type EncryptedFragment struct {
	FragmentNumber uint16
	TotalFragments uint16
	EncryptedData  []byte
}

func (f EncryptedFragment) MarshalBinary() ([]byte, error) {
	if f.FragmentNumber == 0 {
		return nil, fmt.Errorf("%w: fragment number is zero", ErrInvalidEncryptedFragment)
	}
	if f.TotalFragments == 0 {
		return nil, fmt.Errorf("%w: total fragments is zero", ErrInvalidEncryptedFragment)
	}
	if f.FragmentNumber > f.TotalFragments {
		return nil, fmt.Errorf("%w: fragment %d > total %d", ErrInvalidEncryptedFragment, f.FragmentNumber, f.TotalFragments)
	}
	if len(f.EncryptedData) == 0 {
		return nil, fmt.Errorf("%w: encrypted data is empty", ErrInvalidEncryptedFragment)
	}
	if encryptedFragmentBodyHeaderLength+len(f.EncryptedData)+4 > 0xffff {
		return nil, fmt.Errorf("%w: %w: payload length %d", ErrInvalidEncryptedFragment, ErrInvalidLength, encryptedFragmentBodyHeaderLength+len(f.EncryptedData)+4)
	}
	out := make([]byte, encryptedFragmentBodyHeaderLength, encryptedFragmentBodyHeaderLength+len(f.EncryptedData))
	binary.BigEndian.PutUint16(out[0:2], f.FragmentNumber)
	binary.BigEndian.PutUint16(out[2:4], f.TotalFragments)
	out = append(out, f.EncryptedData...)
	return out, nil
}

func ParseEncryptedFragment(data []byte) (EncryptedFragment, error) {
	if len(data) <= encryptedFragmentBodyHeaderLength {
		return EncryptedFragment{}, fmt.Errorf("%w: body length %d", ErrInvalidEncryptedFragment, len(data))
	}
	fragmentNumber := binary.BigEndian.Uint16(data[0:2])
	totalFragments := binary.BigEndian.Uint16(data[2:4])
	if fragmentNumber == 0 {
		return EncryptedFragment{}, fmt.Errorf("%w: fragment number is zero", ErrInvalidEncryptedFragment)
	}
	if totalFragments == 0 {
		return EncryptedFragment{}, fmt.Errorf("%w: total fragments is zero", ErrInvalidEncryptedFragment)
	}
	if fragmentNumber > totalFragments {
		return EncryptedFragment{}, fmt.Errorf("%w: fragment %d > total %d", ErrInvalidEncryptedFragment, fragmentNumber, totalFragments)
	}
	return EncryptedFragment{
		FragmentNumber: fragmentNumber,
		TotalFragments: totalFragments,
		EncryptedData:  append([]byte(nil), data[encryptedFragmentBodyHeaderLength:]...),
	}, nil
}

func EncryptedFragmentPayload(nextPayload uint8, fragment EncryptedFragment) (Payload, error) {
	body, err := fragment.MarshalBinary()
	if err != nil {
		return Payload{}, err
	}
	return Payload{Type: PayloadSKF, NextPayload: nextPayload, Body: body}, nil
}
