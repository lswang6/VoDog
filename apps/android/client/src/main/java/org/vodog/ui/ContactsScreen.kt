package org.vodog

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Message
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Contacts
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Notes
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Place
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleStartEffect

/**
 * S21 §F 通讯录 tab: search, the owner's contacts with their primary number and a 已屏蔽 badge,
 * "导入本机通讯录" behind a runtime READ_CONTACTS prompt, and a detail page that edits or deletes.
 * The list itself is whatever the server returns — 架构决策 2 keeps matching and de-duplication
 * server-side, so nothing here merges or hides a row.
 */
@Composable
internal fun ContactsPage(state: ClientUiState, model: ClientViewModel, onDetailVisible: (Boolean) -> Unit) {
    val context = LocalContext.current
    var selectedId by rememberSaveable { mutableStateOf<String?>(null) }
    var creating by rememberSaveable { mutableStateOf(false) }
    var showRationale by remember { mutableStateOf(false) }
    var permissionDenied by remember { mutableStateOf(false) }
    val contacts = (state.contacts as? RemoteList.Loaded)?.items.orEmpty()
        .mapNotNull { runCatching { it.toClientContact() }.getOrNull() }
    val selected = state.contactDetail?.takeIf { it.id == selectedId }
        ?: contacts.firstOrNull { it.id == selectedId }
    val contactsPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        permissionDenied = !granted
        if (granted && model.state.value.networkAvailable) model.importDeviceContacts()
    }
    fun startImport() {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            permissionDenied = false
            model.importDeviceContacts()
        } else {
            showRationale = true
        }
    }
    LaunchedEffect(state.session?.username, state.networkAvailable) { if (state.session != null && state.networkAvailable) model.refreshContacts() }
    LifecycleStartEffect(Unit) {
        model.startForegroundRefresh(ClientRefreshScope.CONTACTS)
        onStopOrDispose { model.stopForegroundRefresh(ClientRefreshScope.CONTACTS) }
    }
    LaunchedEffect(selected != null) { onDetailVisible(selected != null) }
    LaunchedEffect(state.contactDetail?.id, state.contactMessage, selectedId) {
        if (selectedId != null && state.contactDetail == null &&
            state.contactMessage in setOf("联系人已在另一端删除", "联系人已删除")
        ) {
            selectedId = null
        }
    }
    if (selected != null) {
        BackHandler { model.closeContactDetail(); selectedId = null }
        ContactDetailPage(selected, state, model, onBack = {
            model.closeContactDetail()
            selectedId = null
        })
        return
    }
    // iOS has `.refreshable` here; without it this tab only ever loaded once per session and a
    // contact edited elsewhere could not be pulled in (R4 Part B must-fix). `remoteListDuringRefresh`
    // keeps a loaded list loaded, so the spinner is driven by a local flag, not by the list state.
    var refreshing by remember { mutableStateOf(false) }
    LaunchedEffect(state.contacts) { refreshing = false }
    PullToRefresh(refreshing, { refreshing = true; model.refreshContacts() }) {
    LazyColumn(
        Modifier.fillMaxSize(),
        // S68: 8 dp under the page header, same as the SIM strip on 电话 / 短信 / 记录.
        contentPadding = PaddingValues(start = ScreenPadding, top = 8.dp, end = ScreenPadding, bottom = ScreenPadding),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            OutlinedTextField(
                value = state.contactQuery,
                onValueChange = model::setContactQuery,
                enabled = state.networkAvailable,
                modifier = Modifier.fillMaxWidth(),
                label = { Text("搜索姓名或号码") },
                singleLine = true,
                leadingIcon = { Icon(Icons.Filled.Search, null) },
                trailingIcon = {
                    if (state.contactQuery.isNotEmpty()) {
                        IconButton(onClick = { model.setContactQuery("") }, enabled = state.networkAvailable, modifier = Modifier.size(TouchTarget)) {
                            Icon(Icons.Filled.Close, contentDescription = "清除搜索")
                        }
                    }
                },
            )
        }
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(
                    onClick = ::startImport,
                    enabled = state.networkAvailable && !state.contactImport.running,
                    modifier = Modifier.weight(1f).heightIn(min = TouchTarget),
                ) {
                    Icon(Icons.Filled.Download, null)
                    Spacer(Modifier.width(8.dp))
                    Text("导入本机通讯录")
                }
                FilledTonalButton(
                    onClick = { model.clearContactMessage(); creating = true },
                    enabled = state.networkAvailable && !state.contactBusy,
                    modifier = Modifier.weight(1f).heightIn(min = TouchTarget).testTag("contacts.create"),
                ) {
                    Icon(Icons.Filled.PersonAdd, null)
                    Spacer(Modifier.width(8.dp))
                    Text("新建联系人")
                }
            }
        }
        item { ContactImportStatus(state.contactImport, permissionDenied, model::dismissContactImport) }
        if (state.contactMessage.isNotBlank()) item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) { StatusOrErrorCard(state.contactMessage) }
                TextButton(onClick = model::clearContactMessage) { Text("知道了") }
            }
        }
        item { InlineSectionHeader("联系人") }
        when (val loaded = state.contacts) {
            RemoteList.NotLoaded, RemoteList.Loading -> item { LoadingRow("正在读取通讯录…") }
            is RemoteList.Failed -> item {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    MessageCard("通讯录读取失败：${loaded.message}")
                    OutlinedButton(
                        onClick = { model.refreshContacts() },
                        enabled = state.networkAvailable,
                        modifier = Modifier.heightIn(min = TouchTarget),
                    ) { Text("重试") }
                }
            }
            is RemoteList.Loaded -> if (contacts.isEmpty()) item {
                EmptyStateCard(
                    Icons.Filled.Contacts,
                    if (state.contactQuery.isBlank()) "通讯录还是空的" else "没有匹配的联系人",
                    if (state.contactQuery.isBlank()) "可以导入本机通讯录，或手动新建一个联系人。" else null,
                )
            } else {
                items(contacts, key = ClientContact::id) { contact ->
                    ContactRow(contact) {
                        model.openContactDetail(contact)
                        selectedId = contact.id
                    }
                }
                // The server caps one page at 200 (§A) and this screen does not page; say so rather
                // than letting a large address book look truncated for no reason.
                if (contacts.size >= ClientApiRoutes.CONTACTS_PAGE_LIMIT) item {
                    Text(
                        "只显示前 ${ClientApiRoutes.CONTACTS_PAGE_LIMIT} 位联系人，请用搜索缩小范围。",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
    }
    if (showRationale) AlertDialog(
        onDismissRequest = { showRationale = false },
        title = { Text("需要读取本机通讯录") },
        text = {
            Text(
                "导入会读取这台手机通讯录里的姓名、号码、邮箱和地址，并上传到你自己的 VoDog 账号，" +
                    "用于在通话记录和短信里显示来电者姓名。不会读取通话内容，也不会与他人共享。",
            )
        },
        confirmButton = {
            TextButton(onClick = {
                showRationale = false
                contactsPermission.launch(Manifest.permission.READ_CONTACTS)
            }, enabled = state.networkAvailable) { Text("允许并导入") }
        },
        dismissButton = { TextButton(onClick = { showRationale = false }) { Text("暂不") } },
    )
    if (creating) ContactEditorDialog(
        initial = null,
        presetNumber = null,
        busy = state.contactBusy,
        message = state.contactMessage,
        onDismiss = { creating = false },
        onSave = { draft -> model.createContact(draft, afterSuccess = { creating = false }) },
    )
}

/** 新增/更新/合并/跳过 — the server's own counters, shown verbatim when the import finishes. */
@Composable
private fun ContactImportStatus(
    importState: ContactImportUiState,
    permissionDenied: Boolean,
    onDismiss: () -> Unit,
) {
    if (permissionDenied) {
        MessageCard("没有通讯录权限，导入已取消。可以在系统设置里授予权限后重试，或手动新建联系人。")
        return
    }
    when (importState) {
        ContactImportUiState.Idle -> Unit
        ContactImportUiState.Reading -> LoadingRow("正在读取本机通讯录…")
        is ContactImportUiState.Uploading -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Text(
                "正在上传 ${importState.uploaded} / ${importState.total}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (importState.total > 0) {
                LinearProgressIndicator(
                    progress = { importState.uploaded.toFloat() / importState.total.toFloat() },
                    modifier = Modifier.fillMaxWidth(),
                )
            } else {
                Text("本机通讯录没有可导入的联系人。", style = MaterialTheme.typography.bodySmall)
            }
        }
        is ContactImportUiState.Done -> Card(
            Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        ) {
            Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("导入完成", style = MaterialTheme.typography.titleSmall)
                Text(importState.result.summary, style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = TouchTarget)) { Text("知道了") }
            }
        }
        is ContactImportUiState.Failed -> Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
            MessageCard("导入失败：${importState.message}")
            TextButton(onClick = onDismiss, modifier = Modifier.heightIn(min = TouchTarget)) { Text("知道了") }
        }
    }
}

