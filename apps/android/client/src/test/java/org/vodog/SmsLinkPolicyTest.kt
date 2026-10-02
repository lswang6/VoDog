package org.vodog

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** S87 共同测试向量，逐条照抄 docs/specs/S87-sms-link-open-confirm.md。 */
class SmsLinkPolicyTest {
    private val vectors = listOf(
        "验证码见 https://a.com/x?y=1，请查收" to listOf("https://a.com/x?y=1"),
        "点击 t.cn/A6abc 退订回T" to listOf("http://t.cn/A6abc"),
        "访问 www.10086.cn。" to listOf("http://www.10086.cn"),
        "(详见 https://x.org/a)." to listOf("https://x.org/a"),
        "两个链接 https://a.cn 和 b.com/c" to listOf("https://a.cn", "http://b.com/c"),
        "HTTP://EXAMPLE.COM/A" to listOf("HTTP://EXAMPLE.COM/A"),
        "邮箱 foo@bar.com" to emptyList(),
        "版本 3.5.1 价格 12.50" to emptyList(),
        "abc.community" to emptyList(),
        "ftp://x.com" to emptyList(),
        "https://" to emptyList(),
        "" to emptyList(),
    )

    @Test fun specVectors() {
        for ((text, expected) in vectors) {
            assertEquals(text, expected, SmsLinkPolicy.detect(text).map { it.url })
        }
    }

    @Test fun rangesExcludeTrimmedPunctuationAndMissingScheme() {
        val text = "(详见 https://x.org/a)."
        val link = SmsLinkPolicy.detect(text).single()
        assertEquals("https://x.org/a", text.substring(link.start, link.end))
        val bare = "点击 t.cn/A6abc 退订回T"
        val short = SmsLinkPolicy.detect(bare).single()
        assertEquals("t.cn/A6abc", bare.substring(short.start, short.end))
    }

    @Test fun everyDetectedUrlIsOpenable() {
        for ((text, _) in vectors) SmsLinkPolicy.detect(text).forEach { assertTrue(it.url, SmsLinkPolicy.isOpenable(it.url)) }
    }

    @Test fun openGuardRejectsNonHttpSchemes() {
        assertTrue(SmsLinkPolicy.isOpenable("HTTP://EXAMPLE.COM/A"))
        assertTrue(SmsLinkPolicy.isOpenable("https://a.com"))
        assertFalse(SmsLinkPolicy.isOpenable("javascript:alert(1)"))
        assertFalse(SmsLinkPolicy.isOpenable("ftp://x.com"))
        assertFalse(SmsLinkPolicy.isOpenable("https://"))
        assertFalse(SmsLinkPolicy.isOpenable("intent://x.com#Intent;end"))
        assertFalse(SmsLinkPolicy.isOpenable(""))
    }
}
