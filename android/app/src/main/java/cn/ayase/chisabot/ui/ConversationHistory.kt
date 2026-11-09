package cn.ayase.chisabot.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import cn.ayase.chisabot.AppViewModel
import cn.ayase.chisabot.Bot
import cn.ayase.chisabot.chat.ConversationEntry
import kotlinx.coroutines.CancellationException

@Composable
fun ConversationHistory(vm: AppViewModel, bot: Bot, onDismiss: () -> Unit) {
    var rows by remember(bot.id) { mutableStateOf<List<ConversationEntry>>(emptyList()) }
    var loading by remember(bot.id) { mutableStateOf(true) }
    var error by remember(bot.id) { mutableStateOf<String?>(null) }
    var retry by remember(bot.id) { mutableStateOf(0) }
    LaunchedEffect(bot.id, retry) {
        loading = true; error = null
        try { rows = vm.conversationHistory(bot) }
        catch (e: CancellationException) { throw e }
        catch (e: Exception) { error = e.message ?: "历史对话加载失败" }
        finally { loading = false }
    }
    AlertDialog(onDismissRequest = onDismiss, title = { Text("${bot.name} · 历史对话") }, text = {
        Column {
            when {
                loading -> CircularProgressIndicator()
                error != null -> { Text(error.orEmpty()); TextButton(onClick = { retry++ }) { Text("重试") } }
                rows.isEmpty() -> Text("还没有历史对话")
                else -> LazyColumn(Modifier.heightIn(max = 420.dp)) {
                    items(rows, key = { it.threadId }) { entry ->
                        TextButton(onClick = { onDismiss(); vm.openChat(bot, entry.threadId) }, modifier = Modifier.fillMaxWidth()) {
                            Column(Modifier.fillMaxWidth()) {
                                Text(entry.title, maxLines = 3, overflow = TextOverflow.Ellipsis)
                                val current = if (vm.chatBot?.id == bot.id && vm.threadId == entry.threadId) " · 当前" else ""
                                Text("${entry.messages} 条消息${entry.updatedAt?.let { " · " + historyDate(it) }.orEmpty()}$current", style = MaterialTheme.typography.labelSmall)
                            }
                        }
                    }
                }
            }
        }
    }, confirmButton = { TextButton(onClick = onDismiss) { Text("关闭") } })
}

private fun historyDate(value: String): String = runCatching {
    java.time.Instant.parse(value).atZone(java.time.ZoneId.systemDefault()).format(java.time.format.DateTimeFormatter.ofPattern("MM-dd HH:mm"))
}.getOrDefault(value)
