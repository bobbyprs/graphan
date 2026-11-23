import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Box, Tab, Tabs } from '@mui/material';
import PsychologyIcon from '@mui/icons-material/Psychology';
import ModelTrainingIcon from '@mui/icons-material/ModelTraining';
import AutoGraphIcon from '@mui/icons-material/AutoGraph';
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome';
import Inventory2Icon from '@mui/icons-material/Inventory2Outlined';
import { PageHeader } from '@/components/common/misc';
import type { QuerySpec } from '@/components/ml/DataSourceQuery';
import { RegressionStudio } from '@/components/ml/RegressionStudio';
import { ForecastStudio } from '@/components/ml/ForecastStudio';
import { AutoDashboard } from '@/components/ml/AutoDashboard';
import { ModelRegistry } from '@/components/ml/ModelRegistry';

const TABS = ['predict', 'forecast', 'auto', 'models'] as const;
type TabId = (typeof TABS)[number];

export function MlStudioPage() {
  const [params, setParams] = useSearchParams();
  const tab = (TABS.includes(params.get('tab') as TabId) ? params.get('tab') : 'predict') as TabId;
  const modelId = params.get('model') ?? undefined;
  const setTab = (t: TabId, extra: Record<string, string> = {}) => setParams({ tab: t, ...extra }, { replace: true });

  // Each workflow keeps its own query while you switch tabs
  const [regSpec, setRegSpec] = useState<QuerySpec>({ dataSourceId: '', sql: '', timeRange: { from: 'now-90d', to: 'now' } });
  const [fcSpec, setFcSpec] = useState<QuerySpec>({ dataSourceId: '', sql: '', timeRange: { from: 'now-90d', to: 'now' } });

  useEffect(() => {
    document.title = 'ML Studio · Graphan';
  }, []);

  return (
    <Box>
      <PageHeader
        icon={<PsychologyIcon color="primary" sx={{ fontSize: 34 }} />}
        title="ML Studio"
        subtitle="Predict, forecast and auto-build dashboards from your databases — every model is cross-validated and explained."
      />
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} variant="scrollable" allowScrollButtonsMobile sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Tab value="predict" icon={<ModelTrainingIcon fontSize="small" />} iconPosition="start" label="Predict" sx={{ minHeight: 48 }} />
        <Tab value="forecast" icon={<AutoGraphIcon fontSize="small" />} iconPosition="start" label="Forecast" sx={{ minHeight: 48 }} />
        <Tab value="auto" icon={<AutoAwesomeIcon fontSize="small" />} iconPosition="start" label="Auto dashboard" sx={{ minHeight: 48 }} />
        <Tab value="models" icon={<Inventory2Icon fontSize="small" />} iconPosition="start" label="Models" sx={{ minHeight: 48 }} />
      </Tabs>
      {tab === 'predict' && <RegressionStudio spec={regSpec} onSpec={setRegSpec} openModelId={modelId} />}
      {tab === 'forecast' && <ForecastStudio spec={fcSpec} onSpec={setFcSpec} />}
      {tab === 'auto' && <AutoDashboard />}
      {tab === 'models' && <ModelRegistry onOpen={(id) => setTab('predict', { model: id })} />}
    </Box>
  );
}
