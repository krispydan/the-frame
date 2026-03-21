"use client";

import { useEffect, useState, useCallback } from "react";
import { Plus, Calendar as CalendarIcon, ChevronLeft, ChevronRight, Pencil, Trash2, LayoutGrid, List } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

type ContentItem = {
  id: string;
  title: string;
  type: string;
  platform: string;
  status: string;
  scheduledDate: string | null;
  publishedDate: string | null;
  content: string | null;
  notes: string | null;
  tags: string | null;
};

const statusColors: Record<string, string> = {
  idea: "bg-gray-100 text-gray-800",
  planned: "bg-blue-100 text-blue-800",
  draft: "bg-yellow-100 text-yellow-800",
  scheduled: "bg-purple-100 text-purple-800",
  published: "bg-green-100 text-green-800",
};

const platformColors: Record<string, string> = {
  instagram: "bg-pink-500",
  tiktok: "bg-black",
  facebook: "bg-blue-600",
  twitter: "bg-sky-500",
  linkedin: "bg-blue-700",
  blog: "bg-emerald-600",
  email: "bg-amber-500",
};

const platformTextColors: Record<string, string> = {
  instagram: "text-pink-700 bg-pink-50 border-pink-200",
  tiktok: "text-gray-900 bg-gray-100 border-gray-300",
  facebook: "text-blue-700 bg-blue-50 border-blue-200",
  twitter: "text-sky-700 bg-sky-50 border-sky-200",
  linkedin: "text-blue-800 bg-blue-50 border-blue-200",
  blog: "text-emerald-700 bg-emerald-50 border-emerald-200",
  email: "text-amber-700 bg-amber-50 border-amber-200",
};

const typeIcons: Record<string, string> = {
  blog: "📝",
  social: "📱",
  email: "✉️",
  ad: "📢",
};

const PLATFORMS = ["instagram", "tiktok", "facebook", "twitter", "linkedin", "blog", "email"] as const;
const STATUSES = ["idea", "planned", "draft", "scheduled", "published"] as const;
const TYPES = ["blog", "social", "email", "ad"] as const;

const emptyForm = { title: "", type: "social", platform: "instagram", status: "draft", scheduledDate: "", content: "", notes: "" };

