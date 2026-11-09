package cn.ayase.chisabot.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.ayase.chisabot.AppViewModel
import cn.ayase.chisabot.chat.*
import kotlinx.coroutines.delay
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/** Progress stays outside the transcript, so new steps do not move the user's reading position. */
@Composable
fun TaskProgress(vm: AppViewModel) {
    val sky = LocalSky.current
    val tasks = vm.tasks
    val keyboardVisible = WindowInsets.ime.getBottom(androidx.compose.ui.platform.LocalDensity.current) > 0
    var expanded by remember(vm.threadId) { mutableStateOf(true) }
    var goal by remember(vm.threadId) { mutableStateOf<String?>(null) }
    var showContext by remember(vm.threadId) { mutableStateOf(false) }
    val visible = tasks.visibleWorkers
    val activeGoals = tasks.goals.filter { it.active }
    val failure = listOf("workers", "goals", "inbox").any { it in tasks.errors }
    Column(Modifier.fillMaxWidth()) {
        if (visible.isNotEmpty() || failure) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("后台任务 ${visible.count { it.active }} 运行中" + if (visible.any { !it.active }) " · ${visible.count { !it.active }} 失败" else "",
                    color = sky.ink1, fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f).clickable(role = Role.Button) { expanded = !expanded }.padding(vertical = 10.dp))
                TextButton(onClick = { expanded = !expanded }, modifier = Modifier.semantics { contentDescription = if (expanded) "收起后台任务列表" else "展开后台任务列表" }) { Text(if (expanded) "收起" else "展开") }
                TextButton(onClick = tasks::refresh, enabled = !tasks.refreshing) { Text("刷新") }
            }
            if (failure) Text("进度暂时无法刷新，正在重试；保留上次记录。", color = sky.warn, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 12.dp))
            if (expanded) Column(Modifier.fillMaxWidth().heightIn(max = if (keyboardVisible) 72.dp else 180.dp).verticalScroll(rememberScrollState()).padding(horizontal = 10.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                visible.forEach { worker -> key(worker.id) { BackgroundTaskCard(tasks, worker, visible.count { it.active } > 1) } }
            }
        }
        if (tasks.inbox.isNotEmpty()) Column(Modifier.fillMaxWidth().heightIn(max = 120.dp).verticalScroll(rememberScrollState()).padding(horizontal = 10.dp)) {
            tasks.inbox.forEach { note -> key(note.id) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text((if (note.paused) "已暂停 · " else "排队中 · ") + note.text, color = sky.ink2, fontSize = 12.sp, modifier = Modifier.weight(1f))
                    if (note.paused) ActionChip("↻", "继续", "提交中…", enabled = !vm.running && !vm.turnPreparing) { vm.resumeQueued(note) }
                    ActionChip("×", "撤回", "撤回中…", enabled = note.id !in tasks.busy) { tasks.withdraw(note.id) }
                }
                tasks.errors[note.id]?.let { Text(it, color = sky.danger, fontSize = 12.sp) }
            } }
        }
        if (activeGoals.isNotEmpty() || tasks.context != null) Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            activeGoals.firstOrNull()?.let { task ->
                TextButton(onClick = { goal = task.id }, modifier = Modifier.weight(1f)) {
                    Text("持续任务 ${task.criteria.count { it.passed }}/${task.criteria.size} · ${task.label}", fontSize = 12.sp)
                }
            }
            tasks.context?.let { reading ->
                TextButton(onClick = { showContext = true }) { Text("上下文 ${if (reading.source != "measured") "约 " else ""}${reading.tokens}", fontSize = 12.sp) }
            }
        }
    }
    val selected = activeGoals.find { it.id == goal }
    if (selected != null) GoalDialog(tasks, selected) { goal = null }
    if (showContext) AlertDialog(onDismissRequest = { showContext = false }, title = { Text("上下文用量") }, text = {
        val reading = tasks.context
        val size = vm.modelOptions?.find { it.id == vm.modelState?.model }?.contextWindow
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text("已用 ${reading?.tokens ?: 0} tokens" + (size?.let { " / $it" } ?: "（模型窗口未知）"))
            Text(when (reading?.source) { "measured" -> "上次回复时模型返回的实测用量"; "run-total" -> "整轮累计用量，含工具步骤，可能偏大"; else -> "按服务器自动压缩后的消息估算，不含系统提示与工具定义" })
            tasks.errors["context"]?.let { Text("暂时无法刷新，显示上次读数。") }
        }
    }, confirmButton = { TextButton(onClick = { showContext = false }) { Text("关闭") } }, dismissButton = {
        TextButton(enabled = !vm.running && !vm.turnPreparing, onClick = { showContext = false; vm.newTopic() }) { Text("新话题") }
    })
}

