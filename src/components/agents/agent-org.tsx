"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  Crown,
  Users,
  Plus,
  Loader2,
  Sparkles,
  AlertTriangle,
  TrendingUp,
  CheckCircle2,
  PauseCircle,
  PlayCircle,
  Trash2,
  GitBranch,
  Activity,
  ListChecks,
  Briefcase,
  Play,
  ClipboardCheck,
} from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { canEditSettings } from "@/lib/auth/roles";
import {
  AI_EMPLOYEE_ROLES,
  type AiAgent,
  type AiAgentRole,
  type AiTask,
  type AgentActivity,
} from "@/types/ai-agents";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";

const ROLE_ICON: Record<AiAgentRole, typeof Bot> = {
  co_founder: Crown,
  sales: TrendingUp,
  marketing: Sparkles,
  support: CheckCircle2,
  operations: GitBranch,
  social: Users,
  finance: Briefcase,
  hr: Users,
  custom: Bot,
};

const ROLE_LABEL: Record<AiAgentRole, string> = {
  co_founder: "AI Co-Founder",
  sales: "Sales AI",
  marketing: "Marketing AI",
  support: "Support AI",
  operations: "Operations AI",
  social: "Social Media AI",
  finance: "Finance AI",
  hr: "HR AI",
  custom: "Custom AI Employee",
};

const STATUS_STYLE: Record<string, string> = {
  todo: "bg-slate-500/15 text-slate-300",
  in_progress: "bg-blue-500/15 text-blue-300",
  blocked: "bg-red-500/15 text-red-300",
  done: "bg-emerald-500/15 text-emerald-300",
  cancelled: "bg-slate-500/10 text-slate-500",
};

interface CoFounderOutcome {
  analysis: string;
  recommendations: string[];
  problems: string[];
  opportunities: string[];
  report: string;
  delegation?: { created: number; skipped: number };
}

