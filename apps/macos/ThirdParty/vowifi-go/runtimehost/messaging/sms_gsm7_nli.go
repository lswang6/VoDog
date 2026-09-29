package messaging

const (
	SMSNationalLanguageTurkish    = 1
	SMSNationalLanguageSpanish    = 2
	SMSNationalLanguagePortuguese = 3
	SMSNationalLanguageBengali    = 4
	SMSNationalLanguageGujarati   = 5
	SMSNationalLanguageHindi      = 6
	SMSNationalLanguageKannada    = 7
	SMSNationalLanguageMalayalam  = 8
	SMSNationalLanguageOriya      = 9
	SMSNationalLanguagePunjabi    = 10
	SMSNationalLanguageTamil      = 11
	SMSNationalLanguageTelugu     = 12
	SMSNationalLanguageUrdu       = 13
)

const (
	smsUDHIEINationalLanguageSingleShift  byte = 0x24
	smsUDHIEINationalLanguageLockingShift byte = 0x25
)

var gsm7NationalLanguageSingleShiftTables = map[int][]rune{
	SMSNationalLanguageTurkish: mustGSM7Table(
		"          \u000c         ^                   {}     \\            [~] |      \u011e " +
			"\u0130         \u015e               \u00e7 \u20ac \u011f \u0131         \u015f" +
			"            ",
	),
	SMSNationalLanguageSpanish: mustGSM7Table(
		"         \u00e7\u000c         ^                   {}     \\            [~] |\u00c1  " +
			"     \u00cd     \u00d3     \u00da           \u00e1   \u20ac   \u00ed     \u00f3   " +
			"  \u00fa          ",
	),
	SMSNationalLanguagePortuguese: mustGSM7Table(
		"     \u00ea   \u00e7\u000c\u00d4\u00f4 \u00c1\u00e1  \u03a6\u0393^\u03a9\u03a0\u03a8\u03a3" +
			"\u0398     \u00ca        {}     \\            [~] |\u00c0       \u00cd     " +
			"\u00d3     \u00da     \u00c3\u00d5    \u00c2   \u20ac   \u00ed     \u00f3     " +
			"\u00fa     \u00e3\u00f5  \u00e2",
	),
	SMSNationalLanguageBengali: mustGSM7Table(
		"@\u00a3$\u00a5\u00bf\"\u00a4%&'\u000c*+ -/<=>\u00a1^\u00a1_#*\u09e6\u09e7 \u09e8\u09e9" +
			"\u09ea\u09eb\u09ec\u09ed\u09ee\u09ef\u09df\u09e0\u09e1\u09e2{}\u09e3\u09f2\u09f3" +
			"\u09f4\u09f5\\\u09f6\u09f7\u09f8\u09f9\u09fa       [~] |ABCDEFGHIJKLMNO" +
			"PQRSTUVWXYZ          \u20ac                          ",
	),
	SMSNationalLanguageGujarati: mustGSM7Table(
		"@\u00a3$\u00a5\u00bf\"\u00a4%&'\u000c*+ -/<=>\u00a1^\u00a1_#*\u0964\u0965 \u0ae6\u0ae7" +
			"\u0ae8\u0ae9\u0aea\u0aeb\u0aec\u0aed\u0aee\u0aef  {}     \\            [~] " +
			"|ABCDEFGHIJKLMNOPQRSTUVWXYZ          \u20ac                          ",
	),
	SMSNationalLanguageHindi: mustGSM7Table(
		"@\u00a3$\u00a5\u00bf\"\u00a4%&'\u000c*+ -/<=>\u00a1^\u00a1_#*\u0964\u0965 \u0966\u0967" +
			"\u0968\u0969\u096a\u096b\u096c\u096d\u096e\u096f\u0951\u0952{}\u0953\u0954\u0958" +
			"\u0959\u095a\\\u095b\u095c\u095d\u095e\u095f\u0960\u0961\u0962\u0963\u0970\u0971" +
			" [~] |ABCDEFGHIJKLMNOPQRSTUVWXYZ          \u20ac                          ",
	),
	SMSNationalLanguageKannada: mustGSM7Table(
		"@\u00a3$\u00a5\u00bf\"\u00a4%&'\u000c*+ -/<=>\u00a1^\u00a1_#*\u0964\u0965 \u0ce6\u0ce7" +
			"\u0ce8\u0ce9\u0cea\u0ceb\u0cec\u0ced\u0cee\u0cef\u0cde\u0cf1{}\u0cf2    \\        " +
			"    [~] |ABCDEFGHIJKLMNOPQRSTUVWXYZ          \u20ac                          ",
	),
	SMSNationalLanguageMalayalam: mustGSM7Table(
		"@\u00a3$\u00a5\u00bf\"\u00a4%&'\u000c*+ -/<=>\u00a1^\u00a1_#*\u0964\u0965 \u0d66\u0d67" +
			"\u0d68\u0d69\u0d6a\u0d6b\u0d6c\u0d6d\u0d6e\u0d6f\u0d70\u0d71{}\u0d72\u0d73\u0d74" +
			"\u0d75\u0d7a\\\u0d7b\u0d7c\u0d7d\u0d7e\u0d7f       [~] |ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
			"          \u20ac                          ",
	),
	SMSNationalLanguageOriya: mustGSM7Table(
		"@\u00a3$\u00a5\u00bf\"\u00a4%&'\u000c*+ -/<=>\u00a1^\u00a1_#*\u0964\u0965 \u0b66\u0b67" +
			"\u0b68\u0b69\u0b6a\u0b6b\u0b6c\u0b6d\u0b6e\u0b6f\u0b5c\u0b5d{}\u0b5f\u0b70\u0b71  " +
			"\\            [~] |ABCDEFGHIJKLMNOPQRSTUVWXYZ          \u20ac                     " +
			"     ",
	),
	SMSNationalLanguagePunjabi: mustGSM7Table(
		"@\u00a3$\u00a5\u00bf\"\u00a4%&'\u000c*+ -/<=>\u00a1^\u00a1_#*\u0964\u0965 \u0a66\u0a67" +
			"\u0a68\u0a69\u0a6a\u0a6b\u0a6c\u0a6d\u0a6e\u0a6f\u0a59\u0a5a{}\u0a5b\u0a5c\u0a5e" +
			"\u0a75 \\            [~] |ABCDEFGHIJKLMNOPQRSTUVWXYZ          \u20ac            " +
			"              ",
	),
	SMSNationalLanguageTamil: mustGSM7Table(
		"@\u00a3$\u00a5\u00bf\"\u00a4%&'\u000c*+ -/<=>\u00a1^\u00a1_#*\u0964\u0965 \u0be6\u0be7" +
			"\u0be8\u0be9\u0bea\u0beb\u0bec\u0bed\u0bee\u0bef\u0bf3\u0bf4{}\u0bf5\u0bf6\u0bf7" +
			"\u0bf8\u0bfa\\            [~] |ABCDEFGHIJKLMNOPQRSTUVWXYZ          \u20ac       " +
			"                   ",
	),
	SMSNationalLanguageTelugu: mustGSM7Table(
		"@\u00a3$\u00a5\u00bf\"\u00a4%&'\u000c*+ -/<=>\u00a1^\u00a1_#*   \u0c66\u0c67\u0c68\u0c69" +
			"\u0c6a\u0c6b\u0c6c\u0c6d\u0c6e\u0c6f\u0c58\u0c59{}\u0c78\u0c79\u0c7a\u0c7b\u0c7c\\" +
			"\u0c7d\u0c7e\u0c7f         [~] |ABCDEFGHIJKLMNOPQRSTUVWXYZ          \u20ac        " +
			"                  ",
	),
	SMSNationalLanguageUrdu: mustGSM7Table(
		"@\u00a3$\u00a5\u00bf\"\u00a4%&'\u000c*+ -/<=>\u00a1^\u00a1_#*\u0600\u0601 \u06f0\u06f1" +
			"\u06f2\u06f3\u06f4\u06f5\u06f6\u06f7\u06f8\u06f9\u060c\u060d{}\u060e\u060f\u0610" +
			"\u0611\u0612\\\u0613\u0614\u061b\u061f\u0640\u0652\u0658\u066b\u066c\u0672\u0673" +
			"\u06cd[~]\u06d4|ABCDEFGHIJKLMNOPQRSTUVWXYZ          \u20ac                          ",
	),
}