/** Contact rows say what happened either way, so a success is not dressed as an error. */
@Composable
private fun StatusOrErrorCard(message: String) {
    if (message.endsWith("已创建") || message.endsWith("已更新") || message.endsWith("已删除") ||
        message.endsWith("已添加到联系人")
    ) {
        StatusLine(message)
    } else {
        MessageCard(message)
    }
}

@Composable
private fun ContactRow(contact: ClientContact, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth().testTag("contacts.row.${contact.id}"),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        ListItem(
            modifier = Modifier.heightIn(min = TouchTarget),
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            leadingContent = { Icon(Icons.Filled.Person, null, tint = MaterialTheme.colorScheme.primary) },
            headlineContent = { Text(contact.displayName, style = MaterialTheme.typography.titleMedium) },
            supportingContent = {
                Text(
                    contact.listSubtitle,
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            },
            trailingContent = {
                if (contact.blocked) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                        Icon(Icons.Filled.Block, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.error)
                        Text("已屏蔽", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                    }
                }
            },
        )
    }
}

@Composable
private fun ContactDetailPage(
    contact: ClientContact,
    state: ClientUiState,
    model: ClientViewModel,
    onBack: () -> Unit,
) {
    var editing by remember(contact.id) { mutableStateOf<ClientContact?>(null) }
    var deleting by remember(contact.id) { mutableStateOf<ClientContact?>(null) }
    var editorRevision by remember(contact.id) { mutableStateOf(0) }
    val primary = contact.primaryPhone?.dialNumber.orEmpty()
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = ScreenPadding),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IconButton(onClick = onBack, modifier = Modifier.size(TouchTarget)) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回通讯录")
            }
            Text(
                contact.displayName,
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.weight(1f),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            TextButton(
                onClick = { editing = contact },
                enabled = !state.contactBusy,
                modifier = Modifier.heightIn(min = TouchTarget).testTag("contact.edit"),
            ) { Text("编辑") }
        }
        LazyColumn(
            Modifier.fillMaxWidth().weight(1f),
            contentPadding = PaddingValues(ScreenPadding),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (contact.blocked) item {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Icon(Icons.Filled.Block, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error)
                    Text("这个联系人的号码已被屏蔽", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
            }
            item {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    FilledTonalButton(
                        onClick = { model.requestDial(primary) },
                        enabled = state.networkAvailable && dialableNumber(primary),
                        modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                    ) {
                        Icon(Icons.Filled.Call, null)
                        Spacer(Modifier.width(6.dp))
                        Text("拨打")
                    }
                    FilledTonalButton(
                        onClick = { model.requestSms(primary) },
                        enabled = dialableNumber(primary),
                        modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                    ) {
                        Icon(Icons.AutoMirrored.Filled.Message, null)
                        Spacer(Modifier.width(6.dp))
                        Text("短信")
                    }
                }
            }
            item {
                Card(
                    Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
                ) {
                    Column(Modifier.padding(ScreenPadding), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        contact.organization?.takeIf(String::isNotBlank)?.let {
                            ContactDetailRow(Icons.Filled.Business, "公司", it)
                        }
                        contact.phones.forEach { phone ->
                            ContactDetailRow(Icons.Filled.Call, contactLabelText(phone.label), phone.rawNumber, monospace = true)
                        }
                        contact.emails.forEach { email ->
                            ContactDetailRow(Icons.Filled.Email, contactLabelText(email.label), email.address)
                        }
                        contact.addresses.forEach { address ->
                            ContactDetailRow(Icons.Filled.Place, contactLabelText(address.label), address.displayLine)
                        }
                        contact.notes?.takeIf(String::isNotBlank)?.let {
                            ContactDetailRow(Icons.Filled.Notes, "备注", it)
                        }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        Text(
                            listOfNotNull(
                                contactSourceLabel(contact.source),
                                contact.updatedAt?.let { "更新于 ${displayDateTime(it)}" },
                            ).joinToString(" · "),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            if (contact.id in state.contactConflicts) {
                item {
                    val latestReady = state.contactDetail?.let { latest ->
                        latest.id == contact.id && latest.version >= (state.contactConflicts[contact.id] ?: Long.MAX_VALUE)
                    } == true
                    OutlinedButton(
                        onClick = { model.acceptLatestContactConflict(contact.id) },
                        enabled = latestReady && !state.contactBusy,
                        modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget),
                    ) { Text(if (latestReady) "载入最新内容并重新核对" else if (!state.networkAvailable) "最新内容未加载，联网后读取" else "正在载入最新内容…") }
                }
            }
            if (state.contactMessage.isNotBlank()) item { StatusOrErrorCard(state.contactMessage) }
            item {
                OutlinedButton(
                    onClick = { deleting = contact },
                    enabled = state.networkAvailable && !state.contactBusy,
                    modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget).testTag("contact.delete"),
                    colors = destructiveOutlinedColors(),
                    border = destructiveBorder(),
                ) {
                    Icon(Icons.Filled.Delete, null)
                    Spacer(Modifier.width(8.dp))
                    Text("删除")
                }
            }
        }
    }
    editing?.let { editTarget -> ContactEditorDialog(
        initial = editTarget,
        presetNumber = null,
        busy = state.contactBusy,
        message = state.contactMessage,
        conflict = editTarget.id in state.contactConflicts,
        latestReady = state.contactDetail?.let { latest ->
            latest.id == editTarget.id && latest.version >= (state.contactConflicts[editTarget.id] ?: Long.MAX_VALUE)
        } == true,
        revision = editorRevision,
        onLoadLatest = {
            if (model.acceptLatestContactConflict(editTarget.id)) {
                state.contactDetail?.let { editing = it }
                editorRevision += 1
            }
        },
        onDismiss = { editing = null },
        onSave = { draft -> model.updateContact(editTarget, draft) },
    ) }
    LaunchedEffect(state.contactMessage, state.contactBusy) {
        if (!state.contactBusy && state.contactMessage == "联系人已更新") editing = null
    }
    deleting?.let { deleteTarget -> AlertDialog(
        onDismissRequest = { deleting = null },
        title = { Text("删除「${deleteTarget.displayName}」？") },
        text = { Text("删除后通话记录里将不再显示这个名字，号码本身不受影响。") },
        confirmButton = {
            TextButton(onClick = {
                deleting = null
                model.deleteContact(deleteTarget)
            }, enabled = state.networkAvailable && !state.contactBusy, modifier = Modifier.testTag("contact.delete.confirm"), colors = destructiveTextColors()) {
                Text("删除")
            }
        },
        dismissButton = { TextButton(onClick = { deleting = null }) { Text("取消") } },
    ) }
}