export function AgentOrg() {
  const { accountRole } = useAuth();
  const admin = accountRole ? canEditSettings(accountRole) : false;

  const [agents, setAgents] = useState<AiAgent[]>([]);
  const [tasks, setTasks] = useState<AiTask[]>([]);
  const [activity, setActivity] = useState<AgentActivity[]>([]);
  const [loading, setLoading] = useState(true);
  const [coFounderId, setCoFounderId] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<CoFounderOutcome | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [useAi, setUseAi] = useState(false);

  const coFounder = useMemo(() => agents.find((a) => a.role === "co_founder") ?? null, [agents]);
  const employees = useMemo(() => agents.filter((a) => a.role !== "co_founder"), [agents]);

  const refresh = useCallback(async () => {
    const [aRes, tRes, actRes] = await Promise.all([
      fetch("/api/agents"),
      fetch("/api/tasks"),
      fetch("/api/agents/activity?limit=50"),
    ]);
    const a = await aRes.json().catch(() => ({}));
    const t = await tRes.json().catch(() => ({}));
    const act = await actRes.json().catch(() => ({}));
    if (Array.isArray(a.data)) setAgents(a.data);
    if (Array.isArray(t.data)) setTasks(t.data);
    if (Array.isArray(act.data)) setActivity(act.data);
    const cf = (a.data ?? []).find((x: AiAgent) => x.role === "co_founder");
    setCoFounderId(cf?.id ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const ensureCoFounder = async () => {
    setCreating(true);
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: "co_founder" }),
    });
    const json = await res.json().catch(() => ({}));
    if (json.data) setCoFounderId(json.data.id);
    await refresh();
    setCreating(false);
  };

  const createEmployee = async (payload: {
    name: string;
    role: AiAgentRole;
    instructions?: string;
    responsibilities?: string[];
    job_description?: string;
  }) => {
    setCreating(true);
    await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, manager_id: coFounderId }),
    });
    setCreateOpen(false);
    await refresh();
    setCreating(false);
  };

  const runAnalysis = async (directive = "") => {
    if (analyzing) return;
    setAnalyzing(true);
    setAnalysis(null);
    try {
      const res = await fetch("/api/agents/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ directive }),
      });
      const json = await res.json().catch(() => ({}));
      setAnalysis(json.data ?? json);
      await refresh();
    } finally {
      setAnalyzing(false);
    }
  };

  const toggleAgentStatus = async (agent: AiAgent) => {
    await fetch(`/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: agent.status === "active" ? "paused" : "active" }),
    });
    await refresh();
  };

  const runSweep = async () => {
    setRunning("all");
    try {
      await fetch("/api/agents/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ai: useAi }),
      });
      await refresh();
    } finally {
      setRunning(null);
    }
  };

  const runTask = async (taskId: string) => {
    setRunning(taskId);
    try {
      await fetch("/api/agents/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskId, ai: useAi }),
      });
      await refresh();
    } finally {
      setRunning(null);
    }
  };

  const runReview = async () => {
    setRunning("review");
    try {
      const res = await fetch("/api/agents/review", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      setReport(json.data?.report ?? null);
      await refresh();
    } finally {
      setRunning(null);
    }
  };

  const deleteAgent = async (agent: AiAgent) => {
    if (!confirm(`Remove ${agent.name}? This also removes its tasks.`)) return;
    await fetch(`/api/agents/${agent.id}`, { method: "DELETE" });
    await refresh();
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-muted-foreground">
        <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading your AI organization...
      </div>
    );
  }

  // Owner hasn't seeded a co-founder yet.
  if (!coFounder) {
    return (
      <Card className="mx-auto mt-8 max-w-2xl">
        <CardHeader className="flex items-center gap-3">
          <Crown className="h-10 w-10 text-amber-400" />
          <div>
            <CardTitle>Set up your AI Co-Founder</CardTitle>
            <CardDescription>
              The Co-Founder is your top-level business assistant. It analyzes your
              business, gives recommendations, delegates tasks to AI employees, and
              monitors their progress.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Create the Co-Founder to get started. You&apos;ll then be able to add
            specialized AI employees beneath it.
          </p>
          <Button className="mt-4" onClick={ensureCoFounder} disabled={creating}>
            {creating ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Crown className="mr-2 h-4 w-4" />}
            Create AI Co-Founder
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Co-Founder + Action bar */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <Card className="flex-1 border-amber-500/30 bg-gradient-to-br from-amber-500/5 to-transparent">
          <CardHeader className="flex flex-row items-center gap-3">
            <Crown className="h-8 w-8 text-amber-400" />
            <div>
              <CardTitle>{coFounder.name}</CardTitle>
              <CardDescription>{coFounder.instructions?.slice(0, 120) ?? "Your top-level business assistant."}</CardDescription>
            </div>
            {admin && (
              <div className="ml-auto flex gap-2">
                <Button size="sm" variant="outline" onClick={() => toggleAgentStatus(coFounder)}>
                  {coFounder.status === "active" ? <PauseCircle className="mr-1.5 h-4 w-4" /> : <PlayCircle className="mr-1.5 h-4 w-4" />}
                  {coFounder.status === "active" ? "Pause" : "Activate"}
                </Button>
                <Button size="sm" onClick={() => runAnalysis()} disabled={analyzing}>
                  {analyzing ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Sparkles className="mr-1.5 h-4 w-4" />}
                  Analyze business
                </Button>
                <label className="flex shrink-0 items-center gap-2 text-sm font-medium text-muted-foreground">
                  <Sparkles className="h-4 w-4" />
                  AI plan
                  <Switch checked={useAi} onCheckedChange={setUseAi} />
                </label>
                <Button size="sm" variant="outline" onClick={() => runSweep()} disabled={running !== null}>
                  {running === "all" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Play className="mr-1.5 h-4 w-4" />}
                  Run all employees
                </Button>
                <Button size="sm" variant="outline" onClick={() => runReview()} disabled={running !== null}>
                  {running === "review" ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <ClipboardCheck className="mr-1.5 h-4 w-4" />}
                  Review & report
                </Button>
              </div>
            )}
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline" className="text-amber-300">{employees.length} AI employees</Badge>
              <Badge variant="outline">{tasks.filter((t) => t.status === "todo" || t.status === "in_progress").length} open tasks</Badge>
              {tasks.some((t) => t.escalated) && (
                <Badge variant="outline" className="border-red-500/40 text-red-300">
                  <AlertTriangle className="mr-1 h-3 w-3" /> {tasks.filter((t) => t.escalated).length} escalated
                </Badge>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Analysis output */}
      {analysis && (
        <Card>
          <CardHeader>
            <CardTitle>Co-Founder analysis</CardTitle>
            <CardDescription>Latest business assessment</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm">{analysis.analysis}</p>
            {analysis.report && <p className="rounded-md bg-muted p-3 text-sm">{analysis.report}</p>}
            {analysis.problems.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-red-400">Problems</p>
                <ul className="list-inside list-disc space-y-1 text-sm">
                  {analysis.problems.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              </div>
            )}
            {analysis.recommendations.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recommendations</p>
                <ul className="list-inside list-disc space-y-1 text-sm">
                  {analysis.recommendations.map((r, i) => <li key={i}>{r}</li>)}
                </ul>
              </div>
            )}
            {analysis.delegation && (
              <p className="text-xs text-muted-foreground">
                Delegated {analysis.delegation.created} task(s), skipped {analysis.delegation.skipped} unknown assignee(s).
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Co-Founder review / owner report */}
      {report && (
        <Card className="border-blue-500/30">
          <CardHeader className="flex flex-row items-center gap-2">
            <ClipboardCheck className="h-4 w-4 text-blue-400" />
            <CardTitle>Co-Founder review & owner report</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap rounded-md bg-muted/60 p-3 text-sm">{report}</pre>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* Employees */}
        <div className="flex-1 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <Users className="h-5 w-5 text-primary" /> AI Employees
            </h2>
            {admin && (
              <Dialog open={createOpen} onOpenChange={setCreateOpen}>
                <DialogTrigger
                  render={
                    <Button size="sm">
                      <Plus className="mr-1.5 h-4 w-4" /> Add employee
                    </Button>
                  }
                />
                <DialogContent>
                  <AddEmployeeDialog onSubmit={createEmployee} busy={creating} managerId={coFounderId} />
                </DialogContent>
              </Dialog>
            )}
          </div>

          {employees.length === 0 && (
            <Card>
              <CardContent className="py-10 text-center text-sm text-muted-foreground">
                No AI employees yet. Add a Sales, Marketing, Support, or custom AI
                employee to delegate work to.
              </CardContent>
            </Card>
          )}

          {employees.map((agent) => {
            const Icon = ROLE_ICON[agent.role] ?? Bot;
            const agentTasks = tasks.filter((t) => t.assignee_agent_id === agent.id);
            const openCount = agentTasks.filter((t) => t.status !== "done" && t.status !== "cancelled").length;
            return (
              <Card key={agent.id}>
                <CardHeader className="flex flex-row items-start gap-3">
                  <div className={`rounded-lg p-2 ${agent.role === "custom" ? "bg-violet-500/15 text-violet-300" : "bg-primary/10 text-primary"}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <CardTitle>{agent.title ?? agent.name}</CardTitle>
                      <Badge variant={agent.status === "active" ? "default" : "outline"}>
                        {agent.status === "active" ? "Active" : "Paused"}
                      </Badge>
                    </div>
                    <CardDescription>{agent.instructions}</CardDescription>
                  </div>
                  {admin && (
                    <div className="flex gap-1">
                      <Button size="icon" variant="ghost" onClick={() => toggleAgentStatus(agent)} title="Toggle active">
                        {agent.status === "active" ? <PauseCircle className="h-4 w-4" /> : <PlayCircle className="h-4 w-4" />}
                      </Button>
                      <Button size="icon" variant="ghost" className="text-red-400" onClick={() => deleteAgent(agent)} title="Delete">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  )}
                </CardHeader>
                <CardContent className="space-y-3">
                  {agent.responsibilities.length > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Responsibilities</p>
                      <ul className="list-inside list-disc space-y-0.5 text-sm">
                        {agent.responsibilities.map((r, i) => <li key={i}>{r}</li>)}
                      </ul>
                    </div>
                  )}
                  {agent.tools.length > 0 && (
                    <div>
                      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Connected tools</p>
                      <div className="flex flex-wrap gap-1.5">
                        {agent.tools.map((tool) => <Badge key={tool} variant="outline">{tool}</Badge>)}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-sm">
                    <ListChecks className="h-4 w-4 text-muted-foreground" />
                    {openCount > 0 ? (
                      <span>{openCount} open task(s)</span>
                    ) : (
                      <span className="text-muted-foreground">No open tasks</span>
                    )}
                  </div>
                  {agentTasks.length > 0 && (
                    <div className="space-y-1.5">
                      {agentTasks.slice(0, 3).map((t) => (
                        <div key={t.id} className="flex items-center justify-between gap-2 rounded-md bg-muted/60 px-2 py-1 text-sm">
                          <span className="truncate">{t.title}</span>
                          <div className="flex shrink-0 items-center gap-1">
                            <Badge variant="outline" className={STATUS_STYLE[t.status]}>{t.status.replace(/_/g, " ")}</Badge>
                            {admin && (t.status === "todo" || t.status === "in_progress" || t.status === "blocked") && (
                              <Button
                                size="icon"
                                variant="ghost"
                                title="Run this task"
                                disabled={running !== null}
                                onClick={() => runTask(t.id)}
                              >
                                {running === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                              </Button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>

        {/* Right rail: org tree + activity */}
        <div className="w-full space-y-4 lg:w-80">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><GitBranch className="h-4 w-4" /> Agent Organization</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <div className="font-medium">Business Owner</div>
              <div className="my-1 ml-2 border-l border-border pl-3">
                <div className="font-medium text-amber-300">└── {coFounder.name}</div>
                {employees.map((e) => (
                  <div key={e.id} className="ml-3 text-muted-foreground">· {e.title ?? e.name}</div>
                ))}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Activity className="h-4 w-4" /> Activity</CardTitle>
            </CardHeader>
            <CardContent className="max-h-80 space-y-2 overflow-y-auto text-sm">
              {activity.length === 0 && <p className="text-muted-foreground">No activity yet.</p>}
              {activity.map((a) => (
                <div key={a.id} className="border-l-2 border-primary/40 pl-2">
                  <p className="text-xs text-muted-foreground">{new Date(a.created_at).toLocaleString()}</p>
                  <p>{a.summary}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function AddEmployeeDialog({
  onSubmit,
  busy,
  managerId,
}: {
  onSubmit: (payload: { name: string; role: AiAgentRole; instructions?: string; responsibilities?: string[]; job_description?: string }) => void;
  busy: boolean;
  managerId: string | null;
}) {
  const [role, setRole] = useState<AiAgentRole>("sales");
  const [name, setName] = useState("");
  const [jobDescription, setJobDescription] = useState("");
  const [instructions, setInstructions] = useState("");

  const preset = AI_EMPLOYEE_ROLES.find((r) => r.role === role);

  const submit = () => {
    if (role === "custom") {
      onSubmit({
        name: name || "Custom AI Employee",
        role,
        job_description: jobDescription,
        instructions: instructions || jobDescription || "You are a custom AI employee. Follow your job description and report to the AI Co-Founder.",
        responsibilities: jobDescription ? [jobDescription] : [],
      });
    } else {
      onSubmit({
        name: name || preset?.title || "AI Employee",
        role,
        instructions: preset?.instructions,
        responsibilities: preset?.responsibilities,
      });
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add an AI Employee</DialogTitle>
        <DialogDescription>
          {managerId ? "This employee will report to the AI Co-Founder." : "Add the AI Co-Founder first to build an organization."}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4 py-2">
        <div className="space-y-1.5">
          <Label>Role</Label>
          <select
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={role}
            onChange={(e) => setRole(e.target.value as AiAgentRole)}
            disabled={!managerId}
          >
            {AI_EMPLOYEE_ROLES.map((r) => (
              <option key={r.role} value={r.role}>{ROLE_LABEL[r.role]}</option>
            ))}
            <option value="custom">Custom AI Employee</option>
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="emp-name">Display name</Label>
          <Input id="emp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={preset?.title ?? "e.g. My Custom Assistant"} />
        </div>

        {role === "custom" ? (
          <>
            <div className="space-y-1.5">
              <Label htmlFor="emp-job">Describe the job, role, responsibilities & tools</Label>
              <Textarea
                id="emp-job"
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
                placeholder="e.g. This AI handles inventory reordering: monitor product stock, flag low items, and draft purchase orders to the owner."
                rows={4}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="emp-instr">Instructions (optional override)</Label>
              <Textarea id="emp-instr" value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={3} />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            Responsibilities & tools are pre-filled for the {ROLE_LABEL[role]} role. You can edit them after creation.
          </p>
        )}
      </div>

      <DialogFooter>
        <Button onClick={submit} disabled={busy || !managerId}>
          {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Plus className="mr-1.5 h-4 w-4" />}
          Create employee
        </Button>
      </DialogFooter>
    </>
  );
}
