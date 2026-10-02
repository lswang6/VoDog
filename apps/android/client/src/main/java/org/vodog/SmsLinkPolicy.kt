package org.vodog

/**
 * S87：短信正文里的链接识别。正则与 Web / iOS 字面一致（见 docs/specs/S87-sms-link-open-confirm.md），
 * 纯 Kotlin，方便 JVM 单测。
 */
internal object SmsLinkPolicy {
    data class Link(val start: Int, val end: Int, val url: String)

    private val pattern = Regex(
        """https?://[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+|(?<![@A-Za-z0-9.\-/:])(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+(?:com|cn|net|org|top|xyz|cc|vip|info|me|io|co|app|shop|link)(?![A-Za-z0-9-])(?::\d+)?(?:/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]*)?""",
        RegexOption.IGNORE_CASE,
    )
    private const val TRAILING = ".,;:!?'\")]}*"
    private val scheme = Regex("^https?://", RegexOption.IGNORE_CASE)

    /** 按出现顺序返回链接；[Link.end] 不含（去掉末尾标点之后的）。 */
    fun detect(text: String): List<Link> = pattern.findAll(text).mapNotNull { match ->
        val raw = match.value.trimEnd { it in TRAILING }
        val bare = scheme.replace(raw, "")
        if (bare.isEmpty()) return@mapNotNull null
        val url = if (bare.length == raw.length) "http://$raw" else raw
        Link(match.range.first, match.range.first + raw.length, url)
    }.toList()

    /** 打开前的二次校验：短信正文不可信，只放行 http / https。 */
    fun isOpenable(url: String): Boolean = scheme.containsMatchIn(url) && url.length > url.indexOf("://") + 3
}
