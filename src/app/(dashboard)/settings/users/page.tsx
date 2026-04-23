"use client";

import { useEffect, useState, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { UserPlus, Shield, Loader2, ArrowLeft, ToggleLeft, ToggleRight, KeyRound, Lock } from "lucide-react";
import Link from "next/link";

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  is_active: number;
  has_password: number;
  last_login_at: string | null;
  created_at: string;
}

const ROLES = [
  { value: "owner", label: "Owner" },
  { value: "sales_manager", label: "Sales Manager" },
  { value: "warehouse", label: "Warehouse" },
  { value: "finance", label: "Finance" },
  { value: "marketing", label: "Marketing" },
  { value: "support", label: "Support" },
  { value: "ai", label: "AI Agent" },
];

function roleBadgeVariant(role: string): "default" | "secondary" | "outline" {
  if (role === "owner") return "default";
  if (role === "ai") return "outline";
  return "secondary";
}

function formatDate(dateStr: string | null) {
  if (!dateStr) return "Never";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [saving, setSaving] = useState(false);

  // Invite form
  const [invName, setInvName] = useState("");
  const [invEmail, setInvEmail] = useState("");
  const [invRole, setInvRole] = useState("support");

  // Edit form
  const [editRole, setEditRole] = useState("");
  const [editActive, setEditActive] = useState(true);

  // Password management
  const [setPasswordOpen, setSetPasswordOpen] = useState<UserRow | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [settingPassword, setSettingPassword] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/settings/users");
      if (!res.ok) throw new Error();
      setUsers(await res.json());
    } catch {
      toast.error("Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleInvite = async () => {
    if (!invName || !invEmail) {
      toast.error("Name and email are required");
      return;
    }
    setInviting(true);
    try {
      const res = await fetch("/api/v1/settings/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: invName, email: invEmail, role: invRole }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to invite user");
      } else {
        toast.success(`Invited ${invName} — welcome email sent`);
        setInviteOpen(false);
        setInvName("");
        setInvEmail("");
        setInvRole("support");
        load();
      }
    } catch {
      toast.error("Failed to invite user");
    } finally {
      setInviting(false);
    }
  };

  const openEdit = (user: UserRow) => {
    setEditingUser(user);
    setEditRole(user.role);
    setEditActive(!!user.is_active);
  };

  const handleEdit = async () => {
    if (!editingUser) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/settings/users/${editingUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: editRole, is_active: editActive }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to update user");
      } else {
        toast.success(`Updated ${editingUser.name}`);
        setEditingUser(null);
        load();
      }
    } catch {
      toast.error("Failed to update user");
    } finally {
      setSaving(false);
    }
  };

  const handleSetPassword = async () => {
    if (!setPasswordOpen || !newPassword) return;
    if (newPassword.length < 8) {
      toast.error("Password must be at least 8 characters");
      return;
    }
    setSettingPassword(true);
    try {
      const res = await fetch(`/api/v1/settings/users/${setPasswordOpen.id}/password`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Failed to set password");
      } else {
        toast.success(`Password set for ${setPasswordOpen.name}`);
        setSetPasswordOpen(null);
        setNewPassword("");
        load();
      }
    } catch {
      toast.error("Failed to set password");
    } finally {
      setSettingPassword(false);
    }
  };

  const handleClearPassword = async (user: UserRow) => {
    if (!confirm(`Remove password for ${user.name}? They'll need to use magic link to sign in.`)) return;
    try {
      const res = await fetch(`/api/v1/settings/users/${user.id}/password`, { method: "DELETE" });
      if (!res.ok) {
        toast.error("Failed to clear password");
      } else {
        toast.success(`Password cleared for ${user.name}`);
        load();
      }
    } catch {
      toast.error("Failed to clear password");
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Link href="/settings" className="text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-5 w-5" />
            </Link>
            <h1 className="text-3xl font-bold tracking-tight">User Management</h1>
          </div>
          <p className="text-muted-foreground ml-8">Manage team access to The Frame</p>
        </div>

        <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
          <DialogTrigger asChild>
            <Button>
              <UserPlus className="h-4 w-4 mr-2" /> Invite User
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invite Team Member</DialogTitle>
              <DialogDescription>
                They&apos;ll receive an email with temporary login credentials.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="grid gap-2">
                <Label htmlFor="inv-name">Name</Label>
                <Input id="inv-name" value={invName} onChange={(e) => setInvName(e.target.value)} placeholder="Jane Doe" />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="inv-email">Email</Label>
                <Input id="inv-email" type="email" value={invEmail} onChange={(e) => setInvEmail(e.target.value)} placeholder="jane@example.com" />
              </div>
              <div className="grid gap-2">
                <Label>Role</Label>
                <Select value={invRole} onValueChange={setInvRole}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setInviteOpen(false)}>Cancel</Button>
              <Button onClick={handleInvite} disabled={inviting}>
                {inviting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                Send Invite
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" /> Team Members
          </CardTitle>
          <CardDescription>{users.length} user{users.length !== 1 ? "s" : ""}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Auth</TableHead>
                  <TableHead>Last Login</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.name}</TableCell>
                    <TableCell className="text-muted-foreground">{u.email}</TableCell>
                    <TableCell>
                      <Badge variant={roleBadgeVariant(u.role)}>
                        {ROLES.find((r) => r.value === u.role)?.label || u.role}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {u.is_active ? (
                        <span className="flex items-center gap-1 text-green-600 text-sm">
                          <ToggleRight className="h-4 w-4" /> Active
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-muted-foreground text-sm">
                          <ToggleLeft className="h-4 w-4" /> Inactive
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      {u.has_password ? (
                        <span className="flex items-center gap-1 text-sm text-muted-foreground">
                          <Lock className="h-3.5 w-3.5" /> Password
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-sm text-muted-foreground">
                          <KeyRound className="h-3.5 w-3.5" /> Magic link only
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{formatDate(u.last_login_at)}</TableCell>
                    <TableCell className="text-right space-x-1">
                      <Button variant="ghost" size="sm" onClick={() => openEdit(u)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => { setSetPasswordOpen(u); setNewPassword(""); }}
                      >
                        <KeyRound className="h-3.5 w-3.5 mr-1" />
                        {u.has_password ? "Reset" : "Set"} Password
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Edit User Dialog */}
      <Dialog open={!!editingUser} onOpenChange={(open) => !open && setEditingUser(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editingUser?.name}</DialogTitle>
            <DialogDescription>{editingUser?.email}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid gap-2">
              <Label>Role</Label>
              <Select value={editRole} onValueChange={setEditRole}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {ROLES.map((r) => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <Label>Active</Label>
                <p className="text-sm text-muted-foreground">Inactive users cannot log in</p>
              </div>
              <Button
                variant={editActive ? "default" : "outline"}
                size="sm"
                onClick={() => setEditActive(!editActive)}
              >
                {editActive ? "Active" : "Inactive"}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingUser(null)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Set/Reset Password Dialog */}
      <Dialog open={!!setPasswordOpen} onOpenChange={(open) => !open && setSetPasswordOpen(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {setPasswordOpen?.has_password ? "Reset" : "Set"} Password — {setPasswordOpen?.name}
            </DialogTitle>
            <DialogDescription>
              {setPasswordOpen?.email}
              {setPasswordOpen?.has_password && (
                <span className="block mt-1 text-amber-600">
                  This will replace their current password immediately.
                </span>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="new-pw">New Password</Label>
              <Input
                id="new-pw"
                type="password"
                placeholder="Minimum 8 characters"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                minLength={8}
                autoComplete="new-password"
              />
            </div>
            {setPasswordOpen?.has_password && (
              <Button
                variant="outline"
                size="sm"
                className="text-red-600 hover:text-red-700"
                onClick={() => {
                  if (setPasswordOpen) {
                    handleClearPassword(setPasswordOpen);
                    setSetPasswordOpen(null);
                  }
                }}
              >
                Remove password (force magic link only)
              </Button>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSetPasswordOpen(null)}>Cancel</Button>
            <Button onClick={handleSetPassword} disabled={settingPassword || newPassword.length < 8}>
              {settingPassword && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {setPasswordOpen?.has_password ? "Reset" : "Set"} Password
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