@Composable
private fun BackgroundTaskCard(tasks: ThreadTasks, worker: BackgroundTask, compact: Boolean) {
    val sky = LocalSky.current
    var open by remember(worker.id) { mutableStateOf(!compact) }
    var steering by remember(worker.id) { mutableStateOf(false) }
    var note by remember(worker.id) { mutableStateOf("") }
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(worker.active) { while (worker.active) { delay(1000); now = System.currentTimeMillis() } }
    Column(Modifier.fillMaxWidth().glass(sky, level = 2).padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(worker.title, color = sky.ink1, fontWeight = FontWeight.SemiBold, fontSize = 13.sp, modifier = Modifier.weight(1f))
            Text(worker.label, color = if (worker.status == "failed") sky.danger else sky.accent, fontSize = 12.sp)
            TextButton(onClick = { open = !open }, modifier = Modifier.semantics { contentDescription = "${if (open) "收起" else "展开"}后台任务：${worker.title}" }) { Text(if (open) "收起" else "展开") }
            if (worker.status == "failed") TextButton(onClick = { tasks.dismiss(worker.id) }, modifier = Modifier.semantics { contentDescription = "关闭后台任务：${worker.title}" }) { Text("关闭") }
        }
        Text(if (worker.active) "最近上报步骤：${worker.stepLabel}" else worker.error ?: worker.summary ?: "没有完成", color = sky.ink2, fontSize = 12.sp)
        val start = parseTaskTime(worker.startedAt ?: worker.createdAt)
        val end = parseTaskTime(worker.finishedAt) ?: now
        if (start != null) Text("${if (worker.status == "queued") "已排队" else "用时"} ${taskElapsed(end - start)}", color = sky.ink3, fontSize = 11.sp)
        if (worker.active) {
            val activity = tasks.activities[worker.id]
            Text((activity?.detectedAt?.let { "检测到进展：${taskElapsed(now - it)}前" } ?: if (activity != null) "已连接后台，正在追踪新的进展" else "正在连接后台进展…") +
                if ("activity:${worker.id}" in tasks.errors) " · 连接暂不可用，正在重试" else "", color = sky.ink3, fontSize = 11.sp)
        }
        if (open) {
            if (worker.plan.isNotEmpty()) Text("步骤 ${worker.plan.count { it.status == "done" }}/${worker.plan.size}", color = sky.ink2, fontSize = 12.sp)
            worker.plan.forEach { step -> Text("${when (step.status) { "done" -> "✓"; "current" -> "→"; "blocked" -> "!"; else -> "○" }} ${step.text}", color = if (step.status == "blocked") sky.warn else sky.ink2, fontSize = 12.sp) }
            if (worker.active) {
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    TextButton(onClick = { steering = !steering }) { Text("补充说明") }
                    ActionChip("■", "停止任务", "停止中…", enabled = worker.id !in tasks.busy) { tasks.workerAction(worker.id, "cancel") }
                }
                if (steering) {
                    AlertDialog(onDismissRequest = { steering = false }, title = { Text("补充说明 · ${worker.title}") }, text = {
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedTextField(note, { note = it }, label = { Text("给后台任务补充说明") }, modifier = Modifier.fillMaxWidth(), maxLines = 4)
                            tasks.errors[worker.id]?.let { Text(it, color = sky.danger, fontSize = 12.sp) }
                        }
                    }, confirmButton = {
                        ActionChip("↑", "发送说明", "发送中…", enabled = note.isNotBlank() && worker.id !in tasks.busy) {
                            val ok = tasks.workerAction(worker.id, "steer", note)
                            if (ok) { note = ""; steering = false }; ok
                        }
                    }, dismissButton = { TextButton(onClick = { steering = false }) { Text("取消") } })
                }
            }
        }
        tasks.errors[worker.id]?.let { Text(it, color = sky.danger, fontSize = 12.sp) }
    }
}

@Composable
private fun GoalDialog(tasks: ThreadTasks, task: OngoingTask, close: () -> Unit) {
    var confirmCancel by remember(task.id) { mutableStateOf(false) }
    AlertDialog(onDismissRequest = close, title = { Text("持续任务 · ${task.label}") }, text = {
        Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(task.objective)
            task.detail?.let { Text(it) }
            task.criteria.forEach { Text("${if (it.passed) "✓" else "○"} ${it.title}"); it.detail?.let { detail -> Text(detail, fontSize = 12.sp) } }
            if (task.jobs.isNotEmpty()) Text("后台作业：" + task.jobs.joinToString("、") { "${it.first}（${it.second}）" }, fontSize = 12.sp)
            tasks.errors[task.id]?.let { Text(it, color = LocalSky.current.danger) }
            ActionChip(if (task.resumable) "▶" else "Ⅱ", if (task.resumable) "恢复持续任务" else "停止持续任务", "处理中…", enabled = task.id !in tasks.busy) {
                tasks.goalAction(task.id, if (task.resumable) "resume" else "pause")
            }
            TextButton(onClick = { confirmCancel = true }, enabled = task.id !in tasks.busy) { Text("放弃任务") }
        }
    }, confirmButton = { TextButton(onClick = close) { Text("关闭") } })
    if (confirmCancel) AlertDialog(onDismissRequest = { confirmCancel = false }, title = { Text("放弃持续任务？") }, text = { Text("放弃后可以登记新目标，已完成的步骤不会撤销。") },
        confirmButton = { ActionChip("×", "确认放弃", "处理中…") { val ok = tasks.goalAction(task.id, "cancel"); if (ok) { confirmCancel = false; close() }; ok } },
        dismissButton = { TextButton(onClick = { confirmCancel = false }) { Text("返回") } })
}

private fun parseTaskTime(value: String?): Long? = value?.let {
    listOf("yyyy-MM-dd'T'HH:mm:ss.SSSXXX", "yyyy-MM-dd'T'HH:mm:ssXXX").firstNotNullOfOrNull { pattern ->
        runCatching { SimpleDateFormat(pattern, Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(it)?.time }.getOrNull()
    }
}
private fun taskElapsed(ms: Long): String {
    val seconds = (ms.coerceAtLeast(0) / 1000)
    return if (seconds < 60) "$seconds 秒" else if (seconds < 3600) "${seconds / 60} 分 ${seconds % 60} 秒" else "${seconds / 3600} 小时 ${seconds / 60 % 60} 分"
}
