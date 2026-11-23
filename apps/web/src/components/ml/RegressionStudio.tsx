import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  FormControlLabel,
  LinearProgress,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ModelTrainingIcon from '@mui/icons-material/ModelTraining';
import { useMlModel, useMlProfile, useMlTrain } from '@/api/hooks';
import { errorMessage } from '@/api/client';
import type { ProfileResult, RegressionModelId, TrainResult } from '@/api/types';
import { EmptyState } from '@/components/common/misc';
import { DataSourceQuery, type QuerySpec } from './DataSourceQuery';
import { KIND_META, ProfileView } from './ProfileView';
import { RegressionResults } from './RegressionResults';

export const ALGORITHMS: { id: RegressionModelId; label: string; group: string }[] = [
  { id: 'linear', label: 'Linear regression', group: 'Linear' },
  { id: 'ridge', label: 'Ridge', group: 'Linear' },
  { id: 'lasso', label: 'Lasso', group: 'Linear' },
  { id: 'elastic_net', label: 'Elastic Net', group: 'Linear' },
  { id: 'polynomial', label: 'Polynomial (deg 2)', group: 'Linear' },
  { id: 'knn', label: 'k-Nearest neighbours', group: 'Instance' },
  { id: 'decision_tree', label: 'Decision tree', group: 'Tree' },
  { id: 'random_forest', label: 'Random forest', group: 'Ensemble' },
  { id: 'gradient_boosting', label: 'Gradient boosting', group: 'Ensemble' },
];

const STEPS = ['Running query', 'Encoding features', 'Cross-validating models', 'Ranking the leaderboard', 'Measuring feature importance', 'Refitting the winner'];

function TrainingProgress({ models, folds }: { models: number; folds: number }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((x) => Math.min(STEPS.length - 1, x + 1)), 1800);
    return () => clearInterval(t);
  }, []);
  return (
    <Paper variant="outlined" sx={{ p: 2, bgcolor: 'surface.panel' }}>
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
        <ModelTrainingIcon color="primary" />
        <Typography variant="subtitle2">
          Training {models} models × {folds} folds…
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {STEPS[i]}
        </Typography>
      </Stack>
      <LinearProgress />
    </Paper>
  );
}

