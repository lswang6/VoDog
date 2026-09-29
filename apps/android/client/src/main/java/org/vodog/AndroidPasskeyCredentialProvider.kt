package org.vodog

import android.content.Context
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.NoCredentialException

internal interface PasskeyCredentialProvider {
    suspend fun create(requestJson: String): String
    suspend fun get(requestJson: String): String
}

internal class PasskeyCredentialException(
    message: String,
    val cancelled: Boolean = false,
) : Exception(message)

internal class AndroidPasskeyCredentialProvider(context: Context) : PasskeyCredentialProvider {
    private val manager = CredentialManager.create(context.applicationContext)
    private var foregroundContext: Context = context

    fun updateContext(context: Context) {
        foregroundContext = context
    }

    override suspend fun create(requestJson: String): String {
        return try {
            val response = manager.createCredential(
                context = foregroundContext,
                request = CreatePublicKeyCredentialRequest(requestJson = requestJson),
            )
            (response as? CreatePublicKeyCredentialResponse)?.registrationResponseJson
                ?: throw PasskeyCredentialException("系统凭据服务没有返回通行密钥注册结果")
        } catch (error: CreateCredentialException) {
            throw error.asPasskeyFailure("无法创建通行密钥")
        }
    }

    override suspend fun get(requestJson: String): String {
        return try {
            val result = manager.getCredential(
                context = foregroundContext,
                request = GetCredentialRequest(
                    credentialOptions = listOf(
                        GetPublicKeyCredentialOption(requestJson = requestJson),
                    ),
                ),
            )
            (result.credential as? PublicKeyCredential)?.authenticationResponseJson
                ?: throw PasskeyCredentialException("系统凭据服务没有返回通行密钥")
        } catch (_: NoCredentialException) {
            throw PasskeyCredentialException("此账号没有可用的通行密钥")
        } catch (error: GetCredentialException) {
            throw error.asPasskeyFailure("无法使用通行密钥")
        }
    }

    private fun Exception.asPasskeyFailure(fallback: String): PasskeyCredentialException {
        val name = javaClass.simpleName
        val cancelled = name.contains("Cancellation", ignoreCase = true) ||
            name.contains("Interrupted", ignoreCase = true)
        val message = when {
            cancelled -> "已取消通行密钥操作"
            name.contains("NoCredential", ignoreCase = true) -> "此账号没有可用的通行密钥"
            name.contains("ProviderConfiguration", ignoreCase = true) -> "设备缺少可用的系统凭据服务"
            else -> fallback
        }
        return PasskeyCredentialException(message, cancelled)
    }
}
