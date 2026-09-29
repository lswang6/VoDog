package org.vodog

import android.content.Context
import java.io.Closeable
import java.util.concurrent.CopyOnWriteArraySet
import java.util.UUID

internal sealed interface ProcessSessionEvent {
    data class Changed(val session: Session?) : ProcessSessionEvent
    data object Invalidated : ProcessSessionEvent
}

/** One refresh-token coordinator for the UI, push receiver and ongoing-call service process. */
internal object ClientSessionProcess {
    private val listeners = CopyOnWriteArraySet<(ProcessSessionEvent) -> Unit>()
    @Volatile private var runtime: Runtime? = null

    fun coordinator(context: Context): SessionCoordinator = runtime(context).coordinator

    fun generation(context: Context): String? = runtime(context).generationStore.current()

    @Synchronized
    fun installNew(context: Context, expectedEpoch: Long, session: Session): Boolean {
        val active = runtime(context)
        if (!active.coordinator.isCurrent(expectedEpoch)) return false
        val previous = active.generationStore.current()
        active.generationStore.replace()
        if (active.coordinator.install(expectedEpoch, session)) return true
        active.generationStore.restore(previous)
        return false
    }

    fun listen(listener: (ProcessSessionEvent) -> Unit): Closeable {
        listeners += listener
        return Closeable { listeners -= listener }
    }

    @Synchronized
    private fun runtime(context: Context): Runtime {
        runtime?.let { return it }
        val app = context.applicationContext
        val vault = SessionVault(app)
        val generationStore = SessionGenerationStore(app).also {
            if (vault.read() == null) it.clear() else it.ensure()
        }
        return Runtime(
            vault,
            SessionCoordinator(
                initialSession = vault.read(),
                onSessionChanged = { session ->
                    if (session == null) {
                        vault.clear()
                        generationStore.clear()
                    } else vault.save(session)
                    listeners.forEach { it(ProcessSessionEvent.Changed(session)) }
                },
                onSessionInvalidated = { listeners.forEach { it(ProcessSessionEvent.Invalidated) } },
            ),
            generationStore,
        ).also { runtime = it }
    }

    private data class Runtime(
        val vault: SessionVault,
        val coordinator: SessionCoordinator,
        val generationStore: SessionGenerationStore,
    )
}

private class SessionGenerationStore(context: Context) {
    private val prefs = context.getSharedPreferences("client_session_generation", Context.MODE_PRIVATE)
    fun current(): String? = prefs.getString("generation", null)
    fun ensure(): String = current() ?: replace()
    fun replace(): String = UUID.randomUUID().toString().also {
        check(prefs.edit().putString("generation", it).commit())
    }
    fun restore(value: String?) {
        val edit = prefs.edit()
        if (value == null) edit.remove("generation") else edit.putString("generation", value)
        check(edit.commit())
    }
    fun clear() = restore(null)
}
