"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";

interface SmartList {
  id: string;
  name: string;
  result_count: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export function CampaignCreateDialog({ open, onClose }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [loading, setLoading] = useState(false);
  const [smartLists, setSmartLists] = useState<SmartList[]>([]);

  // Step 1
  const [name, setName] = useState("");
  const [type, setType] = useState("email_sequence");
  const [description, setDescription] = useState("");

  // Step 2
  const [targetType, setTargetType] = useState<"smart_list" | "segment">("smart_list");
  const [smartListId, setSmartListId] = useState("");
  const [segment, setSegment] = useState("");

  // Step 3 - preview contacts
  const [previewCount, setPreviewCount] = useState(0);

  // A/B test fields
  const [variantASubject, setVariantASubject] = useState("");
  const [variantBSubject, setVariantBSubject] = useState("");

  useEffect(() => {
    fetch("/api/v1/sales/smart-lists")
      .then((r) => r.json())
      .then((d) => setSmartLists(d.data || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (step === 3 && smartListId) {
      const list = smartLists.find((l) => l.id === smartListId);
      setPreviewCount(list?.result_count || 0);
    }
  }, [step, smartListId, smartLists]);

  const canNext = () => {
    if (step === 1) return name.trim().length > 0;
    if (step === 2) return targetType === "segment" ? segment.trim().length > 0 : smartListId.length > 0;
    return true;
  };

  const handleCreate = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/v1/sales/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          type,
          description,
          target_segment: targetType === "segment" ? segment : undefined,
          target_smart_list_id: targetType === "smart_list" ? smartListId : undefined,
          variant_a_subject: type === "ab_test" ? variantASubject : undefined,
          variant_b_subject: type === "ab_test" ? variantBSubject : undefined,
        }),
      });
      const data = await res.json();
      if (data.data?.id) {
        router.push(`/campaigns/${data.data.id}`);
        onClose();
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>
            New Campaign — Step {step} of 4
          </DialogTitle>
        </DialogHeader>

        {/* Step indicators */}
        <div className="flex gap-1 mb-4">
          {[1, 2, 3, 4].map((s) => (
            <div
              key={s}
              className={`h-1.5 flex-1 rounded-full ${s <= step ? "bg-primary" : "bg-muted"}`}
            />
          ))}
        </div>

        {step === 1 && (
          <div className="space-y-4">
            <div>
              <Label>Campaign Name</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Q2 Boutique Outreach" />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="email_sequence">Email Sequence</SelectItem>
                  <SelectItem value="calling">Calling</SelectItem>
                  <SelectItem value="re_engagement">Re-engagement</SelectItem>
                  <SelectItem value="ab_test">A/B Test</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {type === "ab_test" && (
              <div className="space-y-2">
                <div>
                  <Label>Variant A Subject</Label>
                  <Input value={variantASubject} onChange={(e) => setVariantASubject(e.target.value)} placeholder="Personalized subject line" />
                </div>
                <div>
                  <Label>Variant B Subject</Label>
                  <Input value={variantBSubject} onChange={(e) => setVariantBSubject(e.target.value)} placeholder="Generic subject line" />
                </div>
              </div>
            )}
            <div>
              <Label>Description</Label>
              <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Campaign goals and notes..." rows={3} />
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-4">
            <div>
              <Label>Target Source</Label>
              <Select value={targetType} onValueChange={(v) => setTargetType(v as "smart_list" | "segment")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="smart_list">Smart List</SelectItem>
                  <SelectItem value="segment">Manual Segment</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {targetType === "smart_list" ? (
              <div>
                <Label>Select Smart List</Label>
                <Select value={smartListId} onValueChange={setSmartListId}>
                  <SelectTrigger><SelectValue placeholder="Choose a list..." /></SelectTrigger>
                  <SelectContent>
                    {smartLists.map((sl) => (
                      <SelectItem key={sl.id} value={sl.id}>
                        {sl.name} ({sl.result_count} contacts)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : (
              <div>
                <Label>Segment Filter</Label>
                <Textarea value={segment} onChange={(e) => setSegment(e.target.value)} placeholder="e.g. State=CA, ICP Tier=A, Has Email" rows={3} />
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div className="rounded-lg border p-4 space-y-2">
              <h3 className="font-semibold">Review</h3>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <span className="text-muted-foreground">Name:</span>
                <span className="font-medium">{name}</span>
                <span className="text-muted-foreground">Type:</span>
                <Badge variant="secondary">{type.replace("_", " ")}</Badge>
                <span className="text-muted-foreground">Target:</span>
                <span>{targetType === "smart_list" ? smartLists.find((l) => l.id === smartListId)?.name : "Manual segment"}</span>
                <span className="text-muted-foreground">Contacts:</span>
                <span className="font-medium">{previewCount > 0 ? `~${previewCount}` : "TBD"}</span>
              </div>
              {type === "ab_test" && (
                <div className="mt-2 space-y-1 text-sm">
                  <div><span className="text-muted-foreground">Variant A:</span> {variantASubject}</div>
                  <div><span className="text-muted-foreground">Variant B:</span> {variantBSubject}</div>
                </div>
              )}
            </div>
            {type === "email_sequence" && (
              <p className="text-sm text-muted-foreground">
                After creation, configure email sequences in{" "}
                <a href="https://app.instantly.ai" target="_blank" rel="noopener" className="underline">
                  Instantly
                </a>
                .
              </p>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="py-8 text-center space-y-2">
            <p className="text-lg font-semibold">Ready to launch?</p>
            <p className="text-sm text-muted-foreground">
              This will create the campaign and push leads to Instantly via API.
            </p>
          </div>
        )}

        <DialogFooter className="flex justify-between">
          <div>
            {step > 1 && (
              <Button variant="ghost" onClick={() => setStep(step - 1)}>
                <ChevronLeft className="mr-1 h-4 w-4" /> Back
              </Button>
            )}
          </div>
          <div>
            {step < 4 ? (
              <Button onClick={() => setStep(step + 1)} disabled={!canNext()}>
                Next <ChevronRight className="ml-1 h-4 w-4" />
              </Button>
            ) : (
              <Button onClick={handleCreate} disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Create Campaign
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
