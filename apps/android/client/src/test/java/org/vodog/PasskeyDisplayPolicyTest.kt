package org.vodog

import org.vodog.PasskeyDisplayPolicy.Icon
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PasskeyDisplayPolicyTest {
    private fun item(
        deviceType: String? = null,
        backedUp: Boolean? = null,
        label: String? = null,
        displayName: String? = null,
        clientPlatform: String? = null,
        authenticatorAttachment: String? = null,
        lastUsedAt: String? = null,
    ) = PasskeyItem(
        id = "cred-1",
        createdAt = "2026-01-02T03:04:05.000Z",
        deviceType = deviceType,
        backedUp = backedUp,
        transports = null,
        label = label,
        displayName = displayName,
        aaguid = null,
        clientPlatform = clientPlatform,
        authenticatorAttachment = authenticatorAttachment,
        lastUsedAt = lastUsedAt,
    )

    @Test
    fun ownLabelBeatsDisplayNameWhichBeatsDeviceType() {
        val full = item(label = "我的手机", displayName = "iCloud Keychain", deviceType = "multiDevice")
        assertEquals("我的手机", PasskeyDisplayPolicy.resolvedName(full))
        assertEquals("iCloud Keychain", PasskeyDisplayPolicy.resolvedName(full.copy(label = null)))
        assertEquals(
            "multiDevice",
            PasskeyDisplayPolicy.resolvedName(full.copy(label = null, displayName = null)),
        )
    }

    @Test
    fun blankNamesFallThroughToTheGenericTitle() {
        assertEquals("Passkey", PasskeyDisplayPolicy.resolvedName(item()))
        assertEquals("Passkey", PasskeyDisplayPolicy.resolvedName(item(label = "   ", displayName = "")))
        // A whitespace-only label must not hide a usable displayName.
        assertEquals(
            "Windows Hello",
            PasskeyDisplayPolicy.resolvedName(item(label = "  \t ", displayName = "Windows Hello")),
        )
        // Labels are trimmed for display, not stored with their padding.
        assertEquals("办公笔记本", PasskeyDisplayPolicy.resolvedName(item(label = "  办公笔记本  ")))
    }

    @Test
    fun platformSummaryJoinsAttachmentSyncAndPlatform() {
        assertEquals(
            "本机 · 已同步 · Chrome on macOS",
            PasskeyDisplayPolicy.platformSummary(
                item(authenticatorAttachment = "platform", backedUp = true, clientPlatform = "Chrome on macOS"),
            ),
        )
        assertEquals(
            "跨设备 · YubiKey",
            PasskeyDisplayPolicy.platformSummary(
                item(authenticatorAttachment = "cross-platform", backedUp = false, clientPlatform = "YubiKey"),
            ),
        )
        assertEquals("本机", PasskeyDisplayPolicy.platformSummary(item(authenticatorAttachment = "platform")))
        assertEquals("已同步", PasskeyDisplayPolicy.platformSummary(item(backedUp = true)))
        assertEquals("iOS App", PasskeyDisplayPolicy.platformSummary(item(clientPlatform = "  iOS App  ")))
    }

    @Test
    fun platformSummaryFallsBackToDeviceTypeThenPasskey() {
        assertEquals("multiDevice", PasskeyDisplayPolicy.platformSummary(item(deviceType = "multiDevice")))
        assertEquals("Passkey", PasskeyDisplayPolicy.platformSummary(item()))
        // An unrecognised attachment value contributes nothing, so the fallback still applies.
        assertEquals(
            "Passkey",
            PasskeyDisplayPolicy.platformSummary(item(authenticatorAttachment = "unknown", clientPlatform = "  ")),
        )
    }

    @Test
    fun platformAttachmentAlwaysWinsTheIcon() {
        // Even a desktop browser label yields the phone icon when the authenticator is on-device.
        assertEquals(
            Icon.PHONE,
            PasskeyDisplayPolicy.icon(
                item(authenticatorAttachment = "platform", clientPlatform = "Chrome on Windows", backedUp = true),
            ),
        )
    }

    @Test
    fun appPlatformsGetThePhoneIconCaseInsensitively() {
        assertEquals(Icon.PHONE, PasskeyDisplayPolicy.icon(item(clientPlatform = "iOS App")))
        assertEquals(Icon.PHONE, PasskeyDisplayPolicy.icon(item(clientPlatform = "android app")))
        assertEquals(Icon.PHONE, PasskeyDisplayPolicy.icon(item(clientPlatform = "ANDROID APP", backedUp = true)))
    }

    @Test
    fun desktopHintsGetTheLaptopIcon() {
        listOf("macOS", "Windows", "Linux", "Chrome", "Edge", "Firefox", "Safari").forEach { hint ->
            assertEquals(hint, Icon.LAPTOP, PasskeyDisplayPolicy.icon(item(clientPlatform = "Foo on $hint")))
        }
        assertEquals(Icon.LAPTOP, PasskeyDisplayPolicy.icon(item(clientPlatform = "chrome on MACOS", backedUp = true)))
    }

    @Test
    fun syncedCredentialsWithoutAPlatformHintGetTheCloudIcon() {
        assertEquals(Icon.CLOUD_KEY, PasskeyDisplayPolicy.icon(item(backedUp = true)))
        assertEquals(Icon.CLOUD_KEY, PasskeyDisplayPolicy.icon(item(backedUp = true, clientPlatform = "浏览器")))
        assertEquals(
            Icon.CLOUD_KEY,
            PasskeyDisplayPolicy.icon(item(backedUp = true, authenticatorAttachment = "cross-platform")),
        )
    }

    @Test
    fun everythingElseGetsThePlainKeyIcon() {
        assertEquals(Icon.KEY, PasskeyDisplayPolicy.icon(item()))
        assertEquals(Icon.KEY, PasskeyDisplayPolicy.icon(item(backedUp = false, clientPlatform = "浏览器")))
        assertEquals(Icon.KEY, PasskeyDisplayPolicy.icon(item(authenticatorAttachment = "cross-platform")))
    }

    @Test
    fun normalizedLabelAcceptsOneToSixtyFourTrimmedCharacters() {
        assertEquals(64, PasskeyDisplayPolicy.LABEL_LIMIT)
        assertNull("empty", PasskeyDisplayPolicy.normalizedLabel(""))
        assertNull("whitespace only", PasskeyDisplayPolicy.normalizedLabel("   \t\n "))
        assertEquals("a", PasskeyDisplayPolicy.normalizedLabel("a"))
        assertEquals("a", PasskeyDisplayPolicy.normalizedLabel("  a  "))
        val exactly64 = "x".repeat(64)
        assertEquals(exactly64, PasskeyDisplayPolicy.normalizedLabel(exactly64))
        // Trimming happens before the length check, so padding never pushes a valid name over.
        assertEquals(exactly64, PasskeyDisplayPolicy.normalizedLabel("  $exactly64  "))
        assertNull("65 chars", PasskeyDisplayPolicy.normalizedLabel("x".repeat(65)))
    }

    @Test
    fun labelValidationMessageNamesTheBound() {
        assertEquals("名称需为 1–64 个字符", PasskeyDisplayPolicy.LABEL_VALIDATION_MESSAGE)
    }
}
