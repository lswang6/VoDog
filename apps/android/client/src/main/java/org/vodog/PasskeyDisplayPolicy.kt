package org.vodog

/**
 * Pure display logic for the Passkey list (S19 port of `apps/ios/VoDog/PasskeyDisplayPolicy.swift`).
 *
 * Every field on [PasskeyItem] is optional because rows registered before the S18 metadata
 * migration carry nulls, so each accessor has to degrade to something a user can still read.
 * Kept free of Compose/Android types so it is unit-testable on the plain JVM.
 */
object PasskeyDisplayPolicy {
    /** Icons the UI maps to concrete Material symbols; ordered by the precedence [icon] applies. */
    enum class Icon { PHONE, LAPTOP, CLOUD_KEY, KEY }

    const val LABEL_LIMIT = 64
    const val LABEL_VALIDATION_MESSAGE = "名称需为 1–64 个字符"

    /** Substrings in `clientPlatform` that mean "a browser or desktop OS", not a phone. */
    internal val DESKTOP_PLATFORM_HINTS =
        listOf("macOS", "Windows", "Linux", "Chrome", "Edge", "Firefox", "Safari")

    private val PHONE_PLATFORM_HINTS = listOf("iOS App", "Android App")

    private fun trimmed(value: String?): String? = value?.trim()?.takeIf(String::isNotEmpty)

    /** `deviceType`, or the generic fallback — mirrors iOS `PasskeyItem.deviceTypeTitle`. */
    fun deviceTypeTitle(item: PasskeyItem): String = trimmed(item.deviceType) ?: "Passkey"

    /** The user's own label wins over the server-derived name, which wins over the device type. */
    fun resolvedName(item: PasskeyItem): String =
        trimmed(item.label) ?: trimmed(item.displayName) ?: deviceTypeTitle(item)

    /** "本机 · 已同步 · Chrome on macOS"-style caption; never empty. */
    fun platformSummary(item: PasskeyItem): String {
        val parts = buildList {
            when (item.authenticatorAttachment) {
                "platform" -> add("本机")
                "cross-platform" -> add("跨设备")
            }
            if (item.backedUp == true) add("已同步")
            trimmed(item.clientPlatform)?.let(::add)
        }
        return if (parts.isEmpty()) deviceTypeTitle(item) else parts.joinToString(" · ")
    }

    fun icon(item: PasskeyItem): Icon {
        if (item.authenticatorAttachment == "platform") return Icon.PHONE
        val platform = trimmed(item.clientPlatform)
        if (platform != null) {
            if (PHONE_PLATFORM_HINTS.any { platform.contains(it, ignoreCase = true) }) return Icon.PHONE
            if (DESKTOP_PLATFORM_HINTS.any { platform.contains(it, ignoreCase = true) }) return Icon.LAPTOP
        }
        if (item.backedUp == true) return Icon.CLOUD_KEY
        return Icon.KEY
    }

    /**
     * Rename validation, identical to the server's `z.string().trim().min(1).max(64)`:
     * returns the trimmed label, or null when it is empty or longer than [LABEL_LIMIT].
     */
    fun normalizedLabel(text: String): String? =
        text.trim().takeIf { it.isNotEmpty() && it.length <= LABEL_LIMIT }
}
