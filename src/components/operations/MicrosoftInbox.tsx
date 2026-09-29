import { useCallback, useEffect, useRef, useState } from "react";
import { TrackedInbox } from "./TrackedInbox";
import DOMPurify from "dompurify";
import {
  Archive,
  ChevronDown,
  Folder,
  Mail,
  ShieldAlert,
  Trash2,
  FileText,
  Flag,
  Forward,
  Inbox,
  MailOpen,
  Paperclip,
  PenLine,
  RefreshCw,
  Reply,
  Search,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import type { Client } from "../../types/operations";
import {
  addressList,
  groupMicrosoftMessages,
  mailTimestamp,
  mailRequest,
  type MailAttachment,
  type MicrosoftFolder,
  type MicrosoftMessage,
  type Page,
} from "../../lib/microsoft-mail";
import { useMailConnection, MailConnectionCard } from "./MailConnection";
import { crmRequest } from '../../lib/crm-client';
import { buildCustomerQuotationPdf, quotationLogo, type CustomerQuotation } from '../../lib/customer-quotation';
import type { MailProviderName } from "./MailConnection";

function formatMailListDate(message: MicrosoftMessage) {
  const date = new Date(mailTimestamp(message));
  if (!Number.isFinite(date.getTime())) return "";
  const today = new Date();
  if (date.toDateString() === today.toDateString())
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.getFullYear() === today.getFullYear())
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  return date.toLocaleDateString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
const folderOrder = ['inbox', 'junkemail', 'drafts', 'sentitems', 'deleteditems', 'archive', 'conversationhistory', 'outbox'];
function folderKey(folder: MicrosoftFolder) { return `${folder.id} ${folder.displayName}`.toLowerCase().replace(/[^a-z]/g, ''); }
function folderRank(folder: MicrosoftFolder) {
  const key = folderKey(folder);
  const index = folderOrder.findIndex(item => key.includes(item));
  return index < 0 ? 100 : index;
}
function FolderIcon({ folder }: { folder: MicrosoftFolder }) {
  const rank = folderRank(folder);
  const Icon = rank === 0 ? Inbox : rank === 1 ? ShieldAlert : rank === 2 ? PenLine : rank === 3 ? Send : rank === 4 ? Trash2 : rank === 5 ? Archive : rank === 7 ? Mail : Folder;
  return <Icon size={16} aria-hidden="true" />;
}
async function attachmentBase64(file: File) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let start = 0; start < bytes.length; start += 16384) binary += String.fromCharCode(...bytes.subarray(start, start + 16384));
  return btoa(binary);
}
type RecipientSuggestion = { name: string; email: string; company?: string; source: string };
const recipientValue = (list?: MicrosoftMessage['toRecipients']) => {
  const addresses = addressList(list);
  return addresses ? `${addresses}, ` : '';
};
const textHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/\n/g, '<br>');
function RecipientField({ label, value, onChange, suggestions, disabled, placeholder, actions }: {
  label: string; value: string; onChange: (value: string) => void; suggestions: RecipientSuggestion[]; disabled: boolean; placeholder?: string; actions?: React.ReactNode;
}) {
  const [focused, setFocused] = useState(false);
  const parts = value.split(/[;,]/);
  const chosen = parts.slice(0, -1).map(item => item.trim()).filter(Boolean);
  const rawQuery = parts[parts.length - 1] || '';
  const query = rawQuery.trim();
  const prefix = chosen.length ? `${chosen.join(', ')}, ` : '';
  const selected = new Set(chosen.map(item => item.toLowerCase()));
  const matches = focused && query ? suggestions.filter(item => !selected.has(item.email.toLowerCase()) && `${item.name} ${item.email} ${item.company || ''}`.toLowerCase().includes(query.toLowerCase())).slice(0, 6) : [];
  return <div className="mail-recipient-field">
    <div className="mail-recipient-header"><label htmlFor={`mail-${label.toLowerCase()}`}>{label}</label>{actions}</div>
    <div className="mail-recipient-box">
      {chosen.map((address, index) => <span className="mail-recipient-chip" key={`${address}-${index}`}>{address}<button type="button" aria-label={`Remove ${address} from ${label}`} disabled={disabled} onClick={() => onChange(`${chosen.filter((_, i) => i !== index).join(', ')}${query ? `${chosen.length > 1 ? ', ' : ''}${query}` : chosen.length > 1 ? ', ' : ''}`)}><X size={12}/></button></span>)}
      <input id={`mail-${label.toLowerCase()}`} aria-label={`${label} emails`} autoComplete="off" value={rawQuery} disabled={disabled} placeholder={chosen.length ? '' : placeholder || 'Type a name or email'} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onChange={event => onChange(prefix + event.target.value)} onKeyDown={event => {
        if (event.key === 'Enter' && matches.length) { event.preventDefault(); onChange(`${prefix}${matches[0].email}, `); }
        else if ((event.key === 'Enter' || event.key === 'Tab') && query.includes('@')) { if (event.key === 'Enter') event.preventDefault(); onChange(`${prefix}${query}, `); }
      }}/>
    </div>
    {!!matches.length && <div className="mail-recipient-suggestions" role="listbox" aria-label={`${label} suggestions`}>{matches.map(item => <button type="button" role="option" aria-selected="false" key={item.email} onMouseDown={event => event.preventDefault()} onClick={() => { onChange(`${prefix}${item.email}, `); setFocused(true); }}><strong>{item.name}</strong><span>{item.email}</span><small>{item.company || item.source}</small></button>)}</div>}
  </div>;
}

