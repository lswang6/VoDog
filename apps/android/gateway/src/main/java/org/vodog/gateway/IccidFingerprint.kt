package org.vodog.gateway

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey

internal val SIM_ICCID_PATTERN = Regex("[0-9]{16,32}[Ff]?")

internal fun readableIccid(value: String?): String? =
    value?.trim()?.takeIf { SIM_ICCID_PATTERN.matches(it) }

/**
 * S65 portable ICCID identity, identical on every gateway (CellDock S53 uses the same rule):
 * lower-hex SHA-256 of the ICCID's digits only, first 32 characters. No device key.
 */
internal fun portableIccidFingerprint(iccid: String): String {
    require(SIM_ICCID_PATTERN.matches(iccid)) { "invalid ICCID" }
    val digits = iccid.filter { it in '0'..'9' }
    return java.security.MessageDigest.getInstance("SHA-256")
        .digest(digits.toByteArray(Charsets.UTF_8))
        .joinToString("") { "%02x".format(it) }
        .take(32)
}

/** Derives a local, non-reversible SIM identifier without persisting or returning raw ICCID. */
class IccidFingerprint internal constructor(private val keyOverride: SecretKey?) {
    constructor() : this(null)

    /** Pre-S65 per-device ICCID HMAC; only sent as `legacyIccidFingerprint` so Control can re-key in place. */
    fun derive(iccid: String): String {
        require(iccid.length >= 16) { "invalid ICCID" }
        require(SIM_ICCID_PATTERN.matches(iccid)) { "invalid ICCID" }
        return deriveDomain("iccid", iccid)
    }

    fun deriveCardId(cardId: Int): String {
        require(cardId >= 0) { "invalid card id" }
        return deriveDomain("card-id", cardId.toString())
    }

    fun deriveFallback(slotIndex: Int, subscriptionId: Int, iccIdHashCode: Int): String {
        return deriveDomain("fallback", "$slotIndex\u0000$subscriptionId\u0000$iccIdHashCode")
    }

    fun derivePhoneAccount(stableHandle: String): String {
        require(stableHandle.isNotBlank())
        return "pa:${deriveDomain("phone-account", stableHandle)}"
    }

    internal fun deriveDomain(domain: String, value: String): String {
        require(domain.isNotBlank())
        return Mac.getInstance(ALGORITHM).run {
            init(keyOverride ?: key())
            doFinal("$domain\u0000$value".toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(ALGORITHM, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .build()
            )
            generateKey()
        }
    }

    private companion object {
        const val ALIAS = "vodog_gateway_iccid_hmac_v1"
        const val ALGORITHM = KeyProperties.KEY_ALGORITHM_HMAC_SHA256
    }
}
