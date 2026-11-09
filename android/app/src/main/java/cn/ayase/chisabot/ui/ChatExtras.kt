package cn.ayase.chisabot.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.ayase.chisabot.AppViewModel
import cn.ayase.chisabot.PendingFile
import cn.ayase.chisabot.chat.Attachment
import cn.ayase.chisabot.chat.ChatMessage
import cn.ayase.chisabot.chat.ConfirmCard
import cn.ayase.chisabot.net.absUrl
import coil.compose.AsyncImage
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * 原生安卓第二轮（DESIGN §84）：确认卡片（§58）、附件（§56）、重新生成 / 编辑（§67）、服务器行（§68.2）。
 * 都是原生 Compose，不再跳网页。
 */

private val CATEGORY_LABEL = mapOf("message" to "对外发消息", "delete" to "删除", "purchase" to "付款购买", "device" to "操作你的电脑")
private val CATEGORY_GLYPH = mapOf("message" to "➤", "delete" to "🗑", "purchase" to "💳", "device" to "🖥")
private val DECIDED_TEXT = mapOf("approved" to "已确认", "denied" to "已取消，没有执行", "expired" to "已过期，没有执行", "cancelled" to "已停止，没有执行")

/**
 * 确认卡片（§58）：要做什么 · 对象 · 细节 · 确认 / 取消（· 以后这类直接做）。决定后原地收成一行（细节和按钮收起，不跳版），
 * 记录留在对话里。按钮是 §2 状态机：确认中… → 已确认 ✓ / 失败 ✕ 可重试；宽度固定。
 */
