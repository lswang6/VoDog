package org.vodog

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Message
import androidx.compose.material.icons.filled.Block
import androidx.compose.material.icons.filled.Business
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Email
import androidx.compose.material.icons.filled.Notes
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.Place
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp

/**
 * S21 §F 联系人卡片 — reached from a 记录 row's "i", from the 记录详情 page and from 拦截记录. It shows
 * the name and every stored phone/email/address when the number is known, and the number alone when
 * it is not; the top row is always 拨打电话 / 发送短信, then 新建 / 添加到现有 / 屏蔽 或 解除屏蔽.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ContactCardSheet(state: ClientUiState, model: ClientViewModel) {
    val card = state.contactCard ?: return
    val actions = contactCardActions(card)
    val contact = card.resolvedContact
    var confirming by remember(card.target) { mutableStateOf<Boolean?>(null) }
    var creating by remember(card.target) { mutableStateOf(false) }
    var attaching by remember(card.target) { mutableStateOf(false) }
    ModalBottomSheet(
        onDismissRequest = model::closeContactCard,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surface,
        contentColor = MaterialTheme.colorScheme.onSurface,
    ) {
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
                .padding(horizontal = ScreenPadding).padding(bottom = 24.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                card.displayName ?: card.target.number.ifBlank { "号码未知" },
                style = MaterialTheme.typography.titleLarge,
            )
            if (card.displayName != null) {
                PhoneNumberText(card.target.number.ifBlank { "号码未知" })
            }
            contact?.organization?.takeIf(String::isNotBlank)?.let {
                ContactDetailRow(Icons.Filled.Business, "公司", it)
            }
            if (card.blocked) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Icon(Icons.Filled.Block, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.error)
                    Text("已屏蔽", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.error)
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                FilledTonalButton(
                    onClick = { model.requestDial(card.target.number) },
                    enabled = state.networkAvailable && actions.canCall,
                    modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                ) {
                    Icon(Icons.Filled.Call, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("拨打电话")
                }
                FilledTonalButton(
                    onClick = { model.requestSms(card.target.number) },
                    enabled = actions.canSms,
                    modifier = Modifier.weight(1f).heightIn(min = 52.dp),
                ) {
                    Icon(Icons.AutoMirrored.Filled.Message, contentDescription = null)
                    Spacer(Modifier.width(6.dp))
                    Text("发送短信")
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            when (val loaded = card.contact) {
                RemoteResource.NotLoaded, RemoteResource.Loading -> {
                    if (state.networkAvailable) LoadingRow("正在查询联系人…")
                    else Text("联系人详情未加载，联网后读取", Modifier.testTag("contactCard.offline"),
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                is RemoteResource.Failed -> Text(
                    "暂时读不到通讯录：${loaded.message}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                is RemoteResource.Loaded -> if (contact == null) {
                    Text(
                        "这个号码还不在通讯录里。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                } else {
                    ContactBody(contact)
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            if (actions.canCreateContact) {
                TextButton(
                    onClick = { model.clearContactMessage(); creating = true },
                    enabled = state.networkAvailable,
                    modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget),
                ) {
                    Icon(Icons.Filled.PersonAdd, null)
                    Spacer(Modifier.width(8.dp))
                    Text("新建联系人")
                }
            }
            if (actions.canAttachToContact) {
                TextButton(
                    onClick = { model.clearContactMessage(); attaching = true; model.refreshContacts() },
                    enabled = state.networkAvailable,
                    modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget),
                ) {
                    Icon(Icons.Filled.Person, null)
                    Spacer(Modifier.width(8.dp))
                    Text("添加到现有联系人")
                }
            }
            TextButton(
                // The flag is the *current* state, so the dialog and the request cannot disagree
                // about which direction the tap means.
                onClick = { confirming = card.blocked },
                enabled = state.networkAvailable && (if (card.blocked) actions.canUnblock else actions.canBlock),
                modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget),
                colors = destructiveTextColors(),
            ) {
                Icon(
                    Icons.Filled.Block,
                    null,
                )
                Spacer(Modifier.width(8.dp))
                Text(actions.blockLabel)
            }
            actions.disabledReason?.let {
                Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (card.busy) LoadingRow("正在提交…")
            if (card.status.isNotBlank()) StatusLine(card.status)
            if (card.message.isNotBlank()) MessageCard(card.message)
        }
    }
    confirming?.let { currentlyBlocked ->
        val prompt = contactBlockConfirm(card.target, currentlyBlocked)
        AlertDialog(
            onDismissRequest = { confirming = null },
            title = { Text(prompt.title) },
            text = { Text(prompt.message) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirming = null
                        model.setContactCardBlocked(!currentlyBlocked)
                    },
                    colors = destructiveTextColors(),
                    modifier = Modifier.testTag("contactCard.block.confirm"),
                    enabled = state.networkAvailable && !card.busy,
                ) { Text(prompt.confirmLabel) }
            },
            dismissButton = { TextButton(onClick = { confirming = null }) { Text("取消") } },
        )
    }
    if (creating) ContactEditorDialog(
        initial = null,
        presetNumber = card.target.number,
        busy = state.contactBusy,
        message = state.contactMessage,
        onDismiss = { creating = false },
        onSave = { draft ->
            model.createContact(
                draft,
                afterSuccess = {
                    creating = false
                    model.closeContactCard()
                },
            )
        },
    )
    if (attaching) ContactPickerDialog(
        state = state,
        onDismiss = { attaching = false },
        onPick = { contactId ->
            model.addNumberToContact(
                contactId,
                card.target.number,
                afterSuccess = {
                    attaching = false
                    model.closeContactCard()
                },
            )
        },
    )
}

/** Every stored phone, email and address for a resolved contact. */
@Composable
private fun ContactBody(contact: ClientContact) {
    contact.phones.forEach { phone ->
        ContactDetailRow(Icons.Filled.Call, contactLabelText(phone.label), phone.rawNumber, monospace = true)
    }
    contact.emails.forEach { email ->
        ContactDetailRow(Icons.Filled.Email, contactLabelText(email.label), email.address)
    }
    contact.addresses.forEach { address ->
        ContactDetailRow(Icons.Filled.Place, contactLabelText(address.label), address.displayLine)
    }
    contact.notes?.takeIf(String::isNotBlank)?.let { ContactDetailRow(Icons.Filled.Notes, "备注", it) }
    Text(
        contactSourceLabel(contact.source),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
internal fun ContactDetailRow(icon: ImageVector, label: String, value: String, monospace: Boolean = false) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = TouchTarget),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(1.dp)) {
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                value,
                style = MaterialTheme.typography.bodyLarge,
                fontFamily = if (monospace) FontFamily.Monospace else null,
            )
        }
    }
}

