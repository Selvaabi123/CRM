'use client';

import { useState } from 'react';
import { Bot, Sparkles, Settings2, BarChart3, Network } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { AiPlayground } from '@/components/agents/ai-playground';
import { AiUsageCard } from '@/components/agents/ai-usage';
import { AiConfig } from '@/components/settings/ai-config';
import { AgentOrg } from '@/components/agents/agent-org';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';

type Tab = 'playground' | 'setup' | 'usage' | 'organization';

export default function AgentsPage() {
  const { accountRole } = useAuth();
  const canViewUsage = accountRole ? canEditSettings(accountRole) : false;
  const [tab, setTab] = useState<Tab>('organization');

  return (
    <div>
      <div className="flex items-center gap-2">
        <Bot className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          AI Agents
        </h1>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        Your AI Business Operating System — the AI Co-Founder and its team of AI
        employees work alongside your CRM.
      </p>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        className="mt-6"
      >
        <TabsList>
          <TabsTrigger value="organization">
            <Network className="mr-1.5 h-4 w-4" /> Organization
          </TabsTrigger>
          <TabsTrigger value="playground">
            <Sparkles className="mr-1.5 h-4 w-4" /> Playground
          </TabsTrigger>
          <TabsTrigger value="setup">
            <Settings2 className="mr-1.5 h-4 w-4" /> Setup
          </TabsTrigger>
          {canViewUsage && (
            <TabsTrigger value="usage">
              <BarChart3 className="mr-1.5 h-4 w-4" /> Usage
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="organization" className="mt-4">
          <AgentOrg />
        </TabsContent>

        <TabsContent value="playground" className="mt-4">
          <AiPlayground onGoToSetup={() => setTab('setup')} />
        </TabsContent>

        <TabsContent value="setup" className="mt-4">
          <AiConfig />
        </TabsContent>

        {canViewUsage && (
          <TabsContent value="usage" className="mt-4">
            <AiUsageCard />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
