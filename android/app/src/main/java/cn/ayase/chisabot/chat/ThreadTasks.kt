package cn.ayase.chisabot.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.*
import java.net.URLEncoder

fun pathPart(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
data class TaskSession(val origin: String, val bot: String, val thread: String) {
    val base get() = "/api/copilotkit/threads/${pathPart(thread)}"
    val dismissalKey get() = "worker-dismissals:$origin:$thread"
}
data class TaskStep(val text: String, val status: String)
data class BackgroundTask(
    val id: String, val title: String, val status: String, val step: String?,
    val plan: List<TaskStep>, val error: String?, val summary: String?,
    val createdAt: String?, val startedAt: String?, val finishedAt: String?,
) {
    val active get() = status in setOf("queued", "running", "waiting")
    fun visible(dismissed: Set<String>) = active || status == "failed" && id !in dismissed
    val label get() = mapOf("queued" to "排队中", "running" to "运行中", "waiting" to "等待你", "failed" to "失败", "done" to "已完成", "cancelled" to "已停止")[status] ?: status
    val stepLabel get() = if (status == "queued") "排队中，前面的任务做完就开始" else
        step?.takeUnless { it.startsWith("正在使用 ") } ?: plan.firstOrNull { it.status == "current" }?.text
        ?: plan.firstOrNull { it.status == "pending" }?.text ?: "正在看任务要求"
}
data class GoalCriterion(val title: String, val passed: Boolean, val detail: String?)
data class OngoingTask(val id: String, val objective: String, val status: String, val detail: String?, val criteria: List<GoalCriterion>, val jobs: List<Pair<String, String>>) {
    val active get() = status in setOf("active", "running", "waiting_background", "waiting_device", "waiting_approval", "paused")
    val resumable get() = status in setOf("paused", "waiting_approval")
    val label get() = mapOf("active" to "自动继续中", "running" to "正在执行", "waiting_background" to "等待后台作业完成", "waiting_device" to "等待设备重新上线", "waiting_approval" to "等待审批或输入", "paused" to "已暂停")[status] ?: status
}
data class QueuedNote(val id: String, val text: String, val paused: Boolean, val kind: String)
data class ContextReading(val tokens: Long, val source: String, val model: String?)
data class TaskActivity(val seq: String, val detectedAt: Long? = null) {
    fun next(nextSeq: String, now: Long) = TaskActivity(nextSeq, if (nextSeq != seq) now else detectedAt)
}

private fun JsonObject.rows(key: String) = (a(key) ?: error("返回的 $key 格式不正确")).map { it as? JsonObject ?: error("返回的数据格式不正确") }
fun parseBackgroundTasks(body: JsonObject) = body.rows("workers").map { row ->
    BackgroundTask(row.s("id") ?: error("任务缺少编号"), row.s("title") ?: "后台任务", row.s("status") ?: error("任务缺少状态"), row.s("step"),
        row.a("plan").orEmpty().mapNotNull { it as? JsonObject }.map { TaskStep(it.s("text").orEmpty(), it.s("status") ?: "pending") },
        row.s("error"), row.s("summary"), row.s("createdAt"), row.s("startedAt"), row.s("finishedAt"))
}
fun parseOngoingTasks(body: JsonObject) = body.rows("tasks").map { row ->
    OngoingTask(row.s("id") ?: error("任务缺少编号"), row.s("objective").orEmpty(), row.s("status").orEmpty(), row.s("detail"),
        row.a("criteria").orEmpty().mapNotNull { it as? JsonObject }.map { GoalCriterion(it.s("title").orEmpty(), it["passed"]?.toString() == "true", it.s("detail")) },
        row.a("jobs").orEmpty().mapNotNull { it as? JsonObject }.map { it.s("jobId").orEmpty() to it.s("status").orEmpty() })
}
fun parseQueuedNotes(body: JsonObject): List<QueuedNote> = body.rows("items").mapNotNull { row ->
    val status = row.s("status")
    val kind = row.s("kind") ?: "message"
    val paused = body["paused"]?.toString() == "true" || status != "queued"
    if (status !in setOf("queued", "paused", "owed", "stopped") || kind !in setOf("message", "worker_result") || kind == "worker_result" && !paused) return@mapNotNull null
    val content = row.o("message")?.get("content") ?: JsonPrimitive("")
    val text = contentAll(content).first
    QueuedNote(row.s("id") ?: return@mapNotNull null, if (kind == "worker_result") text.replace(Regex("^⟦chisabot:[^⟧]*⟧\\s*"), "").lineSequence().first() else text, paused, kind)
}

/** One monitor per visible conversation. Late responses may never update a different session. */
class ThreadTasks(
    private val scope: CoroutineScope,
    private val loadDismissed: (String) -> Set<String>,
    private val saveDismissed: (String, Set<String>) -> Unit,
) {
    var workers by mutableStateOf<List<BackgroundTask>>(emptyList()); private set
    var goals by mutableStateOf<List<OngoingTask>>(emptyList()); private set
    var inbox by mutableStateOf<List<QueuedNote>>(emptyList()); private set
    var context by mutableStateOf<ContextReading?>(null); private set
    var activities by mutableStateOf<Map<String, TaskActivity>>(emptyMap()); private set
    var dismissed by mutableStateOf<Set<String>>(emptySet()); private set
    var errors by mutableStateOf<Map<String, String>>(emptyMap()); private set
    var busy by mutableStateOf<Set<String>>(emptySet()); private set
    var refreshing by mutableStateOf(false); private set
    val visibleWorkers get() = workers.filter { it.visible(dismissed) }
    private var session: TaskSession? = null
    private var generation = 0
    private var job: Job? = null
    private var wake = Channel<Unit>(Channel.CONFLATED)
    private var request: (suspend (String, String, JsonObject?) -> JsonObject)? = null
    private var nextContextReadAt = 0L

    fun clear() {
        stop(); session = null; request = null
        workers = emptyList(); goals = emptyList(); inbox = emptyList(); context = null
        activities = emptyMap(); dismissed = emptySet(); errors = emptyMap(); busy = emptySet()
    }
    fun stop() { generation++; job?.cancel(); job = null; refreshing = false; busy = emptySet() }
    fun start(next: TaskSession, fetch: suspend (String, String, JsonObject?) -> JsonObject) {
        if (session == next && job?.isActive == true) { refresh(); return }
        if (session != next) clear() else stop()
        session = next; request = fetch; dismissed = loadDismissed(next.dismissalKey)
        val epoch = generation
        nextContextReadAt = 0L
        wake.close(); wake = Channel(Channel.CONFLATED)
        val signal = wake
        job = scope.launch {
            while (isActive && epoch == generation) {
                refreshing = true
                // Context estimation can read a large history. Task progress must not
                // re-read that history every three seconds; refresh on focus/run-end too.
                val readContext = System.currentTimeMillis() >= nextContextReadAt
                if (readContext) nextContextReadAt = System.currentTimeMillis() + 60_000
                supervisorScope {
                    suspend fun update(key: String, path: String, apply: (JsonObject) -> Unit) {
                        try {
                            val data = fetch(path, "GET", null)
                            ensureActive()
                            if (epoch == generation) { apply(data); errors = errors - key }
                        } catch (e: CancellationException) { throw e }
                        catch (e: Exception) { if (epoch == generation) errors = errors + (key to (e.message ?: "暂时无法刷新，正在重试")) }
                    }
                    listOf(
                        launch { update("workers", next.base + "/workers") { workers = parseBackgroundTasks(it) } },
                        launch { update("goals", "/api/goal-tasks?threadId=${pathPart(next.thread)}") { goals = parseOngoingTasks(it) } },
                        launch { update("inbox", next.base + "/inbox") { inbox = parseQueuedNotes(it) } },
                        launch { if (readContext) update("context", next.base + "/context?agentId=${pathPart(next.bot)}") { body ->
                            require(body.containsKey("context")) { "上下文读数暂不可用" }
                            context = body.o("context")?.let { ContextReading(it.s("tokens")?.toLongOrNull() ?: error("上下文读数无效"), it.s("source") ?: "estimate", it.s("model")) }
                        } },
                    ).joinAll()
                    workers.filter { it.active }.chunked(4).forEach { batch ->
                        batch.map { worker -> launch {
                            val key = "activity:${worker.id}"
                            update(key, "/api/bot-threads/${pathPart(next.bot)}/sync?threadId=${pathPart("worker-${worker.id}")}") {
                                val thread = it.o("thread") ?: error("暂时无法更新后台活动")
                                require(thread.s("threadId") == "worker-${worker.id}")
                                val seq = thread.s("seq") ?: error("缺少进度游标")
                                activities = activities + (worker.id to (activities[worker.id]?.next(seq, System.currentTimeMillis()) ?: TaskActivity(seq)))
                            }
                        } }.joinAll()
                    }
                }
                if (epoch != generation) break
                refreshing = false
                withTimeoutOrNull(if (workers.any { it.active } || goals.any { it.active } || inbox.isNotEmpty()) 3000L else 10000L) { signal.receive() }
            }
        }
    }
    fun refresh() { nextContextReadAt = 0L; wake.trySend(Unit) }
    fun dismiss(id: String) {
        val s = session ?: return
        if (workers.none { it.id == id && it.status == "failed" }) return
        dismissed = (dismissed + id).toList().takeLast(500).toSet()
        saveDismissed(s.dismissalKey, dismissed)
    }
    private suspend fun act(key: String, path: String, method: String = "POST", body: JsonObject? = null, accept: (JsonObject) -> Boolean = { true }): Boolean {
        val fetch = request ?: return false
        val epoch = generation
        if (key in busy || job?.isActive != true) return false
        busy = busy + key; errors = errors - key
        return try {
            val result = fetch(path, method, body)
            currentCoroutineContext().ensureActive()
            if (epoch != generation) false else {
                check(accept(result)) { "状态已变化，请刷新后重试" }
                refresh(); true
            }
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { if (epoch == generation) errors = errors + (key to (e.message ?: "操作失败，请重试")); false }
        finally { if (epoch == generation) busy = busy - key }
    }
    suspend fun workerAction(id: String, action: String, note: String = ""): Boolean {
        val s = session ?: return false
        if (workers.none { it.id == id && it.active } || action !in setOf("cancel", "steer") || action == "steer" && note.isBlank()) return false
        return act(id, s.base + "/workers", body = buildJsonObject { put("workerId", id); put("action", action); if (action == "steer") put("text", note.trim()) })
    }
    suspend fun goalAction(id: String, action: String): Boolean {
        if (goals.none { it.id == id && it.active } || action !in setOf("pause", "resume", "cancel")) return false
        return act(id, "/api/goal-tasks/${pathPart(id)}/$action")
    }
    suspend fun withdraw(id: String): Boolean {
        val s = session ?: return false
        val ok = act(id, s.base + "/inbox?id=${pathPart(id)}", "DELETE", accept = { it["withdrawn"]?.toString() == "true" })
        if (ok && session == s) inbox = inbox.filterNot { it.id == id }
        return ok
    }
}
