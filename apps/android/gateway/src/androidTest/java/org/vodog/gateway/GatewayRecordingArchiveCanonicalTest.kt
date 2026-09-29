package org.vodog.gateway

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/** Runs against Android's platform org.json, whose JSONObject.quote escapes '/'. */
@RunWith(AndroidJUnit4::class)
class GatewayRecordingArchiveCanonicalTest {
    @Test fun explicitCodecMatchesJavascriptDespitePlatformSlashEscaping() {
        val value = JSONObject()
            .put("slash", "https://x/y</z>")
            .put("controls", "\b\u000c\n\r\t\u0000")
            .put("unicode", "測試🐕")
            .put("lone", "\uD800")
            .put("integer", -0.0)

        assertEquals(
            "{\"controls\":\"\\b\\f\\n\\r\\t\\u0000\",\"integer\":0,\"lone\":\"\\ud800\",\"slash\":\"https://x/y</z>\",\"unicode\":\"測試🐕\"}",
            canonicalJson(value),
        )
        assertEquals("228a707ccc9476286a9d9ba332f45c9318836388a8c9dd0859b6d953b7a57c8a", canonicalFingerprint(value))
        assertEquals("5944e9de9670c227caaaf8f41f7c393fd75af5093172a48a4a243442da1f6e41", legacySlashEscapedCanonicalFingerprint(value))
    }
}
