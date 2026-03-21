"use client";

import { Suspense, useState, useEffect, useCallback } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  ArrowUpDown,
  Receipt,
  Wallet,
  CreditCard,
  Plus,
  Upload,
  ExternalLink,
  RefreshCw,
  Calendar,
  X,
} from "lucide-react";

// ── Types ──

interface PnlSummary {
  period: { start: string; end: string; label: string };
  revenue: number;
  cogs: number;
  grossMargin: number;
  grossMarginPct: number;
  totalFees: number;
  totalExpenses: number;
  netIncome: number;
  channels: Array<{
    channel: string;
    channelLabel: string;
    revenue: number;
    cogs: number;
    grossMargin: number;
    grossMarginPct: number;
    fees: number;
    orderCount: number;
  }>;
  expensesByCategory: Array<{ category: string; amount: number; budget: number | null }>;
}

interface CashFlowSummary {
  currentPosition: number;
  pendingInflows: number;
  expectedOutflows30d: number;
  forecast: Array<{
    period: string;
    label: string;
    inflows: number;
    outflows: number;
    netCashFlow: number;
    projectedBalance: number;
  }>;
  pendingSettlements: Array<{ id: string; channel: string; netAmount: number; periodEnd: string }>;
  upcomingExpenses: Array<{ description: string; amount: number; vendor: string }>;
}

interface Settlement {
  id: string;
  channel: string;
  periodStart: string;
  periodEnd: string;
  grossAmount: number;
  fees: number;
  adjustments: number;
  netAmount: number;
  status: string;
  receivedAt: string | null;
  xeroTransactionId: string | null;
}

interface Expense {
  id: string;
  categoryId: string | null;
  categoryName: string | null;
  description: string;
  amount: number;
  vendor: string | null;
  date: string;
  recurring: boolean;
  frequency: string | null;
}

interface ExpenseCategory {
  id: string;
  name: string;
  budgetMonthly: number | null;
}

// ── Helper ──
function fmt(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}

const CHANNEL_COLORS: Record<string, string> = {
  shopify_dtc: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  shopify_wholesale: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  faire: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  amazon: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "bg-yellow-100 text-yellow-800",
  received: "bg-green-100 text-green-800",
  reconciled: "bg-blue-100 text-blue-800",
  synced_to_xero: "bg-indigo-100 text-indigo-800",
};

// ── Main Component ──

function FinancePageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = searchParams.get("tab") || "pnl";

  const [pnl, setPnl] = useState<PnlSummary | null>(null);
  const [cashFlow, setCashFlow] = useState<CashFlowSummary | null>(null);
  const [stlList, setStlList] = useState<Settlement[]>([]);
  const [expenseList, setExpenseList] = useState<Expense[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [period, setPeriod] = useState<string>("mtd");
  const [loading, setLoading] = useState(true);

  // Expense form state
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const [expForm, setExpForm] = useState({
    description: "", amount: "", vendor: "", date: new Date().toISOString().split("T")[0],
    categoryId: "", recurring: false, frequency: "",
  });

  const loadPnl = useCallback(async () => {
    const res = await fetch(`/api/v1/finance/pnl?period=${period}`);
    const data = await res.json();
    setPnl(data);
  }, [period]);

  const loadCashFlow = useCallback(async () => {
    const res = await fetch("/api/v1/finance/cash-flow");
    const data = await res.json();
    setCashFlow(data);
  }, []);

  const loadSettlements = useCallback(async () => {
    const res = await fetch("/api/v1/finance/settlements?limit=50");
    const data = await res.json();
    setStlList(data.settlements || []);
  }, []);

  const loadExpenses = useCallback(async () => {
    const res = await fetch("/api/v1/finance/expenses?limit=50");
    const data = await res.json();
    setExpenseList(data.expenses || []);
    setCategories(data.categories || []);
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadPnl(), loadCashFlow(), loadSettlements(), loadExpenses()])
      .finally(() => setLoading(false));
  }, [loadPnl, loadCashFlow, loadSettlements, loadExpenses]);

  const setTab = (t: string) => {
    router.push(`/finance?tab=${t}`);
  };

  const handleAddExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    await fetch("/api/v1/finance/expenses", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...expForm,
        amount: parseFloat(expForm.amount),
        categoryId: expForm.categoryId || null,
        frequency: expForm.recurring ? (expForm.frequency || "monthly") : null,
      }),
    });
    setShowExpenseForm(false);
    setExpForm({ description: "", amount: "", vendor: "", date: new Date().toISOString().split("T")[0], categoryId: "", recurring: false, frequency: "" });
    loadExpenses();
    loadPnl();
  };

  const handleDeleteExpense = async (id: string) => {
    await fetch(`/api/v1/finance/expenses/${id}`, { method: "DELETE" });
    loadExpenses();
    loadPnl();
  };

  const handleSyncToXero = async (settlementId: string) => {
    const res = await fetch(`/api/v1/finance/settlements/${settlementId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "sync_to_xero" }),
    });
    const result = await res.json();
    if (result.success) loadSettlements();
    else alert(result.error || "Sync failed");
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Finance</h1>
          <p className="text-muted-foreground">P&L, settlements, expenses, and cash flow</p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            className="rounded-md border bg-background px-3 py-2 text-sm"
          >
            <option value="mtd">Month to Date</option>
            <option value="qtd">Quarter to Date</option>
            <option value="ytd">Year to Date</option>
          </select>
        </div>
      </div>

      {/* Tabs */}
      <div className="border-b">
        <nav className="flex gap-4 -mb-px">
          {[
            { key: "pnl", label: "P&L", icon: TrendingUp },
            { key: "settlements", label: "Settlements", icon: Receipt },
            { key: "expenses", label: "Expenses", icon: CreditCard },
            { key: "cashflow", label: "Cash Flow", icon: Wallet },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-2 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground"
              }`}
            >
              <t.icon className="h-4 w-4" />
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab Content */}
      {tab === "pnl" && pnl && <PnlTab pnl={pnl} />}
      {tab === "settlements" && (
        <SettlementsTab
          settlements={stlList}
          onSyncToXero={handleSyncToXero}
          onRefresh={loadSettlements}
        />
      )}
      {tab === "expenses" && (
        <ExpensesTab
          expenses={expenseList}
          categories={categories}
          pnl={pnl}
          showForm={showExpenseForm}
          setShowForm={setShowExpenseForm}
          form={expForm}
          setForm={setExpForm}
          onSubmit={handleAddExpense}
          onDelete={handleDeleteExpense}
        />
      )}
      {tab === "cashflow" && cashFlow && <CashFlowTab cashFlow={cashFlow} />}
    </div>
  );
}

