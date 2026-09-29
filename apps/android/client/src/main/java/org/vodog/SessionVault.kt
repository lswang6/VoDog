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

data class Session(val token: String, val refreshToken: String, val username: String, val role: String = "")

class SessionVault(context: Context) {
    private val prefs = context.getSharedPreferences("session_vault", Context.MODE_PRIVATE)

    fun save(session: Session) {
        val plain = listOf(session.token, session.refreshToken, session.username, session.role).joinToString("\u0000")
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        prefs.edit()
            .putString("ciphertext", Base64.encodeToString(cipher.doFinal(plain.toByteArray()), Base64.NO_WRAP))
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP)).apply()
    }

    fun read(): Session? = runCatching {
        val ciphertext = prefs.getString("ciphertext", null) ?: return null
        val iv = prefs.getString("iv", null) ?: return null
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
        val parts = cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP))
            .toString(Charsets.UTF_8).split('\u0000')
        if (parts.size !in 3..4) return null
        Session(parts[0], parts[1], parts[2], parts.getOrElse(3) { "" })
    }.getOrNull()

    fun clear() {
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

    companion object {
        private const val ALIAS = "vodog_client_session"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