/** "添加到现有联系人" — the picker the §F wording calls 选择列表. */
@Composable
private fun ContactPickerDialog(state: ClientUiState, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    val contacts = (state.contacts as? RemoteList.Loaded)?.items.orEmpty()
        .mapNotNull { runCatching { it.toClientContact() }.getOrNull() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("选择联系人") },
        text = {
            when {
                state.contacts is RemoteList.Loading -> LoadingRow("正在读取通讯录…")
                state.contacts is RemoteList.Failed ->
                    MessageCard("通讯录读取失败：${(state.contacts as RemoteList.Failed).message}")
                contacts.isEmpty() -> Text("通讯录还是空的，请先导入或新建联系人。")
                else -> LazyColumn(Modifier.fillMaxWidth().heightIn(max = 360.dp)) {
                    if (state.contactMessage.isNotBlank()) item {
                        MessageCard(state.contactMessage)
                    }
                    items(contacts, key = ClientContact::id) { contact ->
                        ListItem(
                            modifier = Modifier.heightIn(min = TouchTarget),
                            colors = ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
                            headlineContent = { Text(contact.displayName) },
                            supportingContent = {
                                Text(
                                    contact.listSubtitle,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            },
                            leadingContent = { Icon(Icons.Filled.Person, null) },
                        )
                        TextButton(
                            onClick = { onPick(contact.id) },
                            enabled = state.networkAvailable && !state.contactBusy,
                            modifier = Modifier.fillMaxWidth().heightIn(min = TouchTarget),
                        ) { Text("加到「${contact.displayName}」") }
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss, enabled = !state.contactBusy) { Text("取消") } },
    )
}

/**
 * The card is opened from three different row shapes, so building the target is a one-liner the
 * callers share rather than a JSON dig repeated per screen.
 */
internal fun callContactCardTarget(call: org.json.JSONObject): ContactCardTarget = ContactCardTarget(
    number = call.optString("remoteNumber"),
    sourceCallId = call.optString("id").takeIf(String::isNotBlank),
    annotation = call.toContactAnnotation(),
)

/** The 短信 tab opens the same card for a thread, keyed on the thread's real reply number. */
internal fun smsContactCardTarget(conversation: SmsConversation): ContactCardTarget = ContactCardTarget(
    number = conversation.contactNumber,
    // `sourceCallId` is a call id on the server; an SMS thread has none to offer.
    sourceCallId = null,
    annotation = conversation.contact,
)

/**
 * An interception is history: the number was blocked when the call or SMS arrived, but it may have
 * been unblocked since. §B gives `blockedEntryId` exactly so the card can tell the two apart —
 * assuming "still blocked" would leave the card offering neither 屏蔽 nor 解除屏蔽.
 */
internal fun interceptionContactCardTarget(item: ClientInterception): ContactCardTarget = ContactCardTarget(
    number = item.remoteNumber,
    sourceCallId = null,
    annotation = ContactAnnotation(
        contactId = item.contactId,
        contactName = item.contactName,
        blocked = item.blockedEntryId != null,
        blockedEntryId = item.blockedEntryId,
    ),
)
