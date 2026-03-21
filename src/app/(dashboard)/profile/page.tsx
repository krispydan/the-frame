"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  updated_at: string;
}

interface Activity {
  id: string;
  timestamp: string;
  entity_type: string;
  entity_id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  source: string;
  agent_type: string | null;
}

const TIMEZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Chicago",
  "America/New_York",
  "America/Anchorage",
  "Pacific/Honolulu",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Australia/Sydney",
  "UTC",
];

const LANDING_PAGES = [
  { value: "/", label: "Dashboard" },
  { value: "/orders", label: "Orders" },
  { value: "/inventory", label: "Inventory" },
  { value: "/customers", label: "Customers" },
  { value: "/catalog", label: "Catalog" },
  { value: "/finance", label: "Finance" },
];

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

const ROLE_COLORS: Record<string, string> = {
  owner: "bg-purple-100 text-purple-800",
  sales_manager: "bg-blue-100 text-blue-800",
  warehouse: "bg-amber-100 text-amber-800",
  finance: "bg-green-100 text-green-800",
  marketing: "bg-pink-100 text-pink-800",
  support: "bg-gray-100 text-gray-800",
  ai: "bg-cyan-100 text-cyan-800",
};

export default function ProfilePage() {
  const [user, setUser] = useState<User | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  // Edit form
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");

  // Preferences
  const [timezone, setTimezone] = useState("America/Los_Angeles");
  const [landingPage, setLandingPage] = useState("/");

  const fetchProfile = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/profile");
      if (!res.ok) throw new Error("Failed to fetch profile");
      const data = await res.json();
      setUser(data.user);
      setActivity(data.activity || []);
      setEditName(data.user.name);
      setEditEmail(data.user.email);
    } catch {
      setMessage({ type: "error", text: "Failed to load profile" });
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchPreferences = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/settings?keys=user.timezone,user.landing_page");
      if (res.ok) {
        const data = await res.json();
        const settings = data.settings || data;
        if (Array.isArray(settings)) {
          for (const s of settings) {
            if (s.key === "user.timezone" && s.value) setTimezone(s.value);
            if (s.key === "user.landing_page" && s.value) setLandingPage(s.value);
          }
        }
      }
    } catch {
      // Settings may not exist yet
    }
  }, []);

  useEffect(() => {
    fetchProfile();
    fetchPreferences();
  }, [fetchProfile, fetchPreferences]);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: editName, email: editEmail }),
      });
      if (!res.ok) throw new Error("Failed to update");
      const data = await res.json();
      setUser(data.user);
      setMessage({ type: "success", text: "Profile updated" });
    } catch {
      setMessage({ type: "error", text: "Failed to update profile" });
    } finally {
      setSaving(false);
    }
  }

  async function handleSavePreferences() {
    setSavingPrefs(true);
    setMessage(null);
    try {
      const res = await fetch("/api/v1/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          settings: [
            { key: "user.timezone", value: timezone, type: "string", module: "core" },
            { key: "user.landing_page", value: landingPage, type: "string", module: "core" },
          ],
        }),
      });
      if (!res.ok) throw new Error("Failed to save");
      setMessage({ type: "success", text: "Preferences saved" });
    } catch {
      setMessage({ type: "error", text: "Failed to save preferences" });
    } finally {
      setSavingPrefs(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <p className="text-muted-foreground">Loading profile...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <p className="text-muted-foreground">No user found</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Profile</h1>
        <p className="text-muted-foreground">Manage your account settings and preferences</p>
      </div>

      {message && (
        <div
          className={`rounded-md px-4 py-3 text-sm ${
            message.type === "success"
              ? "bg-green-50 text-green-800 border border-green-200"
              : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {message.text}
        </div>
      )}

      {/* Profile Card */}
      <Card>
        <CardContent className="flex items-center gap-6 pt-6">
          <Avatar className="h-20 w-20 text-2xl">
            <AvatarFallback className="bg-primary text-primary-foreground text-2xl font-semibold">
              {getInitials(user.name)}
            </AvatarFallback>
          </Avatar>
          <div className="space-y-1">
            <h2 className="text-2xl font-semibold">{user.name}</h2>
            <p className="text-muted-foreground">{user.email}</p>
            <Badge className={ROLE_COLORS[user.role] || "bg-gray-100 text-gray-800"} variant="secondary">
              {user.role.replace("_", " ")}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs defaultValue="edit" className="space-y-4">
        <TabsList>
          <TabsTrigger value="edit">Edit Profile</TabsTrigger>
          <TabsTrigger value="activity">Activity Log</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
        </TabsList>

        {/* Edit Profile */}
        <TabsContent value="edit">
          <Card>
            <CardHeader>
              <CardTitle>Edit Profile</CardTitle>
              <CardDescription>Update your name and email address</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSaveProfile} className="space-y-4 max-w-md">
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" value={editName} onChange={(e) => setEditName(e.target.value)} required />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} required />
                </div>
                <Button type="submit" disabled={saving}>
                  {saving ? "Saving..." : "Save Changes"}
                </Button>
              </form>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Activity Log */}
        <TabsContent value="activity">
          <Card>
            <CardHeader>
              <CardTitle>Activity Log</CardTitle>
              <CardDescription>Your last 20 actions</CardDescription>
            </CardHeader>
            <CardContent>
              {activity.length === 0 ? (
                <p className="text-muted-foreground text-sm">No activity recorded yet.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Entity</TableHead>
                      <TableHead>Field</TableHead>
                      <TableHead>Change</TableHead>
                      <TableHead>Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {activity.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {a.timestamp ? new Date(a.timestamp).toLocaleString() : "—"}
                        </TableCell>
                        <TableCell className="font-medium">
                          {a.entity_type}
                          <span className="text-muted-foreground text-xs ml-1">#{a.entity_id?.slice(0, 8)}</span>
                        </TableCell>
                        <TableCell>{a.field}</TableCell>
                        <TableCell className="text-sm">
                          {a.old_value && (
                            <span className="line-through text-muted-foreground mr-2">{a.old_value}</span>
                          )}
                          {a.new_value && <span>{a.new_value}</span>}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className="text-xs">
                            {a.source}
                            {a.agent_type && ` (${a.agent_type})`}
                          </Badge>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Preferences */}
        <TabsContent value="preferences">
          <Card>
            <CardHeader>
              <CardTitle>Preferences</CardTitle>
              <CardDescription>Customize your experience</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6 max-w-md">
              <div className="space-y-2">
                <Label>Timezone</Label>
                <Select value={timezone} onValueChange={setTimezone}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Default Landing Page</Label>
                <Select value={landingPage} onValueChange={setLandingPage}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LANDING_PAGES.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button onClick={handleSavePreferences} disabled={savingPrefs}>
                {savingPrefs ? "Saving..." : "Save Preferences"}
              </Button>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