export function ConnectedInbox({
  preview = false,
  focusId,
  children,
  customers,
  onQuote,
}: {
  preview?: boolean;
  focusId?: string;
  children: React.ReactNode;
  customers: Client[];
  onQuote: (id: string) => void;
}) {
  const connection = useMailConnection();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLElement>(null);
  const [view, setView] = useState<'inbox' | 'ai' | 'drafts' | 'sent' | 'archive' | 'deleted'>('inbox');
  useEffect(() => { if (focusId) setView('ai'); }, [focusId]);
  useEffect(() => {
    const tabs = tabsRef.current;
    const workspace = workspaceRef.current;
    if (!tabs || !workspace) return;
    const update = () => workspace.style.setProperty('--mail-tabs-height', `${tabs.getBoundingClientRect().height}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(tabs);
    return () => observer.disconnect();
  }, [preview]);
  if (preview) return <>{children}</>;
  const changeView = (next: typeof view) => {
    if (next === view) return;
    const navigation = new Event('dcx-before-navigate', { cancelable: true });
    window.dispatchEvent(navigation);
    if (!navigation.defaultPrevented) setView(next);
  };
  return (
    <div className="mail-workspace" ref={workspaceRef}>
      <nav className="mail-workspace-tabs" ref={tabsRef} aria-label="Email views">
        <button className={view === 'inbox' ? 'active' : ''} aria-current={view === 'inbox' ? 'page' : undefined} onClick={() => changeView('inbox')}><Inbox size={16}/> Inbox</button>
        <button className={view === 'ai' ? 'active' : ''} aria-current={view === 'ai' ? 'page' : undefined} onClick={() => changeView('ai')}><FileText size={16}/> AI Draft Replies</button>
        {connection.provider !== 'hostinger' && <button className={view === 'drafts' ? 'active' : ''} aria-current={view === 'drafts' ? 'page' : undefined} onClick={() => changeView('drafts')}><PenLine size={16}/> Drafts</button>}
        <button className={view === 'sent' ? 'active' : ''} aria-current={view === 'sent' ? 'page' : undefined} onClick={() => changeView('sent')}><Send size={16}/> Sent</button>
        {connection.provider !== 'hostinger' && <><button className={view === 'archive' ? 'active' : ''} aria-current={view === 'archive' ? 'page' : undefined} onClick={() => changeView('archive')}><Archive size={16}/> Archive</button>
        <button className={view === 'deleted' ? 'active' : ''} aria-current={view === 'deleted' ? 'page' : undefined} onClick={() => changeView('deleted')}><Trash2 size={16}/> Deleted</button></>}
      </nav>
      {view === 'ai' ? <TrackedInbox focusId={focusId} customers={customers} onQuote={onQuote} provider={connection.provider || 'microsoft'} onMailbox={() => changeView('inbox')} onSent={() => changeView('sent')} /> : connection.mode !== 'live' ? <MailConnectionCard /> : <MicrosoftInbox
        key={view}
        customers={customers}
        onQuote={onQuote}
        mailbox={connection.mailbox!}
        inboxId={connection.inboxId || 'inbox'}
        initialFolder={view === 'sent' ? (connection.provider === 'hostinger' ? 'INBOX.Sent' : 'sentitems') : view === 'drafts' ? 'drafts' : view === 'archive' ? 'archive' : view === 'deleted' ? 'deleteditems' : connection.inboxId || 'inbox'}
        sentOnly={view === 'sent'}
        provider={connection.provider || 'microsoft'}
      />}
    </div>
  );
}
function MicrosoftInbox({
  customers,
  onQuote,
  mailbox,
  inboxId,
  initialFolder,
  sentOnly,
  provider,
}: {
  customers: Client[];
  onQuote: (id: string) => void;
  mailbox: string;
  inboxId: string;
  initialFolder: string;
  sentOnly: boolean;
  provider: MailProviderName;
}) {
  const [folders, setFolders] = useState<MicrosoftFolder[]>([]);
  const [folder, setFolder] = useState(initialFolder);
  const [messages, setMessages] = useState<MicrosoftMessage[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [updated, setUpdated] = useState("");
  const [compose, setCompose] = useState(false);
  const ribbonRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const ribbon = ribbonRef.current;
    const workspace = ribbon?.closest<HTMLElement>('.mail-workspace');
    if (!ribbon || !workspace) return;
    const update = () => workspace.style.setProperty('--mail-ribbon-height', `${ribbon.getBoundingClientRect().height}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(ribbon);
    return () => observer.disconnect();
  }, []);
  const [editorRequest, setEditorRequest] = useState<{ id: string; kind: 'reply' | 'replyAll' | 'forward' | 'edit'; nonce: number }>();
  const [revision, setRevision] = useState(0);
  const [openThreads, setOpenThreads] = useState<string[]>([]);
  const [threadMessages, setThreadMessages] = useState<
    Record<string, MicrosoftMessage[]>
  >({});
  const dirty = useRef(false);
  const listSequence = useRef(0);
  const loading = useRef(false);
  const manualUnread = useRef(new Set<string>());
  const canLeave = () =>
    !dirty.current ||
    window.confirm(
      "Discard your unsaved reply changes? Save the draft first to keep them.",
    );
  const loadFolders = useCallback(async () => {
    let page = await mailRequest<Page<MicrosoftFolder>>("folders");
    const all = [...page.records];
    while (page.next) {
      page = await mailRequest("page", { cursor: page.next });
      all.push(...page.records);
    }
    setFolders(all.sort((a, b) => folderRank(a) - folderRank(b) || a.displayName.localeCompare(b.displayName)));
  }, []);
  const refresh = useCallback(
    async (cursor?: string) => {
      const seq = ++listSequence.current;
      loading.current = true;
      setBusy(true);
      setError("");
      try {
        const page = await mailRequest<Page<MicrosoftMessage>>(
          cursor ? "page" : "messages",
          cursor ? { cursor } : { folder },
        );
        if (seq !== listSequence.current) return;
        setMessages((old) =>
          cursor
            ? [
                ...new Map(
                  [...old, ...page.records].map((m) => [m.id, m]),
                ).values(),
              ]
            : page.records,
        );
        setNext(page.next);
        setUpdated(new Date().toLocaleTimeString());
        if (!cursor) setRevision((v) => v + 1);
      } catch (error) {
        if (seq === listSequence.current) setError((error as Error).message);
      } finally {
        if (seq === listSequence.current) {
          loading.current = false;
          setBusy(false);
        }
      }
    },
    [folder],
  );
  useEffect(() => {
    loadFolders().catch((e) => setError(e.message));
  }, [loadFolders]);
  useEffect(() => {
    setMessages([]);
    setNext(null);
    setOpenThreads([]);
    setThreadMessages({});
    refresh();
    const timer = window.setInterval(() => {
      if (
        document.visibilityState === "visible" &&
        !dirty.current &&
        !loading.current
      )
        refresh();
    }, 60000);
    return () => {
      clearInterval(timer);
      listSequence.current++;
    };
  }, [refresh]);
  const groups = groupMicrosoftMessages(messages)
    .map((thread) => {
      const complete = threadMessages[thread.id];
      return complete?.length
        ? {
            ...thread,
            messages: complete,
            latest: complete[complete.length - 1],
          }
        : thread;
    })
    .filter((t) =>
      t.messages.some((m) =>
        `${m.subject} ${m.bodyPreview} ${m.from?.emailAddress.address} ${addressList(m.toRecipients)}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ),
    )
    .sort(
      (a, b) =>
        mailTimestamp(b.latest) - mailTimestamp(a.latest) ||
        a.id.localeCompare(b.id),
    );
  const active = groups.find((t) => t.id === selected) || groups[0];
  const rememberThread = useCallback(
    (id: string, records: MicrosoftMessage[]) => {
      const ordered = groupMicrosoftMessages(records).flatMap(
        (thread) => thread.messages,
      );
      setThreadMessages((old) => ({ ...old, [id]: ordered }));
      if (ordered.length > 1)
        setOpenThreads((old) => (old.includes(id) ? old : [...old, id]));
    },
    [],
  );
  const unreadSignature =
    active?.messages
      .filter((message) => !message.isRead && !message.isDraft)
      .map((message) => message.id.slice(-24))
      .join("|") || "";
  const afterAction = () => {
    refresh();
    loadFolders().catch((e) => setError(e.message));
  };
  const missingPreviewIds =
    provider === "hostinger"
      ? messages
          .filter(
            (message) =>
              message.bodyPreview === "Open this message to read its contents.",
          )
          .slice(0, 20)
          .map((message) => message.id)
      : [];
  const previewSignature = missingPreviewIds
    .map((id) => id.slice(-24))
    .join("|");
  useEffect(() => {
    if (!previewSignature) return;
    const controller = new AbortController();
    mailRequest<{ records: { id: string; bodyPreview: string }[] }>(
      "previews",
      {},
      { ids: missingPreviewIds },
      controller.signal,
    )
      .then((result) => {
        const previews = new Map(
          result.records.map((item) => [item.id, item.bodyPreview]),
        );
        setMessages((old) =>
          old.map((message) =>
            previews.has(message.id)
              ? { ...message, bodyPreview: previews.get(message.id)! }
              : message,
          ),
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError((error as Error).message);
      });
    return () => controller.abort();
  }, [previewSignature]);
  useEffect(() => {
    if (!active) return;
    const unread = active.messages.filter(
      (message) => !message.isRead && !message.isDraft && !manualUnread.current.has(message.id),
    );
    if (!unread.length) return;
    const timer = window.setTimeout(() => {
      const ids = new Set(unread.map((message) => message.id));
      setMessages((old) =>
        old.map((message) =>
          ids.has(message.id) ? { ...message, isRead: true } : message,
        ),
      );
      setThreadMessages((old) =>
        active.id && old[active.id]
          ? {
              ...old,
              [active.id]: old[active.id].map((message) =>
                ids.has(message.id) ? { ...message, isRead: true } : message,
              ),
            }
          : old,
      );
      setFolders((old) =>
        old.map((item) =>
          item.id === folder
            ? {
                ...item,
                unreadItemCount: Math.max(
                  0,
                  item.unreadItemCount - unread.length,
                ),
              }
            : item,
        ),
      );
      Promise.all(
        unread.map((message) =>
          mailRequest("read", {}, { id: message.id, isRead: true }),
        ),
      )
        .then(() => loadFolders())
        .catch((error) => {
          setError((error as Error).message);
          refresh();
        });
    }, 650);
    return () => window.clearTimeout(timer);
  }, [active?.id, unreadSignature]);
  async function quickAction(type: "read" | "move" | "flag", destinationId?: string) {
    if (!active?.latest || busy) return;
    if (dirty.current) { setError('Save your reply before changing this message.'); return; }
    setBusy(true);
    setError("");
    try {
      const target = active.latest;
      if (type === 'read') {
        if (target.isRead) manualUnread.current.add(target.id);
        else manualUnread.current.delete(target.id);
      }
      await mailRequest(
        type,
        {},
        type === "read"
          ? { id: target.id, isRead: !target.isRead }
          : type === 'flag'
            ? { id: target.id, flagged: target.flag?.flagStatus !== 'flagged' }
            : { id: target.id, destinationId },
      );
      afterAction();
    } catch (e) {
      if (type === 'read' && active?.latest) manualUnread.current.delete(active.latest.id);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function openSelectedEditor(kind: 'reply' | 'replyAll' | 'forward' | 'edit') {
    if (!active?.latest || !canLeave()) return;
    dirty.current = false;
    const source = kind === 'edit' ? active.latest : [...active.messages].reverse().find(message => !message.isDraft && message.from?.emailAddress.address?.toLowerCase() !== mailbox.toLowerCase()) || active.latest;
    setEditorRequest({ id: source.id, kind, nonce: Date.now() });
  }
  async function expandFolder(f: MicrosoftFolder) {
    setError("");
    try {
      let page = await mailRequest<Page<MicrosoftFolder>>("folders", {
        parent: f.id,
      });
      const children = [...page.records];
      while (page.next) {
        page = await mailRequest("page", { cursor: page.next });
        children.push(...page.records);
      }
      setFolders((old) => {
        const copy = [...old];
        const index = copy.findIndex((x) => x.id === f.id);
        copy.splice(
          index + 1,
          0,
          ...children
            .filter((c) => !copy.some((x) => x.id === c.id))
            .map((c) => ({ ...c, depth: (f.depth || 0) + 1 })),
        );
        return copy;
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      {error && (
        <div className="notice amber" role="alert">
          {error} Existing messages may be out of date.
        </div>
      )}
      <div className="outlook-ribbon" ref={ribbonRef}>
        <button
          className="outlook-new"
          onClick={() => {
            if (canLeave()) {
              dirty.current = false;
              setCompose(true);
            }
          }}
        >
          <PenLine size={16} /> New mail <ChevronDown size={13} />
        </button>
        <span className="ribbon-separator" />
        <button disabled={!active || busy} onClick={() => quickAction("move")}>
          <Archive size={16} /> Archive
        </button>
        <button disabled={!active || busy} onClick={() => quickAction("move", "deleteditems")}>
          <Trash2 size={16} /> Delete
        </button>
        <label className="ribbon-move"><Folder size={16} /><select aria-label="Move selected message to folder" disabled={!active || busy} value="" onChange={event => { const destinationId = event.target.value; if (destinationId) void quickAction('move', destinationId); event.target.value = ''; }}><option value="">Move to</option>{folders.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}</select></label>
        <span className="ribbon-separator" />
        {active?.latest.isDraft ? <button disabled={busy} onClick={() => openSelectedEditor('edit')}><PenLine size={16}/> Edit draft</button> : <>
          <button disabled={!active || busy} onClick={() => openSelectedEditor('reply')}><Reply size={16}/> Reply</button>
          <button disabled={!active || busy} onClick={() => openSelectedEditor('replyAll')}><Reply size={16}/> Reply all</button>
          {provider === 'microsoft' && <button disabled={!active || busy} onClick={() => openSelectedEditor('forward')}><Forward size={16}/> Forward</button>}
        </>}
        <button
          disabled={!active || busy}
          onClick={() => quickAction("read")}
        >
          <MailOpen size={16} /> {active?.latest.isRead ? 'Mark unread' : 'Mark read'}
        </button>
        {provider === 'microsoft' && <button disabled={!active || busy} onClick={() => quickAction('flag')}><Flag size={16} fill={active?.latest.flag?.flagStatus === 'flagged' ? 'currentColor' : 'none'} /> {active?.latest.flag?.flagStatus === 'flagged' ? 'Unflag' : 'Flag'}</button>}
        <span className="ribbon-spacer" />
        <button
          disabled={busy}
          onClick={() => {
            if (dirty.current) {
              setError("Save your reply before refreshing.");
              return;
            }
            afterAction();
          }}
        >
          <RefreshCw size={15} /> Refresh
        </button>
      </div>
      <div className="live-mail-status">
        <span>
          {busy
            ? "Refreshing mailbox…"
            : updated
              ? `Last refreshed ${updated} · Updates every minute`
              : "Loading mailbox…"}
        </span>
      </div>
      <div className="outlook-shell">
        <aside className="mail-folders">
          <div className="mail-account">
            <strong>{mailbox}</strong>
            <ChevronDown size={14} />
          </div>
          <button
            className="primary full folder-compose"
            onClick={() => {
              if (canLeave()) {
                dirty.current = false;
                setCompose(true);
              }
            }}
          >
            <PenLine size={15} /> New message
          </button>
          <small>FOLDERS</small>
          {!folders.length && (
            <button
              className={folder === "inbox" ? "active" : ""}
              onClick={() => {
                if (canLeave()) {
                  dirty.current = false;
                  setFolder(inboxId);
                  setSelected("");
                  setEditorRequest(undefined);
                }
              }}
            >
              <Inbox size={16} /> Inbox
            </button>
          )}
          {folders.map((f) => (
            <div
              className="live-folder-row"
              key={f.id}
              style={{ paddingLeft: (f.depth || 0) * 10 }}
            >
              <button
                className={folder === f.id ? "active" : ""}
                onClick={() => {
                  if (canLeave()) {
                    dirty.current = false;
                    setFolder(f.id);
                    setSelected("");
                    setQuery("");
                    setEditorRequest(undefined);
                  }
                }}
              >
                <FolderIcon folder={f} />
                <span>{f.displayName}</span>
                {f.unreadItemCount > 0 && <b>{f.unreadItemCount}</b>}
              </button>
              {f.childFolderCount > 0 && (
                <button
                  aria-label={`Show folders in ${f.displayName}`}
                  onClick={() => expandFolder(f)}
                >
                  <ChevronDown size={14} />
                </button>
              )}
            </div>
          ))}
          <div className="mail-folder-foot">
            Live mailbox · AI and approval labels will appear here when
            automation is connected.
          </div>
        </aside>
        <section className="thread-list">
          <div className="thread-list-search">
            <Search size={15} />
            <input
              aria-label="Search loaded messages"
              placeholder="Search mail"
              value={query}
              onChange={(e) => {
                if (canLeave()) {
                  dirty.current = false;
                  setQuery(e.target.value);
                }
              }}
            />
          </div>
          <div className="list-caption">
            <strong>
              {folders.find((f) => f.id === folder)?.displayName || ({sentitems:'Sent Items',drafts:'Drafts',archive:'Archive',deleteditems:'Deleted Items'}[folder] || (sentOnly ? 'Sent' : 'Inbox'))}
            </strong>
            <span>{groups.length} conversations</span>
          </div>
          {groups.map((t) => {
            const isOpen = openThreads.includes(t.id);
            const hasThread = t.messages.length > 1;
            return (
              <div className="thread-group" key={t.id}>
                <button
                  className={`thread-item ${active?.id === t.id ? "active" : ""} ${t.messages.some((m) => !m.isRead) ? "unread" : ""}`}
                  aria-expanded={hasThread ? isOpen : undefined}
                  onClick={() => {
                    if (canLeave()) {
                      dirty.current = false;
                      if (selected !== t.id) manualUnread.current.clear();
                      setSelected(t.id);
                      if (selected !== t.id) setEditorRequest(undefined);
                      if (hasThread)
                        setOpenThreads((old) =>
                          old.includes(t.id)
                            ? old.filter((id) => id !== t.id)
                            : [...old, t.id],
                        );
                    }
                  }}
                >
                  <span
                    className={`thread-chevron ${hasThread ? "has-thread" : ""} ${isOpen ? "open" : ""}`}
                  >
                    {hasThread && <ChevronDown size={13} />}
                  </span>
                  <span className="thread-avatar">
                    {(t.latest.from?.emailAddress.name ||
                      t.latest.from?.emailAddress.address ||
                      mailbox)[0].toUpperCase()}
                  </span>
                  <span className="thread-copy">
                    <span className="thread-sender">
                      <strong>
                        {t.latest.from?.emailAddress.name ||
                          t.latest.from?.emailAddress.address ||
                          mailbox}
                      </strong>
                      <time>{formatMailListDate(t.latest)}</time>
                    </span>
                    <h3>{t.latest.subject || "(No subject)"}</h3>
                    <p
                      className={
                        t.latest.bodyPreview ===
                        "Open this message to read its contents."
                          ? "preview-loading"
                          : ""
                      }
                    >
                      {t.latest.bodyPreview}
                    </p>
                    <footer>
                      <span>
                        {t.messages.length} message
                        {t.messages.length === 1 ? "" : "s"}
                      </span>
                      {t.latest.isDraft && (
                        <span className="pill amber">Draft</span>
                      )}
                      {t.latest.importance === "high" && (
                        <span className="pill red">High</span>
                      )}
                      {t.latest.flag?.flagStatus === 'flagged' && <Flag size={13} fill="currentColor" aria-label="Flagged" />}
                      {t.latest.hasAttachments && <Paperclip size={13} />}
                    </footer>
                  </span>
                </button>
                {provider === 'microsoft' && folder !== 'deleteditems' && <button className="thread-delete" type="button" aria-label={`Delete ${t.latest.subject || 'message'}`} title="Move to Deleted Items" disabled={busy} onClick={async () => {
                  if (!canLeave()) return;
                  setError('');
                  try { await mailRequest('move', {}, { id: t.latest.id, destinationId: 'deleteditems' }); afterAction(); }
                  catch (cause) { setError((cause as Error).message); }
                }}><Trash2 size={16}/></button>}
                {isOpen && hasThread && (
                  <div
                    className="thread-children"
                    aria-label="Conversation messages"
                  >
                    {t.messages.map((message) => (
                      <div className="thread-child" key={message.id}>
                        <span className="thread-child-avatar">
                          {(message.from?.emailAddress.name ||
                            mailbox)[0].toUpperCase()}
                        </span>
                        <span className="thread-child-copy">
                          <strong>
                            {message.from?.emailAddress.name ||
                              message.from?.emailAddress.address ||
                              mailbox}
                          </strong>
                          <span>{message.subject || "(No subject)"}</span>
                          <small>{message.bodyPreview}</small>
                        </span>
                        <time>{formatMailListDate(message)}</time>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {!groups.length && (
            <div className="empty-state">
              {busy ? "Loading…" : "No matching messages."}
            </div>
          )}
          {next && (
            <button
              className="secondary load-more"
              disabled={busy}
              onClick={() => refresh(next)}
            >
              Load older messages
            </button>
          )}
        </section>
        {active ? (
          <LiveConversation
            key={active.id}
            id={active.id}
            revision={revision}
            customers={customers}
            onQuote={onQuote}
            onChanged={afterAction}
            onLoaded={rememberThread}
            onDirty={(v) => {
              dirty.current = v;
            }}
            provider={provider}
            mailbox={mailbox}
            folders={folders}
            editorRequest={editorRequest}
            onMarkedUnread={id => manualUnread.current.add(id)}
          />
        ) : (
          <section className="reading-pane empty-state">
            Select a conversation.
          </section>
        )}
      </div>
      {compose && (
        <div className="modal-backdrop">
          <section
            className="detail-modal"
            role="dialog"
            aria-modal="true"
            aria-label="New email"
          >
            <div className="panel-heading">
              <h2>New message</h2>
              <button
                className="icon-button"
                aria-label="Close composer"
                onClick={() => {
                  if (canLeave()) {
                    dirty.current = false;
                    setCompose(false);
                  }
                }}
              >
                <X size={18} />
              </button>
            </div>
            <DraftEditor
              onDirty={(v) => {
                dirty.current = v;
              }}
              onChanged={afterAction}
              onSent={() => { dirty.current = false; setCompose(false); }}
              provider={provider}
              mailbox={mailbox}
              onDiscard={() => { dirty.current = false; setCompose(false); }}
              customers={customers}
            />
          </section>
        </div>
      )}
    </>
  );
}
function LiveConversation({
  id,
  revision,
  customers,
  onQuote,
  onChanged,
  onLoaded,
  onDirty,
  provider,
  mailbox,
  folders,
  editorRequest,
  onMarkedUnread,
}: {
  id: string;
  revision: number;
  customers: Client[];
  onQuote: (id: string) => void;
  onChanged: () => void;
  onLoaded: (id: string, messages: MicrosoftMessage[]) => void;
  onDirty: (v: boolean) => void;
  provider: MailProviderName;
  mailbox: string;
  folders: MicrosoftFolder[];
  editorRequest?: { id: string; kind: 'reply' | 'replyAll' | 'forward' | 'edit'; nonce: number };
  onMarkedUnread: (id: string) => void;
}) {
  const [messages, setMessages] = useState<MicrosoftMessage[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [editor, setEditor] = useState<{
    replyTo?: string;
    replyAll?: boolean;
    forwardOf?: string;
    existing?: MicrosoftMessage;
    initialContent?: string;
    nonce?: number;
  }>();
  const [actionBusy, setActionBusy] = useState(false);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiResult, setAiResult] = useState<{
    analysis: { summary: string; customer_request: string; next_steps: string[]; reply_needed: boolean; draft_reply: string; uncertainties: string[] };
    attachments: { name: string; status: string }[];
    truncated: boolean;
    message_count: number;
    knowledge_sources: { id: string }[];
    reply_to_message_id: string | null;
  }>();
  const editorDirty = useRef(false);
  const editorNode = useRef<HTMLDivElement>(null);
  const handledEditor = useRef<number>();
  useEffect(() => { setAiResult(undefined); setAiError(''); }, [id, revision]);
  useEffect(() => {
    if (!editorRequest || handledEditor.current === editorRequest.nonce) return;
    if (editorRequest.kind === 'edit') {
      const draft = messages.find(message => message.id === editorRequest.id);
      if (!draft) return;
      edit({ existing: draft });
    } else {
      edit(editorRequest.kind === 'forward' ? { forwardOf: editorRequest.id } : { replyTo: editorRequest.id, replyAll: editorRequest.kind === 'replyAll' });
    }
    handledEditor.current = editorRequest.nonce;
  }, [editorRequest?.nonce, messages.length]);
  useEffect(() => { if (editor) editorNode.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [editor]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    (async () => {
      let page = await mailRequest<Page<MicrosoftMessage>>(
        "thread",
        { conversation: id },
        undefined,
        controller.signal,
      );
      const all = [...page.records];
      while (page.next) {
        page = await mailRequest(
          "page",
          { cursor: page.next },
          undefined,
          controller.signal,
        );
        all.push(...page.records);
      }
      const ordered = groupMicrosoftMessages(all).flatMap((t) => t.messages);
      if (!controller.signal.aborted) {
        setMessages(ordered);
        onLoaded(id, ordered);
        setExpanded((old) =>
          old.length
            ? old
            : ordered.length
              ? [ordered[ordered.length - 1].id]
              : [],
        );
      }
    })()
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [id, revision, onLoaded]);
  const latest = messages[messages.length - 1];
  const senderEmails = messages
    .filter((m) => !m.isDraft)
    .map((m) => m.from?.emailAddress.address?.toLowerCase());
  const matches = customers.filter(
    (c) => c.email && senderEmails.includes(c.email.toLowerCase()),
  );
  async function analyzeConversation() {
    setAiBusy(true);
    setAiError('');
    try {
      const response = await fetch('/api/conversation-ai', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ conversationId: id }) });
      const raw = await response.text();
      let result: NonNullable<typeof aiResult> & { error?: string };
      try { result = JSON.parse(raw); }
      catch { throw new Error(`Conversation AI server returned an invalid response (${response.status}). Restart the app server and try again.`); }
      if (!response.ok) throw new Error(result.error || `Could not analyze this conversation (${response.status}).`);
      if (!result.analysis) throw new Error('Conversation AI returned no analysis. Try again.');
      setAiResult(result);
    } catch (cause) { setAiError((cause as Error).message); }
    finally { setAiBusy(false); }
  }
  async function action(
    m: MicrosoftMessage,
    type: "read" | "move" | "flag",
    restore = false,
    destinationId?: string,
  ) {
    if (type !== "read" && editorDirty.current) {
      setError("Save your reply before changing this message.");
      return;
    }
    setActionBusy(true);
    setError("");
    try {
      await mailRequest(
        type,
        {},
        type === "read"
          ? { id: m.id, isRead: !m.isRead }
          : type === 'flag'
            ? { id: m.id, flagged: m.flag?.flagStatus !== 'flagged' }
          : { id: m.id, restore, destinationId },
      );
      if (type === 'read' && m.isRead) onMarkedUnread(m.id);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setActionBusy(false);
    }
  }
  function edit(value: typeof editor) {
    if (
      !editorDirty.current ||
      window.confirm("Discard unsaved reply changes?")
    ) {
      editorDirty.current = false;
      onDirty(false);
      setEditor(value);
    }
  }
  return (
    <section className="reading-pane">
      <header className="reading-heading">
        <span className="pill neutral">
          {provider === "hostinger" ? "Hostinger" : "Microsoft"} conversation
        </span>
        <h2>{latest?.subject || "Conversation"}</h2>
        <p className="field-help">
          History includes matching messages from your mailbox folders.
        </p>
      </header>
      <div className="conversation-content">
        {error && (
          <p className="notice amber" role="alert">
            {error}
          </p>
        )}
        {loading && <p role="status">Refreshing conversation…</p>}
        <section className="mail-intelligence">
          <div className="mail-ai-heading"><strong><Sparkles size={16} /> Conversation AI</strong><button type="button" onClick={() => void analyzeConversation()} disabled={loading || aiBusy || provider !== 'microsoft'}>{aiBusy ? 'Analyzing…' : aiResult ? 'Refresh analysis' : 'Analyze conversation'}</button></div>
          {!aiResult && !aiBusy && <p>Review this email chain and its supported attachments, then prepare a reply.</p>}
          {aiError && <p className="notice amber" role="alert">{aiError}</p>}
          {aiResult && <div className="mail-ai-result">
            <h3>At a glance</h3><p>{aiResult.analysis.summary}</p>
            {!!aiResult.analysis.next_steps.length && <p className="mail-ai-action"><strong>Next:</strong> {aiResult.analysis.next_steps.slice(0, 2).join(' · ')}</p>}
            {aiResult.analysis.reply_needed && aiResult.analysis.draft_reply && aiResult.reply_to_message_id && !editor?.initialContent ? <div className="mail-ai-draft">
              <h3>Suggested reply</h3>
              <p>{aiResult.analysis.draft_reply}</p>
              <button type="button" className="primary" onClick={() => edit({ replyTo: aiResult.reply_to_message_id!, initialContent: aiResult.analysis.draft_reply, nonce: Date.now() })}><PenLine size={15} /> Use suggestion in reply editor</button>
              <small>One editable reply opens below the conversation. Check its recipients before sending.</small>
            </div> : <p className="mail-ai-no-reply">No reply suggested for this conversation.</p>}
            {!!aiResult.analysis.uncertainties.length && <p className="mail-ai-caution"><strong>Check before replying:</strong> {aiResult.analysis.uncertainties.slice(0, 2).join(' · ')}</p>}
            {!!aiResult.attachments.length && <details className="mail-ai-files"><summary>{aiResult.attachments.filter(file => file.status === 'read').length} of {aiResult.attachments.length} attached files included in analysis</summary><ul>{aiResult.attachments.map((file, index) => <li key={index}>{file.name}: {file.status === 'read' ? 'included' : file.status === 'unsupported' ? 'unsupported file type' : file.status === 'unreadable' ? 'could not be read' : 'size or file limit reached'}</li>)}</ul></details>}
            {aiResult.truncated && <p className="mail-ai-caution">Only the latest {aiResult.message_count} messages were analyzed.</p>}
          </div>}
          {matches.length === 1 && (
            <div className="conversation-next">
              <strong>{matches[0].name}</strong>
              <button
                className="text-button"
                onClick={() => onQuote(matches[0].id)}
              >
                <FileText size={14} /> Create quotation
              </button>
            </div>
          )}
          {matches.length > 1 && <p>Multiple customer records match this conversation.</p>}
        </section>
        <div className="conversation-label">
          <span>ORIGINAL CONVERSATION</span>
          <button
            className="text-button"
            onClick={() =>
              setExpanded(
                expanded.length === messages.length
                  ? []
                  : messages.map((m) => m.id),
              )
            }
          >
            {expanded.length === messages.length
              ? "Collapse all"
              : "Expand all"}
          </button>
        </div>
        {messages.map((m) => (
          <article className="conversation-message" key={m.id}>
            <button
              className="conversation-message-header"
              aria-expanded={expanded.includes(m.id)}
              onClick={() =>
                setExpanded((old) =>
                  old.includes(m.id)
                    ? old.filter((x) => x !== m.id)
                    : [...old, m.id],
                )
              }
            >
              <span className="avatar">
                {(m.from?.emailAddress.name || "M")[0]}
              </span>
              <span>
                <strong>
                  {m.from?.emailAddress.name ||
                    m.from?.emailAddress.address ||
                    "Draft"}
                </strong>
                <small>To: {addressList(m.toRecipients)}</small>
              </span>
              <span>
                <time>
                  {new Date(
                    m.receivedDateTime || m.sentDateTime || "",
                  ).toLocaleString()}
                </time>
                <small>
                  {m.isDraft ? "Saved draft" : m.isRead ? "Read" : "Unread"}
                </small>
              </span>
            </button>
            {expanded.includes(m.id) ? (
              <div className="conversation-message-body">
                {m.isDraft && editor ? <p className="field-help">{editor.existing?.id === m.id ? 'This draft is open in the reply editor below.' : 'Saved draft preview hidden while a reply editor is open. Select Edit draft to work on this draft instead.'}</p> : <MessageContent message={m} revision={revision} />}
                <div className="mail-command-bar">
                  {m.isDraft ? (
                    provider === "hostinger" ? (
                      <span className="field-help">
                        Edit provider drafts in Hostinger webmail.
                      </span>
                    ) : (
                      <button
                        className="text-button"
                        onClick={() => edit({ existing: m })}
                      >
                        <PenLine size={14} /> Edit draft
                      </button>
                    )
                  ) : (
                    <>
                      <button
                        className="text-button"
                        onClick={() => edit({ replyTo: m.id })}
                      >
                        <Reply size={14} /> Reply
                      </button>
                      <button
                        className="text-button"
                        onClick={() => edit({ replyTo: m.id, replyAll: true })}
                      >
                        Reply all
                      </button>
                      {provider === 'microsoft' && <button className="text-button" onClick={() => edit({ forwardOf: m.id })}><Forward size={14}/> Forward</button>}
                    </>
                  )}
                  <button
                    className="text-button"
                    disabled={actionBusy}
                    onClick={() => action(m, "read")}
                  >
                    {m.isRead ? "Mark unread" : "Mark read"}
                  </button>
                  {provider === 'microsoft' && <button className="text-button" disabled={actionBusy} onClick={() => action(m, 'flag')}><Flag size={14}/>{m.flag?.flagStatus === 'flagged' ? 'Unflag' : 'Flag'}</button>}
                  {!m.isDraft && (
                    <>
                      <button
                        className="text-button"
                        disabled={actionBusy}
                        onClick={() => action(m, "move")}
                      >
                        <Archive size={14} /> Archive message
                      </button>
                      <button
                        className="text-button"
                        disabled={actionBusy}
                        onClick={() => action(m, "move", true)}
                      >
                        Move to Inbox
                      </button>
                      {provider === 'microsoft' && <label className="mail-move-picker">Move to
                        <select aria-label={`Move ${m.subject || 'message'} to folder`} disabled={actionBusy} value="" onChange={event => { const destinationId = event.target.value; if (destinationId) void action(m, 'move', false, destinationId); event.target.value = ''; }}>
                          <option value="">Choose folder</option>
                          {folders.map(item => <option key={item.id} value={item.id}>{item.displayName}</option>)}
                        </select>
                      </label>}
                      <button className="text-button" disabled={actionBusy} onClick={() => action(m, "move", false, "deleteditems")}><Trash2 size={14}/> Delete</button>
                    </>
                  )}
                </div>
              </div>
            ) : (
              <p className="collapsed-message">{m.bodyPreview}</p>
            )}
          </article>
        ))}
        {editor && (
          <div ref={editorNode} className="inline-mail-composer"><DraftEditor
            key={`${editor.replyTo}-${editor.replyAll}-${editor.forwardOf}-${editor.existing?.id}-${editor.nonce || ''}`}
            {...editor}
            onDirty={(v) => {
              editorDirty.current = v;
              onDirty(v);
            }}
            onChanged={onChanged}
            onSent={() => edit(undefined)}
            provider={provider}
            mailbox={mailbox}
            source={messages.find(message => message.id === (editor.replyTo || editor.forwardOf))}
            onDiscard={() => { editorDirty.current = false; onDirty(false); setEditor(undefined); }}
            customers={customers}
            customerId={matches.length === 1 ? matches[0].id : undefined}
          /></div>
        )}
      </div>
    </section>
  );
}
function MessageContent({
  message,
  revision,
}: {
  message: MicrosoftMessage;
  revision: number;
}) {
  const [record, setRecord] = useState<MicrosoftMessage>();
  const [attachments, setAttachments] = useState<MailAttachment[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setError("");
    (async () => {
      const detail = await mailRequest(
        "message",
        { id: message.id },
        undefined,
        controller.signal,
      );
      if (!controller.signal.aborted) setRecord(detail.record);
      let page = await mailRequest<Page<MailAttachment>>(
        "attachments",
        { id: message.id },
        undefined,
        controller.signal,
      );
      const all = [...page.records];
      while (page.next) {
        page = await mailRequest(
          "page",
          { cursor: page.next },
          undefined,
          controller.signal,
        );
        all.push(...page.records);
      }
      if (!controller.signal.aborted) setAttachments(all);
    })().catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [message.id, revision]);
  async function download(a: MailAttachment) {
    setError("");
    try {
      const response = await fetch(
        `/api/mail?${new URLSearchParams({ action: "download", id: message.id, attachment: a.id })}`,
      );
      if (!response.ok) throw new Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = a.name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      {record?.ccRecipients?.length ? (
        <p className="field-help">Cc: {addressList(record.ccRecipients)}</p>
      ) : null}
      {record?.bccRecipients?.length ? (
        <p className="field-help">Bcc: {addressList(record.bccRecipients)}</p>
      ) : null}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {record?.body ? (
        <SafeMailBody body={record.body} />
      ) : (
        <p>{message.bodyPreview}</p>
      )}
      {attachments.length > 0 && (
        <div className="attachment-list">
          {attachments.map((a) => (
            <button
              className="secondary"
              key={a.id}
              onClick={() => download(a)}
            >
              <Paperclip size={14} />
              {a.name}
              <small>
                {Math.ceil(a.size / 1024)} KB
                {a.isInline ? " · embedded image" : ""}
              </small>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
export function SafeMailBody({
  body,
}: {
  body: { contentType: string; content: string };
}) {
  if (body.contentType.toLowerCase() !== "html")
    return <p className="pre-line">{body.content}</p>;
  const clean = DOMPurify.sanitize(body.content, {
    WHOLE_DOCUMENT: false,
    FORBID_TAGS: [
      "script",
      "form",
      "input",
      "button",
      "iframe",
      "object",
      "embed",
      "base",
      "link",
      "meta",
      "svg",
      "math",
      "video",
      "audio",
    ],
    FORBID_ATTR: [
      "href",
      "target",
      "srcset",
      "action",
      "formaction",
      "background",
    ],
  });
  const doc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; form-action 'none'; base-uri 'none'"><style>body{font:14px/1.6 Arial,sans-serif;color:#243649;overflow-wrap:anywhere;margin:12px}::selection{background:#0f6cbd;color:#fff;text-shadow:none}::-moz-selection{background:#0f6cbd;color:#fff;text-shadow:none}table{max-width:100%}img{max-width:100%}a{pointer-events:none}</style></head><body>${clean}</body></html>`;
  return (
    <>
      <iframe
        className="original-email-frame"
        title="Original email content"
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={doc}
      />
      <p className="field-help">External images and links are blocked here. Attachments can be downloaded below.</p>
    </>
  );
}
function DraftEditor({
  replyTo,
  replyAll,
  forwardOf,
  existing,
  source,
  initialContent,
  onDirty,
  onChanged,
  onSent,
  onDiscard,
  provider,
  mailbox,
  customers,
  customerId,
}: {
  replyTo?: string;
  replyAll?: boolean;
  forwardOf?: string;
  existing?: MicrosoftMessage;
  source?: MicrosoftMessage;
  initialContent?: string;
  onDirty: (v: boolean) => void;
  onChanged: () => void;
  onSent?: () => void;
  onDiscard?: () => void;
  provider: MailProviderName;
  mailbox: string;
  customers: Client[];
  customerId?: string;
}) {
  const [to, setTo] = useState(() => {
    if (!source || !replyTo) return '';
    const addresses = [source.from?.emailAddress.address, ...(replyAll ? (source.toRecipients || []).map(item => item.emailAddress.address) : [])].filter((item): item is string => !!item && item.toLowerCase() !== mailbox.toLowerCase()).filter((item, index, all) => all.findIndex(other => other.toLowerCase() === item.toLowerCase()) === index);
    return addresses.length ? `${addresses.join(', ')}, ` : '';
  });
  const [cc, setCc] = useState(() => {
    const addresses = source && replyAll ? (source.ccRecipients || []).map(item => item.emailAddress.address).filter(item => item.toLowerCase() !== mailbox.toLowerCase()) : [];
    return addresses.length ? `${addresses.join(', ')}, ` : '';
  });
  const [bcc, setBcc] = useState("");
  const [subject, setSubject] = useState(source ? `${forwardOf ? 'Fwd' : 'Re'}: ${source.subject.replace(/^(?:Re|Fwd):\s*/i, '')}` : '');
  const [content, setContent] = useState(initialContent ? textHtml(initialContent) : "");
  const editorRef = useRef<HTMLDivElement>(null);
  const [saved, setSaved] = useState<{
    record: MicrosoftMessage;
    version: string;
  }>();
  const [dirty, setDirty] = useState(!!initialContent);
  const [busy, setBusy] = useState(!!existing);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [showCc, setShowCc] = useState(!!(source && replyAll && source.ccRecipients?.length));
  const [showBcc, setShowBcc] = useState(false);
  const [suggestions, setSuggestions] = useState<RecipientSuggestion[]>(() => customers.filter(customer => customer.email).map(customer => ({ name: customer.contact || customer.name, email: customer.email, company: customer.name, source: 'CRM customer' })));
  const [sent, setSent] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [quotationOptions, setQuotationOptions] = useState<CustomerQuotation[] | null>(null);
  const [quotationBusy, setQuotationBusy] = useState(false);
  const [quotationCustomerId, setQuotationCustomerId] = useState(customerId || '');
  const [ready, setReady] = useState(!existing);
  useEffect(() => { if (initialContent) onDirty(true); }, []);
  useEffect(() => { if (editorRef.current && initialContent) editorRef.current.innerText = initialContent; }, []);
  useEffect(() => {
    let active = true;
    Promise.allSettled([crmRequest('action=recipient-suggestions'), mailRequest('recipient-suggestions')]).then(results => {
      if (!active) return;
      const all = [...suggestions, ...results.flatMap(result => result.status === 'fulfilled' ? result.value.records || [] : [])] as RecipientSuggestion[];
      const unique = new Map<string, RecipientSuggestion>();
      for (const item of all) if (item.email && !unique.has(item.email.toLowerCase())) unique.set(item.email.toLowerCase(), item);
      setSuggestions([...unique.values()]);
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!existing) return;
    const controller = new AbortController();
    mailRequest(
      "message",
      { id: existing.id, text: "true" },
      undefined,
      controller.signal,
    )
      .then((data) => {
        setSaved(data);
        const html = DOMPurify.sanitize(data.record.body.contentType?.toLowerCase() === 'html' ? data.record.body.content : textHtml(data.record.body.content));
        setContent(html);
        if (editorRef.current) editorRef.current.innerHTML = html;
        setTo(recipientValue(data.record.toRecipients));
        setCc(recipientValue(data.record.ccRecipients));
        setBcc(recipientValue(data.record.bccRecipients));
        setSubject(data.record.subject);
        setShowCc(!!data.record.ccRecipients?.length);
        setShowBcc(!!data.record.bccRecipients?.length);
        setReady(true);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [existing?.id]);
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    const navigate = (event: Event) => {
      if (
        dirty &&
        !window.confirm(
          "Discard your unsaved reply changes? Save the draft first to keep them.",
        )
      )
        event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    window.addEventListener("dcx-before-navigate", navigate);
    return () => {
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("dcx-before-navigate", navigate);
    };
  }, [dirty]);
  const change = () => {
    setDirty(true);
    onDirty(true);
    setNotice("");
  };
  async function loadQuotations() {
    if (!quotationCustomerId) return;
    setQuotationBusy(true); setError('');
    try { const result = await crmRequest(`action=quotations&customer_id=${encodeURIComponent(quotationCustomerId)}`); setQuotationOptions(result.records || []); }
    catch (cause) { setError((cause as Error).message); }
    finally { setQuotationBusy(false); }
  }
  async function attachQuotation(quote: CustomerQuotation) {
    setQuotationBusy(true); setError('');
    try {
      const pdf = await buildCustomerQuotationPdf(quote, await quotationLogo());
      const file = new File([pdf.output('blob')], `DCX-Estimate-${quote.estimate_number}.pdf`, { type: 'application/pdf' });
      if (files.length >= 5 || files.reduce((size, item) => size + item.size, file.size) > 3 * 1024 * 1024) throw new Error('Attach up to five files, with a combined size under 3 MB.');
      setFiles(current => [...current, file]); setQuotationOptions(null); change();
    } catch (cause) { setError((cause as Error).message); }
    finally { setQuotationBusy(false); }
  }
  async function persistDraft() {
    const outgoingContent = provider === 'microsoft' ? DOMPurify.sanitize(content) : editorRef.current?.innerText || '';
    const data = await mailRequest(
      "draft",
      {},
      saved
        ? { draftId: saved.record.id, version: saved.version, to, cc, bcc, content: outgoingContent, ...(provider === 'microsoft' ? { format: 'html' } : {}) }
        : { replyTo, replyAll, forwardOf, to, cc, bcc, subject, content: outgoingContent, overrideRecipients: true, ...(provider === 'microsoft' ? { format: 'html' } : {}) },
    );
    setSaved(data);
    if (!saved) {
      setTo(recipientValue(data.record.toRecipients));
      setCc(recipientValue(data.record.ccRecipients));
      setBcc(recipientValue(data.record.bccRecipients));
      if (data.record.ccRecipients?.length) setShowCc(true);
      if (data.record.bccRecipients?.length) setShowBcc(true);
    }
    let current = data as { record: MicrosoftMessage; version: string };
    for (const file of files) {
      const attached = await mailRequest<{ version: string; hasAttachments: boolean }>('attach', {}, { id: current.record.id, name: file.name, contentType: file.type || 'application/octet-stream', contentBytes: await attachmentBase64(file) });
      current = { record: { ...current.record, hasAttachments: attached.hasAttachments }, version: attached.version };
      setSaved(current);
      setFiles(remaining => remaining.filter(item => item !== file));
    }
    setDirty(false);
    onDirty(false);
    onChanged();
    return current;
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      await persistDraft();
      setNotice(
        provider === "hostinger"
          ? "Draft saved. It has not been sent."
          : "Draft saved in Microsoft Outlook. It has not been sent.",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function sendNow() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const current = !saved || dirty || files.length ? await persistDraft() : saved;
      const prepared = await mailRequest<{ record: MicrosoftMessage; approval: string }>("review", {}, { id: current.record.id });
      const result = await mailRequest("send", {}, { approval: prepared.approval });
      setSent(true);
      setNotice(result.message);
      onChanged();
      onSent?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function discard() {
    setBusy(true);
    setError('');
    try {
      const draftId = saved?.record.id || existing?.id;
      if (draftId) await mailRequest('move', {}, { id: draftId, destinationId: 'deleteditems' });
      onDirty(false);
      if (draftId) onChanged();
      onDiscard?.();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  function formatMessage(command: string, value?: string) {
    editorRef.current?.focus();
    document.execCommand(command, false, value);
    setContent(editorRef.current?.innerHTML || '');
    change();
  }
  const hasMessage = !!(editorRef.current?.textContent?.trim() || content.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim());
  const replyMode = existing ? 'Editing saved draft' : forwardOf ? 'Forwarding message' : replyAll ? 'Reply all' : replyTo ? 'Reply' : 'New message';
  return (
    <section className="conversation-reply">
      <div className="mail-reply-context"><strong>{replyMode}</strong><span>{replyTo ? `In this conversation, replying to ${source?.from?.emailAddress.address || 'the selected message'}.` : existing ? 'Check the recipients below before sending this saved draft.' : forwardOf ? 'Forwarding the selected message.' : 'Enter recipients below.'} {replyTo && (replyAll ? 'Reply all includes other recipients of the selected message.' : 'Reply sends only to the selected message’s sender.')} This sends one email in the conversation, not a separate reply to every message.</span></div>
      <div className="mail-compose-top">
        <button className="mail-compose-send" type="button" disabled={busy || !ready || !hasMessage || sent} onClick={() => void sendNow()}><Send size={15} /> Send</button>
        <span className="mail-compose-from">From: <strong>{mailbox}</strong></span>
        <span className="mail-compose-spacer" />
        <button className="mail-compose-discard" type="button" aria-label="Discard draft" title="Discard draft" disabled={busy} onClick={() => void discard()}><Trash2 size={18} /></button>
      </div>
      {error && (
        <p className="notice amber" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      <div className="mail-addresses">
        <RecipientField label="To" value={to} disabled={busy || !ready} suggestions={suggestions} onChange={value => { setTo(value); change(); }} placeholder="Type a name or email" actions={<span className="mail-recipient-actions">{!showCc && <button type="button" onClick={() => setShowCc(true)}>Cc</button>}{!showBcc && <button type="button" onClick={() => setShowBcc(true)}>Bcc</button>}</span>} />
        {showCc && <RecipientField label="Cc" value={cc} disabled={busy || !ready} suggestions={suggestions} onChange={value => { setCc(value); change(); }} actions={<button type="button" className="mail-recipient-remove" aria-label="Remove Cc field and recipients" onClick={() => { setCc(''); setShowCc(false); change(); }}><X size={14}/> Remove</button>} />}
        {showBcc && <RecipientField label="Bcc" value={bcc} disabled={busy || !ready} suggestions={suggestions} onChange={value => { setBcc(value); change(); }} actions={<button type="button" className="mail-recipient-remove" aria-label="Remove Bcc field and recipients" onClick={() => { setBcc(''); setShowBcc(false); change(); }}><X size={14}/> Remove</button>} />}
      </div>
      {!replyTo && !forwardOf && !existing && !saved && <label>
        Subject<input aria-label="Email subject" value={subject} disabled={busy} onChange={e => { setSubject(e.target.value); change(); }} />
      </label>}
      {(replyTo || forwardOf || existing || saved) && <div className="mail-compose-subject">{saved?.record.subject || subject}</div>}
      {!sent && (
        <>
          {provider === 'microsoft' && <div className="mail-format-toolbar" role="toolbar" aria-label="Format email">
            <select aria-label="Font" defaultValue="Arial" disabled={busy} onChange={event => formatMessage('fontName', event.target.value)}><option>Arial</option><option>Calibri</option><option>Georgia</option><option>Times New Roman</option></select>
            <select aria-label="Font size" defaultValue="3" disabled={busy} onChange={event => formatMessage('fontSize', event.target.value)}><option value="2">10</option><option value="3">12</option><option value="4">14</option><option value="5">18</option></select>
            <button type="button" aria-label="Bold" title="Bold" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => formatMessage('bold')}><strong>B</strong></button>
            <button type="button" aria-label="Italic" title="Italic" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => formatMessage('italic')}><em>I</em></button>
            <button type="button" aria-label="Underline" title="Underline" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => formatMessage('underline')}><u>U</u></button>
            <button type="button" aria-label="Bulleted list" title="Bulleted list" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => formatMessage('insertUnorderedList')}>• List</button>
            <button type="button" aria-label="Numbered list" title="Numbered list" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => formatMessage('insertOrderedList')}>1. List</button>
            <button type="button" aria-label="Add link" title="Add link" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => { const url = window.prompt('Link URL'); if (url && /^https?:\/\//i.test(url)) formatMessage('createLink', url); }}>Link</button>
            <button type="button" aria-label="Undo" title="Undo" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => formatMessage('undo')}>↶</button>
            <button type="button" aria-label="Redo" title="Redo" disabled={busy} onMouseDown={event => event.preventDefault()} onClick={() => formatMessage('redo')}>↷</button>
          </div>}
          <div ref={editorRef} className="mail-rich-editor" role="textbox" aria-label="Email reply content" aria-multiline="true" contentEditable={!busy && ready} suppressContentEditableWarning data-placeholder="Write your message…" onInput={event => { setContent(event.currentTarget.innerHTML); change(); }} />
          {provider === 'microsoft' && <div className="mail-file-picker"><label><Paperclip size={15}/> Attach files<input type="file" multiple disabled={busy} onChange={event=>{const incoming=Array.from(event.target.files||[]);event.target.value='';if(files.length+incoming.length>5||[...files,...incoming].reduce((size,file)=>size+file.size,0)>3*1024*1024){setError('Attach up to five files, with a combined size under 3 MB.');return;}setFiles(current=>[...current,...incoming]);if(incoming.length)change();}}/></label><select aria-label="Customer for saved quotation" value={quotationCustomerId} onChange={event=>{setQuotationCustomerId(event.target.value);setQuotationOptions(null);}}><option value="">Choose customer for quotation</option>{customers.map(customer=><option key={customer.id} value={customer.id}>{customer.name}</option>)}</select><button className="secondary compact" type="button" disabled={busy||quotationBusy||!quotationCustomerId} onClick={()=>void loadQuotations()}>{quotationBusy?'Loading…':'Attach saved quotation'}</button>{quotationOptions&&<select aria-label="Choose saved quotation to attach" value="" onChange={event=>{const quote=quotationOptions.find(item=>item.id===event.target.value);if(quote)void attachQuotation(quote);}}><option value="">{quotationOptions.length?'Choose a quotation PDF':'No saved quotations for this customer'}</option>{quotationOptions.map(quote=><option key={quote.id} value={quote.id}>Estimate #{quote.estimate_number} · {quote.status} · created {new Date(quote.created_at).toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' })}</option>)}</select>}{files.map((file,index)=><span key={`${file.name}-${index}`}>{file.name} ({Math.ceil(file.size/1024)} KB)<button type="button" aria-label={`Remove ${file.name}`} onClick={()=>{setFiles(current=>current.filter((_,i)=>i!==index));change();}}><X size={13}/></button></span>)}</div>}
          <div className="button-row">
            <button
              className="secondary"
              disabled={
                busy || !ready || !hasMessage || (!!saved && !dirty && !files.length)
              }
              onClick={save}
            >
              {provider === "hostinger"
                ? "Save draft"
                : "Save to Outlook drafts"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
