"use client";

import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Bell, Package, Users, TrendingDown, DollarSign, AlertTriangle, ShoppingCart, Check, X, Filter } from "lucide-react";
import { useState, useEffect, useCallback } from "react";

type Notification = {
  id: string;
  type: string;
  title: string;
  message: string;
  severity: string;
  module: string;
  entity_id: string | null;
  entity_type: string | null;
  read: number;
  dismissed: number;
  created_at: string;
};

const typeIcons: Record<string, any> = {
  inventory: Package,
  deal: TrendingDown,
  customer: Users,
  finance: DollarSign,
  agent: AlertTriangle,
  order: ShoppingCart,
};

const typeLabels: Record<string, string> = {
  all: "All",
  inventory: "Inventory",
  deal: "Deals",
  customer: "Customers",
  finance: "Finance",
  agent: "Agent",
  order: "Orders",
};

const severityColor = (s: string) => {
  switch (s) {
    case "critical": return "destructive" as const;
    case "high": return "destructive" as const;
    case "medium": return "secondary" as const;
    default: return "outline" as const;
  }
};

const severityBorder = (s: string) => {
  switch (s) {
    case "critical": return "border-l-red-600";
    case "high": return "border-l-red-500";
    case "medium": return "border-l-yellow-500";
    default: return "border-l-blue-400";
  }
};

function timeAgo(dateStr: string) {
  const diff = Date.now() - new Date(dateStr + "Z").getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export default function NotificationsPage() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [filter, setFilter] = useState("all");
  const [loading, setLoading] = useState(true);

  const fetchNotifications = useCallback(async () => {
    const params = new URLSearchParams();
    if (filter !== "all") params.set("type", filter);
    const res = await fetch(`/api/v1/notifications?${params}`);
    if (res.ok) setNotifications(await res.json());
    setLoading(false);
  }, [filter]);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  const unread = notifications.filter(n => !n.read).length;

  const markRead = async (id: string) => {
    await fetch(`/api/v1/notifications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ read: true }),
    });
    setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: 1 } : n));
  };

  const dismiss = async (id: string) => {
    await fetch(`/api/v1/notifications/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dismissed: true }),
    });
    setNotifications(prev => prev.filter(n => n.id !== id));
  };

  const markAllRead = async () => {
    await Promise.all(
      notifications.filter(n => !n.read).map(n =>
        fetch(`/api/v1/notifications/${n.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ read: true }),
        })
      )
    );
    setNotifications(prev => prev.map(n => ({ ...n, read: 1 })));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Bell className="h-6 w-6" /> Notifications
            {unread > 0 && (
              <Badge variant="destructive" className="ml-1">{unread}</Badge>
            )}
          </h1>
          <p className="text-muted-foreground">{unread} unread alert{unread !== 1 ? "s" : ""}</p>
        </div>
        <Button variant="outline" onClick={markAllRead} disabled={unread === 0}>
          <Check className="h-4 w-4 mr-1" />Mark All Read
        </Button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 flex-wrap">
        {Object.entries(typeLabels).map(([key, label]) => (
          <Button
            key={key}
            variant={filter === key ? "default" : "outline"}
            size="sm"
            onClick={() => setFilter(key)}
          >
            {label}
          </Button>
        ))}
      </div>

      {loading ? (
        <p className="text-muted-foreground text-center py-8">Loading...</p>
      ) : notifications.length === 0 ? (
        <p className="text-muted-foreground text-center py-8">No notifications</p>
      ) : (
        <div className="space-y-3">
          {notifications.map(notif => {
            const Icon = typeIcons[notif.type] || Bell;
            return (
              <Card
                key={notif.id}
                className={`cursor-pointer transition-opacity ${notif.read ? "opacity-60" : `border-l-4 ${severityBorder(notif.severity)}`}`}
                onClick={() => !notif.read && markRead(notif.id)}
              >
                <CardContent className="flex items-start gap-4 py-4">
                  <Icon className="h-5 w-5 mt-0.5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{notif.title}</span>
                      <Badge variant={severityColor(notif.severity)}>{notif.severity}</Badge>
                      <Badge variant="outline" className="text-xs">{notif.type}</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground mt-1">{notif.message}</p>
                    <span className="text-xs text-muted-foreground">{timeAgo(notif.created_at)}</span>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => { e.stopPropagation(); dismiss(notif.id); }}
                    title="Dismiss"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