var gsm7NationalLanguageLockingTables = map[int][]rune{
	SMSNationalLanguageTurkish: mustGSM7Table(
		"@\u00a3$\u00a5\u20ac\u00e9\u00f9\u0131\u00f2\u00c7\n\u011e\u011f\r\u00c5\u00e5\u0394_" +
			"\u03a6\u0393\u039b\u03a9\u03a0\u03a8\u03a3\u0398\u039e\uffff\u015e\u015f\u00df" +
			"\u00c9 !\"#\u00a4%&'()*+,-./0123456789:;<=>?\u0130ABCDEFGHIJKLMNOPQRSTUVWXYZ" +
			"\u00c4\u00d6\u00d1\u00dc\u00a7\u00e7abcdefghijklmnopqrstuvwxyz\u00e4\u00f6\u00f1" +
			"\u00fc\u00e0",
	),
	SMSNationalLanguagePortuguese: mustGSM7Table(
		"@\u00a3$\u00a5\u00ea\u00e9\u00fa\u00ed\u00f3\u00e7\n\u00d4\u00f4\r\u00c1\u00e1\u0394_" +
			"\u00aa\u00c7\u00c0\u221e^\\\u20ac\u00d3|\uffff\u00c2\u00e2\u00ca\u00c9 !\"#\u00ba" +
			"%&'()*+,-./0123456789:;<=>?\u00cdABCDEFGHIJKLMNOPQRSTUVWXYZ\u00c3\u00d5\u00da\u00dc" +
			"\u00a7~abcdefghijklmnopqrstuvwxyz\u00e3\u00f5`\u00fc\u00e0",
	),
	SMSNationalLanguageBengali: mustGSM7Table(
		"\u0981\u0982\u0983\u0985\u0986\u0987\u0988\u0989\u098a\u098b\n\u098c \r \u098f\u0990" +
			"  \u0993\u0994\u0995\u0996\u0997\u0998\u0999\u099a\uffff\u099b\u099c\u099d\u099e" +
			" !\u099f\u09a0\u09a1\u09a2\u09a3\u09a4)(\u09a5\u09a6,\u09a7.\u09a80123456789:; " +
			"\u09aa\u09ab?\u09ac\u09ad\u09ae\u09af\u09b0 \u09b2   \u09b6\u09b7\u09b8\u09b9" +
			"\u09bc\u09bd\u09be\u09bf\u09c0\u09c1\u09c2\u09c3\u09c4  \u09c7\u09c8  \u09cb\u09cc" +
			"\u09cd\u09ceabcdefghijklmnopqrstuvwxyz\u09d7\u09dc\u09dd\u09f0\u09f1",
	),
	SMSNationalLanguageGujarati: mustGSM7Table(
		"\u0a81\u0a82\u0a83\u0a85\u0a86\u0a87\u0a88\u0a89\u0a8a\u0a8b\n\u0a8c\u0a8d\r \u0a8f\u0a90" +
			"\u0a91 \u0a93\u0a94\u0a95\u0a96\u0a97\u0a98\u0a99\u0a9a\uffff\u0a9b\u0a9c\u0a9d" +
			"\u0a9e !\u0a9f\u0aa0\u0aa1\u0aa2\u0aa3\u0aa4)(\u0aa5\u0aa6,\u0aa7.\u0aa80123456789:;" +
			" \u0aaa\u0aab?\u0aac\u0aad\u0aae\u0aaf\u0ab0 \u0ab2\u0ab3 \u0ab5\u0ab6\u0ab7\u0ab8" +
			"\u0ab9\u0abc\u0abd\u0abe\u0abf\u0ac0\u0ac1\u0ac2\u0ac3\u0ac4\u0ac5 \u0ac7\u0ac8" +
			"\u0ac9 \u0acb\u0acc\u0acd\u0ad0abcdefghijklmnopqrstuvwxyz\u0ae0\u0ae1\u0ae2\u0ae3" +
			"\u0af1",
	),
	SMSNationalLanguageHindi: mustGSM7Table(
		"\u0901\u0902\u0903\u0905\u0906\u0907\u0908\u0909\u090a\u090b\n\u090c\u090d\r\u090e\u090f" +
			"\u0910\u0911\u0912\u0913\u0914\u0915\u0916\u0917\u0918\u0919\u091a\uffff\u091b\u091c" +
			"\u091d\u091e !\u091f\u0920\u0921\u0922\u0923\u0924)(\u0925\u0926,\u0927.\u0928012345" +
			"6789:;\u0929\u092a\u092b?\u092c\u092d\u092e\u092f\u0930\u0931\u0932\u0933\u0934" +
			"\u0935\u0936\u0937\u0938\u0939\u093c\u093d\u093e\u093f\u0940\u0941\u0942\u0943\u0944" +
			"\u0945\u0946\u0947\u0948\u0949\u094a\u094b\u094c\u094d\u0950abcdefghijklmnopqrstuvwx" +
			"yz\u0972\u097b\u097c\u097e\u097f",
	),
	SMSNationalLanguageKannada: mustGSM7Table(
		" \u0c82\u0c83\u0c85\u0c86\u0c87\u0c88\u0c89\u0c8a\u0c8b\n\u0c8c \r\u0c8e\u0c8f\u0c90 " +
			"\u0c92\u0c93\u0c94\u0c95\u0c96\u0c97\u0c98\u0c99\u0c9a\uffff\u0c9b\u0c9c\u0c9d\u0c9e" +
			" !\u0c9f\u0ca0\u0ca1\u0ca2\u0ca3\u0ca4)(\u0ca5\u0ca6,\u0ca7.\u0ca80123456789:; " +
			"\u0caa\u0cab?\u0cac\u0cad\u0cae\u0caf\u0cb0\u0cb1\u0cb2\u0cb3 \u0cb5\u0cb6\u0cb7" +
			"\u0cb8\u0cb9\u0cbc\u0cbd\u0cbe\u0cbf\u0cc0\u0cc1\u0cc2\u0cc3\u0cc4 \u0cc6\u0cc7" +
			"\u0cc8 \u0cca\u0ccb\u0ccc\u0ccd\u0cd5abcdefghijklmnopqrstuvwxyz\u0cd6\u0ce0\u0ce1" +
			"\u0ce2\u0ce3",
	),
	SMSNationalLanguageMalayalam: mustGSM7Table(
		" \u0d02\u0d03\u0d05\u0d06\u0d07\u0d08\u0d09\u0d0a\u0d0b\n\u0d0c \r\u0d0e\u0d0f\u0d10 " +
			"\u0d12\u0d13\u0d14\u0d15\u0d16\u0d17\u0d18\u0d19\u0d1a\uffff\u0d1b\u0d1c\u0d1d\u0d1e" +
			" !\u0d1f\u0d20\u0d21\u0d22\u0d23\u0d24)(\u0d25\u0d26,\u0d27.\u0d280123456789:; " +
			"\u0d2a\u0d2b?\u0d2c\u0d2d\u0d2e\u0d2f\u0d30\u0d31\u0d32\u0d33\u0d34\u0d35\u0d36" +
			"\u0d37\u0d38\u0d39 \u0d3d\u0d3e\u0d3f\u0d40\u0d41\u0d42\u0d43\u0d44 \u0d46\u0d47" +
			"\u0d48 \u0d4a\u0d4b\u0d4c\u0d4d\u0d57abcdefghijklmnopqrstuvwxyz\u0d60\u0d61\u0d62" +
			"\u0d63\u0d79",
	),
	SMSNationalLanguageOriya: mustGSM7Table(
		"\u0b01\u0b02\u0b03\u0b05\u0b06\u0b07\u0b08\u0b09\u0b0a\u0b0b\n\u0b0c \r \u0b0f\u0b10  " +
			"\u0b13\u0b14\u0b15\u0b16\u0b17\u0b18\u0b19\u0b1a\uffff\u0b1b\u0b1c\u0b1d\u0b1e !" +
			"\u0b1f\u0b20\u0b21\u0b22\u0b23\u0b24)(\u0b25\u0b26,\u0b27.\u0b280123456789:; \u0b2a" +
			"\u0b2b?\u0b2c\u0b2d\u0b2e\u0b2f\u0b30 \u0b32\u0b33 \u0b35\u0b36\u0b37\u0b38\u0b39" +
			"\u0b3c\u0b3d\u0b3e\u0b3f\u0b40\u0b41\u0b42\u0b43\u0b44  \u0b47\u0b48  \u0b4b\u0b4c" +
			"\u0b4d\u0b56abcdefghijklmnopqrstuvwxyz\u0b57\u0b60\u0b61\u0b62\u0b63",
	),
	SMSNationalLanguagePunjabi: mustGSM7Table(
		"\u0a01\u0a02\u0a03\u0a05\u0a06\u0a07\u0a08\u0a09\u0a0a \n  \r \u0a0f\u0a10  \u0a13\u0a14" +
			"\u0a15\u0a16\u0a17\u0a18\u0a19\u0a1a\uffff\u0a1b\u0a1c\u0a1d\u0a1e !\u0a1f\u0a20" +
			"\u0a21\u0a22\u0a23\u0a24)(\u0a25\u0a26,\u0a27.\u0a280123456789:; \u0a2a\u0a2b?\u0a2c" +
			"\u0a2d\u0a2e\u0a2f\u0a30 \u0a32\u0a33 \u0a35\u0a36 \u0a38\u0a39\u0a3c \u0a3e\u0a3f" +
			"\u0a40\u0a41\u0a42    \u0a47\u0a48  \u0a4b\u0a4c\u0a4d\u0a51abcdefghijklmnopqrstuvwx" +
			"yz\u0a70\u0a71\u0a72\u0a73\u0a74",
	),
	SMSNationalLanguageTamil: mustGSM7Table(
		" \u0b82\u0b83\u0b85\u0b86\u0b87\u0b88\u0b89\u0b8a \n  \r\u0b8e\u0b8f\u0b90 \u0b92\u0b93" +
			"\u0b94\u0b95   \u0b99\u0b9a\uffff \u0b9c \u0b9e !\u0b9f   \u0ba3\u0ba4)(  , .\u0ba8" +
			"0123456789:;\u0ba9\u0baa ?  \u0bae\u0baf\u0bb0\u0bb1\u0bb2\u0bb3\u0bb4\u0bb5\u0bb6" +
			"\u0bb7\u0bb8\u0bb9  \u0bbe\u0bbf\u0bc0\u0bc1\u0bc2   \u0bc6\u0bc7\u0bc8 \u0bca\u0bcb" +
			"\u0bcc\u0bcd\u0bd0abcdefghijklmnopqrstuvwxyz\u0bd7\u0bf0\u0bf1\u0bf2\u0bf9",
	),
	SMSNationalLanguageTelugu: mustGSM7Table(
		"\u0c01\u0c02\u0c03\u0c05\u0c06\u0c07\u0c08\u0c09\u0c0a\u0c0b\n\u0c0c \r\u0c0e\u0c0f\u0c10" +
			" \u0c12\u0c13\u0c14\u0c15\u0c16\u0c17\u0c18\u0c19\u0c1a\uffff\u0c1b\u0c1c\u0c1d" +
			"\u0c1e !\u0c1f\u0c20\u0c21\u0c22\u0c23\u0c24)(\u0c25\u0c26,\u0c27.\u0c280123456789:;" +
			" \u0c2a\u0c2b?\u0c2c\u0c2d\u0c2e\u0c2f\u0c30\u0c31\u0c32\u0c33 \u0c35\u0c36\u0c37" +
			"\u0c38\u0c39 \u0c3d\u0c3e\u0c3f\u0c40\u0c41\u0c42\u0c43\u0c44 \u0c46\u0c47\u0c48 " +
			"\u0c4a\u0c4b\u0c4c\u0c4d\u0c55abcdefghijklmnopqrstuvwxyz\u0c56\u0c60\u0c61\u0c62" +
			"\u0c63",
	),
	SMSNationalLanguageUrdu: mustGSM7Table(
		"\u0627\u0622\u0628\u067b\u0680\u067e\u06a6\u062a\u06c2\u067f\n\u0679\u067d\r\u067a\u067c" +
			"\u062b\u062c\u0681\u0684\u0683\u0685\u0686\u0687\u062d\u062e\u062f\uffff\u068c\u0688" +
			"\u0689\u068a !\u068f\u068d\u0630\u0631\u0691\u0693)(\u0699\u0632,\u0696.\u0698012345" +
			"6789:;\u069a\u0633\u0634?\u0635\u0636\u0637\u0638\u0639\u0641\u0642\u06a9\u06aa" +
			"\u06ab\u06af\u06b3\u06b1\u0644\u0645\u0646\u06ba\u06bb\u06bc\u0648\u06c4\u06d5\u06c1" +
			"\u06be\u0621\u06cc\u06d0\u06d2\u064d\u0650\u064f\u0657\u0654abcdefghijklmnopqrstuvwx" +
			"yz\u0655\u0651\u0653\u0656\u0670",
	),
}

