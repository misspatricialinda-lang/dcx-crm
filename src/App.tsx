import { useEffect, useRef, useState } from "react";
import {
  Bell,
  Calculator,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Menu,
  ShieldCheck,
  Users,
  Wallet,
  X,
  Zap,
  Inbox,
  CalendarDays,
  FileText,
  Lightbulb,
} from "lucide-react";
import { CustomerHub } from "./components/operations/CustomerHub";
import { QuotationLanding } from "./components/operations/QuotationLanding";
import { NotificationsPage } from "./components/operations/NotificationsPage";
import { FeatureRequestsPage } from "./components/operations/FeatureRequestsPage";
import { toClient, crmRequest } from "./lib/crm-client";
import { withPreviewExample } from "./lib/preview-example";
import { LoginGate } from "./components/Login";
import {
  Overview,
} from "./components/operations/WorkspacePages";
import { InboxPage } from "./components/operations/Inbox";
import { ConnectedInbox } from "./components/operations/MicrosoftInbox";
import { CalendarAgent } from "./components/operations/CalendarAgent";
import {
  MailProvider,
  useMailConnection,
} from "./components/operations/MailConnection";
import {
  CostWorkspace,
  QuotesPage,
} from "./components/operations/CostWorkspace";
import { PriceBooks } from "./components/operations/PriceBooks";
import { SHOW_RATES } from './lib/features';
import { loadWorkspace, STORAGE_KEY } from "./lib/workspace";
import {
  bookUsable,
  calculateCost,
  FORMULA_VERSION,
  newDraft,
} from "./lib/costing";
import type { Workspace, SavedQuote, Client, PriceBook, QuoteDraft } from "./types/operations";