/**
 * An untouched address field round-trips every stored part; an edited one replaces the first address
 * and leaves any others alone. Pulled out of the composable so the rule is testable.
 */
internal fun contactEditorAddresses(
    stored: List<ClientContactAddress>,
    storedLine: String,
    edited: String,
): List<ContactAddressDraft> {
    val passthrough = stored.map {
        ContactAddressDraft(it.formatted, it.label, it.street, it.city, it.region, it.postalCode, it.country)
    }
    if (edited.trim() == storedLine.trim()) return passthrough.filterNot(ContactAddressDraft::empty)
    val replacement = edited.trim().takeIf(String::isNotEmpty)?.let {
        ContactAddressDraft(formatted = it, label = stored.firstOrNull()?.label)
    }
    return (listOfNotNull(replacement) + passthrough.drop(1)).filterNot(ContactAddressDraft::empty)
}

/**
 * Create and edit share one dialog: the server replaces the whole contact on `PUT`, so an edit form
 * that omitted a field would silently drop it.
 */
@Composable
internal fun ContactEditorDialog(
    initial: ClientContact?,
    presetNumber: String?,
    busy: Boolean,
    message: String = "",
    conflict: Boolean = false,
    latestReady: Boolean = false,
    revision: Int = 0,
    onLoadLatest: () -> Unit = {},
    onDismiss: () -> Unit,
    onSave: (ContactDraft) -> Unit,
) {
    var conflictNoticeVisible by remember(initial?.id) { mutableStateOf(false) }
    LaunchedEffect(conflict) { if (conflict) conflictNoticeVisible = true }
    var displayName by remember(initial?.id, revision) { mutableStateOf(initial?.displayName.orEmpty()) }
    var familyName by remember(initial?.id, revision) { mutableStateOf(initial?.familyName.orEmpty()) }
    var givenName by remember(initial?.id, revision) { mutableStateOf(initial?.givenName.orEmpty()) }
    var organization by remember(initial?.id, revision) { mutableStateOf(initial?.organization.orEmpty()) }
    var notes by remember(initial?.id, revision) { mutableStateOf(initial?.notes.orEmpty()) }
    // PUT replaces the contact wholesale, so an untouched address field must hand back every part
    // the server already stored (street/city/postcode and any second address), not a flattened line.
    val storedAddresses = remember(initial?.id, revision) { initial?.addresses.orEmpty() }
    val storedAddressLine = remember(initial?.id, revision) {
        storedAddresses.firstOrNull()?.displayLine?.takeIf { it != "地址未填写" }.orEmpty()
    }
    var address by remember(initial?.id, revision) { mutableStateOf(storedAddressLine) }
    val phones = remember(initial?.id, revision) {
        mutableStateListOf<String>().apply {
            initial?.phones?.forEach { add(it.rawNumber) }
            presetNumber?.takeIf(String::isNotBlank)?.let { if (it !in this) add(it) }
            if (isEmpty()) add("")
        }
    }
    val emails = remember(initial?.id, revision) {
        mutableStateListOf<String>().apply { initial?.emails?.forEach { add(it.address) } }
    }
    val draft = ContactDraft(
        displayName = displayName.trim(),
        givenName = givenName.trim().takeIf(String::isNotEmpty),
        familyName = familyName.trim().takeIf(String::isNotEmpty),
        organization = organization.trim().takeIf(String::isNotEmpty),
        notes = notes.trim().takeIf(String::isNotEmpty),
        phones = phones.mapNotNull { it.trim().takeIf(String::isNotEmpty)?.let(::ContactPhoneDraft) },
        emails = emails.mapNotNull { it.trim().takeIf(String::isNotEmpty)?.let(::ContactEmailDraft) },
        addresses = contactEditorAddresses(storedAddresses, storedAddressLine, address),
    )
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("contact.editor"),
        title = { Text(if (initial == null) "新建联系人" else "编辑联系人") },
        text = {
            Column(
                // S30：对话框是另一个窗口，根 Box 的「点空白处收键盘」够不着，这里自己贴一次。
                Modifier.fillMaxWidth().heightIn(max = 420.dp).dismissKeyboardOnTapOutside()
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (conflict) {
                    MessageCard("联系人已在另一端更新，当前草稿已保留。载入最新内容后请重新核对。")
                    OutlinedButton(
                        onClick = onLoadLatest,
                        enabled = latestReady && !busy,
                        modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget).testTag("contact.loadLatest"),
                    ) { Text(if (latestReady) "载入最新内容（替换当前草稿）" else if (!LocalNetworkAvailable.current) "最新内容未加载，联网后读取" else "正在载入最新内容…") }
                } else if (message.isNotBlank() && message != "联系人已更新") {
                    MessageCard(message)
                }
                OutlinedTextField(
                    value = displayName,
                    onValueChange = { displayName = it.take(120) },
                    modifier = Modifier.fillMaxWidth().testTag("contact.name"),
                    label = { Text("姓名") },
                    singleLine = true,
                    isError = displayName.isBlank(),
                )
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(
                        value = familyName,
                        onValueChange = { familyName = it.take(60) },
                        modifier = Modifier.weight(1f).testTag("contact.familyName"),
                        label = { Text("姓") },
                        singleLine = true,
                    )
                    OutlinedTextField(
                        value = givenName,
                        onValueChange = { givenName = it.take(60) },
                        modifier = Modifier.weight(1f).testTag("contact.givenName"),
                        label = { Text("名") },
                        singleLine = true,
                    )
                }
                OutlinedTextField(
                    value = organization,
                    onValueChange = { organization = it.take(120) },
                    modifier = Modifier.fillMaxWidth().testTag("contact.organization"),
                    label = { Text("公司") },
                    singleLine = true,
                )
                InlineSectionHeader("电话")
                phones.forEachIndexed { index, value ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = value,
                            onValueChange = { phones[index] = it.take(64) },
                            modifier = Modifier.weight(1f).testTag("contact.phone.$index"),
                            label = { Text("电话 ${index + 1}") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Phone),
                        )
                        IconButton(
                            onClick = { if (phones.size > 1) phones.removeAt(index) else phones[index] = "" },
                            modifier = Modifier.size(TouchTarget),
                        ) {
                            Icon(
                                Icons.Filled.Close,
                                contentDescription = "删除这个号码",
                                tint = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
                TextButton(onClick = { phones.add("") }, modifier = Modifier.heightIn(min = TouchTarget)) {
                    Icon(Icons.Filled.Add, null)
                    Spacer(Modifier.width(6.dp))
                    Text("添加电话")
                }
                InlineSectionHeader("邮箱")
                emails.forEachIndexed { index, value ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        OutlinedTextField(
                            value = value,
                            onValueChange = { emails[index] = it.take(160) },
                            modifier = Modifier.weight(1f).testTag("contact.email.$index"),
                            label = { Text("邮箱 ${index + 1}") },
                            singleLine = true,
                            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email),
                        )
                        IconButton(onClick = { emails.removeAt(index) }, modifier = Modifier.size(TouchTarget)) {
                            Icon(
                                Icons.Filled.Close,
                                contentDescription = "删除这个邮箱",
                                tint = MaterialTheme.colorScheme.error,
                            )
                        }
                    }
                }
                TextButton(onClick = { emails.add("") }, modifier = Modifier.heightIn(min = TouchTarget)) {
                    Icon(Icons.Filled.Add, null)
                    Spacer(Modifier.width(6.dp))
                    Text("添加邮箱")
                }
                OutlinedTextField(
                    value = address,
                    onValueChange = { address = it.take(240) },
                    modifier = Modifier.fillMaxWidth().testTag("contact.address"),
                    label = { Text("地址") },
                    minLines = 2,
                )
                OutlinedTextField(
                    value = notes,
                    onValueChange = { notes = it.take(500) },
                    modifier = Modifier.fillMaxWidth().testTag("contact.notes"),
                    label = { Text("备注") },
                    minLines = 2,
                )
                if (!draft.valid) {
                    Text(
                        "需要姓名，并至少填写一个电话或邮箱。",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onSave(draft) },
                enabled = LocalNetworkAvailable.current && draft.valid && !busy && !conflict,
                modifier = Modifier.testTag("contact.save"),
            ) { Text("保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("取消") } },
    )
    if (conflict && conflictNoticeVisible) {
        AlertDialog(
            onDismissRequest = { conflictNoticeVisible = false },
            title = { Text("联系人已在另一端更新") },
            text = { Text("当前草稿已保留。载入最新内容会替换这份草稿，请重新核对后再保存。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        if (latestReady) {
                            conflictNoticeVisible = false
                            onLoadLatest()
                        }
                    },
                    enabled = latestReady && !busy,
                ) { Text(if (latestReady) "载入最新内容（替换当前草稿）" else if (!LocalNetworkAvailable.current) "最新内容未加载，联网后读取" else "正在载入最新内容…") }
            },
            dismissButton = {
                TextButton(onClick = { conflictNoticeVisible = false }) { Text("保留草稿") }
            },
        )
    }
}