// ── P&L Tab ──

function PnlTab({ pnl }: { pnl: PnlSummary }) {
  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <SummaryCard title="Revenue" value={fmt(pnl.revenue)} icon={DollarSign} trend={null} />
        <SummaryCard title="COGS" value={fmt(pnl.cogs)} icon={TrendingDown} trend={null} negative />
        <SummaryCard title="Gross Margin" value={fmt(pnl.grossMargin)} subtitle={pct(pnl.grossMarginPct)} icon={TrendingUp} trend={null} />
        <SummaryCard title="Expenses + Fees" value={fmt(pnl.totalExpenses + pnl.totalFees)} icon={CreditCard} trend={null} negative />
        <SummaryCard
          title="Net Income"
          value={fmt(pnl.netIncome)}
          icon={Wallet}
          trend={null}
          negative={pnl.netIncome < 0}
          highlight
        />
      </div>

      {/* Channel Breakdown */}
      <div className="rounded-lg border bg-card">
        <div className="p-4 border-b">
          <h3 className="font-semibold">P&L by Channel — {pnl.period.label}</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3 font-medium">Channel</th>
                <th className="text-right p-3 font-medium">Orders</th>
                <th className="text-right p-3 font-medium">Revenue</th>
                <th className="text-right p-3 font-medium">COGS</th>
                <th className="text-right p-3 font-medium">Gross Margin</th>
                <th className="text-right p-3 font-medium">Margin %</th>
                <th className="text-right p-3 font-medium">Fees</th>
                <th className="text-right p-3 font-medium">Net</th>
              </tr>
            </thead>
            <tbody>
              {pnl.channels.map((ch) => (
                <tr key={ch.channel} className="border-b hover:bg-muted/30">
                  <td className="p-3">
                    <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${CHANNEL_COLORS[ch.channel] || "bg-gray-100"}`}>
                      {ch.channelLabel}
                    </span>
                  </td>
                  <td className="text-right p-3">{ch.orderCount}</td>
                  <td className="text-right p-3 font-medium">{fmt(ch.revenue)}</td>
                  <td className="text-right p-3 text-muted-foreground">{fmt(ch.cogs)}</td>
                  <td className="text-right p-3">{fmt(ch.grossMargin)}</td>
                  <td className="text-right p-3">
                    <span className={ch.grossMarginPct >= 50 ? "text-green-600" : ch.grossMarginPct >= 30 ? "text-yellow-600" : "text-red-600"}>
                      {pct(ch.grossMarginPct)}
                    </span>
                  </td>
                  <td className="text-right p-3 text-muted-foreground">{fmt(ch.fees)}</td>
                  <td className="text-right p-3 font-medium">{fmt(ch.grossMargin - ch.fees)}</td>
                </tr>
              ))}
              {pnl.channels.length === 0 && (
                <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">No order data for this period</td></tr>
              )}
            </tbody>
            {pnl.channels.length > 0 && (
              <tfoot>
                <tr className="bg-muted/50 font-semibold">
                  <td className="p-3">Total</td>
                  <td className="text-right p-3">{pnl.channels.reduce((s, c) => s + c.orderCount, 0)}</td>
                  <td className="text-right p-3">{fmt(pnl.revenue)}</td>
                  <td className="text-right p-3">{fmt(pnl.cogs)}</td>
                  <td className="text-right p-3">{fmt(pnl.grossMargin)}</td>
                  <td className="text-right p-3">{pct(pnl.grossMarginPct)}</td>
                  <td className="text-right p-3">{fmt(pnl.totalFees)}</td>
                  <td className="text-right p-3">{fmt(pnl.grossMargin - pnl.totalFees)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Expenses by Category */}
      {pnl.expensesByCategory.length > 0 && (
        <div className="rounded-lg border bg-card">
          <div className="p-4 border-b">
            <h3 className="font-semibold">Expenses by Category</h3>
          </div>
          <div className="p-4 space-y-3">
            {pnl.expensesByCategory.map((ec) => (
              <div key={ec.category} className="flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium truncate">{ec.category}</span>
                    <span className="text-sm">
                      {fmt(ec.amount)}
                      {ec.budget && <span className="text-muted-foreground"> / {fmt(ec.budget)}</span>}
                    </span>
                  </div>
                  {ec.budget && (
                    <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          ec.amount / ec.budget > 1 ? "bg-red-500" : ec.amount / ec.budget > 0.8 ? "bg-yellow-500" : "bg-green-500"
                        }`}
                        style={{ width: `${Math.min(100, (ec.amount / ec.budget) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Settlements Tab ──

function SettlementsTab({
  settlements,
  onSyncToXero,
  onRefresh,
}: {
  settlements: Settlement[];
  onSyncToXero: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Settlement History</h3>
        <button onClick={onRefresh} className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted">
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      <div className="rounded-lg border bg-card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-left p-3 font-medium">Channel</th>
              <th className="text-left p-3 font-medium">Period</th>
              <th className="text-right p-3 font-medium">Gross</th>
              <th className="text-right p-3 font-medium">Fees</th>
              <th className="text-right p-3 font-medium">Net</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="text-left p-3 font-medium">Received</th>
              <th className="text-right p-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {settlements.map((s) => (
              <tr key={s.id} className="border-b hover:bg-muted/30">
                <td className="p-3">
                  <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${CHANNEL_COLORS[s.channel] || "bg-gray-100"}`}>
                    {s.channel.replace("_", " ").replace(/\b\w/g, (c) => c.toUpperCase())}
                  </span>
                </td>
                <td className="p-3 text-muted-foreground">{s.periodStart} → {s.periodEnd}</td>
                <td className="text-right p-3">{fmt(s.grossAmount)}</td>
                <td className="text-right p-3 text-red-600">{fmt(s.fees)}</td>
                <td className="text-right p-3 font-medium">{fmt(s.netAmount)}</td>
                <td className="p-3">
                  <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[s.status] || "bg-gray-100"}`}>
                    {s.status.replace("_", " ")}
                  </span>
                </td>
                <td className="p-3 text-muted-foreground">{s.receivedAt || "—"}</td>
                <td className="text-right p-3">
                  {s.status !== "synced_to_xero" && !s.xeroTransactionId && (
                    <button
                      onClick={() => onSyncToXero(s.id)}
                      className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
                      title="Sync to Xero"
                    >
                      <ExternalLink className="h-3 w-3" /> Xero
                    </button>
                  )}
                  {s.xeroTransactionId && (
                    <span className="text-xs text-green-600">✓ Synced</span>
                  )}
                </td>
              </tr>
            ))}
            {settlements.length === 0 && (
              <tr><td colSpan={8} className="p-8 text-center text-muted-foreground">No settlements yet</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Expenses Tab (Full UI) ──

const CHART_COLORS = [
  "bg-blue-500", "bg-green-500", "bg-yellow-500", "bg-purple-500", "bg-red-500",
  "bg-indigo-500", "bg-pink-500", "bg-teal-500", "bg-orange-500", "bg-cyan-500",
];

function ExpensesTab({
  expenses: initialExpenses,
  categories: initialCategories,
  pnl,
  showForm,
  setShowForm,
  form,
  setForm,
  onSubmit,
  onDelete,
}: {
  expenses: Expense[];
  categories: ExpenseCategory[];
  pnl: PnlSummary | null;
  showForm: boolean;
  setShowForm: (v: boolean) => void;
  form: { description: string; amount: string; vendor: string; date: string; categoryId: string; recurring: boolean; frequency: string };
  setForm: (v: typeof form) => void;
  onSubmit: (e: React.FormEvent) => void;
  onDelete: (id: string) => void;
}) {
  const [expenses, setExpenses] = useState<Expense[]>(initialExpenses);
  const [categories, setCategories] = useState<ExpenseCategory[]>(initialCategories);
  const [editingExpense, setEditingExpense] = useState<Expense | null>(null);
  const [editForm, setEditForm] = useState({ description: "", amount: "", vendor: "", date: "", categoryId: "", recurring: false, frequency: "", notes: "" });
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [catForm, setCatForm] = useState({ name: "", budgetMonthly: "" });
  const [editingCategory, setEditingCategory] = useState<ExpenseCategory | null>(null);

  // Filters
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterVendor, setFilterVendor] = useState("");
  const [filterAmountMin, setFilterAmountMin] = useState("");
  const [filterAmountMax, setFilterAmountMax] = useState("");
  const [showFilters, setShowFilters] = useState(false);

  // Sync from parent
  useEffect(() => { setExpenses(initialExpenses); }, [initialExpenses]);
  useEffect(() => { setCategories(initialCategories); }, [initialCategories]);

  // Filtered expenses
  const filtered = expenses.filter((e) => {
    if (filterDateFrom && e.date < filterDateFrom) return false;
    if (filterDateTo && e.date > filterDateTo) return false;
    if (filterCategory && e.categoryId !== filterCategory) return false;
    if (filterVendor && !(e.vendor || "").toLowerCase().includes(filterVendor.toLowerCase())) return false;
    if (filterAmountMin && e.amount < parseFloat(filterAmountMin)) return false;
    if (filterAmountMax && e.amount > parseFloat(filterAmountMax)) return false;
    return true;
  });

  const totalSpend = filtered.reduce((s, e) => s + e.amount, 0);
  const activeFilters = [filterDateFrom, filterDateTo, filterCategory, filterVendor, filterAmountMin, filterAmountMax].filter(Boolean).length;

  // Monthly chart data — group by category for current month view
  const monthlyByCategory = categories.map((cat, i) => {
    const catExpenses = filtered.filter((e) => e.categoryId === cat.id);
    const total = catExpenses.reduce((s, e) => s + e.amount, 0);
    return { name: cat.name, amount: total, color: CHART_COLORS[i % CHART_COLORS.length] };
  }).filter((c) => c.amount > 0).sort((a, b) => b.amount - a.amount);

  const uncategorized = filtered.filter((e) => !e.categoryId).reduce((s, e) => s + e.amount, 0);
  if (uncategorized > 0) monthlyByCategory.push({ name: "Uncategorized", amount: uncategorized, color: "bg-gray-400" });
  const maxCatAmount = Math.max(...monthlyByCategory.map((c) => c.amount), 1);

  // Unique vendors for filter dropdown
  const uniqueVendors = [...new Set(expenses.map((e) => e.vendor).filter(Boolean))] as string[];

  // Edit expense
  const openEditModal = (exp: Expense) => {
    setEditingExpense(exp);
    setEditForm({
      description: exp.description, amount: String(exp.amount), vendor: exp.vendor || "",
      date: exp.date, categoryId: exp.categoryId || "", recurring: exp.recurring,
      frequency: exp.frequency || "", notes: "",
    });
  };

  const handleEditExpense = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingExpense) return;
    await fetch(`/api/v1/finance/expenses/${editingExpense.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...editForm,
        amount: parseFloat(editForm.amount),
        categoryId: editForm.categoryId || null,
        frequency: editForm.recurring ? (editForm.frequency || "monthly") : null,
      }),
    });
    setEditingExpense(null);
    // Reload
    const res = await fetch("/api/v1/finance/expenses?limit=50");
    const data = await res.json();
    setExpenses(data.expenses || []);
  };

  // Category management
  const handleAddCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (editingCategory) {
      await fetch(`/api/v1/finance/expense-categories/${editingCategory.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: catForm.name, budgetMonthly: catForm.budgetMonthly || null }),
      });
    } else {
      await fetch("/api/v1/finance/expense-categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: catForm.name, budgetMonthly: catForm.budgetMonthly || null }),
      });
    }
    setCatForm({ name: "", budgetMonthly: "" });
    setEditingCategory(null);
    const res = await fetch("/api/v1/finance/expense-categories");
    const data = await res.json();
    setCategories(data.categories || []);
  };

  const handleDeleteCategory = async (id: string) => {
    if (!confirm("Delete this category? Expenses using it will become uncategorized.")) return;
    await fetch(`/api/v1/finance/expense-categories/${id}`, { method: "DELETE" });
    const res = await fetch("/api/v1/finance/expense-categories");
    const data = await res.json();
    setCategories(data.categories || []);
  };

  const clearFilters = () => {
    setFilterDateFrom(""); setFilterDateTo(""); setFilterCategory("");
    setFilterVendor(""); setFilterAmountMin(""); setFilterAmountMax("");
  };

  // Budget vs actual
  const budgetComparison = categories
    .filter((c) => c.budgetMonthly)
    .map((c) => {
      const actual = filtered.filter((e) => e.categoryId === c.id).reduce((s, e) => s + e.amount, 0);
      return { category: c.name, budget: c.budgetMonthly!, actual, pct: c.budgetMonthly! > 0 ? (actual / c.budgetMonthly!) * 100 : 0 };
    })
    .sort((a, b) => b.pct - a.pct);

  return (
    <div className="space-y-6">
      {/* Total Spend Card + Summary */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard title="Total Spend" value={fmt(totalSpend)} subtitle={`${filtered.length} expense${filtered.length !== 1 ? "s" : ""}`} icon={CreditCard} trend={null} highlight />
        <SummaryCard title="Recurring Monthly" value={fmt(expenses.filter((e) => e.recurring).reduce((s, e) => s + e.amount, 0))} subtitle={`${expenses.filter((e) => e.recurring).length} recurring`} icon={RefreshCw} trend={null} />
        <SummaryCard title="Categories" value={String(categories.length)} subtitle={budgetComparison.length > 0 ? `${budgetComparison.filter((b) => b.pct > 100).length} over budget` : "No budgets set"} icon={ArrowUpDown} trend={null} />
      </div>

      {/* Monthly Expense Chart by Category */}
      {monthlyByCategory.length > 0 && (
        <div className="rounded-lg border bg-card">
          <div className="p-4 border-b">
            <h3 className="font-semibold">Expenses by Category</h3>
          </div>
          <div className="p-4 space-y-3">
            {monthlyByCategory.map((cat) => (
              <div key={cat.name} className="flex items-center gap-3">
                <div className="w-32 text-sm font-medium truncate">{cat.name}</div>
                <div className="flex-1">
                  <div className="w-full h-6 bg-muted rounded overflow-hidden">
                    <div
                      className={`h-full ${cat.color} rounded transition-all flex items-center px-2`}
                      style={{ width: `${Math.max(4, (cat.amount / maxCatAmount) * 100)}%` }}
                    >
                      <span className="text-xs text-white font-medium truncate">{fmt(cat.amount)}</span>
                    </div>
                  </div>
                </div>
                <div className="w-20 text-right text-sm text-muted-foreground">
                  {totalSpend > 0 ? pct((cat.amount / totalSpend) * 100) : "0%"}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Budget vs Actual */}
      {budgetComparison.length > 0 && (
        <div className="rounded-lg border bg-card">
          <div className="p-4 border-b">
            <h3 className="font-semibold">Budget vs Actual</h3>
          </div>
          <div className="p-4 grid gap-3">
            {budgetComparison.map((b) => (
              <div key={b.category} className="flex items-center gap-4">
                <div className="w-40 text-sm font-medium truncate">{b.category}</div>
                <div className="flex-1">
                  <div className="w-full h-3 bg-muted rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${b.pct > 100 ? "bg-red-500" : b.pct > 80 ? "bg-yellow-500" : "bg-green-500"}`}
                      style={{ width: `${Math.min(100, b.pct)}%` }}
                    />
                  </div>
                </div>
                <div className="w-32 text-right text-sm">
                  {fmt(b.actual)} <span className="text-muted-foreground">/ {fmt(b.budget)}</span>
                </div>
                <div className={`w-16 text-right text-sm font-medium ${b.pct > 100 ? "text-red-600" : "text-green-600"}`}>
                  {pct(b.pct)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Expense List */}
      <div className="rounded-lg border bg-card">
        <div className="p-4 border-b flex items-center justify-between flex-wrap gap-2">
          <h3 className="font-semibold">Expenses</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowCategoryModal(true)}
              className="inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted"
            >
              <ArrowUpDown className="h-4 w-4" /> Categories
            </button>
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted ${activeFilters > 0 ? "border-primary text-primary" : ""}`}
            >
              <Calendar className="h-4 w-4" /> Filters{activeFilters > 0 && ` (${activeFilters})`}
            </button>
            <button
              onClick={() => setShowForm(!showForm)}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90"
            >
              <Plus className="h-4 w-4" /> Add Expense
            </button>
          </div>
        </div>

        {/* Filters Panel */}
        {showFilters && (
          <div className="p-4 border-b bg-muted/20">
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Date From</label>
                <input type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Date To</label>
                <input type="date" value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Category</label>
                <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                  <option value="">All</option>
                  {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Vendor</label>
                <select value={filterVendor} onChange={(e) => setFilterVendor(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                  <option value="">All</option>
                  {uniqueVendors.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Min Amount</label>
                <input type="number" step="0.01" placeholder="$0" value={filterAmountMin} onChange={(e) => setFilterAmountMin(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground block mb-1">Max Amount</label>
                <input type="number" step="0.01" placeholder="$∞" value={filterAmountMax} onChange={(e) => setFilterAmountMax(e.target.value)}
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
              </div>
            </div>
            {activeFilters > 0 && (
              <button onClick={clearFilters} className="mt-2 text-xs text-primary hover:underline">Clear all filters</button>
            )}
          </div>
        )}

        {/* Add Expense Form */}
        {showForm && (
          <form onSubmit={onSubmit} className="p-4 border-b bg-muted/30 grid grid-cols-2 md:grid-cols-4 gap-3">
            <input placeholder="Description *" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })}
              className="rounded-md border bg-background px-3 py-2 text-sm col-span-2" required />
            <input type="number" step="0.01" placeholder="Amount *" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })}
              className="rounded-md border bg-background px-3 py-2 text-sm" required />
            <input placeholder="Vendor" value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })}
              className="rounded-md border bg-background px-3 py-2 text-sm" />
            <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
              className="rounded-md border bg-background px-3 py-2 text-sm">
              <option value="">Category</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })}
              className="rounded-md border bg-background px-3 py-2 text-sm" />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.recurring} onChange={(e) => setForm({ ...form, recurring: e.target.checked })} />
              Recurring
              {form.recurring && (
                <select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}
                  className="rounded-md border bg-background px-2 py-1 text-xs">
                  <option value="monthly">Monthly</option>
                  <option value="weekly">Weekly</option>
                  <option value="quarterly">Quarterly</option>
                  <option value="annually">Annually</option>
                </select>
              )}
            </label>
            <div className="flex items-center gap-2">
              <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90">Save</button>
              <button type="button" onClick={() => setShowForm(false)} className="rounded-md border px-4 py-2 text-sm hover:bg-muted">Cancel</button>
            </div>
          </form>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3 font-medium">Date</th>
                <th className="text-left p-3 font-medium">Description</th>
                <th className="text-left p-3 font-medium">Category</th>
                <th className="text-left p-3 font-medium">Vendor</th>
                <th className="text-right p-3 font-medium">Amount</th>
                <th className="text-left p-3 font-medium">Type</th>
                <th className="text-right p-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((exp) => (
                <tr key={exp.id} className="border-b hover:bg-muted/30">
                  <td className="p-3 text-muted-foreground">{exp.date}</td>
                  <td className="p-3 font-medium">{exp.description}</td>
                  <td className="p-3 text-muted-foreground">{exp.categoryName || "—"}</td>
                  <td className="p-3 text-muted-foreground">{exp.vendor || "—"}</td>
                  <td className="text-right p-3 font-medium">{fmt(exp.amount)}</td>
                  <td className="p-3">
                    {exp.recurring ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-800">
                        🔄 {exp.frequency || "recurring"}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">one-time</span>
                    )}
                  </td>
                  <td className="text-right p-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => openEditModal(exp)} className="text-muted-foreground hover:text-primary p-1" title="Edit">
                        <Upload className="h-4 w-4 rotate-0" />
                      </button>
                      <button onClick={() => onDelete(exp.id)} className="text-muted-foreground hover:text-red-600 p-1" title="Delete">
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="p-8 text-center text-muted-foreground">
                  {activeFilters > 0 ? "No expenses match filters" : "No expenses recorded"}
                </td></tr>
              )}
            </tbody>
            {filtered.length > 0 && (
              <tfoot>
                <tr className="bg-muted/50 font-semibold">
                  <td colSpan={4} className="p-3">Total ({filtered.length} expenses)</td>
                  <td className="text-right p-3">{fmt(totalSpend)}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* Edit Expense Modal */}
      {editingExpense && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setEditingExpense(null)}>
          <div className="bg-card rounded-lg border shadow-lg w-full max-w-lg mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b flex items-center justify-between">
              <h3 className="font-semibold">Edit Expense</h3>
              <button onClick={() => setEditingExpense(null)} className="text-muted-foreground hover:text-foreground"><X className="h-5 w-5" /></button>
            </div>
            <form onSubmit={handleEditExpense} className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="text-xs text-muted-foreground block mb-1">Description</label>
                  <input value={editForm.description} onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm" required />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Amount</label>
                  <input type="number" step="0.01" value={editForm.amount} onChange={(e) => setEditForm({ ...editForm, amount: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm" required />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Date</label>
                  <input type="date" value={editForm.date} onChange={(e) => setEditForm({ ...editForm, date: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Category</label>
                  <select value={editForm.categoryId} onChange={(e) => setEditForm({ ...editForm, categoryId: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm">
                    <option value="">None</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground block mb-1">Vendor</label>
                  <input value={editForm.vendor} onChange={(e) => setEditForm({ ...editForm, vendor: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm" />
                </div>
                <div className="col-span-2">
                  <label className="text-xs text-muted-foreground block mb-1">Notes</label>
                  <textarea value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })}
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm" rows={2} />
                </div>
                <label className="flex items-center gap-2 text-sm col-span-2">
                  <input type="checkbox" checked={editForm.recurring} onChange={(e) => setEditForm({ ...editForm, recurring: e.target.checked })} />
                  Recurring
                  {editForm.recurring && (
                    <select value={editForm.frequency} onChange={(e) => setEditForm({ ...editForm, frequency: e.target.value })}
                      className="rounded-md border bg-background px-2 py-1 text-xs">
                      <option value="monthly">Monthly</option>
                      <option value="weekly">Weekly</option>
                      <option value="quarterly">Quarterly</option>
                      <option value="annually">Annually</option>
                    </select>
                  )}
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setEditingExpense(null)} className="rounded-md border px-4 py-2 text-sm hover:bg-muted">Cancel</button>
                <button type="submit" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90">Save Changes</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Category Management Modal */}
      {showCategoryModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => { setShowCategoryModal(false); setEditingCategory(null); setCatForm({ name: "", budgetMonthly: "" }); }}>
          <div className="bg-card rounded-lg border shadow-lg w-full max-w-md mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="p-4 border-b flex items-center justify-between">
              <h3 className="font-semibold">Manage Categories</h3>
              <button onClick={() => { setShowCategoryModal(false); setEditingCategory(null); }} className="text-muted-foreground hover:text-foreground"><X className="h-5 w-5" /></button>
            </div>
            <div className="p-4 space-y-4">
              {/* Add/Edit Category Form */}
              <form onSubmit={handleAddCategory} className="flex gap-2">
                <input placeholder="Category name" value={catForm.name} onChange={(e) => setCatForm({ ...catForm, name: e.target.value })}
                  className="flex-1 rounded-md border bg-background px-3 py-2 text-sm" required />
                <input type="number" step="0.01" placeholder="Budget/mo" value={catForm.budgetMonthly} onChange={(e) => setCatForm({ ...catForm, budgetMonthly: e.target.value })}
                  className="w-28 rounded-md border bg-background px-3 py-2 text-sm" />
                <button type="submit" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground hover:bg-primary/90">
                  {editingCategory ? "Update" : "Add"}
                </button>
              </form>

              {/* Category List */}
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {categories.map((cat) => (
                  <div key={cat.id} className="flex items-center justify-between p-2 rounded-md border bg-muted/20">
                    <div>
                      <span className="text-sm font-medium">{cat.name}</span>
                      {cat.budgetMonthly && <span className="text-xs text-muted-foreground ml-2">{fmt(cat.budgetMonthly)}/mo</span>}
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => { setEditingCategory(cat); setCatForm({ name: cat.name, budgetMonthly: cat.budgetMonthly ? String(cat.budgetMonthly) : "" }); }}
                        className="text-muted-foreground hover:text-primary p-1 text-xs">Edit</button>
                      <button onClick={() => handleDeleteCategory(cat.id)}
                        className="text-muted-foreground hover:text-red-600 p-1"><X className="h-3 w-3" /></button>
                    </div>
                  </div>
                ))}
                {categories.length === 0 && <p className="text-sm text-muted-foreground text-center py-4">No categories yet</p>}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Cash Flow Tab ──

function CashFlowTab({ cashFlow }: { cashFlow: CashFlowSummary }) {
  return (
    <div className="space-y-6">
      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard title="Cash Position" value={fmt(cashFlow.currentPosition)} icon={Wallet} trend={null} highlight />
        <SummaryCard title="Pending Inflows" value={fmt(cashFlow.pendingInflows)} icon={TrendingUp} trend={null} />
        <SummaryCard title="Expected Outflows (30d)" value={fmt(cashFlow.expectedOutflows30d)} icon={TrendingDown} trend={null} negative />
      </div>

      {/* 30/60/90 Forecast Table */}
      <div className="rounded-lg border bg-card">
        <div className="p-4 border-b">
          <h3 className="font-semibold">Cash Flow Forecast</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left p-3 font-medium">Period</th>
                <th className="text-right p-3 font-medium">Est. Inflows</th>
                <th className="text-right p-3 font-medium">Est. Outflows</th>
                <th className="text-right p-3 font-medium">Net Cash Flow</th>
                <th className="text-right p-3 font-medium">Projected Balance</th>
              </tr>
            </thead>
            <tbody>
              {cashFlow.forecast.map((f) => (
                <tr key={f.period} className="border-b hover:bg-muted/30">
                  <td className="p-3 font-medium">{f.label}</td>
                  <td className="text-right p-3 text-green-600">{fmt(f.inflows)}</td>
                  <td className="text-right p-3 text-red-600">{fmt(f.outflows)}</td>
                  <td className={`text-right p-3 font-medium ${f.netCashFlow >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {fmt(f.netCashFlow)}
                  </td>
                  <td className={`text-right p-3 font-semibold ${f.projectedBalance >= 0 ? "" : "text-red-600"}`}>
                    {fmt(f.projectedBalance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pending Settlements */}
      {cashFlow.pendingSettlements.length > 0 && (
        <div className="rounded-lg border bg-card">
          <div className="p-4 border-b">
            <h3 className="font-semibold">Pending Settlements</h3>
          </div>
          <div className="p-4 space-y-2">
            {cashFlow.pendingSettlements.map((s) => (
              <div key={s.id} className="flex items-center justify-between py-2 border-b last:border-0">
                <div className="flex items-center gap-3">
                  <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${CHANNEL_COLORS[s.channel] || "bg-gray-100"}`}>
                    {s.channel.replace("_", " ")}
                  </span>
                  <span className="text-sm text-muted-foreground">ending {s.periodEnd}</span>
                </div>
                <span className="font-medium">{fmt(s.netAmount)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recurring Expenses */}
      {cashFlow.upcomingExpenses.length > 0 && (
        <div className="rounded-lg border bg-card">
          <div className="p-4 border-b">
            <h3 className="font-semibold">Recurring Monthly Expenses</h3>
          </div>
          <div className="p-4 space-y-2">
            {cashFlow.upcomingExpenses.map((e, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b last:border-0">
                <div>
                  <span className="text-sm font-medium">{e.description}</span>
                  {e.vendor && <span className="text-sm text-muted-foreground ml-2">({e.vendor})</span>}
                </div>
                <span className="font-medium">{fmt(e.amount)}</span>
              </div>
            ))}
            <div className="flex items-center justify-between py-2 font-semibold">
              <span>Total Monthly</span>
              <span>{fmt(cashFlow.upcomingExpenses.reduce((s, e) => s + e.amount, 0))}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Shared Components ──

function SummaryCard({
  title,
  value,
  subtitle,
  icon: Icon,
  trend,
  negative,
  highlight,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: typeof DollarSign;
  trend: string | null;
  negative?: boolean;
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-lg border p-4 ${highlight ? "bg-primary/5 border-primary/20" : "bg-card"}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-muted-foreground">{title}</span>
        <Icon className={`h-4 w-4 ${negative ? "text-red-500" : "text-muted-foreground"}`} />
      </div>
      <div className={`text-2xl font-bold ${negative ? "text-red-600" : ""}`}>{value}</div>
      {subtitle && <div className="text-sm text-muted-foreground mt-1">{subtitle}</div>}
      {trend && <div className="text-xs text-muted-foreground mt-1">{trend}</div>}
    </div>
  );
}

// ── Export with Suspense ──

export default function FinancePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64"><RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" /></div>}>
      <FinancePageContent />
    </Suspense>
  );
}