@Composable
fun ConfirmCardView(vm: AppViewModel, card: ConfirmCard) {
    val sky = LocalSky.current
    val pending = card.status == "pending"
    val label = CATEGORY_LABEL[card.category] ?: "确认"
    val tone = when {
        !pending && card.status == "approved" -> sky.success
        !pending -> sky.ink3
        card.category == "delete" || card.category == "purchase" -> sky.danger
        else -> sky.accent
    }
    val edge by animateColorAsState(if (pending) tone.copy(alpha = 0.45f) else sky.glassEdge, tween(240), label = "edge")
    var busy by remember(card.id) { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().widthIn(max = 520.dp).clip(RoundedCornerShape(16.dp)).background(if (pending) sky.glass2 else sky.glass1)
            .border(1.dp, edge, RoundedCornerShape(16.dp)).animateContentSize(tween(220))
            .semantics { contentDescription = (if (pending) "需要你确认：" else "${DECIDED_TEXT[card.status] ?: ""}：") + card.title },
    ) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = if (pending) 4.dp else 12.dp), verticalAlignment = Alignment.Top) {
            Box(Modifier.size(32.dp).clip(CircleShape).background(tone.copy(alpha = 0.14f)), contentAlignment = Alignment.Center) {
                Text(
                    when { pending -> CATEGORY_GLYPH[card.category] ?: "?"; card.status == "approved" -> "✓"; card.status == "expired" -> "◷"; else -> "✕" },
                    color = tone, fontSize = 14.sp, fontWeight = FontWeight.Bold,
                )
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    if (pending) card.eyebrow ?: "需要你确认 · $label" else "${DECIDED_TEXT[card.status] ?: card.status} · $label",
                    color = if (pending) tone else sky.ink3, fontSize = 12.sp, fontWeight = FontWeight.Medium,
                )
                Text(card.title, color = if (pending) sky.ink1 else sky.ink2, fontSize = 15.sp, fontWeight = FontWeight.SemiBold, maxLines = if (pending) 4 else 1, overflow = TextOverflow.Ellipsis)
                if (!card.target.isNullOrBlank() && pending) Text(card.target, color = sky.ink3, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (!pending && card.decidedNote != null) Text(card.decidedNote, color = sky.ink3, fontSize = 11.5.sp)
        }
        AnimatedVisibility(pending, enter = fadeIn(tween(180)) + expandVertically(tween(220)), exit = fadeOut(tween(150)) + shrinkVertically(tween(220))) {
            Column(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                if (card.details.isNotEmpty()) Column(
                    Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(sky.codeBg).padding(10.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    card.details.forEach { (k, v, style) ->
                        Column {
                            Text(k, color = sky.ink3, fontSize = 11.5.sp)
                            if (style == "diff") DiffText(v)
                            else Text(v.take(600), color = sky.ink1, fontSize = 13.sp, fontFamily = if (style == "code") FontFamily.Monospace else null, maxLines = 8, overflow = TextOverflow.Ellipsis)
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    SmallAsyncButton(
                        if (card.handOff) "我已自己完成" else "确认", "确认中…", "已确认",
                        Modifier.width(if (card.handOff) 128.dp else 96.dp), danger = card.category == "delete", primary = true, enabled = !busy,
                    ) { busy = true; vm.decide(card, approve = true).also { busy = false } }
                    SmallAsyncButton(if (card.handOff) "不要执行" else "取消", "取消中…", "已取消", Modifier.width(96.dp), primary = false, enabled = !busy) {
                        busy = true; vm.decide(card, approve = false).also { busy = false }
                    }
                    if (!card.upstream && card.category != "purchase") {
                        var saving by remember(card.id) { mutableStateOf(false) }
                        val scope = rememberCoroutineScope()
                        Text(
                            if (saving) "保存中…" else "以后这类直接做", color = sky.ink3, fontSize = 12.5.sp,
                            modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(enabled = !busy && !saving, role = Role.Button) {
                                saving = true; busy = true
                                scope.launch { vm.decide(card, approve = true, always = true); saving = false; busy = false }
                            }.padding(horizontal = 6.dp, vertical = 8.dp),
                        )
                    } else if (card.category == "purchase") Text("🛡 付款一律先问你", color = sky.ink3, fontSize = 12.sp)
                }
            }
        }
    }
}

@Composable
private fun DiffText(diff: String) {
    val sky = LocalSky.current
    Column {
        diff.lines().take(60).forEach { line ->
            val c = when {
                line.startsWith("+") && !line.startsWith("+++") -> sky.success
                line.startsWith("-") && !line.startsWith("---") -> sky.danger
                line.startsWith("@@") -> sky.ink3
                else -> sky.ink2
            }
            Text(line, color = c, fontSize = 12.sp, fontFamily = FontFamily.Monospace, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/** 小号异步按钮（卡片里用，高 36dp）：同 AsyncButton 的状态机。 */
@Composable
fun SmallAsyncButton(
    label: String, pendingLabel: String, doneLabel: String, modifier: Modifier = Modifier,
    primary: Boolean = true, danger: Boolean = false, enabled: Boolean = true, action: suspend () -> Boolean,
) {
    val sky = LocalSky.current
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf(BtnState.Idle) }
    val base = if (danger) sky.danger else sky.accent
    val bg by animateColorAsState(
        when (state) { BtnState.Done -> sky.success; BtnState.Failed -> sky.danger; else -> if (primary) base else Color.Transparent }, tween(200), label = "sb",
    )
    val fg = if (primary || state == BtnState.Done || state == BtnState.Failed) Color.White else sky.ink1
    Box(
        modifier.height(36.dp).clip(RoundedCornerShape(18.dp)).background(if (enabled || state != BtnState.Idle) bg else bg.copy(alpha = 0.45f))
            .then(if (!primary && state == BtnState.Idle) Modifier.border(1.dp, sky.ink4.copy(alpha = 0.6f), RoundedCornerShape(18.dp)) else Modifier)
            .clickable(enabled = enabled && state != BtnState.Pending, role = Role.Button) {
                scope.launch {
                    state = BtnState.Pending
                    val t0 = System.currentTimeMillis()
                    val ok = runCatching { action() }.getOrDefault(false)
                    val wait = 300 - (System.currentTimeMillis() - t0); if (wait > 0) delay(wait)
                    state = if (ok) BtnState.Done else BtnState.Failed
                    delay(if (ok) 1500 else 2200)
                    if (state != BtnState.Pending) state = BtnState.Idle
                }
            }.semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        AnimatedContent(state, transitionSpec = { fadeIn(tween(160)) togetherWith fadeOut(tween(140)) }, label = "sbc") { s ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                when (s) {
                    BtnState.Pending -> CircularProgressIndicator(Modifier.size(13.dp), color = fg, strokeWidth = 1.8.dp)
                    BtnState.Done -> Text("✓", color = fg, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    BtnState.Failed -> Text("✕", color = fg, fontSize = 13.sp, fontWeight = FontWeight.Bold)
                    BtnState.Idle -> Unit
                }
                if (s != BtnState.Idle) Spacer(Modifier.width(5.dp))
                Text(
                    when (s) { BtnState.Idle -> label; BtnState.Pending -> pendingLabel; BtnState.Done -> doneLabel; BtnState.Failed -> "重试" },
                    color = fg, fontSize = 13.5.sp, fontWeight = FontWeight.Medium, maxLines = 1,
                )
            }
        }
    }
}

/** 淡色小胶囊动作（复制旁边的「↻ 重新生成」「✎ 编辑」）：点了原地转圈，失败 ✕ 一会儿复原（§2）。 */
@Composable
fun ActionChip(glyph: String, label: String, pendingLabel: String, enabled: Boolean = true, action: suspend () -> Boolean) {
    val sky = LocalSky.current
    val scope = rememberCoroutineScope()
    var state by remember { mutableStateOf(BtnState.Idle) }
    Row(
        Modifier.clip(RoundedCornerShape(8.dp)).clickable(enabled = enabled && state == BtnState.Idle, role = Role.Button) {
            scope.launch {
                state = BtnState.Pending
                val ok = runCatching { action() }.getOrDefault(false)
                state = if (ok) BtnState.Idle else BtnState.Failed
                if (!ok) { delay(2000); state = BtnState.Idle }
            }
        }.padding(horizontal = 10.dp, vertical = 8.dp).semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when (state) {
            BtnState.Pending -> CircularProgressIndicator(Modifier.size(11.dp), color = sky.ink3, strokeWidth = 1.5.dp)
            BtnState.Failed -> Text("✕", color = sky.danger, fontSize = 12.sp)
            else -> Text(glyph, color = sky.ink3, fontSize = 12.5.sp)
        }
        Spacer(Modifier.width(4.dp))
        Text(if (state == BtnState.Pending) pendingLabel else label, color = if (enabled) sky.ink3 else sky.ink4, fontSize = 12.5.sp)
    }
}

/** 服务器放进对话的一行（定时任务到点、后台任务交回结果、确认后接着做）：居中淡色小字，不是用户气泡。 */
@Composable
fun ServerNote(text: String) {
    val sky = LocalSky.current
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
        Text("✓ $text", color = sky.ink3, fontSize = 12.5.sp, modifier = Modifier.clip(RoundedCornerShape(12.dp)).background(sky.glass1).padding(horizontal = 12.dp, vertical = 6.dp))
    }
}

/** 用户消息里的附件：图片小图（固定 160dp 方块，不因加载变高），文件一个胶囊。 */
@Composable
fun MessageFiles(files: List<Attachment>, images: List<String>) {
    val sky = LocalSky.current
    val shown = if (files.isNotEmpty()) files else images.map { Attachment("图片", "image/*", it, true) }
    val pics = shown.filter { it.image }
    val docs = shown.filter { !it.image }
    if (pics.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        pics.take(4).forEach { a ->
            // 框在图片到之前就定好（不跳版）：知道宽高（§83.2）按比例，最宽 220dp、高 90–280dp；不知道就 160dp 方框
            val box = if (pics.size == 1 && a.width != null && a.height != null) {
                val ratio = a.height.toFloat() / a.width
                val w = 220f.coerceAtMost(280f / ratio).coerceAtLeast(120f)
                Modifier.width(w.dp).height((w * ratio).coerceIn(90f, 280f).dp)
            } else Modifier.size(if (pics.size == 1) 160.dp else 96.dp)
            AsyncImage(absUrl(a.url), a.name, contentScale = ContentScale.Crop, modifier = box.clip(RoundedCornerShape(14.dp)).background(sky.glass1))
        }
    }
    docs.forEach { a -> FileChip(a.name, a.mime) }
}

private fun fileKind(mime: String) = when (mime.substringBefore(';')) {
    "text/csv" -> "CSV 表格"; "text/markdown" -> "Markdown"; "application/json" -> "JSON"; "text/plain" -> "文本"
    else -> if (mime.startsWith("image/")) "图片" else "文件"
}

@Composable
private fun FileChip(name: String, mime: String, trailing: (@Composable () -> Unit)? = null) {
    val sky = LocalSky.current
    Row(
        Modifier.widthIn(max = 260.dp).height(46.dp).clip(RoundedCornerShape(12.dp)).background(sky.glass2).padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text("📄", fontSize = 14.sp)
        Spacer(Modifier.width(6.dp))
        Column(Modifier.weight(1f, fill = false)) {
            Text(name, color = sky.ink1, fontSize = 13.sp, lineHeight = 16.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(fileKind(mime), color = sky.ink3, fontSize = 10.5.sp, lineHeight = 13.sp, maxLines = 1)
        }
        trailing?.invoke()
    }
}

/** 输入框上方待发的附件：图片 56dp 小方块（上传中盖一层转圈），文件一个胶囊；失败红边，点一下重试；右上 ✕ 移除。 */
@Composable
fun AttachmentStrip(vm: AppViewModel) {
    val sky = LocalSky.current
    AnimatedVisibility(vm.files.isNotEmpty(), enter = fadeIn(tween(180)) + expandVertically(tween(200)), exit = fadeOut(tween(150)) + shrinkVertically(tween(200))) {
        Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, top = 8.dp)) {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                vm.files.forEach { f -> PendingFileView(vm, f) }
            }
            vm.files.firstOrNull { it.state == "failed" }?.let { f ->
                Text("「${f.name}」${f.error ?: "上传失败"}", color = sky.danger, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
            }
        }
    }
}

@Composable
private fun PendingFileView(vm: AppViewModel, f: PendingFile) {
    val sky = LocalSky.current
    val failed = f.state == "failed"
    Box(Modifier.semantics { contentDescription = "附件 ${f.name}" + when (f.state) { "uploading" -> "，上传中"; "failed" -> "，上传失败"; else -> "，已上传" } }) {
        val edge = if (failed) sky.danger else sky.glassEdge
        val tap = Modifier.clickable(enabled = failed) { vm.retryFile(f.localId) }
        if (f.image) {
            Box(Modifier.padding(top = 6.dp, end = 6.dp).size(56.dp).clip(RoundedCornerShape(12.dp)).border(1.5.dp, edge, RoundedCornerShape(12.dp)).then(tap), contentAlignment = Alignment.Center) {
                AsyncImage(f.uri, f.name, contentScale = ContentScale.Crop, modifier = Modifier.size(56.dp).background(sky.glass1))
                if (f.state == "uploading") Box(Modifier.size(56.dp).background(Color.Black.copy(alpha = 0.32f)), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(20.dp), color = Color.White, strokeWidth = 2.dp)
                }
                if (failed) Box(Modifier.size(56.dp).background(sky.danger.copy(alpha = 0.25f)), contentAlignment = Alignment.Center) { Text("↻", color = Color.White, fontSize = 18.sp) }
            }
        } else {
            Box(Modifier.padding(top = 6.dp, end = 6.dp).clip(RoundedCornerShape(12.dp)).border(1.5.dp, edge, RoundedCornerShape(12.dp)).then(tap)) {
                FileChip(f.name, f.mime) {
                    Spacer(Modifier.width(6.dp))
                    if (f.state == "uploading") CircularProgressIndicator(Modifier.size(14.dp), color = sky.accent, strokeWidth = 1.8.dp)
                    else if (failed) Text("↻", color = sky.danger, fontSize = 14.sp)
                    else Text("✓", color = sky.success, fontSize = 13.sp)
                }
            }
        }
        Box(
            Modifier.align(Alignment.TopEnd).size(22.dp).clip(CircleShape).background(sky.ink1.copy(alpha = 0.78f))
                .clickable(role = Role.Button) { vm.removeFile(f.localId) }.semantics { contentDescription = "移除 ${f.name}" },
            contentAlignment = Alignment.Center,
        ) { Text("✕", color = sky.skyBottom, fontSize = 10.sp, fontWeight = FontWeight.Bold) }
    }
}

/**
 * 用户气泡（右侧）：附件 + 文字。长按 → 复制 / 编辑；最后一条人发的消息下面常显「✎ 编辑」（手机上没有悬停）。
 * 编辑：可直接重发原内容；仅空文字且无附件时不可发送。
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun UserMessage(vm: AppViewModel, msg: ChatMessage, editable: Boolean) {
    val sky = LocalSky.current
    val ctx = LocalContext.current
    var editing by remember(msg.id) { mutableStateOf(false) }
    var menu by remember(msg.id) { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        AnimatedContent(editing, transitionSpec = { fadeIn(tween(180)) togetherWith fadeOut(tween(120)) }, label = "edit") { isEditing ->
            if (isEditing) EditBox(vm, msg) { editing = false }
            else Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(4.dp)) {
                MessageFiles(msg.files, msg.images)
                if (msg.text.isNotBlank()) Box {
                    Text(
                        msg.text, color = sky.onUser, fontSize = 15.5.sp, lineHeight = 23.sp,
                        modifier = Modifier.widthIn(max = 300.dp).clip(RoundedCornerShape(18.dp, 18.dp, 6.dp, 18.dp)).background(sky.userBubble)
                            .combinedClickable(onClick = {}, onLongClick = { menu = true }).padding(horizontal = 13.dp, vertical = 9.dp),
                    )
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem({ Text("复制") }, { menu = false; copyText(ctx, msg.text) })
                        if (editable) DropdownMenuItem({ Text("编辑") }, { menu = false; editing = true })
                    }
                }
                if (editable) ActionChip("✎", "编辑", "编辑", enabled = !vm.running) { editing = true; true }
            }
        }
    }
}

@Composable
@OptIn(ExperimentalFoundationApi::class)
private fun EditBox(vm: AppViewModel, msg: ChatMessage, close: () -> Unit) {
    val sky = LocalSky.current
    var text by remember(msg.id) { mutableStateOf(msg.text) }
    val focus = remember { FocusRequester() }
    val bringIntoView = remember { BringIntoViewRequester() }
    LaunchedEffect(Unit) { delay(180); runCatching { focus.requestFocus(); bringIntoView.bringIntoView() } }
    val canResend = text.isNotBlank() || msg.files.isNotEmpty()
    Column(Modifier.fillMaxWidth().bringIntoViewRequester(bringIntoView).glass(sky, RoundedCornerShape(16.dp), level = 3).padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        BasicTextField(
            text, { text = it }, textStyle = TextStyle(color = sky.ink1, fontSize = 15.5.sp, lineHeight = 22.sp), cursorBrush = SolidColor(sky.accent),
            maxLines = 10, modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp).focusRequester(focus).semantics { contentDescription = "编辑消息" },
        )
        Text("发送后，这条之后的对话会换成新的回答", color = sky.ink3, fontSize = 12.sp)
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
            Text("取消", color = sky.ink2, fontSize = 14.sp, modifier = Modifier.clip(RoundedCornerShape(18.dp)).clickable(role = Role.Button) { close() }.padding(horizontal = 14.dp, vertical = 9.dp))
            Spacer(Modifier.width(6.dp))
            SmallAsyncButton("发送", "发送中…", "已发送", Modifier.width(96.dp), enabled = canResend && !vm.running && !vm.turnPreparing && !vm.modelSaving && !vm.selectedModelMissing) {
                val ok = vm.editAndResend(msg.id, text)
                if (ok) close()
                ok
            }
        }
    }
}

/** 「+」菜单：照片（系统相册选择器）/ 拍照 / 文件。 */
@Composable
fun AttachButton(onPhotos: () -> Unit, onCamera: () -> Unit, onFiles: () -> Unit, enabled: Boolean) {
    val sky = LocalSky.current
    var open by remember { mutableStateOf(false) }
    Box {
        Box(
            Modifier.size(44.dp).clip(CircleShape).background(sky.glass3).clickable(enabled = enabled, role = Role.Button) { open = true }
                .semantics { contentDescription = "添加附件" },
            contentAlignment = Alignment.Center,
        ) { Text("+", color = if (enabled) sky.ink2 else sky.ink4, fontSize = 22.sp) }
        DropdownMenu(open, { open = false }) {
            DropdownMenuItem({ Text("照片") }, { open = false; onPhotos() })
            DropdownMenuItem({ Text("拍照") }, { open = false; onCamera() })
            DropdownMenuItem({ Text("文件") }, { open = false; onFiles() })
        }
    }
}

/** 一句提示（3 秒后淡出），顶部玻璃小条：重发失败、附件太多、偏好已改等。 */
@Composable
fun NoticePill(vm: AppViewModel, modifier: Modifier = Modifier) {
    val sky = LocalSky.current
    val text = vm.notice
    LaunchedEffect(text) { if (text.isNotBlank()) { delay(3200); if (vm.notice == text) vm.notice = "" } }
    AnimatedVisibility(text.isNotBlank(), modifier, enter = fadeIn(tween(200)), exit = fadeOut(tween(200))) {
        Text(
            text, color = sky.ink1, fontSize = 13.5.sp,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).glass(sky, RoundedCornerShape(14.dp), 3).padding(horizontal = 14.dp, vertical = 9.dp),
        )
    }
}