const nav = [
  { id: "dashboard", label: "Overview", icon: LayoutDashboard },
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "customers", label: "Customers", icon: Users },
  { id: "quotations", label: "Quotations", icon: FileText },
  { id: "calculator", label: "Cost calculator", icon: Calculator },
  { id: "calendar-agent", label: "Calendar Agent", icon: CalendarDays },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "feature-requests", label: "Feature requests", icon: Lightbulb },
  ...(SHOW_RATES ? [{ id: "pricing", label: "Rates", icon: Wallet }] : []),
];
export function App() {
  return (
    <LoginGate>
      {(email, logout, preview) => (
        <MailProvider preview={preview}>
          <Dashboard email={email} logout={logout} preview={preview} />
        </MailProvider>
      )}
    </LoginGate>
  );
}
function Dashboard({
  email,
  logout,
  preview,
}: {
  email: string;
  logout: () => void;
  preview: boolean;
}) {
  const mailConnection = useMailConnection();
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [notificationCount, setNotificationCount] = useState(0);
  useEffect(() => {
    if (preview) return;
    let active = true;
    const refresh = () => { if (document.visibilityState === 'visible') fetch('/api/notifications?action=list', { credentials: 'same-origin', cache: 'no-store' }).then(response => response.ok ? response.json() : null).then(result => { if (active && result) setNotificationCount(result.unread || 0); }).catch(() => {}); };
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => { active = false; clearInterval(timer); };
  }, [preview]);
  const [loaded] = useState(() => {
    const result = loadWorkspace();
    return preview
      ? { ...result, data: withPreviewExample(result.data) }
      : result;
  });
  const [localData, setData] = useState<Workspace>(loaded.data);
  const [storageError, setStorageError] = useState(loaded.error);
  const [cloudCustomers, setCloudCustomers] = useState<Client[] | null>(null);
  useEffect(() => {
    let active = true;
    crmRequest("entity=customers", undefined, preview ? loaded.data : undefined)
      .then(({ records }) => {
        if (active) setCloudCustomers(records.map(toClient));
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [preview]);
  const data = { ...localData, customers: cloudCustomers ?? (preview ? localData.customers : []) };
  const [ratesState, setRatesState] = useState(preview ? 'preview' : 'loading');
  const [ratesError, setRatesError] = useState('');
  const [rateVersions, setRateVersions] = useState<Record<string, number>>({});
  useEffect(() => {
    if (preview) return;
    let active = true;
    crmRequest('action=rates').then(({ books, history }) => {
      if (!active) return;
      setRateVersions(Object.fromEntries(books.map((b: PriceBook) => [b.id, b.version])));
      setData(d => ({ ...d, books: [...books, ...d.books.filter(b => !books.some((x: PriceBook) => x.id === b.id)).map(b => ({ ...b, status: 'Draft' as const }))], bookHistory: history }));
      setRatesState('ready');
    }).catch(e => { if (active) { setRatesState('error'); setRatesError(e.message); } });
    return () => { active = false; };
  }, [preview]);
  async function saveRates(book: PriceBook): Promise<PriceBook> {
    if (!preview && ratesState !== 'ready') throw new Error(ratesError || 'Wait for rates to load.');
    const saved = preview ? book : (await crmRequest('action=rates', { method: 'POST', body: JSON.stringify({ book, expectedVersion: rateVersions[book.id] ?? null }) })).book;
    if (!preview) setRateVersions(v => ({ ...v, [saved.id]: saved.version }));
    update(d => ({ ...d, books: d.books.some(b => b.id === saved.id) ? d.books.map(b => b.id === saved.id ? saved : b) : [...d.books, saved], bookHistory: [...d.books.filter(b => b.id === saved.id), ...d.bookHistory] }), `${saved.name} saved.`);
    return saved;
  }
  async function saveSheetPricing(sheet: QuoteDraft): Promise<void> {
    const book = data.books.find(b => b.id === sheet.bookId);
    if (!book) throw new Error('The selected pricing agreement is unavailable.');
    if (!calculateCost(sheet).valid) throw new Error('Correct invalid sheet inputs before saving prices.');
    const items = sheet.lines.map(({ rateItemId, quantity: _quantity, ...line }) => ({
      ...line,
      id: rateItemId,
    }));
    const saved = await saveRates({ ...book, items, taxPercent: sheet.taxPercent, updatedAt: new Date().toISOString() });
    update(d => ({ ...d, draft: d.draft?.bookId === saved.id ? { ...d.draft, bookVersion: saved.version } : d.draft }));
  }
  const [tab, setTab] = useState(() =>
    nav.map((n) => n.id).includes(location.hash.slice(1))
      ? location.hash.slice(1)
      : "dashboard",
  );
  const [focusId, setFocusId] = useState("");
  const [mobileNav, setMobileNav] = useState(false);
  const [profile, setProfile] = useState(false);
  const [quoteFocus, setQuoteFocus] = useState("");
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [tab, focusId]);
  const [toast, setToast] = useState("");
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    if (loaded.error) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(localData));
      setStorageError("");
    } catch {
      setStorageError(
        "This browser could not save your working estimates. Keep this page open and copy any unsaved work before closing.",
      );
    }
  }, [localData, loaded.error]);
  useEffect(() => {
    const change = () => {
      const id = location.hash.slice(1);
      setTab(nav.map((n) => n.id).includes(id) ? id : "dashboard");
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setProfile(false);
        setMobileNav(false);
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("keydown", escape);
      clearTimeout(toastTimer.current);
    };
  }, []);
  function notify(message: string) {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 6000);
  }
  function update(fn: (d: Workspace) => Workspace, event?: string) {
    setData((d) => {
      const next = fn(d);
      return event
        ? {
            ...next,
            activity: [
              {
                id: crypto.randomUUID(),
                text: event,
                at: new Date().toISOString(),
              },
              ...next.activity,
            ].slice(0, 100),
          }
        : next;
    });
    if (event) notify(event);
  }
  function navigate(id: string, target = "") {
    if (
      !window.dispatchEvent(
        new Event("dcx-before-navigate", { cancelable: true }),
      )
    )
      return;
    if (id === "quotes") {
      const q = data.quotes.find((q) => q.id === target);
      id = "customers";
      target = q?.customerId || "";
      setQuoteFocus(q?.id || "");
    } else setQuoteFocus("");
    setTab(id);
    setFocusId(target);
    location.hash = id;
    setMobileNav(false);
  }
  function startQuote(clientId = "") {
    if (
      data.draft &&
      calculateCost(data.draft).sellingPrice > 0 &&
      !window.confirm(
        "Start a new estimate? Save your current working draft as a quotation first if you want to keep it.",
      )
    )
      return;
    const client = data.customers.find((c) => c.id === clientId);
    if (!client) {
      navigate("customers");
      notify(
        "Open Quotations and choose a customer. The Cost calculator is available for quick estimates.",
      );
      return;
    }
    const book =
      data.books.find((b) => b.id === client.bookId) || data.books[0];
    update((d) => ({
      ...d,
      draft: {
        ...newDraft(book, client.id, client.site),
        customerSnapshot: structuredClone(client),
      },
    }));
    navigate("calculator");
  }
  const draft = data.draft || newDraft(data.books[0]);
  function saveQuote(review: boolean) {
    const calc = calculateCost(draft);
    if (
      !calc.valid ||
      calc.sellingPrice <= 0 ||
      !draft.customerId ||
      !draft.site.trim() ||
      !draft.title.trim() ||
      draft.validityDays < 1
    ) {
      notify("Complete the estimate and correct invalid inputs before saving.");
      return;
    }
    const source = data.quotes.find((q) => q.id === draft.revises);
    const number =
      source?.number ||
      `Q-${new Date().getFullYear()}-${String(data.quotes.length + 1).padStart(3, "0")}`;
    const revision = source
      ? Math.max(
          ...data.quotes
            .filter((q) => q.number === number)
            .map((q) => q.revision),
        ) + 1
      : 1;
    const q: SavedQuote = {
      ...structuredClone(draft),
      customerSnapshot: structuredClone(
        draft.customerSnapshot ||
          data.customers.find((c) => c.id === draft.customerId),
      ),
      id: crypto.randomUUID(),
      number,
      revision,
      status: review ? "Pending review" : "Draft",
      createdAt: new Date().toISOString(),
      totalCost: calc.totalCost,
      sellingPrice: calc.sellingPrice,
      profit: calc.profit,
      formulaVersion: FORMULA_VERSION,
    };
    update(
      (d) => ({ ...d, quotes: [q, ...d.quotes], draft: null }),
      `${number} · revision ${revision} saved to this customer's quotations.`,
    );
    navigate("customers", q.customerId);
    setQuoteFocus(q.id);
  }
  function approveQuote(q: SavedQuote) {
    if (!preview && (ratesState !== 'ready' || !rateVersions[q.bookId])) return notify('Load and publish shared rates before approving this quotation.');
    const book = data.books.find((b) => b.id === q.bookId);
    if (!book || !bookUsable(book))
      return notify(
        "Publish reviewed rates with current effective dates before approving this quotation.",
      );
    if (book.version !== q.bookVersion)
      return notify(
        "Rates have changed. Create a revision and refresh its rates before approval.",
      );
    if (!calculateCost(q).valid)
      return notify("This quote contains invalid calculation inputs.");
    update(
      (d) => ({
        ...d,
        quotes: d.quotes.map((x) =>
          x.id === q.id
            ? { ...x, status: "Approved", approvedAt: new Date().toISOString() }
            : x,
        ),
      }),
      `${q.number} approved. No email has been sent.`,
    );
  }
  const pending =
    mailConnection.mode === "preview"
      ? data.emails.filter((m) => m.status === "Needs review").length
      : 0;
  return (
    <div className="app-shell">
      {mobileNav && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileNav(false)}
        />
      )}
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <button className="brand" onClick={() => navigate("dashboard")}>
          <span className="brand-symbol">
            <Zap size={22} fill="currentColor" />
          </span>
          <span>
            <strong>
              DCX<span className="brand-dot">.</span>
            </strong>
            <small>OPERATIONS WORKSPACE</small>
          </span>
        </button>
        <p className="nav-caption">WORKSPACE</p>
        <nav>
          {nav.map((item, i) => (
            <button
              key={item.id}
              aria-current={tab === item.id ? "page" : undefined}
              className={`nav-item ${tab === item.id ? "active" : ""} ${item.id === "calendar-agent" ? "nav-spaced" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={17} />
              <span>{item.label}</span>
              {item.id === "inbox" && pending > 0 && <b>{pending}</b>}
              {item.id === "notifications" && notificationCount > 0 && <b>{notificationCount}</b>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom sidebar-tools">
          <div className="sidebar-account">
            <button className="sidebar-account-button" aria-label="Account menu" aria-expanded={profile} onClick={() => setProfile(!profile)}>
              <span className="sidebar-avatar">{email.slice(0, 1).toUpperCase()}</span>
              <span className="sidebar-account-email">{email}</span>
              <ChevronDown size={14} />
            </button>
            {profile && <button className="sidebar-signout" onClick={logout}><LogOut size={15} /> Sign out</button>}
          </div>
        </div>
      </aside>
      <div className="app-body">
        <main
          className={`main-content ${tab === "inbox" ? "mail-main-content" : ""} ${tab === "dashboard" ? "dashboard-main-content" : ""}`}
        >
          <button className="icon-button mobile-menu dashboard-mobile-menu" aria-label="Open navigation" onClick={() => setMobileNav(true)}><Menu size={21}/></button>
          {storageError && (
            <div role="alert" className="notice amber">
              {storageError}
            </div>
          )}
          <div
            key={`${tab}-${focusId}`}
            className={`page-content page-enter ${tab === "inbox" ? "mail-page-content" : ""}`}
          >
            {tab === "dashboard" && (
              <Overview
                data={data}
                preview={preview}
                navigate={navigate}
                onQuote={() => navigate('quotations')}
              />
            )}
            {tab === "inbox" && (
              <ConnectedInbox focusId={focusId} preview={preview} customers={data.customers} onQuote={startQuote}>
                <InboxPage
                  data={data}
                  focusId={focusId}
                  onQuote={startQuote}
                  onUpdate={(m) =>
                    update(
                      (d) => ({
                        ...d,
                        emails: d.emails.map((x) => (x.id === m.id ? m : x)),
                      }),
                      `Email ${m.status.toLowerCase()}. No message sent.`,
                    )
                  }
                  onCompose={(m) =>
                    update(
                      (d) => ({ ...d, emails: [m, ...d.emails] }),
                      "New email draft saved locally.",
                    )
                  }
                />
              </ConnectedInbox>
            )}
            {tab === "customers" && (
              <CustomerHub
                preview={preview}
                data={data}
                focusId={focusId}
                quoteFocus={quoteFocus}
                onLoaded={setCloudCustomers}
                onQuote={startQuote}
                renderQuotes={(id) => (
                  <QuotesPage
                    key={`${id}-${quoteFocus}`}
                    data={{
                      ...data,
                      quotes: data.quotes.filter((q) => q.customerId === id),
                    }}
                    embedded
                    focusId={quoteFocus}
                    onNew={() => startQuote(id)}
                    onApprove={approveQuote}
                    onRevise={(q) => {
                      update((d) => ({
                        ...d,
                        draft: { ...structuredClone(q), revises: q.id },
                      }));
                      navigate("calculator");
                    }}
                  />
                )}
              />
            )}
            {tab === "quotations" && <QuotationLanding preview={preview} data={data} onLoaded={setCloudCustomers} onAddCustomer={() => navigate('customers', 'new')} />}
            {tab === "calculator" && (
              <>
              {!preview && ratesState !== 'ready' && <p role="status" className="notice amber">{ratesState === 'loading' ? 'Loading shared rates...' : 'Shared rates are unavailable. These are cached estimates; quotation approval is paused.'}</p>}
              <CostWorkspace
                data={data}
                draft={draft}
                onBack={() => navigate("customers", draft.customerId)}
                onChange={(draft) => update((d) => ({ ...d, draft }))}
                onSave={saveQuote}
                onSavePricing={saveSheetPricing}
                pricingDisabled={!preview && ratesState !== 'ready'}
                hasSavedPricing={preview || !!rateVersions[draft.bookId]}
              />
              </>
            )}
            {tab === "calendar-agent" && <CalendarAgent preview={preview} />}
            {tab === "notifications" && <NotificationsPage preview={preview} onUnread={setNotificationCount} onOpenInbox={() => navigate('inbox')} />}
            {tab === "feature-requests" && <FeatureRequestsPage preview={preview} />}
            {SHOW_RATES && tab === "pricing" && (
              <PriceBooks
                key={ratesState}
                data={data}
                onSave={saveRates}
                disabled={!preview && ratesState !== 'ready'}
                storageLabel={preview ? 'Preview rates are saved in this browser.' : ratesState === 'loading' ? 'Loading shared rates...' : ratesState === 'error' ? ratesError : 'Save rates to share them across your dashboard. Existing estimates keep their original rates.'}
              />
            )}
          </div>
          {tab !== "inbox" && (
            <footer className="workspace-footer">
              <span>DCX Technical Inc.</span>
              <span>Operations workspace</span>
            </footer>
          )}
        </main>
      </div>
      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        <button className={tab === 'dashboard' ? 'active' : ''} onClick={() => navigate('dashboard')}><LayoutDashboard size={20}/><span>Home</span></button>
        <button className={tab === 'inbox' ? 'active' : ''} onClick={() => navigate('inbox')}><Inbox size={20}/><span>Inbox</span></button>
        <button className={tab === 'quotations' ? 'active' : ''} onClick={() => navigate('quotations')}><FileText size={20}/><span>Quotes</span></button>
        <button className={tab === 'notifications' ? 'active' : ''} onClick={() => navigate('notifications')}><Bell size={20}/><span>Alerts</span>{notificationCount > 0 && <b>{notificationCount > 9 ? '9+' : notificationCount}</b>}</button>
        <button onClick={() => setMobileNav(true)}><Menu size={20}/><span>More</span></button>
      </nav>
      {!calendarOpen && <button className="calendar-launcher" type="button" onClick={() => { setCalendarOpen(true); setMobileNav(false); }} aria-label="Open Calendar Agent" aria-expanded={false} aria-controls="calendar-widget"><span className="calendar-launcher-label"><strong>Calendar Agent</strong><small><i/> Online</small></span><span className="calendar-launcher-circle"><CalendarDays size={26}/><i className="calendar-launcher-dot"/></span></button>}
      {calendarOpen && <aside className="calendar-widget" id="calendar-widget" aria-label="Calendar Agent chat"><button className="calendar-widget-close" aria-label="Close Calendar Agent" onClick={() => setCalendarOpen(false)}><X size={17}/></button><CalendarAgent preview={preview}/></aside>}
      {toast && (
        <div className="toast" role="status">
          <ShieldCheck size={17} />
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}
export default App;