export function RegressionStudio({ spec, onSpec, openModelId }: { spec: QuerySpec; onSpec: (s: QuerySpec) => void; openModelId?: string }) {
  const profileM = useMlProfile();
  const train = useMlTrain();
  const saved = useMlModel(openModelId);
  const [profile, setProfile] = useState<ProfileResult | null>(null);
  const [target, setTarget] = useState<string>('');
  const [features, setFeatures] = useState<string[]>([]);
  const [models, setModels] = useState<RegressionModelId[]>(ALGORITHMS.map((a) => a.id));
  const [folds, setFolds] = useState(5);
  const [name, setName] = useState('');
  const [result, setResult] = useState<TrainResult | null>(null);

  // Re-open a model from the registry
  useEffect(() => {
    if (!saved.data) return;
    setResult(saved.data);
    if (saved.data.sql && saved.data.dataSourceId) onSpec({ ...spec, sql: saved.data.sql, dataSourceId: saved.data.dataSourceId });
    setTarget(saved.data.target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved.data]);

  const usable = useMemo(() => profile?.columns.filter((c) => ['numeric', 'categorical', 'boolean', 'datetime'].includes(c.kind)) ?? [], [profile]);
  const targets = useMemo(() => {
    const numeric = profile?.columns.filter((c) => c.kind === 'numeric' || c.kind === 'boolean').map((c) => c.name) ?? [];
    const order = profile?.suggestions.targets ?? [];
    return [...order.filter((t) => numeric.includes(t)), ...numeric.filter((n) => !order.includes(n))];
  }, [profile]);

  const pickTarget = (t: string) => {
    setTarget(t);
    setFeatures(usable.filter((c) => c.name !== t).map((c) => c.name));
  };

  const runProfile = () =>
    profileM.mutate(spec, {
      onSuccess: (p) => {
        setProfile(p);
        setResult(null);
        const t = p.suggestions.targets[0] ?? '';
        setTarget(t);
        setFeatures(p.columns.filter((c) => ['numeric', 'categorical', 'boolean', 'datetime'].includes(c.kind) && c.name !== t).map((c) => c.name));
      },
    });

  const runTrain = () =>
    train.mutate({ ...spec, target, features, models, folds, name: name || undefined }, { onSuccess: (r) => setResult(r) });

  return (
    <Stack spacing={2}>
      <DataSourceQuery value={spec} onChange={onSpec} onRun={runProfile} running={profileM.isPending} runLabel="Analyze data" hint="Write a query whose rows are the examples to learn from — include the value to predict and the columns that might explain it." />
      {profileM.isPending && <LinearProgress />}
      {profileM.error && <Alert severity="error">{errorMessage(profileM.error)}</Alert>}

      {profile && (
        <>
          <ProfileView profile={profile} target={target} onPickTarget={pickTarget} />

          <Paper variant="outlined" sx={{ p: 2, bgcolor: 'surface.panel' }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5 }}>
              Train a prediction model
            </Typography>
            <Stack spacing={2}>
              <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
                <TextField select label="Predict (target)" value={target} onChange={(e) => pickTarget(e.target.value)} sx={{ minWidth: 240 }} helperText={targets[0] === target ? 'Suggested from correlations' : ' '}>
                  {targets.map((t, i) => (
                    <MenuItem key={t} value={t}>
                      {t}
                      {i === 0 && <Chip size="small" label="suggested" sx={{ ml: 1, height: 18, fontSize: 10 }} />}
                    </MenuItem>
                  ))}
                </TextField>
                <Autocomplete
                  multiple
                  options={usable.map((c) => c.name).filter((c) => c !== target)}
                  value={features}
                  onChange={(_e, v) => setFeatures(v)}
                  disableCloseOnSelect
                  sx={{ flex: 1 }}
                  renderTags={(v, getTagProps) =>
                    v.map((opt, i) => {
                      const kind = profile.columns.find((c) => c.name === opt)?.kind ?? 'numeric';
                      return <Chip {...getTagProps({ index: i })} key={opt} size="small" icon={KIND_META[kind].icon} label={opt} />;
                    })
                  }
                  renderInput={(p) => <TextField {...p} label="Using these columns (features)" helperText={`${features.length} of ${usable.length - (target ? 1 : 0)} usable columns · identifiers and free text are excluded automatically`} />}
                />
              </Stack>

              <Box>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                  <Typography variant="subtitle2">Algorithms</Typography>
                  <Button size="small" onClick={() => setModels(ALGORITHMS.map((a) => a.id))}>
                    All
                  </Button>
                  <Button size="small" onClick={() => setModels(['ridge', 'random_forest', 'gradient_boosting'])}>
                    Fast trio
                  </Button>
                </Stack>
                <Stack direction="row" flexWrap="wrap" useFlexGap columnGap={1}>
                  {ALGORITHMS.map((a) => (
                    <FormControlLabel
                      key={a.id}
                      control={
                        <Checkbox
                          size="small"
                          checked={models.includes(a.id)}
                          onChange={(e) => setModels((m) => (e.target.checked ? [...m, a.id] : m.filter((x) => x !== a.id)))}
                        />
                      }
                      label={<Typography variant="body2">{a.label}</Typography>}
                    />
                  ))}
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  A mean baseline is always included so you can see the real lift.
                </Typography>
              </Box>

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
                <Tooltip title="Data is split into k parts; each model is trained k times, each time scored on the part it did not see.">
                  <TextField select label="Cross-validation" value={folds} onChange={(e) => setFolds(Number(e.target.value))} sx={{ width: 170 }}>
                    {[3, 5, 10].map((k) => (
                      <MenuItem key={k} value={k}>
                        {k}-fold
                      </MenuItem>
                    ))}
                  </TextField>
                </Tooltip>
                <TextField label="Model name (optional)" value={name} onChange={(e) => setName(e.target.value)} placeholder={target ? `Predict ${target}` : ''} sx={{ flex: 1, maxWidth: 360 }} />
                <Box sx={{ flex: 1 }} />
                <Button variant="contained" size="large" startIcon={<ModelTrainingIcon />} onClick={runTrain} disabled={train.isPending || !target || !features.length || !models.length}>
                  Train &amp; compare
                </Button>
              </Stack>
            </Stack>
          </Paper>
        </>
      )}

      {train.isPending && <TrainingProgress models={models.length + 1} folds={folds} />}
      {train.error && <Alert severity="error">{errorMessage(train.error)}</Alert>}
      {saved.isLoading && <LinearProgress />}
      {result && !train.isPending && <RegressionResults r={result} />}

      {!profile && !result && !profileM.isPending && !saved.isLoading && (
        <EmptyState
          icon={<ModelTrainingIcon sx={{ fontSize: 48 }} />}
          title="Predict any numeric column"
          description="Pick a table or write a query, then Analyze data. ML Studio profiles every column, suggests what to predict, trains nine algorithms side by side and explains the winner."
        />
      )}
    </Stack>
  );
}
