package cn.ayase.chisabot.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.ayase.chisabot.AppViewModel

@Composable
fun ModelPicker(vm: AppViewModel) {
    val sky = LocalSky.current
    var open by remember(vm.chatBot?.id) { mutableStateOf(false) }
    var query by remember(open) { mutableStateOf("") }
    val state = vm.modelState
    val models = vm.modelOptions.orEmpty()
    val label = when {
        vm.modelSaving -> "模型保存中…"
        state?.available == false -> "外部 BOT"
        state != null -> models.find { it.id == state.model }?.label ?: state.model.substringAfterLast('/').ifBlank { "部署默认" }
        vm.modelsLoading -> "模型加载中…"
        else -> "选择模型"
    }
    val locked = vm.running || vm.turnPreparing || vm.chatLoading || vm.modelSaving || vm.modelsLoading || state?.canManage != true
    Row(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable(role = Role.Button) { open = true; vm.loadModels() }
            .padding(horizontal = 18.dp, vertical = 6.dp).semantics { contentDescription = "模型选择：$label" },
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text("模型", color = sky.ink3, fontSize = 12.sp)
        Text(label, color = if (vm.selectedModelMissing) sky.danger else sky.ink2, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        if (vm.selectedModelMissing) Text("已失效", color = sky.danger, fontSize = 12.sp)
        Text("⌄", color = sky.ink3)
    }
    if (!open) return
    AlertDialog(
        onDismissRequest = { open = false },
        title = { Text("选择模型") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("保存到当前机器人，PC 和网页端也会使用此设置。", fontSize = 12.sp)
                if (vm.running) Text("机器人正在回答，结束后可以切换模型。", fontSize = 12.sp)
                if (state?.available == false) Text("此外部机器人的模型由其服务管理。")
                else {
                    if (state != null && !state.canManage) Text("只有机器人的拥有者或管理员可以更改模型。", fontSize = 12.sp)
                    OutlinedTextField(query, { query = it }, label = { Text("搜索模型或提供方") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    if (vm.modelsLoading || vm.modelSaving) Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                        Text(if (vm.modelSaving) "正在保存…" else "正在加载…")
                    }
                    vm.modelsError?.let { Text(it, color = sky.danger, fontSize = 12.sp) }
                    if (vm.modelsStale) Text("当前显示上次成功获取的列表，可刷新重试。", fontSize = 12.sp)
                    LazyColumn(Modifier.fillMaxWidth().heightIn(max = 340.dp)) {
                        if (state != null) item(key = "default") {
                            ModelChoice("部署默认", state.defaultModel, state.overrideModel == null, !locked) { vm.selectModel(null) }
                        }
                        if (vm.selectedModelMissing) item(key = "missing") {
                            Text("当前模型 ${state?.model} 已不在模型列表中，请重新选择。", color = sky.danger, fontSize = 12.sp, modifier = Modifier.padding(vertical = 8.dp))
                        }
                        val filtered = models.filter { it.matches(query) }
                        items(filtered, key = { "model:${it.id}" }) { model ->
                            ModelChoice(model.label, listOf(model.provider, model.id).filter { it.isNotBlank() }.joinToString(" · "), state?.overrideModel == model.id, !locked) { vm.selectModel(model.id) }
                        }
                        if (filtered.isEmpty() && !vm.modelsLoading) item(key = "empty") {
                            Text(if (query.isBlank()) "暂无可选模型，可刷新列表或到网页设置模型接口。" else "没有匹配的模型", fontSize = 12.sp, modifier = Modifier.padding(vertical = 12.dp))
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton({ open = false }) { Text("完成") } },
        dismissButton = { TextButton({ vm.loadModels(refresh = true) }, enabled = !vm.modelsLoading && !vm.modelSaving) { Text("刷新列表") } },
    )
}

@Composable
private fun ModelChoice(label: String, detail: String, selected: Boolean, enabled: Boolean, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().selectable(selected, enabled = enabled, role = Role.RadioButton, onClick = onClick).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        RadioButton(selected, onClick = null, enabled = enabled)
        Column(Modifier.weight(1f).padding(start = 8.dp)) {
            Text(label, fontSize = 14.sp)
            Text(detail, fontSize = 11.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
    }
}