export function ContentCalendarTab() {
  const [items, setItems] = useState<ContentItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("all");
  const [platformFilter, setPlatformFilter] = useState("all");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ContentItem | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [view, setView] = useState<"calendar" | "list">("calendar");
  const [currentMonth, setCurrentMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  const fetchData = useCallback(async () => {
    const params = new URLSearchParams();
    if (statusFilter !== "all") params.set("status", statusFilter);
    if (platformFilter !== "all") params.set("platform", platformFilter);
    const res = await fetch(`/api/v1/marketing/content?${params}`);
    const json = await res.json();
    setItems(json.data || []);
    setLoading(false);
  }, [statusFilter, platformFilter]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const openCreate = () => {
    setEditingItem(null);
    setForm(emptyForm);
    setDialogOpen(true);
  };

  const openEdit = (item: ContentItem) => {
    setEditingItem(item);
    setForm({
      title: item.title,
      type: item.type,
      platform: item.platform,
      status: item.status,
      scheduledDate: item.scheduledDate || "",
      content: item.content || "",
      notes: item.notes || "",
    });
    setDialogOpen(true);
  };

  const handleSubmit = async () => {
    if (editingItem) {
      await fetch(`/api/v1/marketing/content/${editingItem.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    } else {
      await fetch("/api/v1/marketing/content", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
    }
    setDialogOpen(false);
    setEditingItem(null);
    setForm(emptyForm);
    fetchData();
  };

  const handleDelete = async (id: string) => {
    await fetch(`/api/v1/marketing/content/${id}`, { method: "DELETE" });
    setDeleteConfirm(null);
    fetchData();
  };

  const updateDate = async (id: string, date: string) => {
    await fetch(`/api/v1/marketing/content/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scheduledDate: date }),
    });
    fetchData();
  };

  const statusCounts = {
    idea: items.filter(i => i.status === "idea").length,
    planned: items.filter(i => i.status === "planned").length,
    draft: items.filter(i => i.status === "draft").length,
    scheduled: items.filter(i => i.status === "scheduled").length,
    published: items.filter(i => i.status === "published").length,
  };

  // Calendar helpers
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfWeek = new Date(year, month, 1).getDay();
  const monthName = currentMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" });

  const calendarDays: (number | null)[] = [];
  for (let i = 0; i < firstDayOfWeek; i++) calendarDays.push(null);
  for (let d = 1; d <= daysInMonth; d++) calendarDays.push(d);
  while (calendarDays.length % 7 !== 0) calendarDays.push(null);

  const getItemsForDay = (day: number) => {
    const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return items.filter(i => i.scheduledDate?.startsWith(dateStr));
  };

  const today = new Date();
  const isToday = (day: number) => today.getFullYear() === year && today.getMonth() === month && today.getDate() === day;

  const prevMonth = () => setCurrentMonth(new Date(year, month - 1, 1));
  const nextMonth = () => setCurrentMonth(new Date(year, month + 1, 1));

  return (
    <div className="space-y-4">
      {/* Status Pipeline */}
      <div className="grid grid-cols-5 gap-3">
        {Object.entries(statusCounts).map(([status, count]) => (
          <Card key={status} className={`cursor-pointer hover:shadow-md transition-shadow ${status === statusFilter ? "ring-2 ring-primary" : ""}`} onClick={() => setStatusFilter(status === statusFilter ? "all" : status)}>
            <CardContent className="p-3 text-center">
              <div className="text-2xl font-bold">{count}</div>
              <div className="text-xs text-muted-foreground capitalize">{status}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters + View Toggle + Add */}
      <div className="flex items-center gap-3 flex-wrap">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {STATUSES.map(s => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={platformFilter} onValueChange={setPlatformFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="Platform" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Platforms</SelectItem>
            {PLATFORMS.map(p => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <div className="flex items-center border rounded-md">
          <Button variant={view === "calendar" ? "default" : "ghost"} size="sm" onClick={() => setView("calendar")} className="rounded-r-none">
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button variant={view === "list" ? "default" : "ghost"} size="sm" onClick={() => setView("list")} className="rounded-l-none">
            <List className="h-4 w-4" />
          </Button>
        </div>
        <Button onClick={openCreate}><Plus className="h-4 w-4 mr-2" />Add Content</Button>
      </div>

      {/* Calendar View */}
      {view === "calendar" && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <Button variant="ghost" size="sm" onClick={prevMonth}><ChevronLeft className="h-4 w-4" /></Button>
              <CardTitle className="text-lg">{monthName}</CardTitle>
              <Button variant="ghost" size="sm" onClick={nextMonth}><ChevronRight className="h-4 w-4" /></Button>
            </div>
          </CardHeader>
          <CardContent className="p-2">
            <div className="grid grid-cols-7 gap-px bg-muted rounded-lg overflow-hidden">
              {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => (
                <div key={d} className="bg-muted-foreground/5 p-2 text-center text-xs font-medium text-muted-foreground">{d}</div>
              ))}
              {calendarDays.map((day, i) => {
                const dayItems = day ? getItemsForDay(day) : [];
                return (
                  <div key={i} className={`bg-background min-h-[100px] p-1 ${!day ? "bg-muted/30" : ""} ${day && isToday(day) ? "ring-2 ring-primary ring-inset" : ""}`}>
                    {day && (
                      <>
                        <div className={`text-xs font-medium mb-1 px-1 ${isToday(day) ? "text-primary font-bold" : "text-muted-foreground"}`}>{day}</div>
                        <div className="space-y-0.5">
                          {dayItems.slice(0, 3).map(item => (
                            <button
                              key={item.id}
                              onClick={() => openEdit(item)}
                              className={`w-full text-left text-[10px] leading-tight px-1.5 py-0.5 rounded truncate border ${platformTextColors[item.platform] || "bg-gray-50 text-gray-700 border-gray-200"} hover:opacity-80 transition-opacity`}
                            >
                              <span className={`inline-block w-1.5 h-1.5 rounded-full mr-1 ${platformColors[item.platform] || "bg-gray-400"}`} />
                              {item.title}
                            </button>
                          ))}
                          {dayItems.length > 3 && (
                            <div className="text-[10px] text-muted-foreground px-1.5">+{dayItems.length - 3} more</div>
                          )}
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            {/* Platform Legend */}
            <div className="flex flex-wrap gap-3 mt-3 px-2">
              {PLATFORMS.map(p => (
                <div key={p} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <span className={`w-2.5 h-2.5 rounded-full ${platformColors[p]}`} />
                  <span className="capitalize">{p}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* List View */}
      {view === "list" && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Platform</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Scheduled</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">Loading...</TableCell></TableRow>
                ) : items.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No content found</TableCell></TableRow>
                ) : items.map(item => (
                  <TableRow key={item.id}>
                    <TableCell>{typeIcons[item.type] || "📄"}</TableCell>
                    <TableCell className="font-medium">{item.title}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`${platformTextColors[item.platform] || ""} capitalize`}>
                        <span className={`w-2 h-2 rounded-full mr-1.5 ${platformColors[item.platform] || "bg-gray-400"}`} />
                        {item.platform}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={statusColors[item.status]}>{item.status}</Badge>
                    </TableCell>
                    <TableCell>
                      <Input
                        type="date"
                        value={item.scheduledDate || ""}
                        onChange={e => updateDate(item.id, e.target.value)}
                        className="h-7 w-[140px] text-xs"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(item)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" onClick={() => setDeleteConfirm(item.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Create/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) setEditingItem(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>{editingItem ? "Edit Content" : "Add Content"}</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label>Title</Label><Input value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} placeholder="Content title..." /></div>
            <div className="grid grid-cols-3 gap-3">
              <div><Label>Type</Label>
                <Select value={form.type} onValueChange={v => setForm({ ...form, type: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TYPES.map(t => <SelectItem key={t} value={t} className="capitalize">{typeIcons[t]} {t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div><Label>Platform</Label>
                <Select value={form.platform} onValueChange={v => setForm({ ...form, platform: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PLATFORMS.map(p => <SelectItem key={p} value={p} className="capitalize">{p}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div><Label>Status</Label>
                <Select value={form.status} onValueChange={v => setForm({ ...form, status: v })}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUSES.map(s => <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div><Label>Scheduled Date</Label><Input type="date" value={form.scheduledDate} onChange={e => setForm({ ...form, scheduledDate: e.target.value })} /></div>
            <div><Label>Content / Body</Label><Textarea value={form.content} onChange={e => setForm({ ...form, content: e.target.value })} rows={3} placeholder="Post content or copy..." /></div>
            <div><Label>Notes</Label><Textarea value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} rows={2} placeholder="Internal notes..." /></div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={!form.title}>{editingItem ? "Save Changes" : "Create"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={() => setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete Content</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">Are you sure you want to delete this content item? This action cannot be undone.</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteConfirm && handleDelete(deleteConfirm)}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
