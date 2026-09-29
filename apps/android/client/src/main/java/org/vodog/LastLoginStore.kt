package org.vodog

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** The last account that signed in on this device. The password is only ever read back into the login form. */
data class LastLogin(val username: String, val password: String)

/**
 * S22 决策 11: the login form remembers the last username and password across 退出登录.
 *
 * Deliberately a *separate* store from [SessionVault], not another field inside it: `logout()` clears
 * the session vault (prefs + its KeyStore alias) and the whole point of this entry is to survive that.
 * It therefore has its own prefs file and its own AES/GCM key alias, and nothing in the logout path
 * touches it. Same protection as the session token — hardware-backed AES/GCM in the AndroidKeyStore,
 * app-private prefs — but the contents are a reusable credential, so [clear] exists for an explicit
 * "forget me". It never leaves the device: the manifest sets `android:allowBackup="false"` on the
 * whole application, and the AES key lives in the AndroidKeyStore and is not exportable, so even a
 * ciphertext that somehow escaped could not be decrypted anywhere else.
 */
class LastLoginStore internal constructor(private val blobs: LastLoginBlobStore) {

    fun read(): LastLogin? = decodeLastLogin(blobs.read())

    /** After a password login: both halves are known. */
    fun save(username: String, password: String) {
        val trimmed = username.trim()
        if (trimmed.isEmpty() || password.isEmpty()) return
        blobs.write(encodeLastLogin(LastLogin(trimmed, password)))
    }

    /**
     * After a Passkey login: the password was never typed, so only the username is refreshed and any
     * stored password for the *same* account is kept. A different account replaces the entry and
     * stores no password, so the form cannot offer one account's password for another's name.
     */
    fun saveUsername(username: String) {
        val trimmed = username.trim()
        if (trimmed.isEmpty()) return
        val existing = read()
        val password = if (existing?.username == trimmed) existing.password else ""
        blobs.write(encodeLastLogin(LastLogin(trimmed, password)))
    }

    fun clear() = blobs.clear()

    companion object {
        fun create(context: Context): LastLoginStore = LastLoginStore(KeystoreLastLoginBlobStore(context))
    }
}

/** The sealed-bytes side of [LastLoginStore]; a fake implementation makes the store unit-testable. */
internal interface LastLoginBlobStore {
    fun read(): String?
    fun write(blob: String)
    fun clear()
}

/**
 * `username` and `password` joined by NUL. The separator cannot occur in either field (both come from a text field
 * that cannot produce NUL), so the split is unambiguous and no JSON parser is needed for two strings.
 */
internal fun encodeLastLogin(value: LastLogin): String = "${value.username}\u0000${value.password}"

internal fun decodeLastLogin(raw: String?): LastLogin? {
    val parts = raw?.split('\u0000') ?: return null
    if (parts.size != 2 || parts[0].isEmpty()) return null
    return LastLogin(parts[0], parts[1])
}

/** AES/GCM in the AndroidKeyStore under its own alias, mirroring [SessionVault]'s scheme. */
private class KeystoreLastLoginBlobStore(context: Context) : LastLoginBlobStore {
    private val prefs = context.getSharedPreferences("last_login_vault", Context.MODE_PRIVATE)

    override fun read(): String? = runCatching {
        val ciphertext = prefs.getString("ciphertext", null) ?: return null
        val iv = prefs.getString("iv", null) ?: return null
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
        cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP)).toString(Charsets.UTF_8)
    }.getOrNull()

    override fun write(blob: String) {
        runCatching {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            prefs.edit()
                .putString("ciphertext", Base64.encodeToString(cipher.doFinal(blob.toByteArray()), Base64.NO_WRAP))
                .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .apply()
        }
    }

    override fun clear() {
        prefs.edit().clear().apply()
        runCatching { keyStore().deleteEntry(ALIAS) }
    }

    private fun secretKey(): SecretKey {
        val store = keyStore()
        (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
            generateKey()
        }
    }

    private fun keyStore() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private companion object {
        const val ALIAS = "vodog_last_login"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
