package cn.ayase.chisabot

import cn.ayase.chisabot.chat.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ThreadTasksTest {
    private fun json(value: String) = Json.parseToJsonElement(value) as JsonObject
    private fun worker(status: String = "running", id: String = "w") = json("""{"workers":[{"id":"$id","title":"后台验证","status":"$status","plan":[{"text":"读取","status":"done"},{"text":"整理","status":"current"}]}]}""")
    private fun empty(path: String): JsonObject = when {
        path.contains("/workers") -> json("""{"workers":[]}""")
        path.contains("goal-tasks") -> json("""{"tasks":[]}""")
        path.contains("/inbox") -> json("""{"items":[]}""")
        path.contains("/context") -> json("""{"context":null}""")
        else -> json("""{"thread":{"threadId":"worker-w","seq":"1"}}""")
    }
    private suspend fun until(test: () -> Boolean) = withTimeout(3000) { while (!test()) delay(5) }
    private val session = TaskSession("https://example.test", "bot-a", "thread-a")

    @Test fun completedAndCancelledDisappearButFailuresStayUntilDismissed() {
        for (status in listOf("done", "cancelled")) assertFalse(parseBackgroundTasks(worker(status)).single().visible(emptySet()))
        assertTrue(parseBackgroundTasks(worker("failed")).single().visible(emptySet()))
        assertFalse(parseBackgroundTasks(worker("failed")).single().visible(setOf("w")))
        for (status in listOf("queued", "running", "waiting")) assertTrue(parseBackgroundTasks(worker(status)).single().visible(setOf("w")))
    }
    @Test fun stepsAndOnlyRealCursorChangesReportProgress() {
        assertEquals("整理", parseBackgroundTasks(worker()).single().stepLabel)
        val first = TaskActivity("9007199254740993123")
        assertNull(first.detectedAt)
        assertNull(first.next(first.seq, 100).detectedAt)
        assertEquals(200L, first.next("9007199254740993124", 200).detectedAt)
        assertEquals(200L, first.next("9007199254740993124", 200).next("9007199254740993124", 300).detectedAt)
    }
    @Test fun pausedInboxIncludesHeldWorkerResultsAndExcludesReadItems() {
        val items = parseQueuedNotes(json("""{"paused":true,"items":[
          {"id":"a","status":"queued","kind":"message","message":{"content":"补充条件"}},
          {"id":"b","status":"owed","kind":"worker_result","message":{"content":"⟦chisabot:worker-result:x:failed⟧\n验证失败\n说明"}},
          {"id":"c","status":"read","kind":"message","message":{"content":"已读"}}]}"""))
        assertEquals(listOf("a", "b"), items.map { it.id }); assertTrue(items.all { it.paused }); assertEquals("验证失败", items[1].text)
    }
    @Test fun emptyListDiscoversTasksOnExplicitRefreshAndFailuresPreserveProgress() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val monitor = ThreadTasks(scope, { emptySet() }, { _, _ -> })
        var phase = 0
        monitor.start(session) { path, _, _ ->
            if (path.endsWith("workers")) when (phase) { 0 -> empty(path); 1 -> worker(); else -> error("offline") } else empty(path)
        }
        until { !monitor.refreshing }
        phase = 1; monitor.refresh(); until { monitor.workers.size == 1 }
        phase = 2; monitor.refresh(); until { "workers" in monitor.errors }
        assertEquals("w", monitor.workers.single().id)
        phase = 1; monitor.refresh(); until { "workers" !in monitor.errors }
        monitor.stop(); scope.cancel()
    }
    @Test fun lateResponseAfterSwitchCannotPopulateNewConversation() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val gate = CompletableDeferred<Unit>()
        val monitor = ThreadTasks(scope, { emptySet() }, { _, _ -> })
        monitor.start(session) { path, _, _ ->
            if (path.endsWith("workers")) { withContext(NonCancellable) { gate.await() }; worker(id = "old") } else empty(path)
        }
        monitor.start(session.copy(bot = "bot-b", thread = "thread-b")) { path, _, _ -> empty(path) }
        gate.complete(Unit); delay(20)
        assertTrue(monitor.workers.isEmpty()); assertFalse(monitor.refreshing)
        monitor.stop(); scope.cancel()
    }
    @Test fun dismissalsPersistPerServerAndConversation() = runBlocking {
        val saved = mutableMapOf<String, Set<String>>()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val monitor = ThreadTasks(scope, { saved[it].orEmpty() }, { k, v -> saved[k] = v })
        val fetch: suspend (String, String, JsonObject?) -> JsonObject = { path, _, _ -> if (path.endsWith("workers")) worker("failed") else empty(path) }
        monitor.start(session, fetch); until { monitor.workers.isNotEmpty() }; monitor.dismiss("w")
        assertTrue(monitor.visibleWorkers.isEmpty())
        monitor.stop(); monitor.start(session, fetch); assertTrue(monitor.visibleWorkers.isEmpty())
        monitor.start(session.copy(origin = "https://other.test"), fetch); until { monitor.workers.isNotEmpty() }; assertEquals(1, monitor.visibleWorkers.size)
        monitor.stop(); scope.cancel()
    }
    @Test fun workerActionsTargetCorrectThreadAndRejectTerminalOrEmptyNotes() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val writes = mutableListOf<Pair<String, JsonObject?>>()
        val monitor = ThreadTasks(scope, { emptySet() }, { _, _ -> })
        monitor.start(session) { path, method, body -> if (method == "POST") { writes += path to body; json("{}") } else if (path.endsWith("workers")) worker() else empty(path) }
        until { monitor.workers.isNotEmpty() }
        assertFalse(monitor.workerAction("w", "steer", " "))
        assertTrue(monitor.workerAction("w", "steer", "检查来源"))
        assertEquals("/api/copilotkit/threads/thread-a/workers", writes.single().first)
        assertEquals("检查来源", writes.single().second?.s("text"))
        assertFalse(monitor.workerAction("missing", "cancel"))
        monitor.stop(); scope.cancel()
    }
    @Test fun stoppingObservationPreservesDataAndStopsRefreshRequests() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        var reads = 0
        val monitor = ThreadTasks(scope, { emptySet() }, { _, _ -> })
        val fetch: suspend (String, String, JsonObject?) -> JsonObject = { path, _, _ -> reads++; if (path.endsWith("workers")) worker("failed") else empty(path) }
        monitor.start(session, fetch); until { !monitor.refreshing }; monitor.stop()
        val stopped = reads; monitor.refresh(); delay(30); assertEquals(stopped, reads)
        assertEquals(1, monitor.workers.size)
        monitor.start(session, fetch); until { reads > stopped }; monitor.stop(); scope.cancel()
    }
    @Test fun modelWindowComesOnlyFromCatalog() {
        val model = parseModelOptions(json("""{"models":[{"id":"a","contextWindow":128000},{"id":"b"}]}"""))
        assertEquals(128000L, model[0].contextWindow); assertNull(model[1].contextWindow)
    }
}