func mustGSM7Table(s string) []rune {
	table := []rune(s)
	if len(table) != 128 {
		panic("GSM 7-bit national language table must contain 128 entries")
	}
	return table
}

func smsNationalLanguageIdentifierKnown(lang int) bool {
	return lang >= SMSNationalLanguageTurkish && lang <= SMSNationalLanguageUrdu
}

func gsm7LockingTable(lang int) []rune {
	if table, ok := gsm7NationalLanguageLockingTables[lang]; ok {
		return table
	}
	return gsm7BasicAlphabet
}

func gsm7SingleShiftTable(lang int) []rune {
	if table, ok := gsm7NationalLanguageSingleShiftTables[lang]; ok {
		return table
	}
	return gsm7DefaultSingleShiftTable
}

var gsm7DefaultSingleShiftTable = mustGSM7Table(
	"          \u000c         ^                   {}     \\            [~] |               " +
		"                     \u20ac                          ",
)

func gsm7LockingCode(r rune, lang int) (byte, bool) {
	table := gsm7LockingTable(lang)
	if r == ' ' && len(table) > 0x20 && table[0x20] == ' ' {
		return 0x20, true
	}
	for i, candidate := range table {
		if candidate == r && candidate != '\uffff' {
			return byte(i), true
		}
	}
	return 0, false
}

func gsm7SingleShiftCode(r rune, lang int) (byte, bool) {
	for i, candidate := range gsm7SingleShiftTable(lang) {
		if candidate == r && candidate != ' ' && candidate != '\uffff' {
			return byte(i), true
		}
	}
	return 0, false
}

func gsm7LockingRune(code byte, lang int) (rune, bool) {
	table := gsm7LockingTable(lang)
	if int(code) >= len(table) || table[code] == '\uffff' {
		return 0, false
	}
	return table[code], true
}

func gsm7SingleShiftRune(code byte, lang int) (rune, bool) {
	table := gsm7SingleShiftTable(lang)
	if int(code) >= len(table) || table[code] == ' ' || table[code] == '\uffff' {
		return 0, false
	}
	return table[code], true
}
